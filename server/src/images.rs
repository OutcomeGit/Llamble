//! Picture generation: "/imagine a llama surfing", or asking the AI to draw something.
//!
//! Runs on a member's lent GPU when one offers images (seconds), otherwise on the NAS
//! itself with stable-diffusion.cpp (its built-in graphics via Vulkan if the container
//! can see /dev/dri, else the CPU: minutes). Models: FLUX.2 [klein] 4B or Z-Image Turbo,
//! downloaded from Hugging Face once.
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::models::{load_channel, load_message, Channel};
use crate::perms::{self, require_channel};
use crate::state::{AuthUser, Shared};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use dashmap::DashMap;
use futures::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::{oneshot, RwLock, Semaphore};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct ImageSettings {
    pub enabled: bool,
    /// flux2-klein-4b | z-image-turbo
    pub model: String,
    /// who may make pictures: everyone | adults | admins
    pub who: String,
    /// draw on the NAS when no GPU is lent
    pub nas: bool,
}

impl Default for ImageSettings {
    fn default() -> Self {
        ImageSettings { enabled: false, model: "flux2-klein-4b".into(), who: "adults".into(), nas: true }
    }
}

pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    /// (Hugging Face repo, file path in the repo, local file name)
    pub files: &'static [(&'static str, &'static str, &'static str)],
    pub steps: u32,
    pub cfg: f32,
}

pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "flux2-klein-4b",
        label: "FLUX.2 [klein] 4B — fast, great all-rounder (~6 GB)",
        files: &[
            ("unsloth/FLUX.2-klein-4B-GGUF", "flux-2-klein-4b-Q4_K_M.gguf", "diffusion.gguf"),
            ("Comfy-Org/vae-text-encorder-for-flux-klein-4b", "split_files/vae/flux2-vae.safetensors", "vae.safetensors"),
            ("unsloth/Qwen3-4B-Instruct-2507-GGUF", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "text-encoder.gguf"),
        ],
        steps: 4,
        cfg: 1.0,
    },
    ModelSpec {
        id: "z-image-turbo",
        label: "Z-Image Turbo — very realistic photos (~7 GB)",
        files: &[
            ("leejet/Z-Image-Turbo-GGUF", "z_image_turbo-Q4_K.gguf", "diffusion.gguf"),
            ("Comfy-Org/z_image_turbo", "split_files/vae/ae.safetensors", "vae.safetensors"),
            ("unsloth/Qwen3-4B-Instruct-2507-GGUF", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "text-encoder.gguf"),
        ],
        steps: 8,
        cfg: 1.0,
    },
];

pub fn spec(id: &str) -> &'static ModelSpec {
    MODELS.iter().find(|m| m.id == id).unwrap_or(&MODELS[0])
}

pub async fn load_settings(state: &Shared) -> ImageSettings {
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'images'").fetch_optional(&state.db).await.ok().flatten();
    v.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

fn sd_bin() -> PathBuf {
    PathBuf::from(std::env::var("LLAMBLE_SD_BIN").unwrap_or_else(|_| "/opt/sd/sd-cli".into()))
}
fn hf() -> String {
    std::env::var("LLAMBLE_HF_ENDPOINT").unwrap_or_else(|_| "https://huggingface.co".into()).trim_end_matches('/').to_string()
}
fn model_dir(state: &Shared, id: &str) -> PathBuf {
    state.cfg.data_dir.join("images").join(id)
}
fn ready(state: &Shared, id: &str) -> bool {
    spec(id).files.iter().all(|f| model_dir(state, id).join(f.2).exists())
}

// ---------------------------------------------------------------- NAS graphics

/// Can this container use the NAS's built-in graphics? (none | no-access | ready)
fn gpu_access() -> (String, Option<u32>) {
    let dev = std::path::Path::new("/dev/dri/renderD128");
    if !dev.exists() {
        return ("none".into(), None);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let gid = std::fs::metadata(dev).map(|m| m.gid()).ok();
        let ok = std::fs::OpenOptions::new().read(true).write(true).open(dev).is_ok();
        return (if ok { "ready" } else { "no-access" }.into(), gid);
    }
    #[allow(unreachable_code)]
    ("none".into(), None)
}

// ---------------------------------------------------------------- downloads

#[derive(Serialize, Clone, Default)]
pub struct Status {
    pub state: String, // idle | downloading | ready | error
    pub file: Option<String>,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
    pub busy: bool,
}
static STATUS: Lazy<RwLock<Status>> = Lazy::new(|| RwLock::new(Status::default()));
static DONE: AtomicU64 = AtomicU64::new(0);
static DL_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

pub fn ensure_models(state: Shared) {
    tokio::spawn(async move {
        let _g = DL_LOCK.lock().await;
        let s = load_settings(&state).await;
        if !s.enabled || !s.nas || ready(&state, &s.model) {
            let mut st = STATUS.write().await;
            st.state = if ready(&state, &s.model) { "ready" } else { "idle" }.into();
            return;
        }
        let dir = model_dir(&state, &s.model);
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            STATUS.write().await.error = Some(e.to_string());
            return;
        }
        for (repo, path, local) in spec(&s.model).files {
            let dst = dir.join(local);
            if dst.exists() {
                continue;
            }
            // reuse a copy the AI model manager already downloaded (same text encoder)
            let shared = state.cfg.data_dir.join("models").join(repo.replace('/', "__")).join(path.rsplit('/').next().unwrap());
            if shared.exists() && tokio::fs::hard_link(&shared, &dst).await.is_ok() {
                continue;
            }
            {
                let mut st = STATUS.write().await;
                st.state = "downloading".into();
                st.file = Some(path.rsplit('/').next().unwrap().to_string());
                st.error = None;
                st.done_bytes = 0;
                st.total_bytes = 0;
            }
            if let Err(e) = download(&format!("{}/{}/resolve/main/{}", hf(), repo, path), &dst).await {
                let mut st = STATUS.write().await;
                st.state = "error".into();
                st.error = Some(format!("couldn't download {path}: {e:#}"));
                return;
            }
        }
        let mut st = STATUS.write().await;
        st.state = "ready".into();
        st.file = None;
        st.error = None;
    });
}

async fn download(url: &str, dst: &std::path::Path) -> anyhow::Result<()> {
    let part = dst.with_extension("part");
    let mut have = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    let mut req = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build()?.get(url);
    if let Ok(t) = std::env::var("HF_TOKEN") {
        req = req.bearer_auth(t);
    }
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let res = req.send().await?.error_for_status()?;
    if res.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        have = 0;
    }
    STATUS.write().await.total_bytes = have + res.content_length().unwrap_or(0);
    DONE.store(have, Ordering::Relaxed);
    let mut out = tokio::fs::OpenOptions::new().create(true).write(true).append(have > 0).truncate(have == 0).open(&part).await?;
    let mut stream = res.bytes_stream();
    while let Some(c) = stream.next().await {
        let c = c?;
        out.write_all(&c).await?;
        DONE.fetch_add(c.len() as u64, Ordering::Relaxed);
    }
    out.flush().await?;
    tokio::fs::rename(&part, dst).await?;
    Ok(())
}

// ---------------------------------------------------------------- making a picture

/// Pictures waiting on a lent GPU: job → where to deliver the PNG
static PENDING: Lazy<DashMap<String, (u64, oneshot::Sender<Result<Vec<u8>, String>>)>> = Lazy::new(Default::default);
static NAS_SLOT: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(1));

fn dims(shape: &str) -> (u32, u32) {
    match shape {
        "wide" => (1024, 576),
        "tall" => (576, 1024),
        _ => (768, 768),
    }
}

async fn on_nas(state: &Shared, s: &ImageSettings, prompt: &str, w: u32, h: u32, seed: i64) -> anyhow::Result<Vec<u8>> {
    if !ready(state, &s.model) {
        anyhow::bail!("the picture model is still downloading on the server");
    }
    let _slot = NAS_SLOT.acquire().await?;
    STATUS.write().await.busy = true;
    let d = model_dir(state, &s.model);
    let m = spec(&s.model);
    let out = std::env::temp_dir().join(format!("llamble-img-{}.png", new_id()));
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).to_string();
    // the NAS's graphics are slow: draw smaller there and keep it under ~10 minutes
    let (w, h) = (w * 2 / 3 / 64 * 64, h * 2 / 3 / 64 * 64);
    let res = tokio::time::timeout(
        Duration::from_secs(1200),
        tokio::process::Command::new(sd_bin())
            .arg("--diffusion-model")
            .arg(d.join("diffusion.gguf"))
            .arg("--vae")
            .arg(d.join("vae.safetensors"))
            .arg("--llm")
            .arg(d.join("text-encoder.gguf"))
            .args(["--cfg-scale", &m.cfg.to_string(), "--steps", &m.steps.to_string(), "-W", &w.to_string(), "-H", &h.to_string()])
            .args(["--seed", &seed.to_string(), "-t", &threads, "--vae-tiling"])
            .arg("-p")
            .arg(prompt)
            .arg("-o")
            .arg(&out)
            .kill_on_drop(true)
            .output(),
    )
    .await;
    STATUS.write().await.busy = false;
    let res = res.map_err(|_| anyhow::anyhow!("took too long"))??;
    let png = tokio::fs::read(&out).await;
    let _ = tokio::fs::remove_file(&out).await;
    match png {
        Ok(p) if p.len() > 100 => Ok(p),
        _ => anyhow::bail!("drawing failed: {}", String::from_utf8_lossy(&res.stderr).lines().rev().take(3).collect::<Vec<_>>().join(" | ")),
    }
}

/// A lent GPU that offers pictures and whose owner can see the channel.
async fn image_worker(state: &Shared, ch: &Channel) -> Option<(u64, String)> {
    let mut list: Vec<(u64, i64, String, String)> = state.bot.workers.iter().filter(|w| w.available && w.images).map(|w| (*w.key(), w.vram_mb, w.user_id.clone(), w.gpu.clone())).collect();
    list.sort_by(|a, b| b.1.cmp(&a.1));
    for (conn, _, uid, gpu) in list {
        if perms::channel_perms(&state.db, ch, &uid).await.map(|p| p & perms::VIEW != 0).unwrap_or(false) {
            return Some((conn, gpu));
        }
    }
    None
}

async fn on_worker(state: &Shared, conn: u64, s: &ImageSettings, prompt: &str, w: u32, h: u32, seed: i64) -> anyhow::Result<Vec<u8>> {
    let job = new_id();
    let (tx, rx) = oneshot::channel();
    PENDING.insert(job.clone(), (conn, tx));
    let m = spec(&s.model);
    let sent = state.bot.workers.get(&conn).map(|wk| {
        wk.tx.send(json!({ "t": "IMAGE_JOB", "d": {
            "job_id": job, "prompt": prompt, "width": w, "height": h, "seed": seed,
            "model": m.id, "files": m.files.iter().map(|f| json!({ "repo": f.0, "path": f.1, "name": f.2 })).collect::<Vec<_>>(),
            "steps": m.steps, "cfg": m.cfg,
        }}).to_string()).is_ok()
    });
    if sent != Some(true) {
        PENDING.remove(&job);
        anyhow::bail!("the GPU went away");
    }
    // first run on a PC downloads the model there, so be patient
    let r = tokio::time::timeout(Duration::from_secs(1800), rx).await;
    PENDING.remove(&job);
    match r {
        Ok(Ok(Ok(png))) => Ok(png),
        Ok(Ok(Err(e))) => anyhow::bail!("{e}"),
        _ => anyhow::bail!("the GPU didn't finish"),
    }
}

/// The lent GPU's app uploads the finished PNG here (or an error in `x-error`).
pub async fn job_result(State(state): State<Shared>, auth: AuthUser, Path(job): Path<String>, headers: HeaderMap, body: Bytes) -> ApiResult<Json<Value>> {
    let Some((_, (conn, tx))) = PENDING.remove(&job) else { return Err(AppError::not_found()) };
    let owner = state.bot.workers.get(&conn).map(|w| w.user_id.clone());
    if owner.as_deref() != Some(auth.id.as_str()) {
        PENDING.insert(job, (conn, tx));
        return Err(AppError::forbidden());
    }
    let r = match headers.get("x-error").and_then(|v| v.to_str().ok()) {
        Some(e) => Err(e.chars().take(300).collect()),
        None if body.starts_with(b"\x89PNG") && body.len() < 30 * 1024 * 1024 => Ok(body.to_vec()),
        None => Err("the GPU sent something that isn't a picture".to_string()),
    };
    let _ = tx.send(r);
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------- the request

#[derive(Deserialize)]
pub struct Imagine {
    pub prompt: String,
    #[serde(default)]
    pub shape: String,
}

/// Words that keep pictures family-friendly (always on; this is a family chat app).
fn not_allowed(prompt: &str) -> bool {
    let re = regex::Regex::new(r"(?i)\b(nude|naked|nsfw|porn\w*|sex\w*|topless|lingerie|explicit|hentai|genitals?|gore|gory|decapitat\w*|dismember\w*)\b").unwrap();
    re.is_match(prompt)
}

pub async fn may_draw(state: &Shared, uid: &str, is_admin: bool) -> Result<ImageSettings, String> {
    let s = load_settings(state).await;
    if !s.enabled {
        return Err("making pictures isn't turned on (Master Admin: Settings → AI Model → Pictures)".into());
    }
    let kid = crate::kids::is_kid(state, uid).await;
    match s.who.as_str() {
        "admins" if !is_admin => return Err("only admins can make pictures here".into()),
        "adults" if kid => return Err("making pictures is turned off for kid accounts".into()),
        _ => {}
    }
    Ok(s)
}

pub async fn imagine(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<Imagine>) -> ApiResult<Json<Value>> {
    let ch = load_channel(&state.db, &cid).await?;
    require_channel(&state.db, &ch, &auth.id, perms::VIEW | perms::SEND | perms::ATTACH).await?;
    crate::kids::check_quiet(&state, &auth.id).await?;
    let s = may_draw(&state, &auth.id, auth.is_admin).await.map_err(AppError::bad)?;
    let prompt: String = req.prompt.trim().chars().take(600).collect();
    if prompt.len() < 3 {
        return Err(AppError::bad("describe the picture"));
    }
    if not_allowed(&prompt) {
        return Err(AppError::bad("that picture isn't allowed here"));
    }
    start(state, ch, auth.id, s, prompt, req.shape).await.map_err(|e| AppError::bad(e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

/// Post "Drawing…" from the bot, make the picture, then swap in the image.
pub async fn start(state: Shared, ch: Channel, uid: String, s: ImageSettings, prompt: String, shape: String) -> anyhow::Result<()> {
    let worker = image_worker(&state, &ch).await;
    if worker.is_none() && !(s.nas && sd_bin().exists()) {
        anyhow::bail!("no GPU is lent for pictures right now, and drawing on the server is off");
    }
    let (w, h) = dims(&shape);
    let seed: i64 = rand::random::<u32>() as i64;
    let place = match &worker {
        Some((_, gpu)) => format!("on a lent {gpu}"),
        None => match gpu_access().0.as_str() {
            "ready" => "on the server's graphics — this takes a minute or two".into(),
            _ => "on the server's processor — this can take several minutes".into(),
        },
    };
    let name = crate::models::get_user(&state.db, &uid).await.map(|u| u.display_name).unwrap_or_default();
    let msg = post(&state, &ch, &format!("🎨 Drawing **{prompt}** for {name} {place}…")).await?;
    tokio::spawn(async move {
        let png = match worker {
            Some((conn, _)) => match on_worker(&state, conn, &s, &prompt, w, h, seed).await {
                Ok(p) => Ok(p),
                // the GPU dropped out: fall back to the server if allowed
                Err(e) if s.nas && sd_bin().exists() => {
                    tracing::info!("picture on GPU failed ({e:#}); drawing on the server");
                    on_nas(&state, &s, &prompt, w, h, seed).await
                }
                Err(e) => Err(e),
            },
            None => on_nas(&state, &s, &prompt, w, h, seed).await,
        };
        let content = match &png {
            Ok(_) => format!("🎨 **{prompt}** — for {name}"),
            Err(e) => format!("🎨 Couldn't draw **{prompt}**: {e:#}"),
        };
        if let Ok(p) = png {
            match crate::api::files::store_bytes(&state, &state.bot_id, "picture.png", "image/png", &p).await {
                Ok(f) => {
                    let _ = sqlx::query("INSERT INTO message_attachments (message_id, file_id, position, spoiler) VALUES (?,?,0,0)").bind(&msg).bind(&f).execute(&state.db).await;
                }
                Err(e) => tracing::warn!("saving picture: {e:#}"),
            }
        }
        let _ = sqlx::query("UPDATE messages SET content = ? WHERE id = ?").bind(&content).bind(&msg).execute(&state.db).await;
        if let Ok(m) = load_message(&state.db, &msg).await {
            state.emit_channel(&ch, "MESSAGE_UPDATE", &m).await;
        }
    });
    Ok(())
}

async fn post(state: &Shared, ch: &Channel, text: &str) -> anyhow::Result<String> {
    let id = new_id();
    sqlx::query("INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?,?,?,?,?)")
        .bind(&id)
        .bind(&ch.id)
        .bind(&state.bot_id)
        .bind(text)
        .bind(now_ms())
        .execute(&state.db)
        .await?;
    let m = load_message(&state.db, &id).await?;
    let mut v = serde_json::to_value(&m)?;
    v["guild_id"] = json!(ch.guild_id);
    state.emit_channel(ch, "MESSAGE_CREATE", &v).await;
    Ok(id)
}

// ---------------------------------------------------------------- admin

pub async fn get_admin(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    let s = load_settings(&state).await;
    let mut st = STATUS.read().await.clone();
    if st.state == "downloading" {
        st.done_bytes = DONE.load(Ordering::Relaxed);
    } else if st.state.is_empty() || st.state == "idle" {
        st.state = if ready(&state, &s.model) { "ready" } else { "idle" }.into();
    }
    let (gpu, gid) = gpu_access();
    let gpus: Vec<Value> = state.bot.workers.iter().filter(|w| w.images).map(|w| json!({ "gpu": w.gpu, "available": w.available })).collect();
    Ok(Json(json!({
        "settings": s,
        "status": st,
        "models": MODELS.iter().map(|m| json!({ "id": m.id, "label": m.label })).collect::<Vec<_>>(),
        "nas_tool": sd_bin().exists(),
        "nas_gpu": gpu,
        "nas_gpu_gid": gid,
        "lent_gpus": gpus,
    })))
}

pub async fn put_admin(State(state): State<Shared>, auth: AuthUser, Json(req): Json<Value>) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    let mut cur = serde_json::to_value(load_settings(&state).await).unwrap();
    if let (Some(c), Some(r)) = (cur.as_object_mut(), req.as_object()) {
        for (k, v) in r {
            if c.contains_key(k) {
                c.insert(k.clone(), v.clone());
            }
        }
    }
    let s: ImageSettings = serde_json::from_value(cur).map_err(|e| AppError::bad(e.to_string()))?;
    if !MODELS.iter().any(|m| m.id == s.model) || !["everyone", "adults", "admins"].contains(&s.who.as_str()) {
        return Err(AppError::bad("unknown model or audience"));
    }
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('images', ?)").bind(serde_json::to_string(&s).unwrap()).execute(&state.db).await?;
    ensure_models(state.clone());
    announce(&state).await;
    get_admin(State(state), auth).await
}

/// What apps need to know: can pictures be made, and which model lent GPUs should run.
pub async fn config_json(state: &Shared) -> Value {
    let s = load_settings(state).await;
    let m = spec(&s.model);
    json!({ "enabled": s.enabled, "who": s.who, "model": s.model,
            "files": m.files.iter().map(|f| json!({ "repo": f.0, "path": f.1, "name": f.2 })).collect::<Vec<_>>(),
            "steps": m.steps, "cfg": m.cfg })
}

pub async fn announce(state: &Shared) {
    let v = config_json(state).await;
    state.hub.send_users(&state.hub.online_users(), "CONFIG_UPDATE", &json!({ "images": v }));
}

pub fn boot(state: Shared) {
    ensure_models(state);
}

#[cfg(test)]
mod tests {
    #[test]
    fn family_friendly() {
        assert!(super::not_allowed("a naked man"));
        assert!(!super::not_allowed("a llama surfing a giant wave"));
        assert!(!super::not_allowed("Sussex countryside")); // "sex" only as a whole word
    }
}
