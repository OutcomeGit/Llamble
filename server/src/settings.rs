//! Instance settings editable by admins from the app (stored in SQLite).
//! Environment variables only provide the first-boot defaults.
use crate::error::{ApiResult, AppError};
use crate::state::{AuthUser, Shared};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ServerSettings {
    /// the NAS's address on the home network (voice needs it); learned automatically
    pub lan_ip: Option<String>,
    pub max_upload_mb: u64,
    /// "admin" or "all"
    pub guild_create: String,
    pub unfurl_links: bool,
    pub bot_name: String,
    /// allow members to record calls on the server (used by show recording)
    pub allow_server_recording: bool,
}

impl ServerSettings {
    pub fn defaults(cfg: &crate::config::Config) -> Self {
        ServerSettings {
            lan_ip: None,
            max_upload_mb: cfg.max_upload_bytes / 1024 / 1024,
            guild_create: cfg.guild_create.clone(),
            unfurl_links: cfg.unfurl_links,
            bot_name: cfg.bot_name.clone(),
            allow_server_recording: false,
        }
    }
    pub fn max_upload_bytes(&self) -> u64 {
        self.max_upload_mb.max(1) * 1024 * 1024
    }
}

pub async fn load_into_cache(state: &Shared) {
    let mut s = ServerSettings::defaults(&state.cfg);
    if let Ok(Some(v)) = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'server'")
        .fetch_optional(&state.db)
        .await
    {
        if let Ok(saved) = serde_json::from_str::<Value>(&v) {
            // merge saved over defaults (tolerates fields added in later versions)
            let mut base = serde_json::to_value(&s).unwrap();
            if let (Some(b), Some(o)) = (base.as_object_mut(), saved.as_object()) {
                for (k, val) in o {
                    b.insert(k.clone(), val.clone());
                }
            }
            if let Ok(m) = serde_json::from_value(base) {
                s = m;
            }
        }
    }
    *state.settings.write().unwrap() = s;
}

async fn save(state: &Shared, s: &ServerSettings) -> ApiResult<()> {
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('server', ?)")
        .bind(serde_json::to_string(s).unwrap())
        .execute(&state.db)
        .await?;
    *state.settings.write().unwrap() = s.clone();
    Ok(())
}

pub async fn get(state: &Shared) -> ServerSettings {
    state.settings.read().unwrap().clone()
}

fn private_ipv4(host: &str) -> Option<String> {
    let ip: std::net::Ipv4Addr = host.split(':').next()?.parse().ok()?;
    (ip.is_private()).then(|| ip.to_string())
}

/// Learn the NAS's home-network IP from how clients reach it (e.g. Host: 192.168.1.20:8090).
pub async fn learn_lan_ip(state: &Shared, headers: &HeaderMap) {
    let Some(host) = headers.get("host").and_then(|h| h.to_str().ok()) else { return };
    let Some(ip) = private_ipv4(host) else { return };
    let cur = get(state).await;
    if cur.lan_ip.as_deref() == Some(ip.as_str()) || cur.lan_ip.is_some() {
        return;
    }
    let mut s = cur;
    s.lan_ip = Some(ip.clone());
    if save(state, &s).await.is_ok() {
        tracing::info!("learned home-network address {ip} (used for voice)");
        crate::voice_server::refresh(state.clone());
    }
}

pub async fn get_settings(State(state): State<Shared>, auth: AuthUser, headers: HeaderMap) -> ApiResult<Json<Value>> {
    if !auth.is_admin {
        return Err(AppError::forbidden());
    }
    learn_lan_ip(&state, &headers).await;
    Ok(Json(json!({
        "settings": get(&state).await,
        "voice": crate::voice_server::status_json(&state).await,
    })))
}

pub async fn put_settings(State(state): State<Shared>, auth: AuthUser, Json(req): Json<Value>) -> ApiResult<Json<Value>> {
    if !auth.is_admin {
        return Err(AppError::forbidden());
    }
    let mut cur = serde_json::to_value(get(&state).await).unwrap();
    if let (Some(c), Some(r)) = (cur.as_object_mut(), req.as_object()) {
        for (k, v) in r {
            if c.contains_key(k) {
                c.insert(k.clone(), v.clone());
            }
        }
    }
    let mut s: ServerSettings = serde_json::from_value(cur).map_err(|e| AppError::bad(e.to_string()))?;
    s.max_upload_mb = s.max_upload_mb.clamp(1, 20_000);
    if !["admin", "all"].contains(&s.guild_create.as_str()) {
        return Err(AppError::bad("guild_create must be admin or all"));
    }
    s.bot_name = s.bot_name.trim().chars().take(32).collect();
    if s.bot_name.is_empty() {
        s.bot_name = "Llamble".into();
    }
    if let Some(ip) = &s.lan_ip {
        if !ip.is_empty() && ip.parse::<std::net::Ipv4Addr>().is_err() {
            return Err(AppError::bad("home-network address must be an IPv4 address like 192.168.1.20"));
        }
    }
    if s.lan_ip.as_deref() == Some("") {
        s.lan_ip = None;
    }
    let before = get(&state).await;
    save(&state, &s).await?;
    if before.bot_name != s.bot_name {
        let _ = sqlx::query("UPDATE users SET display_name = ? WHERE id = ?").bind(&s.bot_name).bind(&state.bot_id).execute(&state.db).await;
        if let Ok(u) = crate::models::get_user(&state.db, &state.bot_id).await {
            let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM users WHERE is_bot = 0").fetch_all(&state.db).await.unwrap_or_default();
            state.hub.send_users(&ids, "USER_UPDATE", &u);
        }
    }
    if before.lan_ip != s.lan_ip {
        crate::voice_server::refresh(state.clone());
    }
    Ok(Json(json!({ "settings": s })))
}
