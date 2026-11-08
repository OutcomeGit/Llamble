//! Soundboard: short clips anyone in a voice channel can play for everyone in it.
//! Each server keeps its own sounds (uploaded by people who can manage the server);
//! the built-in starter sounds ship with the app. Clients play the clip themselves,
//! so everyone can set their own soundboard volume or mute it.
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::models::{get_file, load_channel};
use crate::perms::{self, require_channel, require_guild};
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, State};
use axum::Json;
use dashmap::DashMap;
use serde::Deserialize;
use serde_json::{json, Value};

/// largest clip file, and most sounds per server
const MAX_BYTES: i64 = 1024 * 1024;
const MAX_SOUNDS: i64 = 60;
/// one sound per person every this many ms
const COOLDOWN_MS: i64 = 1500;

pub const BUILTIN: &[&str] = &["airhorn", "rimshot", "crickets", "sad-trombone", "boing", "drumroll", "applause", "tada", "whoosh", "bonk"];

static LAST_PLAY: once_cell::sync::Lazy<DashMap<String, i64>> = once_cell::sync::Lazy::new(Default::default);

pub async fn migrate(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    sqlx::raw_sql(
        r#"
CREATE TABLE IF NOT EXISTS sounds (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '',
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    volume REAL NOT NULL DEFAULT 1.0,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sounds_guild ON sounds(guild_id);
"#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn sound_list(state: &Shared, gid: &str) -> ApiResult<Vec<Value>> {
    let rows: Vec<(String, String, String, String, f64, String)> =
        sqlx::query_as("SELECT id, name, emoji, file_id, volume, created_by FROM sounds WHERE guild_id = ? ORDER BY created_at")
            .bind(gid)
            .fetch_all(&state.db)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, emoji, file_id, volume, by)| json!({ "id": id, "name": name, "emoji": emoji, "file_id": file_id, "volume": volume, "created_by": by }))
        .collect())
}

pub async fn list(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::VIEW).await?;
    Ok(Json(json!({ "builtin": BUILTIN, "sounds": sound_list(&state, &gid).await? })))
}

#[derive(Deserialize)]
pub struct NewSound {
    pub name: String,
    #[serde(default)]
    pub emoji: String,
    pub file_id: String,
    pub volume: Option<f64>,
}

pub async fn add(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>, Json(req): Json<NewSound>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::MANAGE_GUILD).await?;
    let name: String = req.name.trim().chars().take(32).collect();
    if name.is_empty() {
        return Err(AppError::bad("give the sound a name"));
    }
    let f = get_file(&state.db, &req.file_id).await.map_err(|_| AppError::bad("unknown file"))?;
    if f.uploader_id != auth.id {
        return Err(AppError::bad("unknown file"));
    }
    if !f.mime.starts_with("audio/") {
        return Err(AppError::bad("that isn't an audio file (use mp3, ogg, wav or m4a)"));
    }
    if f.size > MAX_BYTES {
        return Err(AppError::bad("sound files can be up to 1 MB (about 5 seconds)"));
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sounds WHERE guild_id = ?").bind(&gid).fetch_one(&state.db).await?;
    if count >= MAX_SOUNDS {
        return Err(AppError::bad("this server already has the most sounds it can (60); delete one first"));
    }
    let id = new_id();
    sqlx::query("INSERT INTO sounds (id, guild_id, name, emoji, file_id, volume, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)")
        .bind(&id)
        .bind(&gid)
        .bind(&name)
        .bind(req.emoji.chars().take(8).collect::<String>())
        .bind(&req.file_id)
        .bind(req.volume.unwrap_or(1.0).clamp(0.05, 1.0))
        .bind(&auth.id)
        .bind(now_ms())
        .execute(&state.db)
        .await?;
    announce(&state, &gid).await;
    Ok(Json(json!({ "id": id })))
}

pub async fn remove(State(state): State<Shared>, auth: AuthUser, Path((gid, sid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::MANAGE_GUILD).await?;
    sqlx::query("DELETE FROM sounds WHERE id = ? AND guild_id = ?").bind(&sid).bind(&gid).execute(&state.db).await?;
    announce(&state, &gid).await;
    Ok(Json(json!({ "ok": true })))
}

async fn announce(state: &Shared, gid: &str) {
    if let Ok(list) = sound_list(state, gid).await {
        let members: Vec<String> = sqlx::query_scalar("SELECT user_id FROM members WHERE guild_id = ?").bind(gid).fetch_all(&state.db).await.unwrap_or_default();
        state.hub.send_users(&members, "SOUNDS_UPDATE", &json!({ "guild_id": gid, "sounds": list }));
    }
}

#[derive(Deserialize)]
pub struct Play {
    /// a server sound id, or "builtin:NAME"
    pub sound: String,
}

pub async fn play(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<Play>) -> ApiResult<Json<Value>> {
    let ch = load_channel(&state.db, &cid).await?;
    require_channel(&state.db, &ch, &auth.id, perms::VIEW | perms::SPEAK).await?;
    crate::kids::check_quiet(&state, &auth.id).await?;
    let in_channel = state.hub.voice.get(&auth.id).map(|v| v.channel_id == cid).unwrap_or(false);
    if !in_channel {
        return Err(AppError::bad("join the voice channel to play sounds"));
    }
    let now = now_ms();
    if let Some(last) = LAST_PLAY.get(&auth.id) {
        if now - *last < COOLDOWN_MS {
            return Err(AppError::bad("slow down a little"));
        }
    }
    LAST_PLAY.insert(auth.id.clone(), now);

    let sound = if let Some(name) = req.sound.strip_prefix("builtin:") {
        if !BUILTIN.contains(&name) {
            return Err(AppError::bad("unknown sound"));
        }
        json!({ "builtin": name, "name": name, "volume": 1.0 })
    } else {
        let gid = ch.guild_id.clone().ok_or_else(|| AppError::bad("unknown sound"))?;
        let row: Option<(String, String, String, f64)> = sqlx::query_as("SELECT id, name, file_id, volume FROM sounds WHERE id = ? AND guild_id = ?")
            .bind(&req.sound)
            .bind(&gid)
            .fetch_optional(&state.db)
            .await?;
        let (id, name, file_id, volume) = row.ok_or_else(|| AppError::bad("unknown sound"))?;
        json!({ "id": id, "name": name, "file_id": file_id, "volume": volume })
    };
    let listeners: Vec<String> = state.hub.voice.iter().filter(|v| v.channel_id == cid).map(|v| v.user_id.clone()).collect();
    state.hub.send_users(&listeners, "SOUNDBOARD_PLAY", &json!({ "channel_id": cid, "user_id": auth.id, "sound": sound }));
    Ok(Json(json!({ "ok": true })))
}
