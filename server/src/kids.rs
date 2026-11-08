//! Kid accounts and their parents.
//!
//! A kid account is linked to one or more parent accounts (any regular account can be a
//! parent; it doesn't have to be an admin). Parents:
//! - create kid accounts directly (no invite), set their passwords
//! - read everything the kid can read, DMs included (read-only)
//! - approve who the kid may DM and which servers the kid may join
//! - can take the kid out of any server, whoever owns it
//! - set quiet hours, kid-safe AI, whether the kid may delete messages
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::models::{get_user, UserPublic, USER_COLS};
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Quiet {
    pub enabled: bool,
    /// "21:00"
    pub start: String,
    /// "07:00"
    pub end: String,
    /// days the quiet period STARTS on, 0 = Sunday … 6 = Saturday
    pub days: Vec<u8>,
    /// the parent's time zone when saved: minutes to add to UTC (e.g. -300 for EST)
    pub utc_offset_min: i32,
}

impl Default for Quiet {
    fn default() -> Self {
        Quiet { enabled: false, start: "21:00".into(), end: "07:00".into(), days: vec![0, 1, 2, 3, 4, 5, 6], utc_offset_min: 0 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct KidSettings {
    /// "approved": DMs only with people a parent approved; "anyone": anyone in a shared server
    pub dm_mode: String,
    /// joining a server needs a parent's OK
    pub join_approval: bool,
    /// servers owned by these accounts are approved automatically (e.g. a sibling's)
    pub auto_approve_owners: Vec<String>,
    /// AI bot answers this kid in a kid-appropriate way
    pub kid_safe_bot: bool,
    pub quiet: Quiet,
    /// whether the kid may delete their own messages
    pub can_delete: bool,
}

impl Default for KidSettings {
    fn default() -> Self {
        KidSettings {
            dm_mode: "approved".into(),
            join_approval: true,
            auto_approve_owners: vec![],
            kid_safe_bot: true,
            quiet: Quiet::default(),
            can_delete: false,
        }
    }
}

pub const KID_SAFE_PROMPT: &str = "You are talking with a child. Keep everything age-appropriate and kind: no violence, sexual content, profanity, scary or upsetting detail, or advice about dangerous activities. Use simple words. If they ask about something unsafe or adult, gently say it's a question for a parent. Encourage them to talk to a parent or trusted adult if they seem upset.";

// ---------- helpers used across the server ----------

pub async fn settings(state: &Shared, kid: &str) -> KidSettings {
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM kid_settings WHERE kid_id = ?").bind(kid).fetch_optional(&state.db).await.ok().flatten();
    v.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub async fn is_kid(state: &Shared, uid: &str) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT is_kid FROM users WHERE id = ?").bind(uid).fetch_optional(&state.db).await.ok().flatten().unwrap_or(false)
}

pub async fn guardians_of(state: &Shared, kid: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT guardian_id FROM guardians WHERE kid_id = ?").bind(kid).fetch_all(&state.db).await.unwrap_or_default()
}

pub async fn is_guardian(state: &Shared, kid: &str, uid: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM guardians WHERE kid_id = ? AND guardian_id = ?")
        .bind(kid)
        .bind(uid)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// May this person manage this kid? (a parent, or an instance admin)
async fn may_manage(state: &Shared, auth: &AuthUser, kid: &str) -> ApiResult<()> {
    if !is_kid(state, kid).await {
        return Err(AppError::not_found());
    }
    if auth.is_admin || is_guardian(state, kid, &auth.id).await {
        Ok(())
    } else {
        Err(AppError::forbidden())
    }
}

/// Is the kid inside quiet hours right now? Returns when it ends ("07:00").
pub async fn quiet_now(state: &Shared, kid: &str) -> Option<String> {
    if !is_kid(state, kid).await {
        return None;
    }
    let q = settings(state, kid).await.quiet;
    if !q.enabled {
        return None;
    }
    let mins = |s: &str| -> Option<i64> {
        let (h, m) = s.split_once(':')?;
        Some(h.trim().parse::<i64>().ok()? * 60 + m.trim().parse::<i64>().ok()?)
    };
    let (start, end) = (mins(&q.start)?, mins(&q.end)?);
    let local_ms = now_ms() + q.utc_offset_min as i64 * 60_000;
    let day_min = (local_ms / 60_000).rem_euclid(1440);
    // 1970-01-01 was a Thursday (4)
    let weekday = ((local_ms / 86_400_000) + 4).rem_euclid(7) as u8;
    let yesterday = (weekday + 6) % 7;
    let inside = if start <= end {
        day_min >= start && day_min < end && q.days.contains(&weekday)
    } else {
        // crosses midnight: the evening part belongs to today, the morning part to yesterday
        (day_min >= start && q.days.contains(&weekday)) || (day_min < end && q.days.contains(&yesterday))
    };
    inside.then(|| q.end.clone())
}

pub async fn check_quiet(state: &Shared, uid: &str) -> ApiResult<()> {
    match quiet_now(state, uid).await {
        Some(end) => Err(AppError::bad(format!("It's quiet hours right now (until {end}). A parent can change this."))),
        None => Ok(()),
    }
}

/// May `a` and `b` have a DM conversation? Err(kid id) names the kid who needs approval.
pub async fn dm_allowed(state: &Shared, a: &str, b: &str) -> Result<(), String> {
    for (kid, other) in [(a, b), (b, a)] {
        if !is_kid(state, kid).await || other == state.bot_id {
            continue;
        }
        if is_guardian(state, kid, other).await {
            continue;
        }
        let s = settings(state, kid).await;
        if s.dm_mode == "anyone" {
            continue;
        }
        let ok: Option<i64> = sqlx::query_scalar("SELECT 1 FROM kid_contacts WHERE kid_id = ? AND user_id = ?")
            .bind(kid)
            .bind(other)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
        if ok.is_none() {
            return Err(kid.to_string());
        }
    }
    Ok(())
}

/// Record a request for the kid's parents (deduplicated) and tell them.
pub async fn request(state: &Shared, kid: &str, kind: &str, target: &str) -> ApiResult<()> {
    let existing: Option<String> = sqlx::query_scalar("SELECT id FROM kid_requests WHERE kid_id = ? AND kind = ? AND target = ? AND status = 'pending'")
        .bind(kid)
        .bind(kind)
        .bind(target)
        .fetch_optional(&state.db)
        .await?;
    if existing.is_some() {
        return Ok(());
    }
    let id = new_id();
    sqlx::query("INSERT INTO kid_requests (id, kid_id, kind, target, created_at) VALUES (?,?,?,?,?)")
        .bind(&id)
        .bind(kid)
        .bind(kind)
        .bind(target)
        .bind(now_ms())
        .execute(&state.db)
        .await?;
    let payload = request_json(state, &id).await?;
    state.hub.send_users(&guardians_of(state, kid).await, "KID_REQUEST", &payload);
    Ok(())
}

async fn request_json(state: &Shared, id: &str) -> ApiResult<Value> {
    let (kid, kind, target, status, at): (String, String, String, String, i64) =
        sqlx::query_as("SELECT kid_id, kind, target, status, created_at FROM kid_requests WHERE id = ?").bind(id).fetch_one(&state.db).await?;
    let target_info = if kind == "dm" {
        get_user(&state.db, &target).await.map(|u| json!(u)).unwrap_or(json!(null))
    } else {
        let g: Option<(String, String)> = sqlx::query_as("SELECT name, owner_id FROM guilds WHERE id = ?").bind(&target).fetch_optional(&state.db).await?;
        match g {
            Some((name, owner)) => json!({ "id": target, "name": name, "owner": get_user(&state.db, &owner).await.ok() }),
            None => json!(null),
        }
    };
    Ok(json!({ "id": id, "kid": get_user(&state.db, &kid).await?, "kind": kind, "target": target_info, "status": status, "created_at": at }))
}

/// A kid wants to join a server. Ok(true) = may join now, Ok(false) = waiting for a parent.
pub async fn join_allowed(state: &Shared, kid: &str, guild_id: &str) -> ApiResult<bool> {
    if !is_kid(state, kid).await {
        return Ok(true);
    }
    let s = settings(state, kid).await;
    if !s.join_approval {
        return Ok(true);
    }
    let owner: Option<String> = sqlx::query_scalar("SELECT owner_id FROM guilds WHERE id = ?").bind(guild_id).fetch_optional(&state.db).await?;
    let Some(owner) = owner else { return Err(AppError::not_found()) };
    if s.auto_approve_owners.contains(&owner) || is_guardian(state, kid, &owner).await {
        return Ok(true);
    }
    request(state, kid, "join", guild_id).await?;
    Ok(false)
}

/// Can `uid` read this channel because they're a parent of a kid who can?
pub async fn guardian_can_read(state: &Shared, ch: &crate::models::Channel, uid: &str) -> bool {
    let kids: Vec<String> = sqlx::query_scalar("SELECT kid_id FROM guardians WHERE guardian_id = ?").bind(uid).fetch_all(&state.db).await.unwrap_or_default();
    for k in kids {
        if let Ok(p) = crate::perms::channel_perms(&state.db, ch, &k).await {
            if p & crate::perms::VIEW != 0 {
                return true;
            }
        }
    }
    false
}

// ---------- API ----------

async fn kid_json(state: &Shared, kid: &str) -> ApiResult<Value> {
    let user = get_user(&state.db, kid).await?;
    let gids = guardians_of(state, kid).await;
    let mut guardians = vec![];
    for g in &gids {
        if let Ok(u) = get_user(&state.db, g).await {
            guardians.push(u);
        }
    }
    let contacts: Vec<UserPublic> = sqlx::query_as(&format!(
        "SELECT {USER_COLS} FROM users WHERE id IN (SELECT user_id FROM kid_contacts WHERE kid_id = ?) ORDER BY display_name"
    ))
    .bind(kid)
    .fetch_all(&state.db)
    .await?;
    let guilds: Vec<(String, String, String)> =
        sqlx::query_as("SELECT g.id, g.name, g.owner_id FROM guilds g JOIN members m ON m.guild_id = g.id WHERE m.user_id = ? ORDER BY g.name")
            .bind(kid)
            .fetch_all(&state.db)
            .await?;
    let reqs: Vec<String> = sqlx::query_scalar("SELECT id FROM kid_requests WHERE kid_id = ? AND status = 'pending' ORDER BY created_at")
        .bind(kid)
        .fetch_all(&state.db)
        .await?;
    let mut requests = vec![];
    for r in reqs {
        requests.push(request_json(state, &r).await?);
    }
    Ok(json!({
        "user": user,
        "guardians": guardians,
        "contacts": contacts,
        "guilds": guilds.into_iter().map(|(id, name, owner)| json!({ "id": id, "name": name, "owner_id": owner })).collect::<Vec<_>>(),
        "settings": settings(state, kid).await,
        "requests": requests,
        "quiet_now": quiet_now(state, kid).await,
    }))
}

/// The kids this person looks after (admins: every kid account).
pub async fn list_kids(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let ids: Vec<String> = if auth.is_admin {
        sqlx::query_scalar("SELECT id FROM users WHERE is_kid = 1 ORDER BY display_name").fetch_all(&state.db).await?
    } else {
        sqlx::query_scalar("SELECT u.id FROM users u JOIN guardians g ON g.kid_id = u.id WHERE g.guardian_id = ? ORDER BY u.display_name")
            .bind(&auth.id)
            .fetch_all(&state.db)
            .await?
    };
    let mut out = vec![];
    for id in ids {
        let mut k = kid_json(&state, &id).await?;
        k["mine"] = json!(is_guardian(&state, &id, &auth.id).await);
        out.push(k);
    }
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
pub struct CreateKid {
    pub username: String,
    pub display_name: Option<String>,
    pub password: String,
}

/// Make a kid account directly (no invite). The creator becomes a parent of it.
pub async fn create_kid(State(state): State<Shared>, auth: AuthUser, Json(req): Json<CreateKid>) -> ApiResult<Json<Value>> {
    if auth.is_kid {
        return Err(AppError::forbidden());
    }
    let username = req.username.trim().to_string();
    if !crate::api::auth::valid_username(&username) {
        return Err(AppError::bad("username must be 2-32 chars: letters, numbers, _ . -"));
    }
    if req.password.len() < 8 {
        return Err(AppError::bad("password must be at least 8 characters"));
    }
    let taken: Option<i64> = sqlx::query_scalar("SELECT 1 FROM users WHERE username = ?").bind(&username).fetch_optional(&state.db).await?;
    if taken.is_some() {
        return Err(AppError::conflict("username taken"));
    }
    let id = new_id();
    let display: String = req.display_name.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&username).chars().take(32).collect();
    let hash = crate::api::auth::hash_password(req.password.clone()).await?;
    sqlx::query("INSERT INTO users (id, username, display_name, password_hash, is_kid, created_at) VALUES (?,?,?,?,1,?)")
        .bind(&id)
        .bind(&username)
        .bind(&display)
        .bind(&hash)
        .bind(now_ms())
        .execute(&state.db)
        .await?;
    sqlx::query("INSERT INTO guardians (kid_id, guardian_id) VALUES (?,?)").bind(&id).bind(&auth.id).execute(&state.db).await?;
    Ok(Json(kid_json(&state, &id).await?))
}

pub async fn update_kid_settings(State(state): State<Shared>, auth: AuthUser, Path(kid): Path<String>, Json(req): Json<Value>) -> ApiResult<Json<Value>> {
    may_manage(&state, &auth, &kid).await?;
    let mut cur = serde_json::to_value(settings(&state, &kid).await).unwrap();
    if let (Some(c), Some(r)) = (cur.as_object_mut(), req.as_object()) {
        for (k, v) in r {
            if c.contains_key(k) {
                c.insert(k.clone(), v.clone());
            }
        }
    }
    let s: KidSettings = serde_json::from_value(cur).map_err(|e| AppError::bad(e.to_string()))?;
    if !["approved", "anyone"].contains(&s.dm_mode.as_str()) {
        return Err(AppError::bad("dm_mode must be approved or anyone"));
    }
    sqlx::query("INSERT OR REPLACE INTO kid_settings (kid_id, value) VALUES (?,?)")
        .bind(&kid)
        .bind(serde_json::to_string(&s).unwrap())
        .execute(&state.db)
        .await?;
    Ok(Json(kid_json(&state, &kid).await?))
}

#[derive(Deserialize)]
pub struct Who {
    /// a username (what people type) or a user id
    pub user: String,
}

async fn find_user(state: &Shared, who: &str) -> ApiResult<String> {
    let id: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE (id = ? OR username = ?) AND is_bot = 0")
        .bind(who.trim())
        .bind(who.trim().trim_start_matches('@'))
        .fetch_optional(&state.db)
        .await?;
    id.ok_or_else(|| AppError::bad(format!("no account named {:?}", who.trim())))
}

pub async fn add_guardian(State(state): State<Shared>, auth: AuthUser, Path(kid): Path<String>, Json(req): Json<Who>) -> ApiResult<Json<Value>> {
    may_manage(&state, &auth, &kid).await?;
    let g = find_user(&state, &req.user).await?;
    if g == kid || is_kid(&state, &g).await {
        return Err(AppError::bad("a parent must be a regular account"));
    }
    sqlx::query("INSERT OR IGNORE INTO guardians (kid_id, guardian_id) VALUES (?,?)").bind(&kid).bind(&g).execute(&state.db).await?;
    Ok(Json(kid_json(&state, &kid).await?))
}

pub async fn remove_guardian(State(state): State<Shared>, auth: AuthUser, Path((kid, g)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    may_manage(&state, &auth, &kid).await?;
    if guardians_of(&state, &kid).await.len() <= 1 && !auth.is_admin {
        return Err(AppError::bad("a kid account needs at least one parent"));
    }
    sqlx::query("DELETE FROM guardians WHERE kid_id = ? AND guardian_id = ?").bind(&kid).bind(&g).execute(&state.db).await?;
    Ok(Json(kid_json(&state, &kid).await?))
}

pub async fn add_contact(State(state): State<Shared>, auth: AuthUser, Path(kid): Path<String>, Json(req): Json<Who>) -> ApiResult<Json<Value>> {
    may_manage(&state, &auth, &kid).await?;
    let u = find_user(&state, &req.user).await?;
    sqlx::query("INSERT OR IGNORE INTO kid_contacts (kid_id, user_id) VALUES (?,?)").bind(&kid).bind(&u).execute(&state.db).await?;
    Ok(Json(kid_json(&state, &kid).await?))
}

pub async fn remove_contact(State(state): State<Shared>, auth: AuthUser, Path((kid, u)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    may_manage(&state, &auth, &kid).await?;
    sqlx::query("DELETE FROM kid_contacts WHERE kid_id = ? AND user_id = ?").bind(&kid).bind(&u).execute(&state.db).await?;
    Ok(Json(kid_json(&state, &kid).await?))
}

#[derive(Deserialize)]
pub struct KidPassword {
    pub password: String,
}

pub async fn set_kid_password(State(state): State<Shared>, auth: AuthUser, Path(kid): Path<String>, Json(req): Json<KidPassword>) -> ApiResult<Json<Value>> {
    may_manage(&state, &auth, &kid).await?;
    if req.password.len() < 8 {
        return Err(AppError::bad("password must be at least 8 characters"));
    }
    let hash = crate::api::auth::hash_password(req.password).await?;
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash).bind(&kid).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct GuildRef {
    pub guild_id: String,
}

/// A parent puts their kid in one of the parent's servers.
pub async fn add_to_guild(State(state): State<Shared>, auth: AuthUser, Path(kid): Path<String>, Json(req): Json<GuildRef>) -> ApiResult<Json<Value>> {
    may_manage(&state, &auth, &kid).await?;
    if !auth.is_admin {
        crate::perms::require_guild(&state.db, &req.guild_id, &auth.id, crate::perms::CREATE_INVITE).await?;
    }
    crate::api::guilds::add_member(&state, &req.guild_id, &kid).await?;
    Ok(Json(kid_json(&state, &kid).await?))
}

/// Parents outrank server owners for their own kid: take the kid out of any server.
pub async fn remove_from_guild(State(state): State<Shared>, auth: AuthUser, Path((kid, gid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    may_manage(&state, &auth, &kid).await?;
    crate::api::guilds::remove_member(&state, &gid, &kid).await?;
    Ok(Json(kid_json(&state, &kid).await?))
}

#[derive(Deserialize)]
pub struct Decide {
    pub approve: bool,
}

pub async fn decide_request(State(state): State<Shared>, auth: AuthUser, Path(rid): Path<String>, Json(req): Json<Decide>) -> ApiResult<Json<Value>> {
    let row: Option<(String, String, String)> = sqlx::query_as("SELECT kid_id, kind, target FROM kid_requests WHERE id = ? AND status = 'pending'")
        .bind(&rid)
        .fetch_optional(&state.db)
        .await?;
    let Some((kid, kind, target)) = row else { return Err(AppError::not_found()) };
    may_manage(&state, &auth, &kid).await?;
    if req.approve {
        match kind.as_str() {
            "dm" => {
                sqlx::query("INSERT OR IGNORE INTO kid_contacts (kid_id, user_id) VALUES (?,?)").bind(&kid).bind(&target).execute(&state.db).await?;
            }
            "join" => {
                crate::api::guilds::add_member(&state, &target, &kid).await?;
            }
            _ => {}
        }
    }
    sqlx::query("UPDATE kid_requests SET status = ?, decided_by = ? WHERE id = ?")
        .bind(if req.approve { "approved" } else { "denied" })
        .bind(&auth.id)
        .bind(&rid)
        .execute(&state.db)
        .await?;
    let payload = request_json(&state, &rid).await?;
    let mut tell = guardians_of(&state, &kid).await;
    tell.push(kid.clone());
    state.hub.send_users(&tell, "KID_REQUEST_DONE", &payload);
    Ok(Json(payload))
}

/// Everything a kid can read, for the parent's read-only view.
pub async fn kid_channels(State(state): State<Shared>, auth: AuthUser, Path(kid): Path<String>) -> ApiResult<Json<Value>> {
    may_manage(&state, &auth, &kid).await?;
    let mut out = vec![];
    let guilds: Vec<(String, String)> = sqlx::query_as("SELECT g.id, g.name FROM guilds g JOIN members m ON m.guild_id = g.id WHERE m.user_id = ? ORDER BY g.name")
        .bind(&kid)
        .fetch_all(&state.db)
        .await?;
    for (gid, name) in guilds {
        let chans = crate::models::load_channels(&state.db, &gid).await?;
        let mut visible = vec![];
        for c in chans.into_iter().filter(|c| c.kind == "text") {
            if crate::perms::channel_perms(&state.db, &c, &kid).await.map(|p| p & crate::perms::VIEW != 0).unwrap_or(false) {
                visible.push(json!({ "id": c.id, "name": c.name }));
            }
        }
        out.push(json!({ "guild": { "id": gid, "name": name }, "channels": visible }));
    }
    let dms: Vec<String> = sqlx::query_scalar("SELECT channel_id FROM dm_members WHERE user_id = ?").bind(&kid).fetch_all(&state.db).await?;
    let mut dm_list = vec![];
    for cid in dms {
        let others: Vec<UserPublic> = sqlx::query_as(&format!(
            "SELECT {USER_COLS} FROM users WHERE id IN (SELECT user_id FROM dm_members WHERE channel_id = ? AND user_id != ?)"
        ))
        .bind(&cid)
        .bind(&kid)
        .fetch_all(&state.db)
        .await?;
        let last: Option<i64> = sqlx::query_scalar("SELECT MAX(created_at) FROM messages WHERE channel_id = ?").bind(&cid).fetch_one(&state.db).await?;
        dm_list.push(json!({ "id": cid, "with": others, "last_at": last }));
    }
    dm_list.sort_by_key(|d| std::cmp::Reverse(d["last_at"].as_i64().unwrap_or(0)));
    Ok(Json(json!({ "servers": out, "dms": dm_list })))
}

// ---------- instance admins: make an existing account a kid ----------

#[derive(Deserialize)]
pub struct MakeKid {
    pub is_kid: bool,
    /// usernames of the parents (required when turning an account into a kid)
    #[serde(default)]
    pub guardians: Vec<String>,
}

pub async fn admin_set_kid(State(state): State<Shared>, auth: AuthUser, Path(uid): Path<String>, Json(req): Json<MakeKid>) -> ApiResult<Json<Value>> {
    if !auth.is_admin {
        return Err(AppError::forbidden());
    }
    let (role, bot): (String, bool) = sqlx::query_as("SELECT instance_role, is_bot FROM users WHERE id = ?").bind(&uid).fetch_one(&state.db).await?;
    if bot || (req.is_kid && role != "user") {
        return Err(AppError::bad("admins and the bot can't be kid accounts"));
    }
    if req.is_kid {
        let mut ids = vec![];
        for g in &req.guardians {
            let id = find_user(&state, g).await?;
            if id == uid {
                return Err(AppError::bad("an account can't be its own parent"));
            }
            ids.push(id);
        }
        if ids.is_empty() && guardians_of(&state, &uid).await.is_empty() {
            return Err(AppError::bad("pick at least one parent account"));
        }
        sqlx::query("UPDATE users SET is_kid = 1 WHERE id = ?").bind(&uid).execute(&state.db).await?;
        for g in ids {
            sqlx::query("INSERT OR IGNORE INTO guardians (kid_id, guardian_id) VALUES (?,?)").bind(&uid).bind(&g).execute(&state.db).await?;
        }
    } else {
        sqlx::query("UPDATE users SET is_kid = 0 WHERE id = ?").bind(&uid).execute(&state.db).await?;
        sqlx::query("DELETE FROM guardians WHERE kid_id = ?").bind(&uid).execute(&state.db).await?;
    }
    // they'll see their new limits on the next connection
    state.hub.kick_user(&uid);
    Ok(Json(json!({ "user": get_user(&state.db, &uid).await? })))
}
