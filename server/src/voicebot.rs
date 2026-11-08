//! Talking with Llamble in voice channels.
//!
//! Where a server owner turns it on, each person's app sends the bits of audio where they
//! spoke (not silence) to this server. They're turned into text right here on the NAS
//! (Whisper, via sherpa-onnx), never stored for adults: the last ~10 back-and-forths of each
//! call are kept in memory only, so Llamble has context, and older lines are dropped as new
//! ones come in. Calls that a kid is in are saved as text for their parents.
//!
//! "Hey Llamble, …" asks a question. The answer comes from the same model as chat (a lent
//! GPU or the server's own), is spoken with Kokoro (a natural-sounding voice that runs on the
//! NAS CPU), and every app in the call plays it.
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::models::{get_user, load_channel, Channel};
use crate::state::{AuthUser, Shared};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::Json;
use dashmap::DashMap;
use futures::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, RwLock, Semaphore};

// ---------------------------------------------------------------- settings

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct VoiceAiSettings {
    pub enabled: bool,
    /// speech recognition model: whisper-tiny.en | whisper-base.en | whisper-small.en
    pub stt: String,
    /// Kokoro voice number (see VOICES)
    pub voice: i64,
    pub speed: f64,
    /// shown to people the first time they join a server where Llamble listens
    pub notice: String,
    /// what wakes it; {name} is the bot's name ("haro {name}" works too)
    pub wake_phrases: Vec<String>,
    /// after answering, keep listening to the same person this long (0 = off)
    pub follow_up_secs: i64,
}

pub fn default_wake() -> Vec<String> {
    ["hey {name}", "hi {name}", "okay {name}", "yo {name}", "hello {name}", "{name}"].iter().map(|s| s.to_string()).collect()
}

pub const DEFAULT_NOTICE: &str = "Llamble listens in this server's voice channels so you can say \"Hey Llamble\" and ask it things out loud. What's said is turned into text on this server only to answer you; it keeps just the last few minutes in memory and nothing is saved, except that calls with kids in them are saved as text for their parents.";

impl Default for VoiceAiSettings {
    fn default() -> Self {
        VoiceAiSettings { enabled: false, stt: "whisper-base.en".into(), voice: 6, speed: 1.0, notice: DEFAULT_NOTICE.into(), wake_phrases: default_wake(), follow_up_secs: 20 }
    }
}

pub const STT_MODELS: &[(&str, &str, &str)] = &[
    ("whisper-tiny.en", "Fastest (~100 MB)", "Quick on any NAS; mishears more"),
    ("whisper-base.en", "Balanced (~200 MB)", "Good accuracy, fast on a modern NAS CPU"),
    ("whisper-small.en", "Most accurate (~600 MB)", "Best results; needs a strong CPU"),
];

/// Kokoro v0.19 English voices, in model order.
pub const VOICES: &[(&str, &str)] = &[
    ("af", "Default (American, female)"),
    ("af_bella", "Bella (American, female)"),
    ("af_nicole", "Nicole (American, female, soft)"),
    ("af_sarah", "Sarah (American, female)"),
    ("af_sky", "Sky (American, female)"),
    ("am_adam", "Adam (American, male)"),
    ("am_michael", "Michael (American, male)"),
    ("bf_emma", "Emma (British, female)"),
    ("bf_isabella", "Isabella (British, female)"),
    ("bm_george", "George (British, male)"),
    ("bm_lewis", "Lewis (British, male)"),
];

pub async fn load_settings(state: &Shared) -> VoiceAiSettings {
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'voice_ai'").fetch_optional(&state.db).await.ok().flatten();
    v.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

async fn save_settings(state: &Shared, s: &VoiceAiSettings) -> ApiResult<()> {
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('voice_ai', ?)").bind(serde_json::to_string(s).unwrap()).execute(&state.db).await?;
    Ok(())
}

pub async fn migrate(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    sqlx::raw_sql(
        r#"
CREATE TABLE IF NOT EXISTS call_transcripts (
    id TEXT PRIMARY KEY,
    kid_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    speaker_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS call_transcripts_kid ON call_transcripts(kid_id, created_at);
"#,
    )
    .execute(pool)
    .await?;
    let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('bot_settings')").fetch_all(pool).await?;
    if !cols.iter().any(|c| c == "voice_listen") {
        sqlx::query("ALTER TABLE bot_settings ADD COLUMN voice_listen INTEGER NOT NULL DEFAULT 0").execute(pool).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------- models on disk

fn sherpa_dir() -> PathBuf {
    PathBuf::from(std::env::var("LLAMBLE_SHERPA_DIR").unwrap_or_else(|_| "/opt/sherpa".into()))
}
fn stt_bin() -> PathBuf {
    std::env::var("LLAMBLE_STT_BIN").map(PathBuf::from).unwrap_or_else(|_| sherpa_dir().join("bin/sherpa-onnx-offline"))
}
fn tts_bin() -> PathBuf {
    std::env::var("LLAMBLE_TTS_BIN").map(PathBuf::from).unwrap_or_else(|_| sherpa_dir().join("bin/sherpa-onnx-offline-tts"))
}
fn models_base() -> String {
    std::env::var("LLAMBLE_VOICE_MODELS_URL").unwrap_or_else(|_| "https://github.com/k2-fsa/sherpa-onnx/releases/download".into()).trim_end_matches('/').to_string()
}
fn voice_dir(state: &Shared) -> PathBuf {
    state.cfg.data_dir.join("voice")
}
const TTS_MODEL: &str = "kokoro-int8-en-v0_19";

fn stt_name(model: &str) -> &str {
    model.strip_prefix("whisper-").unwrap_or("base.en")
}
fn stt_folder(state: &Shared, model: &str) -> PathBuf {
    voice_dir(state).join(format!("sherpa-onnx-whisper-{}", stt_name(model)))
}
fn stt_ready(state: &Shared, model: &str) -> bool {
    let n = stt_name(model);
    stt_folder(state, model).join(format!("{n}-encoder.int8.onnx")).exists()
}
fn tts_folder(state: &Shared) -> PathBuf {
    voice_dir(state).join(TTS_MODEL)
}
fn tts_ready(state: &Shared) -> bool {
    tts_folder(state).join("model.int8.onnx").exists()
}

#[derive(Serialize, Clone, Default)]
pub struct Status {
    /// idle | downloading | ready | error
    pub stt: String,
    pub tts: String,
    pub downloading: Option<String>,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
}

static STATUS: Lazy<RwLock<Status>> = Lazy::new(|| RwLock::new(Status::default()));

/// What's been happening (counts only — never what was said), for the admin page.
#[derive(Serialize, Clone, Default)]
pub struct Activity {
    pub received: u64,
    pub recognized: u64,
    pub wakes: u64,
    pub answers: u64,
    pub last_at: Option<i64>,
    pub last_error: Option<String>,
}
static ACTIVITY: Lazy<std::sync::Mutex<Activity>> = Lazy::new(Default::default);
fn act(f: impl FnOnce(&mut Activity)) {
    if let Ok(mut a) = ACTIVITY.lock() {
        f(&mut a);
    }
}
static DOWNLOAD: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static DONE: AtomicU64 = AtomicU64::new(0);

async fn refresh_status(state: &Shared) {
    let s = load_settings(state).await;
    let mut st = STATUS.write().await;
    if st.downloading.is_none() {
        st.stt = if stt_ready(state, &s.stt) { "ready" } else { "idle" }.into();
        st.tts = if tts_ready(state) { "ready" } else { "idle" }.into();
    }
}

/// Download whatever's missing for the current settings (in the background).
pub fn ensure_models(state: Shared) {
    tokio::spawn(async move {
        let _g = DOWNLOAD.lock().await;
        let s = load_settings(&state).await;
        if !s.enabled {
            refresh_status(&state).await;
            return;
        }
        let jobs = [
            (!stt_ready(&state, &s.stt)).then(|| format!("asr-models/sherpa-onnx-whisper-{}.tar.bz2", stt_name(&s.stt))),
            (!tts_ready(&state)).then(|| format!("tts-models/{TTS_MODEL}.tar.bz2")),
        ];
        for job in jobs.into_iter().flatten() {
            // GitHub's download servers sometimes answer 502/503/504 for a while: try a few times
            let mut result = fetch_and_unpack(&state, &job).await;
            for wait in [5u64, 20, 60, 180] {
                match &result {
                    Err(e) if transient(e) => {
                        tracing::info!("voice model download hiccup ({e:#}); retrying in {wait}s");
                        tokio::time::sleep(Duration::from_secs(wait)).await;
                        result = fetch_and_unpack(&state, &job).await;
                    }
                    _ => break,
                }
            }
            if let Err(e) = result {
                tracing::warn!("voice model download failed: {e:#}");
                let mut st = STATUS.write().await;
                st.downloading = None;
                st.error = Some(format!("couldn't download {job}: {e:#}"));
                return;
            }
        }
        {
            let mut st = STATUS.write().await;
            st.downloading = None;
            st.error = None;
        }
        refresh_status(&state).await;
        crate::voicebot::announce_config(&state).await;
    });
}

/** Worth trying again: server-side 5xx, 429, timeouts and dropped connections. */
fn transient(e: &anyhow::Error) -> bool {
    match e.downcast_ref::<reqwest::Error>() {
        Some(r) => r.is_timeout() || r.is_connect() || r.is_body() || r.is_request() || r.status().is_some_and(|s| s.is_server_error() || s.as_u16() == 429),
        None => false,
    }
}

async fn fetch_and_unpack(state: &Shared, job: &str) -> anyhow::Result<()> {
    let dir = voice_dir(state);
    tokio::fs::create_dir_all(&dir).await?;
    let url = format!("{}/{}", models_base(), job);
    let file = dir.join(job.rsplit('/').next().unwrap());
    {
        let mut st = STATUS.write().await;
        st.downloading = Some(job.rsplit('/').next().unwrap().trim_end_matches(".tar.bz2").to_string());
        st.done_bytes = 0;
        st.total_bytes = 0;
        st.error = None;
        if job.starts_with("asr") {
            st.stt = "downloading".into();
        } else {
            st.tts = "downloading".into();
        }
    }
    let res = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build()?.get(&url).send().await?.error_for_status()?;
    STATUS.write().await.total_bytes = res.content_length().unwrap_or(0);
    DONE.store(0, Ordering::Relaxed);
    let mut out = tokio::fs::File::create(&file).await?;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        out.write_all(&chunk).await?;
        DONE.fetch_add(chunk.len() as u64, Ordering::Relaxed);
    }
    out.flush().await?;
    drop(out);
    let st = tokio::process::Command::new("tar").arg("xjf").arg(&file).arg("-C").arg(&dir).status().await?;
    let _ = tokio::fs::remove_file(&file).await;
    if !st.success() {
        anyhow::bail!("unpacking failed");
    }
    // the fp32 Whisper weights are big and unused (we run the int8 ones)
    if job.starts_with("asr") {
        if let Ok(mut rd) = tokio::fs::read_dir(dir.join(job.rsplit('/').next().unwrap().trim_end_matches(".tar.bz2"))).await {
            while let Ok(Some(e)) = rd.next_entry().await {
                let n = e.file_name().to_string_lossy().to_string();
                if n.ends_with(".onnx") && !n.contains(".int8.") {
                    let _ = tokio::fs::remove_file(e.path()).await;
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- speech → text, text → speech

static STT_SLOTS: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(2));
static TTS_SLOT: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(1));

fn threads() -> String {
    std::thread::available_parallelism().map(|n| (n.get() / 2).clamp(1, 8)).unwrap_or(2).to_string()
}

/// 16 kHz mono 16-bit PCM → WAV bytes
fn wav(pcm: &[u8], rate: u32) -> Vec<u8> {
    let mut w = Vec::with_capacity(44 + pcm.len());
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&rate.to_le_bytes());
    w.extend_from_slice(&(rate * 2).to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    w.extend_from_slice(pcm);
    w
}

async fn transcribe(state: &Shared, model: &str, pcm: &[u8]) -> anyhow::Result<String> {
    let _slot = STT_SLOTS.acquire().await?;
    let tmp = std::env::temp_dir().join(format!("llamble-utt-{}.wav", new_id()));
    tokio::fs::write(&tmp, wav(pcm, 16000)).await?;
    let n = stt_name(model);
    let d = stt_folder(state, model);
    let out = tokio::time::timeout(
        Duration::from_secs(60),
        tokio::process::Command::new(stt_bin())
            .arg(format!("--whisper-encoder={}", d.join(format!("{n}-encoder.int8.onnx")).display()))
            .arg(format!("--whisper-decoder={}", d.join(format!("{n}-decoder.int8.onnx")).display()))
            .arg(format!("--tokens={}", d.join(format!("{n}-tokens.txt")).display()))
            .arg("--whisper-language=en")
            .arg(format!("--num-threads={}", threads()))
            .arg(&tmp)
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let _ = tokio::fs::remove_file(&tmp).await;
    let out = out.map_err(|_| anyhow::anyhow!("speech recognition took too long"))??;
    // sherpa prints a JSON line per file (to stderr or stdout depending on version)
    let all = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    for line in all.lines() {
        let l = line.trim();
        if l.starts_with('{') && l.contains("\"text\"") {
            if let Ok(v) = serde_json::from_str::<Value>(l) {
                return Ok(v["text"].as_str().unwrap_or("").trim().to_string());
            }
        }
    }
    if !out.status.success() {
        anyhow::bail!("speech recognition failed: {}", all.lines().rev().take(3).collect::<Vec<_>>().join(" | "));
    }
    Ok(String::new())
}

/// Text → WAV with the chosen Kokoro voice.
pub async fn speak(state: &Shared, text: &str, voice: i64, speed: f64) -> anyhow::Result<Vec<u8>> {
    if !tts_ready(state) {
        anyhow::bail!("the voice isn't downloaded yet");
    }
    let _slot = TTS_SLOT.acquire().await?;
    let d = tts_folder(state);
    let tmp = std::env::temp_dir().join(format!("llamble-say-{}.wav", new_id()));
    let out = tokio::time::timeout(
        Duration::from_secs(120),
        tokio::process::Command::new(tts_bin())
            .arg(format!("--kokoro-model={}", d.join("model.int8.onnx").display()))
            .arg(format!("--kokoro-voices={}", d.join("voices.bin").display()))
            .arg(format!("--kokoro-tokens={}", d.join("tokens.txt").display()))
            .arg(format!("--kokoro-data-dir={}", d.join("espeak-ng-data").display()))
            .arg(format!("--num-threads={}", threads()))
            .arg(format!("--sid={}", voice.clamp(0, VOICES.len() as i64 - 1)))
            .arg(format!("--kokoro-length-scale={}", (1.0 / speed.clamp(0.5, 2.0))))
            .arg(format!("--output-filename={}", tmp.display()))
            .arg(text)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| anyhow::anyhow!("speaking took too long"))??;
    let bytes = tokio::fs::read(&tmp).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    match bytes {
        Ok(b) if b.len() > 44 => Ok(b),
        _ => anyhow::bail!("couldn't make speech: {}", String::from_utf8_lossy(&out.stderr).lines().rev().take(3).collect::<Vec<_>>().join(" | ")),
    }
}

// ---------------------------------------------------------------- per-call memory

struct Line {
    at: i64,
    who: String,
    text: String,
}

/// Recent lines per voice channel. Memory only, never written anywhere.
static CONTEXT: Lazy<DashMap<String, VecDeque<Line>>> = Lazy::new(Default::default);
/// finished answers, fetched by the apps in the call (kept a few minutes)
static AUDIO: Lazy<DashMap<String, (Vec<u8>, i64)>> = Lazy::new(Default::default);
static ANSWER_LOCKS: Lazy<DashMap<String, std::sync::Arc<Mutex<()>>>> = Lazy::new(Default::default);
/// Conversation mode: after answering, Llamble keeps listening to the person who called it
/// (no wake word needed) until they go quiet for a while. channel → (user, until ms)
static CONVO: Lazy<DashMap<String, (String, i64, bool)>> = Lazy::new(Default::default);
/// when Llamble's own voice is playing (so its words picked up by a mic aren't taken as a question)
static SPEAKING: Lazy<DashMap<String, (i64, String)>> = Lazy::new(Default::default);

const KEEP_LINES: usize = 20; // ~10 back-and-forths
const KEEP_MS: i64 = 15 * 60 * 1000;

fn remember(channel: &str, who: &str, text: &str) {
    let mut q = CONTEXT.entry(channel.to_string()).or_default();
    let now = now_ms();
    q.push_back(Line { at: now, who: who.to_string(), text: text.to_string() });
    while q.len() > KEEP_LINES || q.front().map(|l| now - l.at > KEEP_MS).unwrap_or(false) {
        q.pop_front();
    }
}

/// Forget a call when it empties out.
pub fn forget_channel(channel: &str) {
    CONTEXT.remove(channel);
}

// ---------------------------------------------------------------- wake word

fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + if a[i - 1] == b[j - 1] { 0 } else { 1 });
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Does this word sound like the bot's name? Whisper writes "Llamble" many ways
/// (Lamble, Lambo, Gamble, Llama bull…).
fn sounds_like(word: &str, name: &str) -> bool {
    let w = word.to_lowercase();
    let n = name.to_lowercase();
    if w == n {
        return true;
    }
    let max = if n.len() >= 6 { 2 } else { 1 };
    if edit_distance(&w, &n) <= max {
        return true;
    }
    if n == "llamble" {
        return ["lamble", "lambo", "lambeau", "lambl", "gamble", "rambl", "ramble", "lumble", "lemble", "bramble", "lamb", "llama", "lamba", "lamby", "lambie"].iter().any(|v| w.starts_with(v));
    }
    false
}

/// If the text calls the bot with one of the wake phrases, return what was asked (possibly empty).
/// Each phrase is words plus `{name}` (the bot's name, matched loosely because speech
/// recognition spells it many ways). Other words allow one slip ("haro" ≈ "harro").
pub fn wake(text: &str, name: &str, phrases: &[String]) -> Option<String> {
    let words: Vec<(usize, &str)> = text
        .split_whitespace()
        .scan(0usize, |pos, w| {
            let start = text[*pos..].find(w).map(|i| i + *pos).unwrap_or(*pos);
            *pos = start + w.len();
            Some((start, w))
        })
        .collect();
    let clean = |w: &str| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
    let lname = name.to_lowercase();
    // how many words starting at j are the bot's name (0 = not the name)
    let name_at = |j: usize| -> usize {
        let Some(w) = words.get(j) else { return 0 };
        let first = clean(w.1);
        if edit_distance(&first, &lname) <= 1 {
            return 1;
        }
        if let Some(w2) = words.get(j + 1) {
            let two = format!("{}{}", first, clean(w2.1));
            if two.len() <= lname.len() + 3 && edit_distance(&two, &lname) <= 3 {
                return 2;
            }
        }
        if sounds_like(&first, name) { 1 } else { 0 }
    };
    let word_ok = |want: &str, got: &str| want == got || (want.len() >= 4 && edit_distance(want, got) <= 1);
    let list: Vec<String> = if phrases.is_empty() { default_wake() } else { phrases.to_vec() };
    // longer phrases first, so "hey {name}" wins over "{name}"
    let mut list: Vec<Vec<String>> = list.iter().map(|p| p.split_whitespace().map(|t| t.to_lowercase()).collect()).filter(|v: &Vec<String>| !v.is_empty()).collect();
    list.sort_by_key(|p| std::cmp::Reverse(p.len()));
    // the phrase may come after a word or two of lead-in ("um, hey llamble")
    for start in 0..3.min(words.len()) {
        'phrase: for p in &list {
            let mut j = start;
            for tok in p {
                if tok == "{name}" {
                    let n = name_at(j);
                    if n == 0 {
                        continue 'phrase;
                    }
                    j += n;
                } else {
                    match words.get(j) {
                        Some(w) if word_ok(tok, &clean(w.1)) => j += 1,
                        _ => continue 'phrase,
                    }
                }
            }
            // a bare-name phrase only counts at the very start ("I told Llamble…" isn't a call)
            if p.len() == 1 && start > 0 {
                continue;
            }
            let rest = words.get(j).map(|(pos, _)| &text[*pos..]).unwrap_or("");
            return Some(rest.trim().trim_start_matches(|c: char| c == ',' || c == '.' || c == '!').trim().to_string());
        }
    }
    None
}

// ---------------------------------------------------------------- who's listening

pub async fn guild_listens(state: &Shared, gid: &str) -> bool {
    let v: Option<(bool, bool)> = sqlx::query_as("SELECT enabled, voice_listen FROM bot_settings WHERE guild_id = ?").bind(gid).fetch_optional(&state.db).await.ok().flatten();
    matches!(v, Some((true, true)))
}

/// What apps need to know (sent in READY and whenever it changes).
pub async fn config_json(state: &Shared) -> Value {
    let s = load_settings(state).await;
    let available = s.enabled && stt_ready(state, &s.stt);
    let guilds: Vec<String> = if available {
        sqlx::query_scalar("SELECT guild_id FROM bot_settings WHERE enabled = 1 AND voice_listen = 1").fetch_all(&state.db).await.unwrap_or_default()
    } else {
        vec![]
    };
    json!({ "available": available, "notice": s.notice, "guilds": guilds })
}

pub async fn announce_config(state: &Shared) {
    let v = config_json(state).await;
    state.hub.send_users(&state.hub.online_users(), "CONFIG_UPDATE", &json!({ "voice_ai": v }));
}

// ---------------------------------------------------------------- the API

/// One stretch of someone talking: 16 kHz mono 16-bit little-endian PCM.
pub async fn utterance(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, headers: axum::http::HeaderMap, body: Bytes) -> ApiResult<Json<Value>> {
    crate::bot::note_tz(&auth.id, &headers);
    let ch = load_channel(&state.db, &cid).await?;
    let in_call = state.hub.voice.get(&auth.id).map(|v| v.channel_id == cid).unwrap_or(false);
    if !in_call {
        return Err(AppError::bad("not in this call"));
    }
    let gid = ch.guild_id.clone().ok_or_else(|| AppError::bad("Llamble only listens in server voice channels"))?;
    let s = load_settings(&state).await;
    if !s.enabled || !stt_ready(&state, &s.stt) || !guild_listens(&state, &gid).await {
        return Err(AppError::bad("Llamble isn't listening here"));
    }
    if body.len() < 16000 / 2 || body.len() > 16000 * 2 * 30 {
        return Ok(Json(json!({ "ok": true, "skipped": true }))); // under ¼ s or over 30 s
    }
    act(|a| {
        a.received += 1;
        a.last_at = Some(now_ms());
    });
    let st = state.clone();
    let uid = auth.id.clone();
    tokio::spawn(async move {
        if let Err(e) = handle(st, ch, uid, s, body).await {
            tracing::warn!("voice: {e:#}");
            act(|a| a.last_error = Some(format!("{e:#}")));
        }
    });
    Ok(Json(json!({ "ok": true })))
}

/// Whisper's usual noises on silence/music — not speech.
fn junk(text: &str) -> bool {
    let t = text.trim().trim_matches(|c: char| c == '.' || c == '!' || c == ' ').to_lowercase();
    t.is_empty() || (text.trim().starts_with('[') && text.trim().ends_with(']')) || (text.trim().starts_with('(') && text.trim().ends_with(')')) || ["you", "thank you", "thanks for watching", "bye"].contains(&t.as_str())
}

async fn handle(state: Shared, ch: Channel, uid: String, s: VoiceAiSettings, pcm: Bytes) -> anyhow::Result<()> {
    let text = transcribe(&state, &s.stt, &pcm).await?;
    if junk(&text) {
        return Ok(());
    }
    act(|a| a.recognized += 1);
    let user = get_user(&state.db, &uid).await?;
    let name = display_name(&state, ch.guild_id.as_deref(), &user).await;
    remember(&ch.id, &name, &text);
    save_for_kids(&state, &ch, &uid, &text).await;

    let bot = state.s().bot_name.clone();
    let now = now_ms();
    // its own voice coming back through someone's speakers: not a question
    if let Some(sp) = SPEAKING.get(&ch.id) {
        if now < sp.0 && similar(&text, &sp.1) {
            return Ok(());
        }
    }
    let woke = wake(&text, &bot, &s.wake_phrases);
    // show the speaker (only them) what Llamble heard, so they can tell it's working
    state.hub.send_users(&[uid.clone()], "VOICE_HEARD", &json!({ "channel_id": ch.id, "text": text, "wake": woke.is_some() }));
    if woke.is_some() {
        act(|a| a.wakes += 1);
    }
    // (a "Yes?" window always counts; follow-up windows only while follow-ups are on)
    let in_convo = CONVO.get(&ch.id).map(|c| c.0 == uid && c.1 > now && (c.2 || s.follow_up_secs > 0)).unwrap_or(false);
    let question = match woke {
        Some(q) if q.chars().count() >= 3 => Some(q),
        Some(_) => {
            // just the name: their next sentence is the question
            start_convo(&state, &ch, &uid, now + 10_000, true);
            say(&state, &ch, &s, "Yes?", &uid).await;
            None
        }
        None if in_convo => {
            if done_talking(&text) {
                end_convo(&state, &ch);
                say(&state, &ch, &s, "Okay!", &uid).await;
                None
            } else {
                Some(text.clone())
            }
        }
        None => None,
    };
    if let Some(q) = question {
        answer(&state, &ch, &s, &uid, &name, &q).await?;
    }
    Ok(())
}

/// "thanks", "that's all", "never mind"… ends a conversation.
fn done_talking(t: &str) -> bool {
    let t = t.to_lowercase();
    let t = t.trim().trim_matches(|c: char| !c.is_alphanumeric());
    ["thanks", "thank you", "that's all", "thats all", "never mind", "nevermind", "stop", "that's it", "bye", "goodbye", "no thanks", "nothing"].iter().any(|p| t == *p || t.starts_with(&format!("{p} ")) || t.ends_with(&format!(" {p}")))
}

/// Rough "is this the same sentence" check (for echo).
fn similar(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    let (a, b) = (norm(a), norm(b));
    if a.len() < 6 {
        return b.contains(&a);
    }
    b.contains(&a) || a.contains(&b) || {
        let wa: std::collections::HashSet<&str> = a.split(' ').collect();
        let wb: std::collections::HashSet<&str> = b.split(' ').collect();
        wa.intersection(&wb).count() * 10 >= wa.len() * 7
    }
}

fn start_convo(state: &Shared, ch: &Channel, uid: &str, until: i64, asked_name_only: bool) {
    CONVO.insert(ch.id.clone(), (uid.to_string(), until, asked_name_only));
    state.hub.send_users(&listeners(state, &ch.id), "BOT_CONVERSATION", &json!({ "channel_id": ch.id, "user_id": uid, "until": until }));
}

fn end_convo(state: &Shared, ch: &Channel) {
    if CONVO.remove(&ch.id).is_some() {
        state.hub.send_users(&listeners(state, &ch.id), "BOT_CONVERSATION", &json!({ "channel_id": ch.id, "user_id": null }));
    }
}

async fn kids_in_call(state: &Shared, cid: &str) -> Vec<String> {
    let ids: Vec<String> = state.hub.voice.iter().filter(|v| v.channel_id == cid).map(|v| v.user_id.clone()).collect();
    let mut out = vec![];
    for id in ids {
        if crate::kids::is_kid(state, &id).await {
            out.push(id);
        }
    }
    out
}

async fn save_for_kids(state: &Shared, ch: &Channel, speaker: &str, text: &str) {
    for kid in kids_in_call(state, &ch.id).await {
        let _ = sqlx::query("INSERT INTO call_transcripts (id, kid_id, channel_id, speaker_id, text, created_at) VALUES (?,?,?,?,?,?)")
            .bind(new_id())
            .bind(&kid)
            .bind(&ch.id)
            .bind(speaker)
            .bind(text)
            .bind(now_ms())
            .execute(&state.db)
            .await;
    }
}

fn listeners(state: &Shared, cid: &str) -> Vec<String> {
    state.hub.voice.iter().filter(|v| v.channel_id == cid).map(|v| v.user_id.clone()).collect()
}

/// Strip markdown and emoji-ish bits so the voice reads it naturally.
fn speakable(t: &str) -> String {
    let re = regex::Regex::new(r"(```[\s\S]*?```|`|\*\*|\*|__|#+ |\[([^\]]+)\]\([^)]+\))").unwrap();
    let t = re.replace_all(t, |c: &regex::Captures| c.get(2).map(|m| m.as_str().to_string()).unwrap_or_default());
    t.chars().filter(|c| c.is_alphanumeric() || c.is_whitespace() || ".,!?'\"-:;()%$&/+".contains(*c)).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Speak to everyone in the call. Returns how long the speech lasts (ms).
async fn say(state: &Shared, ch: &Channel, s: &VoiceAiSettings, text: &str, asked_by: &str) -> i64 {
    let mut dur = (text.len() as i64) * 60; // reading time if there's no audio
    let audio = match speak(state, &speakable(text), s.voice, s.speed).await {
        Ok(w) => {
            dur = wav_ms(&w);
            SPEAKING.insert(ch.id.clone(), (now_ms() + dur + 1500, text.to_string()));
            let id = new_id();
            AUDIO.insert(id.clone(), (w, now_ms() + 5 * 60 * 1000));
            AUDIO.retain(|_, v| v.1 > now_ms());
            Some(format!("/api/voice-ai/audio/{id}"))
        }
        Err(e) => {
            tracing::info!("voice: speaking failed ({e:#}); sending text only");
            None
        }
    };
    state.hub.send_users(&listeners(state, &ch.id), "BOT_SPEAK", &json!({ "channel_id": ch.id, "text": text, "audio_url": audio, "asked_by": asked_by }));
    dur
}

/// Length of a 16-bit PCM WAV in ms.
fn wav_ms(w: &[u8]) -> i64 {
    if w.len() < 44 {
        return 0;
    }
    let rate = u32::from_le_bytes([w[24], w[25], w[26], w[27]]).max(1) as i64;
    let ch = u16::from_le_bytes([w[22], w[23]]).max(1) as i64;
    ((w.len() as i64 - 44) / 2 / ch) * 1000 / rate
}

async fn answer(state: &Shared, ch: &Channel, s: &VoiceAiSettings, uid: &str, name: &str, question: &str) -> anyhow::Result<()> {
    let lock = ANSWER_LOCKS.entry(ch.id.clone()).or_default().clone();
    let _g = lock.lock().await;
    state.hub.send_users(&listeners(state, &ch.id), "BOT_THINKING", &json!({ "channel_id": ch.id, "asked_by": uid, "question": question }));
    let bot = state.s().bot_name.clone();
    let custom = match &ch.guild_id {
        Some(g) => crate::bot::settings(state, g).await.system_prompt,
        None => String::new(),
    };
    let mut system = format!(
        "You are {bot}, talking out loud in a voice call on a private, self-hosted chat server. Your words are read aloud by a speech voice, \
         so answer the way a person would speak: short (one to three sentences unless they ask for more), warm, no lists, no markdown, no emoji, \
         no URLs. Numbers and symbols should be easy to say. The recent conversation in the call is given for context; people's names come first."
    );
    if !custom.trim().is_empty() {
        system.push_str("\n\n");
        system.push_str(custom.trim());
    }
    if !kids_in_call(state, &ch.id).await.is_empty() {
        system.push_str("\n\n");
        system.push_str(crate::kids::KID_SAFE_PROMPT);
    }
    let context: String = CONTEXT
        .get(&ch.id)
        .map(|q| q.iter().map(|l| format!("{}: {}", l.who, l.text)).collect::<Vec<_>>().join("\n"))
        .unwrap_or_default();
    let messages = vec![
        json!({ "role": "system", "content": system }),
        json!({ "role": "user", "content": format!("Recent conversation in the call:\n{context}\n\n{name} just asked you: {question}") }),
    ];
    let ctx = crate::tools::Ctx { tz: crate::bot::USER_TZ.get(uid).map(|t| t.clone()), kid: !kids_in_call(state, &ch.id).await.is_empty(), ..Default::default() };
    let reply = match crate::bot::complete(state, ch, &messages, &ctx).await {
        Ok(r) => r,
        Err(e) => format!("Sorry, I can't answer right now: {e}."),
    };
    act(|a| a.answers += 1);
    remember(&ch.id, &bot, &reply);
    save_for_kids(state, ch, &state.bot_id, &reply).await;
    let dur = say(state, ch, s, &reply, uid).await;
    // conversation mode: keep listening to them for a bit after it finishes talking
    if s.follow_up_secs > 0 {
        start_convo(state, ch, uid, now_ms() + dur + s.follow_up_secs * 1000, false);
    }
    Ok(())
}

pub async fn audio(State(_state): State<Shared>, _auth: AuthUser, Path(id): Path<String>) -> ApiResult<axum::response::Response> {
    let a = AUDIO.get(&id).map(|v| v.0.clone()).ok_or_else(AppError::not_found)?;
    Ok(([("content-type", "audio/wav"), ("cache-control", "private, max-age=300")], a).into_response())
}

// ---------------------------------------------------------------- admin

pub async fn get_admin(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    refresh_status(&state).await;
    let mut st = STATUS.read().await.clone();
    if st.downloading.is_some() {
        st.done_bytes = DONE.load(Ordering::Relaxed);
    }
    let installed = stt_bin().exists() && tts_bin().exists();
    Ok(Json(json!({
        "settings": load_settings(&state).await,
        "status": st,
        "activity": ACTIVITY.lock().map(|a| a.clone()).unwrap_or_default(),
        "installed": installed,
        "stt_models": STT_MODELS.iter().map(|(id, label, note)| json!({ "id": id, "label": label, "note": note })).collect::<Vec<_>>(),
        "voices": VOICES.iter().enumerate().map(|(i, (id, label))| json!({ "sid": i, "id": id, "label": label })).collect::<Vec<_>>(),
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
    let mut s: VoiceAiSettings = serde_json::from_value(cur).map_err(|e| AppError::bad(e.to_string()))?;
    if !STT_MODELS.iter().any(|m| m.0 == s.stt) {
        return Err(AppError::bad("unknown speech recognition model"));
    }
    s.voice = s.voice.clamp(0, VOICES.len() as i64 - 1);
    s.speed = s.speed.clamp(0.6, 1.6);
    s.follow_up_secs = s.follow_up_secs.clamp(0, 120);
    s.wake_phrases = s.wake_phrases.iter().map(|p| p.trim().to_lowercase().chars().take(60).collect::<String>()).filter(|p| !p.is_empty()).take(20).collect();
    if s.wake_phrases.is_empty() {
        s.wake_phrases = default_wake();
    }
    s.notice = s.notice.trim().chars().take(1000).collect();
    if s.notice.is_empty() {
        s.notice = DEFAULT_NOTICE.into();
    }
    save_settings(&state, &s).await?;
    ensure_models(state.clone());
    announce_config(&state).await;
    get_admin(State(state), auth).await
}

#[derive(Deserialize)]
pub struct Preview {
    pub text: Option<String>,
    pub voice: Option<i64>,
    pub speed: Option<f64>,
}

/// Hear a voice before picking it.
pub async fn preview(State(state): State<Shared>, auth: AuthUser, Json(req): Json<Preview>) -> ApiResult<axum::response::Response> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    let s = load_settings(&state).await;
    let text: String = req.text.unwrap_or_else(|| format!("Hi! I'm {}. Just say hey {} when you want me.", state.s().bot_name, state.s().bot_name)).chars().take(400).collect();
    let w = speak(&state, &text, req.voice.unwrap_or(s.voice), req.speed.unwrap_or(s.speed)).await.map_err(|e| AppError::bad(e.to_string()))?;
    Ok(([("content-type", "audio/wav")], w).into_response())
}

/// Turn listening on/off for one server (server owners/admins).
#[derive(Deserialize)]
pub struct GuildListen {
    pub voice_listen: bool,
}

pub async fn set_guild_listen(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>, Json(req): Json<GuildListen>) -> ApiResult<Json<Value>> {
    crate::perms::require_guild(&state.db, &gid, &auth.id, crate::perms::MANAGE_GUILD).await?;
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM bot_settings WHERE guild_id = ?").bind(&gid).fetch_optional(&state.db).await?;
    if exists.is_none() {
        return Err(AppError::bad("turn on the AI bot for this server first"));
    }
    sqlx::query("UPDATE bot_settings SET voice_listen = ? WHERE guild_id = ?").bind(req.voice_listen).bind(&gid).execute(&state.db).await?;
    announce_config(&state).await;
    Ok(Json(json!({ "voice_listen": req.voice_listen })))
}

/// Parents: what was said in calls their kid was in.
pub async fn kid_calls(State(state): State<Shared>, auth: AuthUser, Path(kid): Path<String>) -> ApiResult<Json<Value>> {
    if !crate::kids::is_guardian(&state, &kid, &auth.id).await && !auth.is_admin {
        return Err(AppError::forbidden());
    }
    let rows: Vec<(String, String, String, i64)> =
        sqlx::query_as("SELECT channel_id, speaker_id, text, created_at FROM call_transcripts WHERE kid_id = ? ORDER BY created_at DESC LIMIT 2000").bind(&kid).fetch_all(&state.db).await?;
    let mut out = vec![];
    for (c, sp, t, at) in rows.into_iter().rev() {
        let ch = load_channel(&state.db, &c).await.ok();
        let who = get_user(&state.db, &sp).await.map(|u| u.display_name).unwrap_or_else(|_| "Someone".into());
        out.push(json!({ "channel_id": c, "channel_name": ch.map(|c| c.name), "speaker_id": sp, "speaker": who, "text": t, "at": at }));
    }
    Ok(Json(json!(out)))
}

pub fn boot(state: Shared) {
    ensure_models(state);
}

/// Server nickname if they have one, else their display name.
async fn display_name(state: &Shared, gid: Option<&str>, user: &crate::models::UserPublic) -> String {
    if let Some(g) = gid {
        let nick: Option<Option<String>> = sqlx::query_scalar("SELECT nickname FROM members WHERE guild_id = ? AND user_id = ?").bind(g).bind(&user.id).fetch_optional(&state.db).await.ok().flatten();
        if let Some(Some(n)) = nick {
            if !n.trim().is_empty() {
                return n;
            }
        }
    }
    if user.display_name.is_empty() { user.username.clone() } else { user.display_name.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wake_words() {
        let d = default_wake();
        assert_eq!(wake("Hey Llamble, what time is it?", "Llamble", &d).as_deref(), Some("what time is it?"));
        assert_eq!(wake("hey lamble what's the weather", "Llamble", &d).as_deref(), Some("what's the weather"));
        assert_eq!(wake("Hey gamble, tell me a joke.", "Llamble", &d).as_deref(), Some("tell me a joke."));
        assert_eq!(wake("Hey llama bull how tall is a giraffe", "Llamble", &d).as_deref(), Some("how tall is a giraffe"));
        assert_eq!(wake("Okay Lambo.", "Llamble", &d).as_deref(), Some(""));
        assert_eq!(wake("Llamble, are you there?", "Llamble", &d).as_deref(), Some("are you there?"));
        assert_eq!(wake("Um, hey Llamble, are you there?", "Llamble", &d).as_deref(), Some("are you there?"));
        assert_eq!(wake("I went to the lambo dealer", "Llamble", &d), None);
        assert_eq!(wake("I told Llamble about it", "Llamble", &d), None);
        assert_eq!(wake("hey guys what's up", "Llamble", &d), None);
        assert_eq!(wake("Hey Jarvis open the door", "Jarvis", &d).as_deref(), Some("open the door"));
        let haro = vec!["haro {name}".to_string(), "haro haro".to_string()];
        assert_eq!(wake("Haro Llamble, sing a song", "Llamble", &haro).as_deref(), Some("sing a song"));
        assert_eq!(wake("Harro lamble sing", "Llamble", &haro).as_deref(), Some("sing"));
        assert_eq!(wake("haro haro what's up", "Llamble", &haro).as_deref(), Some("what's up"));
        assert_eq!(wake("Hey Llamble sing", "Llamble", &haro), None);
    }
    #[test]
    fn speakable_strips_markdown() {
        assert_eq!(speakable("**Sure!** Here's a [link](http://x.y) and `code` 🎉"), "Sure! Here's a link and code");
    }
}

/// "Test my microphone": transcribe a sample and say whether it heard the wake word.
/// Only the person who sent it gets the text back.
pub async fn test_hearing(State(state): State<Shared>, _auth: AuthUser, body: Bytes) -> ApiResult<Json<Value>> {
    let s = load_settings(&state).await;
    if !s.enabled || !stt_ready(&state, &s.stt) {
        return Err(AppError::bad("voice conversations aren't turned on (or the speech model is still downloading)"));
    }
    if body.len() < 8000 || body.len() > 16000 * 2 * 30 {
        return Err(AppError::bad("send between half a second and 30 seconds of audio"));
    }
    let t = std::time::Instant::now();
    let text = transcribe(&state, &s.stt, &body).await.map_err(|e| AppError::bad(e.to_string()))?;
    let w = wake(&text, &state.s().bot_name, &s.wake_phrases);
    Ok(Json(json!({ "text": text, "wake": w.is_some(), "question": w, "seconds": t.elapsed().as_secs_f32() })))
}
