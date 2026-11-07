use crate::error::{now_ms, new_id, ApiResult, AppError};
use crate::models::*;
use crate::perms::{self, require_channel};
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct ListQ {
    pub before: Option<String>,
    pub after: Option<String>,
    pub around: Option<String>,
    pub limit: Option<i64>,
}

pub async fn list_messages(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Query(q): Query<ListQ>) -> ApiResult<Json<Vec<Message>>> {
    let ch = load_channel(&state.db, &cid).await?;
    require_channel(&state.db, &ch, &auth.id, perms::VIEW).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let rows = if let Some(after) = q.after {
        let mut r = sqlx::query_as::<_, MessageRow>(&format!(
            "SELECT {MSG_COLS} FROM messages WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT ?"
        ))
        .bind(&cid).bind(after).bind(limit).fetch_all(&state.db).await?;
        r.reverse();
        r
    } else if let Some(around) = q.around {
        let half = limit / 2;
        let mut newer = sqlx::query_as::<_, MessageRow>(&format!(
            "SELECT {MSG_COLS} FROM messages WHERE channel_id = ? AND id >= ? ORDER BY id ASC LIMIT ?"
        ))
        .bind(&cid).bind(&around).bind(half.max(1)).fetch_all(&state.db).await?;
        newer.reverse();
        let older = sqlx::query_as::<_, MessageRow>(&format!(
            "SELECT {MSG_COLS} FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?"
        ))
        .bind(&cid).bind(&around).bind(limit - half).fetch_all(&state.db).await?;
        newer.extend(older);
        newer
    } else {
        sqlx::query_as::<_, MessageRow>(&format!(
            "SELECT {MSG_COLS} FROM messages WHERE channel_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?"
        ))
        .bind(&cid).bind(&q.before).bind(&q.before).bind(limit).fetch_all(&state.db).await?
    };
    // newest first
    Ok(Json(hydrate_messages(&state.db, rows).await?))
}

#[derive(Deserialize)]
pub struct AttachRef {
    pub id: String,
    #[serde(default)]
    pub spoiler: bool,
}

#[derive(Deserialize)]
pub struct CreateMsg {
    #[serde(default)]
    pub content: String,
    pub reply_to: Option<String>,
    #[serde(default)]
    pub attachments: Vec<AttachRef>,
    pub nonce: Option<String>,
}

pub async fn create_message(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<CreateMsg>) -> ApiResult<Json<Value>> {
    let ch = load_channel(&state.db, &cid).await?;
    if ch.kind == "category" {
        return Err(AppError::bad("can't post in a category"));
    }
    let mut need = perms::VIEW | perms::SEND;
    if !req.attachments.is_empty() {
        need |= perms::ATTACH;
    }
    let p = require_channel(&state.db, &ch, &auth.id, need).await?;
    let content = req.content.trim_end().to_string();
    if content.chars().count() > 4000 {
        return Err(AppError::bad("message too long (4000 max)"));
    }
    if content.trim().is_empty() && req.attachments.is_empty() {
        return Err(AppError::bad("empty message"));
    }
    if req.attachments.len() > 10 {
        return Err(AppError::bad("max 10 attachments"));
    }
    for a in &req.attachments {
        let f = get_file(&state.db, &a.id).await.map_err(|_| AppError::bad("unknown attachment"))?;
        if f.uploader_id != auth.id {
            let is_gif: Option<i64> = sqlx::query_scalar("SELECT 1 FROM gifs WHERE file_id = ?")
                .bind(&a.id).fetch_optional(&state.db).await?;
            if is_gif.is_none() {
                return Err(AppError::bad("unknown attachment"));
            }
            let _ = sqlx::query("UPDATE gifs SET uses = uses + 1 WHERE file_id = ?").bind(&a.id).execute(&state.db).await;
        }
    }
    let reply_to = match req.reply_to {
        Some(r) => {
            let ok: Option<i64> = sqlx::query_scalar("SELECT 1 FROM messages WHERE id = ? AND channel_id = ?")
                .bind(&r).bind(&cid).fetch_optional(&state.db).await?;
            ok.map(|_| r)
        }
        None => None,
    };
    let id = new_id();
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO messages (id, channel_id, author_id, content, reply_to, created_at) VALUES (?,?,?,?,?,?)")
        .bind(&id).bind(&cid).bind(&auth.id).bind(&content).bind(&reply_to).bind(now_ms())
        .execute(&mut *tx).await?;
    for (i, a) in req.attachments.iter().enumerate() {
        sqlx::query("INSERT OR IGNORE INTO message_attachments (message_id, file_id, position, spoiler) VALUES (?,?,?,?)")
            .bind(&id).bind(&a.id).bind(i as i64).bind(a.spoiler).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT OR REPLACE INTO read_states (user_id, channel_id, last_read_id) VALUES (?,?,?)")
        .bind(&auth.id).bind(&cid).bind(&id).execute(&mut *tx).await?;
    tx.commit().await?;

    let msg = load_message(&state.db, &id).await?;
    let mut payload = serde_json::to_value(&msg).unwrap();
    if let Some(n) = req.nonce {
        payload["nonce"] = json!(n);
    }
    payload["guild_id"] = json!(ch.guild_id);
    state.emit_channel(&ch, "MESSAGE_CREATE", &payload).await;

    if p & perms::EMBED_LINKS != 0 && state.s().unfurl_links {
        crate::api::embeds::spawn_unfurl(state.clone(), ch.clone(), id.clone(), content.clone());
    }
    crate::bot::maybe_respond(&state, &ch, &id, &auth.id, &content, reply_to.as_deref()).await;
    Ok(Json(payload))
}

async fn get_msg_and_channel(state: &Shared, mid: &str) -> ApiResult<(MessageRow, Channel)> {
    let row = sqlx::query_as::<_, MessageRow>(&format!("SELECT {MSG_COLS} FROM messages WHERE id = ?"))
        .bind(mid).fetch_one(&state.db).await?;
    let ch = load_channel(&state.db, &row.channel_id).await?;
    Ok((row, ch))
}

#[derive(Deserialize)]
pub struct EditMsg {
    pub content: String,
}

pub async fn edit_message(State(state): State<Shared>, auth: AuthUser, Path(mid): Path<String>, Json(req): Json<EditMsg>) -> ApiResult<Json<Message>> {
    let (row, ch) = get_msg_and_channel(&state, &mid).await?;
    let p = require_channel(&state.db, &ch, &auth.id, perms::VIEW).await?;
    if row.author_id != auth.id {
        return Err(AppError::forbidden());
    }
    let content = req.content.trim_end().to_string();
    if content.chars().count() > 4000 {
        return Err(AppError::bad("message too long"));
    }
    sqlx::query("UPDATE messages SET content = ?, edited_at = ?, embeds = '[]' WHERE id = ?")
        .bind(&content).bind(now_ms()).bind(&mid).execute(&state.db).await?;
    let msg = load_message(&state.db, &mid).await?;
    state.emit_channel(&ch, "MESSAGE_UPDATE", &msg).await;
    if p & perms::EMBED_LINKS != 0 && state.s().unfurl_links {
        crate::api::embeds::spawn_unfurl(state.clone(), ch, mid, content);
    }
    Ok(Json(msg))
}

pub async fn delete_message(State(state): State<Shared>, auth: AuthUser, Path(mid): Path<String>) -> ApiResult<Json<Value>> {
    let (row, ch) = get_msg_and_channel(&state, &mid).await?;
    let p = require_channel(&state.db, &ch, &auth.id, perms::VIEW).await?;
    if row.author_id != auth.id && p & perms::MANAGE_MESSAGES == 0 {
        return Err(AppError::forbidden());
    }
    sqlx::query("DELETE FROM messages WHERE id = ?").bind(&mid).execute(&state.db).await?;
    state.emit_channel(&ch, "MESSAGE_DELETE", &json!({ "id": mid, "channel_id": ch.id })).await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn add_reaction(State(state): State<Shared>, auth: AuthUser, Path((mid, emoji)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let (_, ch) = get_msg_and_channel(&state, &mid).await?;
    require_channel(&state.db, &ch, &auth.id, perms::VIEW | perms::REACT).await?;
    let emoji: String = emoji.chars().take(64).collect();
    if emoji.trim().is_empty() {
        return Err(AppError::bad("emoji required"));
    }
    let distinct: i64 = sqlx::query_scalar("SELECT COUNT(DISTINCT emoji) FROM reactions WHERE message_id = ?")
        .bind(&mid).fetch_one(&state.db).await?;
    if distinct >= 20 {
        return Err(AppError::bad("too many reactions"));
    }
    sqlx::query("INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)")
        .bind(&mid).bind(&auth.id).bind(&emoji).bind(now_ms()).execute(&state.db).await?;
    state.emit_channel(&ch, "REACTION_ADD", &json!({ "message_id": mid, "channel_id": ch.id, "user_id": auth.id, "emoji": emoji })).await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn remove_reaction(State(state): State<Shared>, auth: AuthUser, Path((mid, emoji)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let (_, ch) = get_msg_and_channel(&state, &mid).await?;
    require_channel(&state.db, &ch, &auth.id, perms::VIEW).await?;
    sqlx::query("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
        .bind(&mid).bind(&auth.id).bind(&emoji).execute(&state.db).await?;
    state.emit_channel(&ch, "REACTION_REMOVE", &json!({ "message_id": mid, "channel_id": ch.id, "user_id": auth.id, "emoji": emoji })).await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn typing(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    let ch = load_channel(&state.db, &cid).await?;
    require_channel(&state.db, &ch, &auth.id, perms::VIEW | perms::SEND).await?;
    state.emit_channel(&ch, "TYPING_START", &json!({ "channel_id": cid, "user_id": auth.id, "ts": now_ms() })).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct Ack {
    pub message_id: String,
}

pub async fn ack(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<Ack>) -> ApiResult<Json<Value>> {
    let ch = load_channel(&state.db, &cid).await?;
    require_channel(&state.db, &ch, &auth.id, perms::VIEW).await?;
    sqlx::query(
        "INSERT INTO read_states (user_id, channel_id, last_read_id) VALUES (?,?,?)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)",
    )
    .bind(&auth.id).bind(&cid).bind(&req.message_id).execute(&state.db).await?;
    state.hub.send_user(&auth.id, "READ_STATE_UPDATE", &json!({ "channel_id": cid, "last_read_id": req.message_id }));
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct SearchQ {
    pub q: String,
    pub limit: Option<i64>,
}

/// Simple per-channel substring search.
pub async fn search(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Query(q): Query<SearchQ>) -> ApiResult<Json<Vec<Message>>> {
    let ch = load_channel(&state.db, &cid).await?;
    require_channel(&state.db, &ch, &auth.id, perms::VIEW).await?;
    let term = q.q.trim();
    if term.len() < 2 {
        return Ok(Json(vec![]));
    }
    let like = format!("%{}%", term.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows = sqlx::query_as::<_, MessageRow>(&format!(
        "SELECT {MSG_COLS} FROM messages WHERE channel_id = ? AND content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?"
    ))
    .bind(&cid).bind(like).bind(q.limit.unwrap_or(25).clamp(1, 100)).fetch_all(&state.db).await?;
    Ok(Json(hydrate_messages(&state.db, rows).await?))
}

// ---------- DMs ----------

#[derive(Deserialize)]
pub struct OpenDm {
    pub recipient_id: String,
}

pub async fn open_dm(State(state): State<Shared>, auth: AuthUser, Json(req): Json<OpenDm>) -> ApiResult<Json<Value>> {
    if req.recipient_id == auth.id {
        return Err(AppError::bad("can't DM yourself"));
    }
    let shares: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM members a JOIN members b ON a.guild_id = b.guild_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1",
    ).bind(&auth.id).bind(&req.recipient_id).fetch_optional(&state.db).await?;
    if shares.is_none() && !auth.is_admin {
        return Err(AppError::forbidden());
    }
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT a.channel_id FROM dm_members a JOIN dm_members b ON a.channel_id = b.channel_id
         WHERE a.user_id = ? AND b.user_id = ?
         AND (SELECT COUNT(*) FROM dm_members c WHERE c.channel_id = a.channel_id) = 2 LIMIT 1",
    ).bind(&auth.id).bind(&req.recipient_id).fetch_optional(&state.db).await?;
    let cid = match existing {
        Some(c) => c,
        None => {
            let c = new_id();
            sqlx::query("INSERT INTO channels (id, guild_id, kind, created_at) VALUES (?, NULL, 'dm', ?)")
                .bind(&c).bind(now_ms()).execute(&state.db).await?;
            for u in [&auth.id, &req.recipient_id] {
                sqlx::query("INSERT INTO dm_members (channel_id, user_id) VALUES (?,?)").bind(&c).bind(u).execute(&state.db).await?;
            }
            c
        }
    };
    let payload = dm_payload(&state, &cid).await?;
    state.hub.send_users(&[auth.id.clone(), req.recipient_id.clone()], "CHANNEL_CREATE", &payload);
    Ok(Json(payload))
}

pub async fn dm_payload(state: &Shared, cid: &str) -> ApiResult<Value> {
    let ch = load_channel(&state.db, cid).await?;
    let ids: Vec<String> = sqlx::query_scalar("SELECT user_id FROM dm_members WHERE channel_id = ?")
        .bind(cid).fetch_all(&state.db).await?;
    let users = load_users(&state.db, &ids).await?;
    let mut v = serde_json::to_value(&ch).unwrap();
    v["recipients"] = json!(users.values().collect::<Vec<_>>());
    Ok(v)
}
