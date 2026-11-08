//! Notes: sticky notes on a server's board, for everyone there or for picked people.
//! Unlike DMs they're not a conversation: each stays pinned until dismissed or expired,
//! and its author can see who has read it. Home shows every note addressed to you.
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::models::get_user;
use crate::perms::{self, require_guild};
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

const COLORS: [&str; 5] = ["yellow", "pink", "blue", "green", "purple"];
const MAX_TARGETS: usize = 50;
const MAX_AHEAD_MS: i64 = 90 * 24 * 3600 * 1000;

#[derive(sqlx::FromRow, Clone)]
struct NoteRow {
    id: String,
    guild_id: String,
    author_id: String,
    content: String,
    color: String,
    audience: String,
    expires_at: Option<i64>,
    created_at: i64,
    edited_at: Option<i64>,
}

const COLS: &str = "n.id, n.guild_id, n.author_id, n.content, n.color, n.audience, n.expires_at, n.created_at, n.edited_at";

async fn targets(state: &Shared, note: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT user_id FROM note_targets WHERE note_id = ?").bind(note).fetch_all(&state.db).await.unwrap_or_default()
}

async fn read_count(state: &Shared, n: &NoteRow) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM note_reads WHERE note_id = ? AND user_id != ?").bind(&n.id).bind(&n.author_id).fetch_one(&state.db).await.unwrap_or(0)
}

/// The note as `viewer` sees it.
async fn note_json(state: &Shared, n: &NoteRow, viewer: &str) -> ApiResult<Value> {
    let author = get_user(&state.db, &n.author_id).await?;
    let to = if n.audience == "people" { targets(state, &n.id).await } else { vec![] };
    let mine: Option<(i64, Option<i64>)> = sqlx::query_as("SELECT read_at, dismissed_at FROM note_reads WHERE note_id = ? AND user_id = ?")
        .bind(&n.id)
        .bind(viewer)
        .fetch_optional(&state.db)
        .await?;
    let target_count = if n.audience == "people" {
        to.len() as i64
    } else {
        // people who could read it: members other than the author, not counting bots
        sqlx::query_scalar("SELECT COUNT(*) FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ? AND m.user_id != ? AND u.is_bot = 0")
            .bind(&n.guild_id)
            .bind(&n.author_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0)
    };
    Ok(json!({
        "id": n.id, "guild_id": n.guild_id, "author": author, "content": n.content, "color": n.color,
        "audience": n.audience, "to": to, "expires_at": n.expires_at, "created_at": n.created_at, "edited_at": n.edited_at,
        "read": viewer == n.author_id || mine.is_some(),
        "dismissed": mine.and_then(|m| m.1).is_some(),
        "read_count": read_count(state, n).await,
        "target_count": target_count,
    }))
}

/// Everyone who can see the note (author included).
async fn audience(state: &Shared, n: &NoteRow) -> Vec<String> {
    let members = crate::state::guild_member_ids(&state.db, &n.guild_id).await;
    let mut ids: Vec<String> = if n.audience == "people" {
        let t = targets(state, &n.id).await;
        members.into_iter().filter(|m| t.contains(m)).collect()
    } else {
        members
    };
    if !ids.contains(&n.author_id) {
        ids.push(n.author_id.clone());
    }
    ids
}

async fn load(state: &Shared, id: &str) -> ApiResult<NoteRow> {
    sqlx::query_as::<_, NoteRow>(&format!("SELECT {COLS} FROM notes n WHERE n.id = ?"))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(AppError::not_found)
}

/// The note, if `uid` may see it right now (member, addressed to them or everyone, not expired).
async fn load_visible(state: &Shared, id: &str, uid: &str) -> ApiResult<NoteRow> {
    let n = load(state, id).await?;
    require_guild(&state.db, &n.guild_id, uid, perms::VIEW).await?;
    let addressed = n.audience == "everyone" || n.author_id == uid || targets(state, &n.id).await.iter().any(|t| t == uid);
    let live = n.expires_at.map_or(true, |e| e > now_ms());
    if !addressed || !live {
        return Err(AppError::not_found());
    }
    Ok(n)
}

/// Send each person in the note's audience their own view of it.
async fn emit_each(state: &Shared, n: &NoteRow, t: &str) {
    for uid in audience(state, n).await {
        if let Ok(v) = note_json(state, n, &uid).await {
            state.hub.send_users(&[uid], t, &v);
        }
    }
}

/// Notes visible to `uid`. `guild`: one server's board (incl. own and dismissed) or None for
/// Home (every server, excluding own and dismissed).
async fn visible(state: &Shared, uid: &str, guild: Option<&str>) -> ApiResult<Vec<Value>> {
    let now = now_ms();
    let scope = match guild {
        Some(_) => "n.guild_id = ?3",
        None => "n.guild_id IN (SELECT guild_id FROM members WHERE user_id = ?1 UNION SELECT id FROM guilds WHERE owner_id = ?1)
                 AND n.author_id != ?1
                 AND NOT EXISTS (SELECT 1 FROM note_reads r WHERE r.note_id = n.id AND r.user_id = ?1 AND r.dismissed_at IS NOT NULL)",
    };
    let sql = format!(
        "SELECT {COLS} FROM notes n WHERE {scope}
           AND (n.expires_at IS NULL OR n.expires_at > ?2)
           AND (n.audience = 'everyone' OR n.author_id = ?1 OR EXISTS (SELECT 1 FROM note_targets t WHERE t.note_id = n.id AND t.user_id = ?1))
         ORDER BY n.created_at DESC LIMIT 200"
    );
    let mut q = sqlx::query_as::<_, NoteRow>(&sql).bind(uid).bind(now);
    if let Some(g) = guild {
        q = q.bind(g);
    }
    let rows = q.fetch_all(&state.db).await?;
    let mut out = vec![];
    for n in rows {
        out.push(note_json(state, &n, uid).await?);
    }
    Ok(out)
}

/// GET /api/home
pub async fn home(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let notes = visible(&state, &auth.id, None).await?;
    let highlights = crate::api::highlights::for_home(&state, &auth, 30).await?;
    Ok(Json(json!({ "notes": notes, "highlights": highlights })))
}

/// GET /api/guilds/{gid}/notes
pub async fn list(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::VIEW).await?;
    Ok(Json(json!(visible(&state, &auth.id, Some(&gid)).await?)))
}

fn clean_content(s: &str) -> ApiResult<String> {
    let c = s.trim().to_string();
    let n = c.chars().count();
    if n == 0 {
        return Err(AppError::bad("a note needs some text"));
    }
    if n > 2000 {
        return Err(AppError::bad("notes can be up to 2000 characters"));
    }
    Ok(c)
}

fn clean_color(c: Option<&str>) -> ApiResult<String> {
    let c = c.unwrap_or("yellow");
    if !COLORS.contains(&c) {
        return Err(AppError::bad("color must be yellow, pink, blue, green or purple"));
    }
    Ok(c.to_string())
}

fn clean_expiry(e: i64) -> ApiResult<i64> {
    let now = now_ms();
    if e <= now {
        return Err(AppError::bad("the note would already be expired"));
    }
    if e > now + MAX_AHEAD_MS {
        return Err(AppError::bad("notes can last up to 90 days"));
    }
    Ok(e)
}

#[derive(Deserialize)]
pub struct CreateNote {
    pub content: String,
    pub color: Option<String>,
    #[serde(default)]
    pub to: Vec<String>,
    pub expires_at: Option<i64>,
}

/// POST /api/guilds/{gid}/notes
pub async fn create(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>, Json(req): Json<CreateNote>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::VIEW).await?;
    crate::kids::check_quiet(&state, &auth.id).await?;
    let content = clean_content(&req.content)?;
    let color = clean_color(req.color.as_deref())?;
    let expires_at = req.expires_at.map(clean_expiry).transpose()?;
    let asked_for_people = !req.to.is_empty();
    let mut to: Vec<String> = vec![];
    for u in req.to {
        if u != auth.id && !to.contains(&u) {
            to.push(u);
        }
    }
    if asked_for_people && to.is_empty() {
        return Err(AppError::bad("pick someone other than yourself (or leave it for everyone)"));
    }
    if to.len() > MAX_TARGETS {
        return Err(AppError::bad("a note can go to up to 50 people (or to everyone)"));
    }
    let members = crate::state::guild_member_ids(&state.db, &gid).await;
    for u in &to {
        if !members.contains(u) {
            return Err(AppError::bad("everyone you pick has to be in this server"));
        }
        // kids: the same rule as starting a DM
        if let Err(kid) = crate::kids::dm_allowed(&state, &auth.id, u).await {
            let target = if kid == auth.id { u.clone() } else { auth.id.clone() };
            crate::kids::request(&state, &kid, "dm", &target).await?;
            return Err(AppError::forbidden_msg("A parent needs to approve notes between these two first. They've been asked."));
        }
    }
    let id = new_id();
    let audience = if to.is_empty() { "everyone" } else { "people" };
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO notes (id, guild_id, author_id, content, color, audience, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?)")
        .bind(&id)
        .bind(&gid)
        .bind(&auth.id)
        .bind(&content)
        .bind(&color)
        .bind(audience)
        .bind(expires_at)
        .bind(now_ms())
        .execute(&mut *tx)
        .await?;
    for u in &to {
        sqlx::query("INSERT INTO note_targets (note_id, user_id) VALUES (?,?)").bind(&id).bind(u).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    let n = load(&state, &id).await?;
    emit_each(&state, &n, "NOTE_CREATE").await;
    Ok(Json(note_json(&state, &n, &auth.id).await?))
}

/// PATCH /api/notes/{id} { content?, color?, expires_at?: ms|null } (author only)
pub async fn edit(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, Json(req): Json<Value>) -> ApiResult<Json<Value>> {
    let n = load(&state, &id).await?;
    if n.author_id != auth.id {
        return Err(AppError::forbidden());
    }
    if let Some(c) = req.get("content").and_then(|v| v.as_str()) {
        let c = clean_content(c)?;
        sqlx::query("UPDATE notes SET content = ?, edited_at = ? WHERE id = ?").bind(c).bind(now_ms()).bind(&id).execute(&state.db).await?;
    }
    if let Some(c) = req.get("color") {
        let c = clean_color(c.as_str())?;
        sqlx::query("UPDATE notes SET color = ? WHERE id = ?").bind(c).bind(&id).execute(&state.db).await?;
    }
    if let Some(e) = req.get("expires_at") {
        let e = match e {
            Value::Null => None,
            v => Some(clean_expiry(v.as_i64().ok_or_else(|| AppError::bad("expires_at must be a time in milliseconds or null"))?)?),
        };
        sqlx::query("UPDATE notes SET expires_at = ? WHERE id = ?").bind(e).bind(&id).execute(&state.db).await?;
    }
    let n = load(&state, &id).await?;
    emit_each(&state, &n, "NOTE_UPDATE").await;
    Ok(Json(note_json(&state, &n, &auth.id).await?))
}

/// DELETE /api/notes/{id} (author, or MANAGE_MESSAGES in that server)
pub async fn delete(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let n = load(&state, &id).await?;
    if n.author_id != auth.id {
        require_guild(&state.db, &n.guild_id, &auth.id, perms::MANAGE_MESSAGES).await?;
    }
    let who = audience(&state, &n).await;
    sqlx::query("DELETE FROM notes WHERE id = ?").bind(&id).execute(&state.db).await?;
    state.hub.send_users(&who, "NOTE_DELETE", &json!({ "id": id, "guild_id": n.guild_id }));
    Ok(Json(json!({ "ok": true })))
}

/// Mark read (and optionally dismissed); tells the author when someone reads it for the first time.
async fn mark(state: &Shared, id: &str, uid: &str, dismiss: bool) -> ApiResult<()> {
    let n = load_visible(state, id, uid).await?;
    let now = now_ms();
    let first = sqlx::query("INSERT OR IGNORE INTO note_reads (note_id, user_id, read_at) VALUES (?,?,?)").bind(id).bind(uid).bind(now).execute(&state.db).await?.rows_affected() > 0;
    if dismiss {
        sqlx::query("UPDATE note_reads SET dismissed_at = ? WHERE note_id = ? AND user_id = ?").bind(now).bind(id).bind(uid).execute(&state.db).await?;
    }
    if first && uid != n.author_id {
        let count = read_count(state, &n).await;
        state.hub.send_users(&[n.author_id.clone()], "NOTE_READ", &json!({ "id": id, "user_id": uid, "read_count": count }));
    }
    Ok(())
}

/// POST /api/notes/{id}/read
pub async fn read(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    mark(&state, &id, &auth.id, false).await?;
    Ok(Json(json!({ "ok": true })))
}

/// POST /api/notes/{id}/dismiss
pub async fn dismiss(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    mark(&state, &id, &auth.id, true).await?;
    Ok(Json(json!({ "ok": true })))
}

/// POST /api/notes/{id}/undismiss
pub async fn undismiss(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    load_visible(&state, &id, &auth.id).await?;
    sqlx::query("UPDATE note_reads SET dismissed_at = NULL WHERE note_id = ? AND user_id = ?").bind(&id).bind(&auth.id).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

/// GET /api/notes/{id}/reads (author only)
pub async fn reads(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let n = load(&state, &id).await?;
    if n.author_id != auth.id {
        return Err(AppError::forbidden());
    }
    let rows: Vec<(String, i64, Option<i64>)> = sqlx::query_as("SELECT user_id, read_at, dismissed_at FROM note_reads WHERE note_id = ? AND user_id != ? ORDER BY read_at")
        .bind(&id)
        .bind(&n.author_id)
        .fetch_all(&state.db)
        .await?;
    let mut out = vec![];
    for (u, read_at, dismissed_at) in rows {
        if let Ok(user) = get_user(&state.db, &u).await {
            out.push(json!({ "user": user, "read_at": read_at, "dismissed_at": dismissed_at }));
        }
    }
    Ok(Json(json!(out)))
}
