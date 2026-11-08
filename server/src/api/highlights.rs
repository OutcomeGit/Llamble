//! Home → highlights: messages (pictures, posts, links) and show recordings a server wants
//! to remember. Anyone can add one; AI pictures and finished recordings can be added
//! automatically (per-server settings). Everyone only ever sees highlights whose source
//! they're allowed to see.
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::models::{get_user, load_channel, load_message, Channel};
use crate::perms::{self, require_channel, require_guild};
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

/// Notes and highlights tables (run after shows::migrate: highlights reference shows).
pub async fn migrate(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    sqlx::raw_sql(
        r#"
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'yellow',
    audience TEXT NOT NULL DEFAULT 'everyone',   -- everyone | people
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notes_guild ON notes(guild_id, created_at);
CREATE TABLE IF NOT EXISTS note_targets (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_note_targets_user ON note_targets(user_id);
CREATE TABLE IF NOT EXISTS note_reads (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at INTEGER NOT NULL,
    dismissed_at INTEGER,
    PRIMARY KEY (note_id, user_id)
);
CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                            -- message | recording
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    show_id TEXT REFERENCES shows(id) ON DELETE CASCADE,
    added_by TEXT NOT NULL,
    auto INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_highlights_msg ON highlights(guild_id, message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_highlights_show ON highlights(guild_id, show_id) WHERE show_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_highlights_guild ON highlights(guild_id, created_at);
"#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(sqlx::FromRow, Clone)]
struct Row {
    id: String,
    guild_id: String,
    kind: String,
    message_id: Option<String>,
    show_id: Option<String>,
    added_by: String,
    auto: bool,
    created_at: i64,
}

const COLS: &str = "id, guild_id, kind, message_id, show_id, added_by, auto, created_at";

/// A user as a permission subject (for working out what someone else may see).
pub async fn subject(state: &Shared, uid: &str) -> Option<AuthUser> {
    let r: Option<(bool, String, bool)> = sqlx::query_as("SELECT is_admin, instance_role, is_kid FROM users WHERE id = ?").bind(uid).fetch_optional(&state.db).await.ok().flatten();
    r.map(|(is_admin, role, is_kid)| AuthUser { id: uid.to_string(), is_admin, is_master: role == "master", is_kid, token_hash: String::new() })
}

/// The highlight as `who` sees it, or None if they can't see its source.
async fn to_json(state: &Shared, who: &AuthUser, r: &Row) -> Option<Value> {
    let (channel_id, message, recording) = match r.kind.as_str() {
        "message" => {
            let msg = load_message(&state.db, r.message_id.as_deref()?).await.ok()?;
            let ch = load_channel(&state.db, &msg.channel_id).await.ok()?;
            require_channel(&state.db, &ch, &who.id, perms::VIEW).await.ok()?;
            (Some(ch.id), serde_json::to_value(&msg).ok()?, Value::Null)
        }
        "recording" => {
            let sid = r.show_id.as_deref()?;
            let rec = crate::shows::recording_for(state, who, sid).await?;
            let ch = crate::shows::show_channel(state, sid).await.map(|c| c.0);
            (ch, Value::Null, rec)
        }
        _ => return None,
    };
    let added_by = get_user(&state.db, &r.added_by).await.ok().and_then(|u| serde_json::to_value(u).ok()).unwrap_or(Value::Null);
    Some(json!({
        "id": r.id, "guild_id": r.guild_id, "kind": r.kind, "added_by": added_by, "auto": r.auto,
        "created_at": r.created_at, "channel_id": channel_id, "message": message, "recording": recording,
    }))
}

async fn load_row(state: &Shared, id: &str) -> ApiResult<Row> {
    sqlx::query_as::<_, Row>(&format!("SELECT {COLS} FROM highlights WHERE id = ?"))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(AppError::not_found)
}

/// Tell each member of the server about a new highlight, as they would see it.
async fn announce(state: &Shared, r: &Row) {
    for uid in crate::state::guild_member_ids(&state.db, &r.guild_id).await {
        let Some(who) = subject(state, &uid).await else { continue };
        if let Some(v) = to_json(state, &who, r).await {
            state.hub.send_users(&[uid], "HIGHLIGHT_CREATE", &v);
        }
    }
}

/// Insert (or find) a highlight. Returns the row and whether it's new.
async fn insert(state: &Shared, gid: &str, kind: &str, message_id: Option<&str>, show_id: Option<&str>, added_by: &str, auto: bool) -> ApiResult<(Row, bool)> {
    let col = if kind == "message" { "message_id" } else { "show_id" };
    let key = message_id.or(show_id).unwrap_or_default();
    let existing: Option<String> = sqlx::query_scalar(&format!("SELECT id FROM highlights WHERE guild_id = ? AND {col} = ?")).bind(gid).bind(key).fetch_optional(&state.db).await?;
    if let Some(id) = existing {
        return Ok((load_row(state, &id).await?, false));
    }
    let id = new_id();
    sqlx::query("INSERT INTO highlights (id, guild_id, kind, message_id, show_id, added_by, auto, created_at) VALUES (?,?,?,?,?,?,?,?)")
        .bind(&id)
        .bind(gid)
        .bind(kind)
        .bind(message_id)
        .bind(show_id)
        .bind(added_by)
        .bind(auto)
        .bind(now_ms())
        .execute(&state.db)
        .await?;
    let r = load_row(state, &id).await?;
    announce(state, &r).await;
    Ok((r, true))
}

#[derive(Deserialize)]
pub struct ListQ {
    pub before: Option<i64>,
    pub limit: Option<i64>,
}

async fn visible_rows(state: &Shared, who: &AuthUser, sql: &str, binds: &[&str], before: i64, limit: usize) -> ApiResult<Vec<Value>> {
    let mut out = vec![];
    let mut cursor = before;
    // some rows may be hidden from this person: keep paging until we have enough
    for _ in 0..5 {
        let mut q = sqlx::query_as::<_, Row>(sql);
        for b in binds {
            q = q.bind(*b);
        }
        let rows = q.bind(cursor).bind((limit * 2) as i64).fetch_all(&state.db).await?;
        let n = rows.len();
        for r in &rows {
            cursor = r.created_at;
            if let Some(v) = to_json(state, who, r).await {
                out.push(v);
                if out.len() >= limit {
                    return Ok(out);
                }
            }
        }
        if n < limit * 2 {
            break;
        }
    }
    Ok(out)
}

/// GET /api/guilds/{gid}/highlights?before=&limit=
pub async fn list(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>, Query(q): Query<ListQ>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::VIEW).await?;
    let limit = q.limit.unwrap_or(30).clamp(1, 50) as usize;
    let sql = format!("SELECT {COLS} FROM highlights WHERE guild_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?");
    Ok(Json(json!(visible_rows(&state, &auth, &sql, &[&gid], q.before.unwrap_or(i64::MAX), limit).await?)))
}

/// Newest highlights across every server this person is in (for Home).
pub async fn for_home(state: &Shared, auth: &AuthUser, limit: usize) -> ApiResult<Vec<Value>> {
    let sql = format!(
        "SELECT {COLS} FROM highlights WHERE guild_id IN (SELECT guild_id FROM members WHERE user_id = ? UNION SELECT id FROM guilds WHERE owner_id = ?)
         AND created_at < ? ORDER BY created_at DESC LIMIT ?"
    );
    visible_rows(state, auth, &sql, &[&auth.id, &auth.id], i64::MAX, limit).await
}

#[derive(Deserialize)]
pub struct AddReq {
    pub message_id: Option<String>,
    pub show_id: Option<String>,
}

/// POST /api/guilds/{gid}/highlights { message_id } | { show_id }
pub async fn create(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>, Json(req): Json<AddReq>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::VIEW).await?;
    let (r, _) = match (req.message_id.as_deref(), req.show_id.as_deref()) {
        (Some(mid), None) => {
            let msg = load_message(&state.db, mid).await.map_err(|_| AppError::not_found())?;
            let ch = load_channel(&state.db, &msg.channel_id).await?;
            if ch.guild_id.as_deref() != Some(gid.as_str()) {
                return Err(AppError::bad("that message isn't in this server"));
            }
            require_channel(&state.db, &ch, &auth.id, perms::VIEW).await?;
            insert(&state, &gid, "message", Some(mid), None, &auth.id, false).await?
        }
        (None, Some(sid)) => {
            let (cid, _) = crate::shows::show_channel(&state, sid).await.ok_or_else(AppError::not_found)?;
            let ch = load_channel(&state.db, &cid).await?;
            if ch.guild_id.as_deref() != Some(gid.as_str()) {
                return Err(AppError::bad("that recording isn't from this server"));
            }
            if crate::shows::recording_for(&state, &auth, sid).await.is_none() {
                return Err(AppError::not_found());
            }
            insert(&state, &gid, "recording", None, Some(sid), &auth.id, false).await?
        }
        _ => return Err(AppError::bad("give either message_id or show_id")),
    };
    Ok(Json(to_json(&state, &auth, &r).await.ok_or_else(AppError::not_found)?))
}

/// DELETE /api/highlights/{id} (whoever added it, or MANAGE_MESSAGES)
pub async fn delete(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let r = load_row(&state, &id).await?;
    let p = require_guild(&state.db, &r.guild_id, &auth.id, perms::VIEW).await?;
    if r.added_by != auth.id && p & perms::MANAGE_MESSAGES == 0 {
        return Err(AppError::forbidden());
    }
    sqlx::query("DELETE FROM highlights WHERE id = ?").bind(&id).execute(&state.db).await?;
    state.emit_guild(&r.guild_id, "HIGHLIGHT_DELETE", &json!({ "id": id, "guild_id": r.guild_id })).await;
    Ok(Json(json!({ "ok": true })))
}

/// Before a message or recording is deleted: drop its highlights and tell everyone.
/// (The database would remove them anyway; this keeps open Home pages in sync.)
pub async fn forget(state: &Shared, col: &str, id: &str) {
    let col = if col == "show_id" { "show_id" } else { "message_id" };
    let rows: Vec<(String, String)> = sqlx::query_as(&format!("SELECT id, guild_id FROM highlights WHERE {col} = ?")).bind(id).fetch_all(&state.db).await.unwrap_or_default();
    for (hid, gid) in rows {
        let _ = sqlx::query("DELETE FROM highlights WHERE id = ?").bind(&hid).execute(&state.db).await;
        state.emit_guild(&gid, "HIGHLIGHT_DELETE", &json!({ "id": hid, "guild_id": gid })).await;
    }
}

async fn auto_on(state: &Shared, gid: &str, col: &str) -> bool {
    let col = if col == "pictures" { "highlights_auto_pictures" } else { "highlights_auto_recordings" };
    sqlx::query_scalar::<_, bool>(&format!("SELECT {col} FROM guilds WHERE id = ?")).bind(gid).fetch_optional(&state.db).await.ok().flatten().unwrap_or(false)
}

/// An AI picture was posted in a server channel.
pub async fn auto_picture(state: &Shared, ch: &Channel, message_id: &str, drawn_for: &str) {
    let Some(gid) = ch.guild_id.as_deref() else { return };
    if !auto_on(state, gid, "pictures").await {
        return;
    }
    if let Err(e) = insert(state, gid, "message", Some(message_id), None, drawn_for, true).await {
        tracing::warn!("auto highlight (picture): {e:?}");
    }
}

/// A show recording finished.
pub async fn auto_recording(state: &Shared, show_id: &str, initiator: &str) {
    let Some((cid, _)) = crate::shows::show_channel(state, show_id).await else { return };
    let Ok(ch) = load_channel(&state.db, &cid).await else { return };
    let Some(gid) = ch.guild_id.as_deref() else { return };
    if !auto_on(state, gid, "recordings").await {
        return;
    }
    if let Err(e) = insert(state, gid, "recording", None, Some(show_id), initiator, true).await {
        tracing::warn!("auto highlight (recording): {e:?}");
    }
}
