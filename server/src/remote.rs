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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RemoteConfig {
    pub enabled: bool,
    /// full host name clients use, e.g. chat.example.com
    pub domain: String,
    /// how the address is kept pointed at home in direct mode:
    /// namecheap | cloudflare | duckdns | custom | manual
    #[serde(default = "default_provider")]
    pub ddns_provider: String,
    /// provider secret: Namecheap DDNS password, Cloudflare API token or DuckDNS token
    #[serde(default)]
    pub ddns_password: String,
    /// custom provider: update URL (may contain {ip}); treated as a secret
    #[serde(default)]
    pub ddns_url: String,
    #[serde(default)]
    pub email: String,
    /// "direct" (router port forwarding + Namecheap DDNS) or "relay" (your own VPS)
    #[serde(default = "default_mode")]
    pub mode: String,
    /// relay mode: the VPS's address (IP or host name)
    #[serde(default)]
    pub relay_addr: String,
    /// relay mode: shared secret, generated here, pasted into the VPS command
    #[serde(default)]
    pub relay_token: String,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        RemoteConfig {
            enabled: false,
            domain: String::new(),
            ddns_provider: default_provider(),
            ddns_password: String::new(),
            ddns_url: String::new(),
            email: String::new(),
            mode: default_mode(),
            relay_addr: String::new(),
            relay_token: String::new(),
        }
    }
}

fn default_provider() -> String {
    "namecheap".into()
}

const PROVIDERS: &[&str] = &["namecheap", "cloudflare", "duckdns", "custom", "manual"];

fn default_mode() -> String {
    "direct".into()
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct RemoteStatus {
    pub ddns_state: String, // off | ok | error
    pub ddns_ip: Option<String>,
    pub ddns_error: Option<String>,
    pub ddns_at: Option<i64>,
    pub tls_state: String, // off | obtaining | ready | error
    pub tls_error: Option<String>,
    pub relay_state: String, // off | connecting | connected | error
    pub relay_error: Option<String>,
    pub relay_ip: Option<String>,
}

#[derive(Default)]
pub struct Remote {
    pub status: RwLock<RemoteStatus>,
    server: Mutex<Option<axum_server::Handle>>,
    kick: tokio::sync::Notify,
    relay_gen: std::sync::atomic::AtomicU64,
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

/// The relay VPS's IPv4 address (voice media is advertised there in relay mode).
pub async fn relay_ip(state: &Shared) -> Option<String> {
    state.remote.status.read().await.relay_ip.clone()
}

async fn resolve_ipv4(addr: &str) -> Option<String> {
    let host = addr.split(':').next()?.to_string();
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        return Some(ip.to_string());
    }
    let found = tokio::net::lookup_host((host.as_str(), 0)).await.ok()?.find(|a| a.is_ipv4()).map(|a| a.ip().to_string());
    found
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

fn http() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(20)).build().unwrap_or_default()
}

/// This network's public IPv4, as seen from outside (only needed by providers that
/// must be told the IP; the others detect it from the update request itself).
async fn public_ipv4() -> Result<String, String> {
    let url = std::env::var("LLAMBLE_IP_ECHO").unwrap_or_else(|_| "https://1.1.1.1/cdn-cgi/trace".into());
    let body = http().get(&url).send().await.map_err(|e| format!("couldn't look up this network's public IP: {e}"))?.text().await.map_err(|e| e.to_string())?;
    body.lines()
        .find_map(|l| l.strip_prefix("ip="))
        .map(|s| s.trim().to_string())
        .filter(|s| s.parse::<std::net::Ipv4Addr>().is_ok())
        .ok_or_else(|| "couldn't find an IPv4 public address".into())
}

async fn update_namecheap(c: &RemoteConfig) -> Result<Option<String>, String> {
    let (host, root) = split_domain(&c.domain);
    let base = std::env::var("LLAMBLE_DDNS_ENDPOINT").unwrap_or_else(|_| "https://dynamicdns.park-your-domain.com".into());
    let body = http()
        .get(format!("{base}/update"))
        .query(&[("host", host.as_str()), ("domain", root.as_str()), ("password", c.ddns_password.as_str())])
        .send()
        .await
        .map_err(|e| format!("couldn't reach Namecheap: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let errs: i64 = xml_tag(&body, "ErrCount").and_then(|v| v.parse().ok()).unwrap_or(1);
    if errs != 0 {
        return Err(xml_tag(&body, "Err1").unwrap_or("Namecheap rejected the update").to_string());
    }
    Ok(xml_tag(&body, "IP").map(|s| s.to_string()))
}

async fn update_cloudflare(c: &RemoteConfig) -> Result<Option<String>, String> {
    let api = std::env::var("LLAMBLE_CLOUDFLARE_API").unwrap_or_else(|_| "https://api.cloudflare.com/client/v4".into());
    let auth = format!("Bearer {}", c.ddns_password);
    let get = |url: String| {
        let auth = auth.clone();
        async move {
            let v: Value = http().get(url).header("authorization", auth).send().await.map_err(|e| format!("couldn't reach Cloudflare: {e}"))?.json().await.map_err(|e| e.to_string())?;
            if v["success"] != json!(true) {
                return Err(cf_error(&v));
            }
            Ok::<Value, String>(v)
        }
    };
    // the zone is the longest suffix of the address that Cloudflare knows about
    let labels: Vec<&str> = c.domain.split('.').collect();
    let mut zone = None;
    for n in (2..=labels.len()).rev() {
        let name = labels[labels.len() - n..].join(".");
        let v = get(format!("{api}/zones?name={name}")).await?;
        if let Some(id) = v["result"][0]["id"].as_str() {
            zone = Some(id.to_string());
            break;
        }
    }
    let zone = zone.ok_or("this Cloudflare token can't see a zone for that address (give it Zone → DNS → Edit for your domain)")?;
    let ip = public_ipv4().await?;
    let existing = get(format!("{api}/zones/{zone}/dns_records?type=A&name={}", c.domain)).await?;
    let body = json!({ "type": "A", "name": c.domain, "content": ip, "ttl": 60, "proxied": false });
    let req = match existing["result"][0]["id"].as_str() {
        Some(id) => http().put(format!("{api}/zones/{zone}/dns_records/{id}")),
        None => http().post(format!("{api}/zones/{zone}/dns_records")),
    };
    let v: Value = req.header("authorization", &auth).json(&body).send().await.map_err(|e| format!("couldn't reach Cloudflare: {e}"))?.json().await.map_err(|e| e.to_string())?;
    if v["success"] != json!(true) {
        return Err(cf_error(&v));
    }
    Ok(Some(ip))
}

fn cf_error(v: &Value) -> String {
    let msg = v["errors"][0]["message"].as_str().unwrap_or("Cloudflare rejected the request");
    format!("Cloudflare: {msg}")
}

async fn update_duckdns(c: &RemoteConfig) -> Result<Option<String>, String> {
    let sub = c.domain.strip_suffix(".duckdns.org").ok_or("DuckDNS addresses end in .duckdns.org")?;
    let sub = sub.rsplit('.').next().unwrap_or(sub);
    let base = std::env::var("LLAMBLE_DUCKDNS_ENDPOINT").unwrap_or_else(|_| "https://www.duckdns.org".into());
    let body = http()
        .get(format!("{base}/update"))
        .query(&[("domains", sub), ("token", c.ddns_password.as_str()), ("verbose", "true")])
        .send()
        .await
        .map_err(|e| format!("couldn't reach DuckDNS: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let mut lines = body.lines();
    if lines.next().map(str::trim) != Some("OK") {
        return Err("DuckDNS rejected the update (check the subdomain and token)".into());
    }
    Ok(lines.next().map(|s| s.trim().to_string()).filter(|s| s.parse::<std::net::Ipv4Addr>().is_ok()))
}

async fn update_custom(c: &RemoteConfig) -> Result<Option<String>, String> {
    let mut url = c.ddns_url.trim().to_string();
    let mut ip = None;
    if url.contains("{ip}") {
        let p = public_ipv4().await?;
        url = url.replace("{ip}", &p);
        ip = Some(p);
    }
    let r = http().get(&url).send().await.map_err(|e| format!("couldn't reach the update URL: {}", e.without_url()))?;
    if !r.status().is_success() {
        return Err(format!("the update URL answered {}", r.status()));
    }
    Ok(ip)
}

/// What the address currently points to (used when the provider doesn't say).
async fn resolve_domain(domain: &str) -> Option<String> {
    resolve_ipv4(domain).await
}

/// Keep the address pointed at home (direct mode) and learn the public IP calls should use.
async fn update_address(state: &Shared, c: &RemoteConfig) {
    let result = match c.ddns_provider.as_str() {
        "namecheap" => update_namecheap(c).await,
        "cloudflare" => update_cloudflare(c).await,
        "duckdns" => update_duckdns(c).await,
        "custom" => update_custom(c).await,
        _ => Ok(None), // manual: router DDNS or a static IP
    };
    let result = match result {
        Ok(Some(ip)) => Ok(ip),
        Ok(None) => resolve_domain(&c.domain).await.ok_or_else(|| format!("{} doesn't point anywhere yet", c.domain)),
        Err(e) => Err(e),
    };
    let mut st = state.remote.status.write().await;
    st.ddns_at = Some(crate::error::now_ms());
    match result {
        Ok(ip) => {
            st.ddns_state = "ok".into();
            st.ddns_error = None;
            if st.ddns_ip.as_deref() != Some(ip.as_str()) {
                st.ddns_ip = Some(ip);
                crate::voice_server::refresh(state.clone());
            }
        }
        Err(e) => {
            st.ddns_state = "error".into();
            st.ddns_error = Some(e);
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
            if c.enabled && c.mode == "direct" {
                update_address(&state, &c).await;
            }
        }
    });
}

async fn apply(state: &Shared) {
    let c = load(state).await;
    // any running relay link stops when settings change; restarted below if still wanted
    let relay_gen = state.remote.relay_gen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    if !c.enabled || c.domain.is_empty() {
        stop_https(state).await;
        *state.remote.status.write().await = RemoteStatus { ddns_state: "off".into(), tls_state: "off".into(), relay_state: "off".into(), ..Default::default() };
        crate::voice_server::refresh(state.clone());
        return;
    }
    if c.mode == "relay" {
        {
            let mut st = state.remote.status.write().await;
            st.ddns_state = "off".into();
            st.ddns_ip = None;
            st.ddns_error = None;
        }
        start_https(state, &c).await;
        tokio::spawn(relay_loop(state.clone(), c, relay_gen));
        return;
    }
    {
        let mut st = state.remote.status.write().await;
        st.relay_state = "off".into();
        st.relay_error = None;
        st.relay_ip = None;
    }
    crate::voice_server::refresh(state.clone());
    update_address(state, &c).await;
    start_https(state, &c).await;
}

/// Keep the outbound link to the relay VPS up while relay mode is on.
async fn relay_loop(state: Shared, c: RemoteConfig, gen: u64) {
    use std::sync::atomic::Ordering;
    let mut backoff = 2u64;
    while state.remote.relay_gen.load(Ordering::SeqCst) == gen {
        if c.relay_addr.trim().is_empty() {
            let mut st = state.remote.status.write().await;
            st.relay_state = "error".into();
            st.relay_error = Some("enter your relay server's address".into());
            return;
        }
        let ip = resolve_ipv4(c.relay_addr.trim()).await;
        {
            let mut st = state.remote.status.write().await;
            st.relay_state = "connecting".into();
            if st.relay_ip != ip {
                st.relay_ip = ip.clone();
                drop(st);
                crate::voice_server::refresh(state.clone());
            }
        }
        let st2 = state.clone();
        let link = crate::relay::run_home_link(c.relay_addr.trim(), &c.relay_token, move || {
            let st2 = st2.clone();
            tokio::spawn(async move {
                let mut st = st2.remote.status.write().await;
                st.relay_state = "connected".into();
                st.relay_error = None;
            });
            tracing::info!("relay link up");
        });
        let stopped = async {
            while state.remote.relay_gen.load(Ordering::SeqCst) == gen {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        };
        let was_up;
        tokio::select! {
            r = link => {
                let err = r.err().unwrap_or_default();
                let mut st = state.remote.status.write().await;
                was_up = st.relay_state == "connected";
                st.relay_state = "error".into();
                st.relay_error = Some(err);
            }
            _ = stopped => return,
        }
        if was_up {
            backoff = 2;
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(60);
    }
}

// ---------- admin API ----------

pub async fn get_remote(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    if !auth.is_admin {
        return Err(AppError::forbidden());
    }
    let c = load(&state).await;
    let mut c = c;
    if c.relay_token.is_empty() {
        c.relay_token = crate::error::random_token(24);
        save(&state, &c).await?;
    }
    let image = std::env::var("LLAMBLE_IMAGE").unwrap_or_else(|_| "ghcr.io/outcomegit/llamble:latest".into());
    let relay_command = format!(
        "docker run -d --name llamble-relay --restart unless-stopped -p 443:{https} -p {ctl}:{ctl} -p {tcp}:{tcp} -p {udp}:{udp}/udp -e LLAMBLE_RELAY_TOKEN={tok} {image} llamble-server relay",
        https = HTTPS_PORT,
        ctl = crate::relay::CONTROL_PORT,
        tcp = crate::voice_server::TCP_PORT,
        udp = crate::voice_server::UDP_PORT,
        tok = c.relay_token,
    );
    Ok(Json(json!({
        "enabled": c.enabled,
        "mode": c.mode,
        "domain": c.domain,
        "email": c.email,
        "ddns_provider": c.ddns_provider,
        "has_ddns_secret": !c.ddns_password.is_empty() || !c.ddns_url.is_empty(),
        "relay_addr": c.relay_addr,
        "relay_command": relay_command,
        "status": *state.remote.status.read().await,
        "voice": crate::voice_server::status_json(&state).await,
        "ports": {
            "https": HTTPS_PORT,
            "voice_tcp": crate::voice_server::TCP_PORT,
            "voice_udp": crate::voice_server::UDP_PORT,
            "relay_control": crate::relay::CONTROL_PORT,
        },
    })))
}

#[derive(Deserialize)]
pub struct SetRemote {
    pub enabled: bool,
    pub domain: String,
    pub ddns_password: Option<String>,
    pub ddns_provider: Option<String>,
    pub ddns_url: Option<String>,
    pub email: Option<String>,
    pub mode: Option<String>,
    pub relay_addr: Option<String>,
    /// make a new relay token (the VPS command must then be run again)
    #[serde(default)]
    pub new_relay_token: bool,
}

async fn save(state: &Shared, c: &RemoteConfig) -> ApiResult<()> {
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('remote', ?)")
        .bind(serde_json::to_string(c).unwrap())
        .execute(&state.db)
        .await?;
    Ok(())
}

pub async fn set_remote(State(state): State<Shared>, auth: AuthUser, Json(req): Json<SetRemote>) -> ApiResult<Json<Value>> {
    if !auth.is_admin {
        return Err(AppError::forbidden());
    }
    let domain = req.domain.trim().trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/').to_lowercase();
    if req.enabled {
        let ok = domain.contains('.') && domain.split('.').all(|p| !p.is_empty() && p.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-'));
        if !ok {
            return Err(AppError::bad("enter a host name like chat.example.com"));
        }
    }
    let mut c = load(&state).await;
    c.enabled = req.enabled;
    c.domain = domain;
    if let Some(pv) = req.ddns_provider {
        if !PROVIDERS.contains(&pv.as_str()) {
            return Err(AppError::bad("unknown address provider"));
        }
        if pv != c.ddns_provider {
            // a secret for one provider means nothing to another
            c.ddns_password.clear();
            c.ddns_url.clear();
        }
        c.ddns_provider = pv;
    }
    if let Some(u) = req.ddns_url {
        let u = u.trim();
        if !u.is_empty() {
            if !(u.starts_with("https://") || u.starts_with("http://")) {
                return Err(AppError::bad("the update URL should start with https://"));
            }
            c.ddns_url = u.to_string();
        }
    }
    if let Some(p) = req.ddns_password {
        if !p.trim().is_empty() {
            c.ddns_password = p.trim().to_string();
        }
    }
    if let Some(e) = req.email {
        c.email = e.trim().to_string();
    }
    if let Some(m) = req.mode {
        if m != "direct" && m != "relay" {
            return Err(AppError::bad("mode must be direct or relay"));
        }
        c.mode = m;
    }
    if let Some(a) = req.relay_addr {
        c.relay_addr = a.trim().trim_start_matches("http://").trim_start_matches("https://").trim_end_matches('/').to_string();
    }
    if req.new_relay_token || c.relay_token.is_empty() {
        c.relay_token = crate::error::random_token(24);
    }
    if c.enabled && c.mode == "relay" && c.relay_addr.is_empty() {
        return Err(AppError::bad("enter your relay server's address"));
    }
    save(&state, &c).await?;
    state.remote.kick.notify_one();
    Ok(Json(json!({ "ok": true })))
}

// ---------- LiveKit signaling proxy: /livekit/... -> LiveKit server ----------


pub async fn livekit_proxy(State(state): State<Shared>, Path(rest): Path<String>, ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>, req: Request) -> Response {
    let ws = ws.ok();
    let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let target = format!("{}/{}{}", crate::voice_server::internal_url(&state).await.trim_end_matches('/'), rest, query);
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
