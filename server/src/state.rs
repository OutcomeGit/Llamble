use crate::config::Config;
use crate::error::{now_ms, sha256_hex, AppError};
use crate::models::Channel;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use dashmap::DashMap;
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;

pub type Shared = Arc<AppState>;

pub struct AppState {
    pub db: SqlitePool,
    pub cfg: Config,
    pub hub: Hub,
    pub secret: Vec<u8>,
    pub bot_id: String,
    pub bot: crate::bot::BotRuntime,
}

#[derive(Serialize, Clone, Debug)]
pub struct VoiceState {
    pub user_id: String,
    pub channel_id: String,
    pub guild_id: Option<String>,
    pub muted: bool,
    pub deafened: bool,
    pub video: bool,
    pub screen: bool,
}

#[derive(Default)]
pub struct Hub {
    next: AtomicU64,
    conns: DashMap<String, Vec<(u64, UnboundedSender<String>)>>,
    pub voice: DashMap<String, VoiceState>,
}

impl Hub {
    pub fn register(&self, user_id: &str, tx: UnboundedSender<String>) -> (u64, bool) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut e = self.conns.entry(user_id.to_string()).or_default();
        let first = e.is_empty();
        e.push((id, tx));
        (id, first)
    }

    /// Returns true if this was the user's last connection.
    pub fn unregister(&self, user_id: &str, conn: u64) -> bool {
        let mut last = false;
        if let Some(mut e) = self.conns.get_mut(user_id) {
            e.retain(|(i, _)| *i != conn);
            last = e.is_empty();
        }
        if last {
            self.conns.remove(user_id);
        }
        last
    }

    pub fn online_users(&self) -> Vec<String> {
        self.conns.iter().map(|e| e.key().clone()).collect()
    }

    pub fn is_online(&self, uid: &str) -> bool {
        self.conns.contains_key(uid)
    }

    pub fn send_user(&self, user_id: &str, t: &str, d: &impl Serialize) {
        let payload = json!({ "t": t, "d": d }).to_string();
        self.send_raw(user_id, &payload);
    }

    fn send_raw(&self, user_id: &str, payload: &str) {
        if let Some(e) = self.conns.get(user_id) {
            for (_, tx) in e.iter() {
                let _ = tx.send(payload.to_string());
            }
        }
    }

    pub fn send_users(&self, users: &[String], t: &str, d: &impl Serialize) {
        let payload = json!({ "t": t, "d": d }).to_string();
        for u in users {
            self.send_raw(u, &payload);
        }
    }

    pub fn kick_user(&self, user_id: &str) {
        // closing senders ends the socket loops
        self.conns.remove(user_id);
    }
}

pub async fn guild_member_ids(db: &SqlitePool, guild_id: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT user_id FROM members WHERE guild_id = ?")
        .bind(guild_id)
        .fetch_all(db)
        .await
        .unwrap_or_default()
}

pub async fn channel_audience(db: &SqlitePool, ch: &Channel) -> Vec<String> {
    match &ch.guild_id {
        Some(g) => guild_member_ids(db, g).await,
        None => sqlx::query_scalar("SELECT user_id FROM dm_members WHERE channel_id = ?")
            .bind(&ch.id)
            .fetch_all(db)
            .await
            .unwrap_or_default(),
    }
}

impl AppState {
    pub async fn emit_guild(&self, guild_id: &str, t: &str, d: &impl Serialize) {
        let ids = guild_member_ids(&self.db, guild_id).await;
        self.hub.send_users(&ids, t, d);
    }
    pub async fn emit_channel(&self, ch: &Channel, t: &str, d: &impl Serialize) {
        let ids = channel_audience(&self.db, ch).await;
        self.hub.send_users(&ids, t, d);
    }
    /// Everyone who shares a guild or DM with this user (for presence/profile updates).
    pub async fn related_users(&self, user_id: &str) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT DISTINCT m2.user_id FROM members m1 JOIN members m2 ON m1.guild_id = m2.guild_id WHERE m1.user_id = ?1
             UNION SELECT DISTINCT d2.user_id FROM dm_members d1 JOIN dm_members d2 ON d1.channel_id = d2.channel_id WHERE d1.user_id = ?1",
        )
        .bind(user_id)
        .fetch_all(&self.db)
        .await
        .unwrap_or_default()
    }
    pub async fn emit_related(&self, user_id: &str, t: &str, d: &Value) {
        let ids = self.related_users(user_id).await;
        self.hub.send_users(&ids, t, d);
    }
}

#[derive(Clone, Debug)]
pub struct AuthUser {
    pub id: String,
    pub is_admin: bool,
    pub token_hash: String,
}

pub fn token_from_parts(parts: &Parts) -> Option<String> {
    if let Some(h) = parts.headers.get("authorization").and_then(|v| v.to_str().ok()) {
        if let Some(t) = h.strip_prefix("Bearer ") {
            return Some(t.trim().to_string());
        }
    }
    let q = parts.uri.query()?;
    url::form_urlencoded::parse(q.as_bytes())
        .find(|(k, _)| k == "access_token")
        .map(|(_, v)| v.into_owned())
}

pub async fn auth_token(state: &AppState, token: &str) -> Result<AuthUser, AppError> {
    let hash = sha256_hex(token.as_bytes());
    let row: Option<(String, bool, i64)> = sqlx::query_as(
        "SELECT s.user_id, u.is_admin, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    let Some((id, is_admin, last_seen)) = row else { return Err(AppError::unauthorized()) };
    let now = now_ms();
    if now - last_seen > 60_000 {
        let _ = sqlx::query("UPDATE sessions SET last_seen = ? WHERE token_hash = ?")
            .bind(now)
            .bind(&hash)
            .execute(&state.db)
            .await;
    }
    Ok(AuthUser { id, is_admin, token_hash: hash })
}

impl FromRequestParts<Shared> for AuthUser {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &Shared) -> Result<Self, Self::Rejection> {
        let token = token_from_parts(parts).ok_or_else(AppError::unauthorized)?;
        auth_token(state, &token).await
    }
}
