//! Built-in AI model manager: picks a GGUF from Hugging Face, downloads it into
//! /data/models with progress, and runs llama-server (bundled in the image)
//! as a supervised child process on 127.0.0.1. Admins choose/switch the model
//! from the setup wizard or Settings → AI Model.
use crate::error::{ApiResult, AppError};
use crate::state::{AuthUser, Shared};
use axum::extract::State;
use axum::Json;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, RwLock};

pub const LLAMA_PORT: u16 = 18081;

#[derive(Serialize, Clone, Debug, Default)]
pub struct AiStatus {
    /// none | resolving | downloading | starting | ready | error | external
    pub state: String,
    pub repo: Option<String>,
    pub quant: Option<String>,
    pub files: Vec<String>,
    pub ctx: i64,
    pub total_bytes: u64,
    pub downloaded_bytes: u64,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct AiManager {
    pub status: RwLock<AiStatus>,
    downloaded: AtomicU64,
    /// bumps on every new model selection; stale background tasks exit when it changes
    generation: AtomicU64,
    child: Mutex<Option<tokio::process::Child>>,
    log: Mutex<VecDeque<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ModelChoice {
    pub repo: String,
    pub quant: String,
    pub ctx: i64,
}

pub struct CatalogEntry {
    pub repo: &'static str,
    pub quant: &'static str,
    pub name: &'static str,
    pub size_gb: f64,
    pub note: &'static str,
}

/// Curated, CPU-friendly picks. Any Hugging Face GGUF repo can be entered as "custom".
pub const CATALOG: &[CatalogEntry] = &[
    CatalogEntry { repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF", quant: "Q4_K_M", name: "Qwen3 4B Instruct", size_gb: 2.5, note: "Fast on a NAS CPU. Good everyday assistant." },
    CatalogEntry { repo: "unsloth/Llama-3.2-3B-Instruct-GGUF", quant: "Q4_K_M", name: "Llama 3.2 3B Instruct", size_gb: 2.0, note: "Fastest. Simple Q&A and short replies." },
    CatalogEntry { repo: "unsloth/gemma-3-4b-it-GGUF", quant: "Q4_K_M", name: "Gemma 3 4B", size_gb: 2.5, note: "Friendly tone, good writing." },
    CatalogEntry { repo: "unsloth/Qwen3-8B-GGUF", quant: "Q4_K_M", name: "Qwen3 8B", size_gb: 5.0, note: "Smarter, roughly half the speed of 4B on CPU." },
    CatalogEntry { repo: "unsloth/gemma-3-12b-it-GGUF", quant: "Q4_K_M", name: "Gemma 3 12B", size_gb: 7.3, note: "Noticeably smarter; slow on CPU (best with a lent GPU)." },
    CatalogEntry { repo: "unsloth/Qwen3-14B-GGUF", quant: "Q4_K_M", name: "Qwen3 14B", size_gb: 9.0, note: "Strongest here; really wants a lent GPU." },
];

fn hf_endpoint() -> String {
    std::env::var("LLAMBLE_HF_ENDPOINT").unwrap_or_else(|_| "https://huggingface.co".into()).trim_end_matches('/').to_string()
}

pub fn llama_bin() -> PathBuf {
    PathBuf::from(std::env::var("LLAMBLE_LLAMA_BIN").unwrap_or_else(|_| "/opt/llama/llama-server".into()))
}

pub fn models_dir(state: &Shared) -> PathBuf {
    state.cfg.data_dir.join("models")
}

fn http() -> reqwest::Client {
    let mut b = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).user_agent("Llamble/0.1");
    if let Ok(tok) = std::env::var("HF_TOKEN") {
        let mut h = reqwest::header::HeaderMap::new();
        if let Ok(v) = format!("Bearer {tok}").parse() {
            h.insert(reqwest::header::AUTHORIZATION, v);
        }
        b = b.default_headers(h);
    }
    b.build().unwrap()
}

fn valid_repo(repo: &str) -> bool {
    let parts: Vec<&str> = repo.split('/').collect();
    parts.len() == 2 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)))
}

#[derive(Serialize, Clone, Debug)]
pub struct QuantOption {
    pub quant: String,
    pub files: Vec<String>,
    pub size: u64,
}

/// List the GGUF quantizations available in a Hugging Face repo.
pub async fn list_quants(repo: &str) -> anyhow::Result<Vec<QuantOption>> {
    if !valid_repo(repo) {
        anyhow::bail!("repo must look like owner/name");
    }
    let url = format!("{}/api/models/{}/tree/main?recursive=true", hf_endpoint(), repo);
    let res = http().get(&url).send().await?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        anyhow::bail!("model repo not found on Hugging Face");
    }
    if res.status() == reqwest::StatusCode::UNAUTHORIZED || res.status() == reqwest::StatusCode::FORBIDDEN {
        anyhow::bail!("this model is gated/private (set HF_TOKEN to use it)");
    }
    let items: Vec<Value> = res.error_for_status()?.json().await?;
    let mut groups: std::collections::BTreeMap<String, QuantOption> = Default::default();
    let split = regex::Regex::new(r"-(\d{5})-of-(\d{5})\.gguf$").unwrap();
    let quant_re = regex::Regex::new(r"(?i)(UD-)?(I?Q\d(_[A-Z0-9]+)*|F16|BF16|F32)").unwrap();
    for it in items {
        if it["type"] != "file" {
            continue;
        }
        let path = it["path"].as_str().unwrap_or_default().to_string();
        let lower = path.to_lowercase();
        if !lower.ends_with(".gguf") || lower.contains("mmproj") {
            continue;
        }
        let size = it["lfs"]["size"].as_u64().or(it["size"].as_u64()).unwrap_or(0);
        let base = split.replace(&path, ".gguf").to_string();
        let fname = base.rsplit('/').next().unwrap_or(&base).trim_end_matches(".gguf").to_string();
        let quant = quant_re
            .find_iter(&fname)
            .last()
            .map(|m| m.as_str().to_uppercase())
            .unwrap_or_else(|| fname.clone());
        let e = groups.entry(quant.clone()).or_insert(QuantOption { quant, files: vec![], size: 0 });
        e.files.push(path);
        e.size += size;
    }
    let mut out: Vec<QuantOption> = groups.into_values().collect();
    for o in &mut out {
        o.files.sort();
    }
    out.sort_by_key(|o| o.size);
    Ok(out)
}

impl AiManager {
    async fn set(&self, f: impl FnOnce(&mut AiStatus)) {
        let mut s = self.status.write().await;
        f(&mut s);
    }

    pub async fn snapshot(&self) -> AiStatus {
        let mut s = self.status.read().await.clone();
        if s.state == "downloading" {
            s.downloaded_bytes = self.downloaded.load(Ordering::Relaxed);
        }
        s
    }

    async fn push_log(&self, line: String) {
        let mut l = self.log.lock().await;
        l.push_back(line);
        while l.len() > 200 {
            l.pop_front();
        }
    }

    async fn stop_child(&self) {
        if let Some(mut c) = self.child.lock().await.take() {
            let _ = c.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(10), c.wait()).await;
        }
    }
}

/// URL the bot should use for the server-side model, if one is available.
pub async fn server_llama_url(state: &Shared) -> Option<String> {
    if let Some(u) = &state.cfg.llama_url {
        return Some(u.clone());
    }
    let s = state.ai.status.read().await;
    (s.state == "ready").then(|| format!("http://127.0.0.1:{LLAMA_PORT}"))
}

pub async fn load_choice(state: &Shared) -> Option<ModelChoice> {
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ai.model'")
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    v.and_then(|s| serde_json::from_str(&s).ok())
}

async fn save_choice(state: &Shared, c: Option<&ModelChoice>) -> ApiResult<()> {
    match c {
        Some(c) => {
            sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai.model', ?)")
                .bind(serde_json::to_string(c).unwrap())
                .execute(&state.db)
                .await?;
        }
        None => {
            sqlx::query("DELETE FROM settings WHERE key = 'ai.model'").execute(&state.db).await?;
        }
    }
    Ok(())
}

/// Called at boot: resume whatever model was chosen.
pub async fn boot(state: Shared) {
    if state.cfg.llama_url.is_some() {
        state.ai.set(|s| s.state = "external".into()).await;
        return;
    }
    match load_choice(&state).await {
        Some(c) => activate(state, c),
        None => state.ai.set(|s| s.state = "none".into()).await,
    }
}

/// Start (or switch to) a model in the background: resolve → download → run.
pub fn activate(state: Shared, choice: ModelChoice) {
    let gen = state.ai.generation.fetch_add(1, Ordering::SeqCst) + 1;
    tokio::spawn(async move {
        if let Err(e) = run(state.clone(), choice, gen).await {
            if state.ai.generation.load(Ordering::SeqCst) == gen {
                tracing::warn!("AI model: {e:#}");
                state.ai.set(|s| {
                    s.state = "error".into();
                    s.error = Some(format!("{e:#}"));
                }).await;
            }
        }
    });
}

async fn run(state: Shared, c: ModelChoice, gen: u64) -> anyhow::Result<()> {
    let ai = &state.ai;
    let current = || ai.generation.load(Ordering::SeqCst) == gen;
    ai.stop_child().await;
    ai.downloaded.store(0, Ordering::Relaxed);
    ai.set(|s| {
        *s = AiStatus { state: "resolving".into(), repo: Some(c.repo.clone()), quant: Some(c.quant.clone()), ctx: c.ctx, ..Default::default() };
    })
    .await;

    let dir = models_dir(&state).join(c.repo.replace('/', "__"));
    tokio::fs::create_dir_all(&dir).await?;

    // Resolve files: use the cached manifest if present (works offline), else ask Hugging Face.
    let manifest = dir.join(format!("{}.json", c.quant));
    let opt: QuantOption = match tokio::fs::read_to_string(&manifest).await.ok().and_then(|s| serde_json::from_str::<(Vec<String>, u64)>(&s).ok()) {
        Some((files, size)) => QuantOption { quant: c.quant.clone(), files, size },
        None => {
            let quants = list_quants(&c.repo).await?;
            let q = quants
                .into_iter()
                .find(|q| q.quant.eq_ignore_ascii_case(&c.quant))
                .ok_or_else(|| anyhow::anyhow!("quantization {} not found in {}", c.quant, c.repo))?;
            tokio::fs::write(&manifest, serde_json::to_string(&(&q.files, q.size))?).await?;
            q
        }
    };
    if !current() {
        return Ok(());
    }
    ai.set(|s| {
        s.files = opt.files.clone();
        s.total_bytes = opt.size;
        s.state = "downloading".into();
    })
    .await;

    // Download any missing parts (resumable).
    let mut done_before: u64 = 0;
    for f in &opt.files {
        let local = dir.join(f.rsplit('/').next().unwrap_or(f));
        if let Ok(m) = tokio::fs::metadata(&local).await {
            done_before += m.len();
            ai.downloaded.store(done_before, Ordering::Relaxed);
            continue;
        }
        let part = local.with_extension("gguf.part");
        let mut have = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
        let url = format!("{}/{}/resolve/main/{}", hf_endpoint(), c.repo, f);
        let mut req = http().get(&url);
        if have > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let res = req.send().await?;
        if res.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            have = 0;
        }
        let res = res.error_for_status()?;
        if res.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            have = 0; // server ignored the range; start over
        }
        let mut out = tokio::fs::OpenOptions::new().create(true).write(true).append(have > 0).truncate(have == 0).open(&part).await?;
        let mut stream = res.bytes_stream();
        let mut got = have;
        while let Some(chunk) = stream.next().await {
            if !current() {
                return Ok(()); // a different model was chosen; keep the .part for later
            }
            let chunk = chunk?;
            out.write_all(&chunk).await?;
            got += chunk.len() as u64;
            ai.downloaded.store(done_before + got, Ordering::Relaxed);
        }
        out.flush().await?;
        drop(out);
        tokio::fs::rename(&part, &local).await?;
        done_before += got;
    }
    if !current() {
        return Ok(());
    }

    // Run llama-server, restarting it if it crashes.
    let first = dir.join(opt.files[0].rsplit('/').next().unwrap());
    let mut backoff = 2u64;
    loop {
        if !current() {
            return Ok(());
        }
        ai.set(|s| {
            s.state = "starting".into();
            s.error = None;
            s.downloaded_bytes = s.total_bytes;
        })
        .await;
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).to_string();
        let bin = llama_bin();
        if !bin.exists() {
            anyhow::bail!("llama-server binary not found at {}", bin.display());
        }
        let mut cmd = tokio::process::Command::new(&bin);
        cmd.arg("-m").arg(&first)
            .args(["-c", &c.ctx.to_string(), "--host", "127.0.0.1", "--port", &LLAMA_PORT.to_string(), "-t", &threads, "--jinja"])
            .env_remove("LLAMA_ARG_HOST")
            .env_remove("LLAMA_ARG_PORT")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if let Some(dir) = bin.parent() {
            cmd.env("LD_LIBRARY_PATH", dir);
        }
        let mut child = cmd.spawn()?;
        for pipe in [child.stdout.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|p| Box::new(p) as _)].into_iter().flatten() {
            let st = state.clone();
            tokio::spawn(async move {
                use tokio::io::AsyncBufReadExt;
                let mut lines = tokio::io::BufReader::new(pipe).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    st.ai.push_log(l).await;
                }
            });
        }
        *ai.child.lock().await = Some(child);

        // wait for health
        let started = std::time::Instant::now();
        let client = reqwest::Client::new();
        let health = format!("http://127.0.0.1:{LLAMA_PORT}/health");
        let mut healthy = false;
        while started.elapsed() < Duration::from_secs(900) && current() {
            if let Some(ch) = ai.child.lock().await.as_mut() {
                if let Ok(Some(_)) = ch.try_wait() {
                    break; // exited
                }
            }
            if let Ok(r) = client.get(&health).timeout(Duration::from_secs(3)).send().await {
                if r.status().is_success() {
                    healthy = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
        if !current() {
            ai.stop_child().await;
            return Ok(());
        }
        if healthy {
            backoff = 2;
            ai.set(|s| s.state = "ready".into()).await;
            tracing::info!("AI model ready: {} {}", c.repo, c.quant);
            // supervise until it exits or the model changes
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                if !current() {
                    return Ok(());
                }
                let exited = match ai.child.lock().await.as_mut() {
                    Some(ch) => matches!(ch.try_wait(), Ok(Some(_))),
                    None => true,
                };
                if exited {
                    break;
                }
            }
        }
        let tail: Vec<String> = ai.log.lock().await.iter().rev().take(3).cloned().collect::<Vec<_>>().into_iter().rev().collect();
        ai.stop_child().await;
        ai.set(|s| {
            s.state = "error".into();
            s.error = Some(format!("llama-server stopped; restarting. {}", tail.join(" | ")));
        })
        .await;
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(60);
    }
}

// ---------- HTTP API (instance admins) ----------

fn sys_info(state: &Shared) -> Value {
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    let ram_gb = std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|m| m.lines().find(|l| l.starts_with("MemTotal:")).and_then(|l| l.split_whitespace().nth(1)?.parse::<f64>().ok()))
        .map(|kb| (kb / 1048576.0 * 10.0).round() / 10.0);
    let disk_free_gb = disk_free(&state.cfg.data_dir).map(|b| (b as f64 / 1e9 * 10.0).round() / 10.0);
    json!({ "cpus": cpus, "ram_gb": ram_gb, "disk_free_gb": disk_free_gb, "llama_bundled": llama_bin().exists() })
}

fn disk_free(path: &Path) -> Option<u64> {
    let out = std::process::Command::new("df").arg("-B1").arg("--output=avail").arg(path).output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().nth(1)?.trim().parse().ok()
}

pub async fn get_status(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    let catalog: Vec<Value> = CATALOG
        .iter()
        .map(|c| json!({ "repo": c.repo, "quant": c.quant, "name": c.name, "size_gb": c.size_gb, "note": c.note }))
        .collect();
    let log: Vec<String> = state.ai.log.lock().await.iter().rev().take(40).cloned().collect::<Vec<_>>().into_iter().rev().collect();
    Ok(Json(json!({
        "status": state.ai.snapshot().await,
        "catalog": catalog,
        "system": sys_info(&state),
        "external_url": state.cfg.llama_url,
        "log": log,
    })))
}

#[derive(Deserialize)]
pub struct QuantsQ {
    pub repo: String,
}

pub async fn get_quants(State(_state): State<Shared>, auth: AuthUser, axum::extract::Query(q): axum::extract::Query<QuantsQ>) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    let repo = q.repo.trim().trim_start_matches("https://huggingface.co/").trim_end_matches('/').to_string();
    let quants = list_quants(&repo).await.map_err(|e| AppError::bad(e.to_string()))?;
    if quants.is_empty() {
        return Err(AppError::bad("no GGUF files in that repo"));
    }
    Ok(Json(json!({ "repo": repo, "quants": quants })))
}

#[derive(Deserialize)]
pub struct SetModel {
    pub repo: String,
    pub quant: String,
    pub ctx: Option<i64>,
}

pub async fn set_model(State(state): State<Shared>, auth: AuthUser, Json(req): Json<SetModel>) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    if state.cfg.llama_url.is_some() {
        return Err(AppError::bad("this server uses an external llama server (LLAMBLE_LLAMA_URL); remove it to manage models here"));
    }
    let repo = req.repo.trim().trim_start_matches("https://huggingface.co/").trim_end_matches('/').to_string();
    if !valid_repo(&repo) {
        return Err(AppError::bad("repo must look like owner/name"));
    }
    let choice = ModelChoice { repo, quant: req.quant.trim().to_uppercase(), ctx: req.ctx.unwrap_or(8192).clamp(1024, 131072) };
    save_choice(&state, Some(&choice)).await?;
    activate(state.clone(), choice);
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct DisableQ {
    #[serde(default)]
    pub delete_files: bool,
}

pub async fn disable(State(state): State<Shared>, auth: AuthUser, axum::extract::Query(q): axum::extract::Query<DisableQ>) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    state.ai.generation.fetch_add(1, Ordering::SeqCst);
    state.ai.stop_child().await;
    save_choice(&state, None).await?;
    state.ai.set(|s| *s = AiStatus { state: "none".into(), ..Default::default() }).await;
    if q.delete_files {
        let _ = tokio::fs::remove_dir_all(models_dir(&state)).await;
    }
    Ok(Json(json!({ "ok": true })))
}


// ---------- models stored on the server ----------

/// Every model on disk, grouped by repo + quantization, with what's complete and what's in use.
pub async fn list_models(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    let active = load_choice(&state).await;
    let mut out = vec![];
    let root = models_dir(&state);
    let mut repos = match tokio::fs::read_dir(&root).await {
        Ok(r) => r,
        Err(_) => return Ok(Json(json!({ "models": [], "total_bytes": 0 }))),
    };
    let mut total: u64 = 0;
    while let Ok(Some(d)) = repos.next_entry().await {
        if !d.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let repo = d.file_name().to_string_lossy().replacen("__", "/", 1);
        // all files in this repo folder and their sizes
        let mut files: std::collections::HashMap<String, u64> = Default::default();
        if let Ok(mut rd) = tokio::fs::read_dir(d.path()).await {
            while let Ok(Some(f)) = rd.next_entry().await {
                if let Ok(m) = f.metadata().await {
                    if m.is_file() {
                        files.insert(f.file_name().to_string_lossy().to_string(), m.len());
                    }
                }
            }
        }
        let mut claimed: std::collections::HashSet<String> = Default::default();
        for (name, _) in files.clone() {
            let Some(quant) = name.strip_suffix(".json") else { continue };
            let Ok(txt) = tokio::fs::read_to_string(d.path().join(&name)).await else { continue };
            let Ok((parts, size)) = serde_json::from_str::<(Vec<String>, u64)>(&txt) else { continue };
            claimed.insert(name.clone());
            let mut on_disk = 0;
            let mut complete = true;
            for p in &parts {
                let base = p.rsplit('/').next().unwrap_or(p).to_string();
                let partial = format!("{}.part", base.trim_end_matches(".gguf").to_string() + ".gguf");
                if let Some(n) = files.get(&base) {
                    on_disk += n;
                    claimed.insert(base);
                } else {
                    complete = false;
                    if let Some(n) = files.get(&partial) {
                        on_disk += n;
                        claimed.insert(partial);
                    }
                }
            }
            total += on_disk;
            let is_active = active.as_ref().map(|a| a.repo == repo && a.quant.eq_ignore_ascii_case(quant)).unwrap_or(false);
            out.push(json!({
                "repo": repo, "quant": quant, "size": size, "on_disk": on_disk,
                "complete": complete, "active": is_active,
            }));
        }
        // anything else in the folder (old or unknown files) still uses disk: show it
        let other: u64 = files.iter().filter(|(n, _)| !claimed.contains(*n)).map(|(_, s)| s).sum();
        if other > 0 {
            total += other;
            out.push(json!({ "repo": repo, "quant": null, "size": other, "on_disk": other, "complete": false, "active": false, "other": true }));
        }
    }
    out.sort_by(|a, b| b["active"].as_bool().cmp(&a["active"].as_bool()).then(a["repo"].as_str().cmp(&b["repo"].as_str())));
    Ok(Json(json!({ "models": out, "total_bytes": total })))
}

#[derive(Deserialize)]
pub struct DeleteModelQ {
    pub repo: String,
    /// omit to delete the whole repo folder (including unknown files)
    pub quant: Option<String>,
}

pub async fn delete_model(State(state): State<Shared>, auth: AuthUser, axum::extract::Query(q): axum::extract::Query<DeleteModelQ>) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    if q.repo.contains("..") || q.repo.starts_with('/') || q.quant.as_deref().map(|x| x.contains('/') || x.contains("..")).unwrap_or(false) {
        return Err(AppError::bad("bad model name"));
    }
    let active = load_choice(&state).await;
    let hits_active = active.as_ref().map(|a| a.repo == q.repo && q.quant.as_deref().map(|x| a.quant.eq_ignore_ascii_case(x)).unwrap_or(true)).unwrap_or(false);
    if hits_active {
        return Err(AppError::bad("that model is in use: choose a different one (or turn the server model off) first"));
    }
    let dir = models_dir(&state).join(q.repo.replace('/', "__"));
    match &q.quant {
        None => {
            let _ = tokio::fs::remove_dir_all(&dir).await;
        }
        Some(quant) => {
            let manifest = dir.join(format!("{quant}.json"));
            if let Ok(txt) = tokio::fs::read_to_string(&manifest).await {
                if let Ok((parts, _)) = serde_json::from_str::<(Vec<String>, u64)>(&txt) {
                    for p in parts {
                        let base = p.rsplit('/').next().unwrap_or(&p).to_string();
                        let _ = tokio::fs::remove_file(dir.join(&base)).await;
                        let _ = tokio::fs::remove_file(dir.join(base.trim_end_matches(".gguf").to_string() + ".gguf.part")).await;
                    }
                }
            }
            let _ = tokio::fs::remove_file(&manifest).await;
            // drop the folder if nothing is left
            if let Ok(mut rd) = tokio::fs::read_dir(&dir).await {
                if rd.next_entry().await.ok().flatten().is_none() {
                    let _ = tokio::fs::remove_dir(&dir).await;
                }
            }
        }
    }
    Ok(Json(json!({ "ok": true })))
}
