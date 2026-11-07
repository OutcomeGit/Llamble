//! Remote access: a public HTTPS address for people outside the home network.
//! - Keeps the domain pointed at the home IP via Namecheap Dynamic DNS (Namecheap
//!   detects the IP itself — no third-party "what's my IP" service).
//! - Gets and renews a Let's Encrypt certificate automatically (TLS-ALPN-01 on the
//!   forwarded 443 port, so no extra ports are needed for certificates).
//! - Serves Llamble over HTTPS on container port 8443 and proxies voice signaling
//!   (wss://domain/livekit) to the LiveKit server, so one TCP port covers web + calls.
use crate::error::{ApiResult, AppError};
use crate::state::{AuthUser, Shared};
use axum::body::Body;
use axum::extract::ws::{Message as AxMsg, WebSocketUpgrade};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::{Mutex, RwLock};

pub const HTTPS_PORT: u16 = 8443;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct RemoteConfig {
    pub enabled: bool,
    /// full host name clients use, e.g. chat.llamble.com
    pub domain: String,
    #[serde(default)]
    pub ddns_password: String,
    #[serde(default)]
    pub email: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct RemoteStatus {
    pub ddns_state: String, // off | ok | error
    pub ddns_ip: Option<String>,
    pub ddns_error: Option<String>,
    pub ddns_at: Option<i64>,
    pub tls_state: String, // off | obtaining | ready | error
    pub tls_error: Option<String>,
}

#[derive(Default)]
pub struct Remote {
    pub status: RwLock<RemoteStatus>,
    server: Mutex<Option<axum_server::Handle>>,
    kick: tokio::sync::Notify,
}

static APP: OnceLock<Router> = OnceLock::new();

pub async fn load(state: &Shared) -> RemoteConfig {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'remote'")
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Public base URL for clients that came in through the remote domain.
pub async fn public_domain(state: &Shared) -> Option<String> {
    let c = load(state).await;
    (c.enabled && !c.domain.is_empty()).then_some(c.domain)
}

/// LiveKit URL to hand a client: through our HTTPS proxy if they connected via the domain.
pub async fn livekit_url_for(state: &Shared, headers: &HeaderMap) -> Option<String> {
    let host = headers.get("host").and_then(|h| h.to_str().ok()).unwrap_or("").split(':').next().unwrap_or("").to_lowercase();
    if let Some(d) = public_domain(state).await {
        if host == d.to_lowercase() {
            return Some(format!("wss://{d}/livekit"));
        }
    }
    state.cfg.livekit_url.clone()
}

fn split_domain(domain: &str) -> (String, String) {
    // chat.llamble.com -> ("chat", "llamble.com"); llamble.com -> ("@", "llamble.com")
    let parts: Vec<&str> = domain.trim_end_matches('.').split('.').collect();
    if parts.len() <= 2 {
        return ("@".into(), parts.join("."));
    }
    let root = parts[parts.len() - 2..].join(".");
    let host = parts[..parts.len() - 2].join(".");
    (host, root)
}

fn xml_tag<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let s = xml.find(&open)? + open.len();
    let e = xml[s..].find(&close)? + s;
    Some(xml[s..e].trim())
}

async fn update_ddns(state: &Shared, c: &RemoteConfig) {
    let (host, root) = split_domain(&c.domain);
    let base = std::env::var("LLAMBLE_DDNS_ENDPOINT").unwrap_or_else(|_| "https://dynamicdns.park-your-domain.com".into());
    let url = format!("{base}/update");
    let res = reqwest::Client::new()
        .get(&url)
        .query(&[("host", host.as_str()), ("domain", root.as_str()), ("password", c.ddns_password.as_str())])
        .timeout(Duration::from_secs(20))
        .send()
        .await;
    let now = crate::error::now_ms();
    let mut st = state.remote.status.write().await;
    st.ddns_at = Some(now);
    match res {
        Ok(r) => {
            let body = r.text().await.unwrap_or_default();
            let errs: i64 = xml_tag(&body, "ErrCount").and_then(|v| v.parse().ok()).unwrap_or(1);
            if errs == 0 {
                st.ddns_state = "ok".into();
                st.ddns_ip = xml_tag(&body, "IP").map(|s| s.to_string());
                st.ddns_error = None;
            } else {
                st.ddns_state = "error".into();
                st.ddns_error = Some(xml_tag(&body, "Err1").unwrap_or("Namecheap rejected the update").to_string());
            }
        }
        Err(e) => {
            st.ddns_state = "error".into();
            st.ddns_error = Some(format!("couldn't reach Namecheap: {e}"));
        }
    }
}

async fn stop_https(state: &Shared) {
    if let Some(h) = state.remote.server.lock().await.take() {
        h.graceful_shutdown(Some(Duration::from_secs(5)));
    }
}

async fn start_https(state: &Shared, c: &RemoteConfig) {
    stop_https(state).await;
    let Some(app) = APP.get().cloned() else { return };
    let cache = state.cfg.data_dir.join("acme");
    let staging = std::env::var("LLAMBLE_ACME_STAGING").is_ok();
    let mut acme = rustls_acme::AcmeConfig::new([c.domain.clone()])
        .cache(rustls_acme::caches::DirCache::new(cache))
        .directory_lets_encrypt(!staging);
    if !c.email.trim().is_empty() {
        acme = acme.contact_push(format!("mailto:{}", c.email.trim()));
    }
    let mut acme_state = acme.state();
    let acceptor = acme_state.axum_acceptor(acme_state.default_rustls_config());
    {
        let mut st = state.remote.status.write().await;
        st.tls_state = "obtaining".into();
        st.tls_error = None;
    }
    let st2 = state.clone();
    tokio::spawn(async move {
        while let Some(ev) = acme_state.next().await {
            let mut st = st2.remote.status.write().await;
            match ev {
                Ok(ok) => {
                    tracing::info!("certificate: {ok:?}");
                    st.tls_state = "ready".into();
                    st.tls_error = None;
                }
                Err(err) => {
                    tracing::warn!("certificate error: {err:?}");
                    st.tls_state = "error".into();
                    st.tls_error = Some(format!("{err}"));
                }
            }
        }
    });
    let handle = axum_server::Handle::new();
    *state.remote.server.lock().await = Some(handle.clone());
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], HTTPS_PORT));
    tokio::spawn(async move {
        if let Err(e) = axum_server::bind(addr).acceptor(acceptor).handle(handle).serve(app.into_make_service()).await {
            tracing::error!("https listener failed: {e}");
        }
    });
    tracing::info!("HTTPS listening on :{HTTPS_PORT} for {}", c.domain);
}

/// Called once at startup with the full app router (so HTTPS serves the same routes).
pub fn init(state: Shared, app: Router) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let _ = APP.set(app);
    tokio::spawn(async move {
        apply(&state).await;
        loop {
            // re-check the home IP every 10 minutes, or right away when settings change
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(600)) => {}
                _ = state.remote.kick.notified() => { apply(&state).await; continue; }
            }
            let c = load(&state).await;
            if c.enabled && !c.ddns_password.is_empty() {
                update_ddns(&state, &c).await;
            }
        }
    });
}

async fn apply(state: &Shared) {
    let c = load(state).await;
    if !c.enabled || c.domain.is_empty() {
        stop_https(state).await;
        *state.remote.status.write().await = RemoteStatus { ddns_state: "off".into(), tls_state: "off".into(), ..Default::default() };
        return;
    }
    if !c.ddns_password.is_empty() {
        update_ddns(state, &c).await;
    } else {
        state.remote.status.write().await.ddns_state = "off".into();
    }
    start_https(state, &c).await;
}

// ---------- admin API ----------

pub async fn get_remote(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    if !auth.is_admin {
        return Err(AppError::forbidden());
    }
    let c = load(&state).await;
    Ok(Json(json!({
        "enabled": c.enabled,
        "domain": c.domain,
        "email": c.email,
        "has_ddns_password": !c.ddns_password.is_empty(),
        "status": *state.remote.status.read().await,
        "https_port": HTTPS_PORT,
        "voice_ports": { "tcp": 7881, "udp": "50000-50100" },
    })))
}

#[derive(Deserialize)]
pub struct SetRemote {
    pub enabled: bool,
    pub domain: String,
    pub ddns_password: Option<String>,
    pub email: Option<String>,
}

pub async fn set_remote(State(state): State<Shared>, auth: AuthUser, Json(req): Json<SetRemote>) -> ApiResult<Json<Value>> {
    if !auth.is_admin {
        return Err(AppError::forbidden());
    }
    let domain = req.domain.trim().trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/').to_lowercase();
    if req.enabled {
        let ok = domain.contains('.') && domain.split('.').all(|p| !p.is_empty() && p.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-'));
        if !ok {
            return Err(AppError::bad("enter a host name like chat.llamble.com"));
        }
    }
    let mut c = load(&state).await;
    c.enabled = req.enabled;
    c.domain = domain;
    if let Some(p) = req.ddns_password {
        if !p.trim().is_empty() {
            c.ddns_password = p.trim().to_string();
        }
    }
    if let Some(e) = req.email {
        c.email = e.trim().to_string();
    }
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('remote', ?)")
        .bind(serde_json::to_string(&c).unwrap())
        .execute(&state.db)
        .await?;
    state.remote.kick.notify_one();
    Ok(Json(json!({ "ok": true })))
}

// ---------- LiveKit signaling proxy: /livekit/... -> LiveKit server ----------

fn livekit_internal() -> String {
    std::env::var("LIVEKIT_INTERNAL_URL").unwrap_or_else(|_| "http://host.docker.internal:7880".into()).trim_end_matches('/').to_string()
}

pub async fn livekit_proxy(Path(rest): Path<String>, ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>, req: Request) -> Response {
    let ws = ws.ok();
    let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let target = format!("{}/{}{}", livekit_internal(), rest, query);
    if let Some(ws) = ws {
        let target = target.replacen("http", "ws", 1);
        return ws.on_upgrade(move |client| async move {
            let upstream = match tokio_tungstenite::connect_async(&target).await {
                Ok((s, _)) => s,
                Err(e) => {
                    tracing::warn!("livekit proxy: can't reach {target}: {e}");
                    return;
                }
            };
            let (mut up_tx, mut up_rx) = upstream.split();
            let (mut cl_tx, mut cl_rx) = client.split();
            use tokio_tungstenite::tungstenite::Message as TMsg;
            let a = async {
                while let Some(Ok(m)) = cl_rx.next().await {
                    let out = match m {
                        AxMsg::Text(t) => TMsg::Text(t.as_str().into()),
                        AxMsg::Binary(b) => TMsg::Binary(b),
                        AxMsg::Ping(p) => TMsg::Ping(p),
                        AxMsg::Pong(p) => TMsg::Pong(p),
                        AxMsg::Close(_) => break,
                    };
                    if up_tx.send(out).await.is_err() {
                        break;
                    }
                }
            };
            let b = async {
                while let Some(Ok(m)) = up_rx.next().await {
                    let out = match m {
                        TMsg::Text(t) => AxMsg::Text(t.as_str().into()),
                        TMsg::Binary(b) => AxMsg::Binary(b),
                        TMsg::Ping(p) => AxMsg::Ping(p),
                        TMsg::Pong(p) => AxMsg::Pong(p),
                        TMsg::Close(_) => break,
                        TMsg::Frame(_) => continue,
                    };
                    if cl_tx.send(out).await.is_err() {
                        break;
                    }
                }
            };
            tokio::select! { _ = a => {}, _ = b => {} }
        });
    }
    // plain HTTP (e.g. /rtc/validate)
    let method = req.method().clone();
    match reqwest::Client::new().request(method, &target).header("authorization", req.headers().get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("")).send().await {
        Ok(r) => {
            let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let body = r.bytes().await.unwrap_or_default();
            (status, Body::from(body)).into_response()
        }
        Err(_) => (StatusCode::BAD_GATEWAY, "voice server unreachable").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn domains() {
        assert_eq!(split_domain("chat.llamble.com"), ("chat".into(), "llamble.com".into()));
        assert_eq!(split_domain("llamble.com"), ("@".into(), "llamble.com".into()));
        assert_eq!(split_domain("a.b.llamble.com"), ("a.b".into(), "llamble.com".into()));
        let x = "<interface-response><IP>1.2.3.4</IP><ErrCount>0</ErrCount></interface-response>";
        assert_eq!(xml_tag(x, "IP"), Some("1.2.3.4"));
    }
}
