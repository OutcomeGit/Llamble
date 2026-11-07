//! Built-in voice/video server: runs LiveKit (bundled in the image) as a supervised
//! child process with an auto-generated key/secret. Llamble picks the address LiveKit
//! advertises for media based on the remote-access mode (home IP, public IP, or VPS IP)
//! and restarts it when that changes. Clients reach its signaling through Llamble's
//! own port at /livekit, so only the media ports need to be published.
use crate::state::Shared;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::{Mutex, RwLock};

pub const SIGNAL_PORT: u16 = 7880;
pub const TCP_PORT: u16 = 7881;
pub const UDP_PORT: u16 = 7882;

#[derive(Default)]
pub struct VoiceServer {
    pub state: RwLock<String>, // off | starting | running | error | external | no-address
    pub node_ip: RwLock<Option<String>>,
    pub error: RwLock<Option<String>>,
    keys: RwLock<Option<(String, String)>>,
    generation: AtomicU64,
    child: Mutex<Option<(u64, tokio::process::Child)>>,
}

pub fn livekit_bin() -> PathBuf {
    PathBuf::from(std::env::var("LLAMBLE_LIVEKIT_BIN").unwrap_or_else(|_| "/opt/livekit/livekit-server".into()))
}

/// External LiveKit configured through env (legacy/advanced) instead of the built-in one.
pub fn external(state: &Shared) -> bool {
    state.cfg.livekit_url.is_some() && state.cfg.livekit_key.is_some() && state.cfg.livekit_secret.is_some()
}

pub fn enabled(state: &Shared) -> bool {
    external(state) || livekit_bin().exists()
}

/// API key + secret used to sign join tokens.
pub async fn credentials(state: &Shared) -> Option<(String, String)> {
    if external(state) {
        return Some((state.cfg.livekit_key.clone()?, state.cfg.livekit_secret.clone()?));
    }
    if let Some(k) = state.voice.keys.read().await.clone() {
        return Some(k);
    }
    let saved: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'livekit.keys'")
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    let keys = match saved.and_then(|s| serde_json::from_str::<(String, String)>(&s).ok()) {
        Some(k) => k,
        None => {
            let k = (format!("llamble{}", &crate::error::random_token(6)), crate::error::random_token(32));
            let _ = sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('livekit.keys', ?)")
                .bind(serde_json::to_string(&k).unwrap())
                .execute(&state.db)
                .await;
            k
        }
    };
    *state.voice.keys.write().await = Some(keys.clone());
    Some(keys)
}

/// URL a client should use for voice signaling, based on how it reached us.
pub async fn client_url(state: &Shared, headers: &axum::http::HeaderMap) -> Option<String> {
    if external(state) {
        return crate::remote::livekit_url_for(state, headers).await;
    }
    let host = headers.get("host").and_then(|h| h.to_str().ok())?.to_string();
    let bare = host.split(':').next().unwrap_or("").to_lowercase();
    if let Some(d) = crate::remote::public_domain(state).await {
        if bare == d.to_lowercase() {
            return Some(format!("wss://{d}/livekit"));
        }
    }
    let secure = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) == Some("https");
    Some(format!("{}://{host}/livekit", if secure { "wss" } else { "ws" }))
}

pub async fn internal_url(state: &Shared) -> String {
    if external(state) {
        return std::env::var("LIVEKIT_INTERNAL_URL").unwrap_or_else(|_| "http://host.docker.internal:7880".into());
    }
    format!("http://127.0.0.1:{SIGNAL_PORT}")
}

/// Which IP LiveKit should advertise for media right now.
async fn desired_node_ip(state: &Shared) -> Option<String> {
    let r = crate::remote::load(state).await;
    if r.enabled {
        if r.mode == "relay" {
            if let Some(ip) = crate::remote::relay_ip(state).await {
                return Some(ip);
            }
        } else if let Some(ip) = state.remote.status.read().await.ddns_ip.clone() {
            return Some(ip);
        }
    }
    crate::settings::get(state).await.lan_ip
}

fn config_yaml(node_ip: &str, key: &str, secret: &str) -> String {
    format!(
        "port: {SIGNAL_PORT}\nrtc:\n  tcp_port: {TCP_PORT}\n  udp_port: {UDP_PORT}\n  node_ip: {node_ip}\n  use_external_ip: false\nkeys:\n  {key}: {secret}\nroom:\n  empty_timeout: 300\nlogging:\n  level: info\n"
    )
}

/// (Re)start the built-in LiveKit if the advertised address changed.
pub fn refresh(state: Shared) {
    tokio::spawn(async move {
        if external(&state) {
            *state.voice.state.write().await = "external".into();
            return;
        }
        if !livekit_bin().exists() {
            *state.voice.state.write().await = "off".into();
            return;
        }
        let ip = desired_node_ip(&state).await;
        let running = state.voice.state.read().await.clone();
        if *state.voice.node_ip.read().await == ip && running == "running" {
            return;
        }
        let Some(ip) = ip else {
            *state.voice.state.write().await = "no-address".into();
            return;
        };
        let gen = state.voice.generation.fetch_add(1, Ordering::SeqCst) + 1;
        supervise(state, ip, gen).await;
    });
}

/// Stop the running voice server. With `only`, stop it only if that supervisor started it.
async fn stop_child(state: &Shared, only: Option<u64>) {
    let taken = {
        let mut slot = state.voice.child.lock().await;
        match (&*slot, only) {
            (Some((g, _)), Some(o)) if *g != o => None,
            _ => slot.take().map(|(_, c)| c),
        }
    };
    if let Some(mut c) = taken {
        let _ = c.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(5), c.wait()).await;
    }
}

async fn supervise(state: Shared, ip: String, gen: u64) {
    let (key, secret) = match credentials(&state).await {
        Some(k) => k,
        None => return,
    };
    let mut backoff = 2;
    loop {
        if state.voice.generation.load(Ordering::SeqCst) != gen {
            return;
        }
        stop_child(&state, None).await;
        *state.voice.state.write().await = "starting".into();
        *state.voice.node_ip.write().await = Some(ip.clone());
        let spawned = tokio::process::Command::new(livekit_bin())
            .arg("--config-body")
            .arg(config_yaml(&ip, &key, &secret))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                *state.voice.state.write().await = "error".into();
                *state.voice.error.write().await = Some(format!("can't start voice server: {e}"));
                return;
            }
        };
        let stderr = child.stderr.take();
        *state.voice.child.lock().await = Some((gen, child));
        tracing::info!("voice server starting (media address {ip})");
        let tail = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        if let Some(err) = stderr {
            let tail = tail.clone();
            tokio::spawn(async move {
                use tokio::io::AsyncBufReadExt;
                let mut lines = tokio::io::BufReader::new(err).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    let mut t = tail.lock().await;
                    t.push(l);
                    if t.len() > 20 {
                        t.remove(0);
                    }
                }
            });
        }
        // healthy once the signaling port answers
        let client = reqwest::Client::new();
        for _ in 0..40 {
            if state.voice.generation.load(Ordering::SeqCst) != gen {
                break;
            }
            if client.get(format!("http://127.0.0.1:{SIGNAL_PORT}/")).timeout(Duration::from_secs(2)).send().await.is_ok() {
                *state.voice.state.write().await = "running".into();
                *state.voice.error.write().await = None;
                backoff = 2;
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        // wait for exit or replacement
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if state.voice.generation.load(Ordering::SeqCst) != gen {
                stop_child(&state, Some(gen)).await;
                return;
            }
            let exited = match state.voice.child.lock().await.as_mut() {
                Some((g, c)) if *g == gen => matches!(c.try_wait(), Ok(Some(_))),
                _ => true,
            };
            if exited {
                break;
            }
        }
        if state.voice.generation.load(Ordering::SeqCst) != gen {
            return;
        }
        let last = tail.lock().await.join(" | ");
        *state.voice.state.write().await = "error".into();
        *state.voice.error.write().await = Some(format!("voice server stopped; restarting. {last}"));
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(60);
    }
}

/// Wait (up to `max`) until the built-in voice server is running. No-op for an external one.
pub async fn wait_ready(state: &Shared, max: Duration) {
    if external(state) || !livekit_bin().exists() {
        return;
    }
    let end = tokio::time::Instant::now() + max;
    while tokio::time::Instant::now() < end {
        let st = state.voice.state.read().await.clone();
        if st == "running" || st == "no-address" || st == "off" {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

pub async fn status_json(state: &Shared) -> Value {
    json!({
        "state": *state.voice.state.read().await,
        "media_address": *state.voice.node_ip.read().await,
        "error": *state.voice.error.read().await,
        "tcp_port": TCP_PORT,
        "udp_port": UDP_PORT,
        "bundled": livekit_bin().exists(),
    })
}
