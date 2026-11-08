use crate::error::{invite_code, now_ms, new_id, ApiResult, AppError};
use crate::models::*;
use crate::perms::{self, require_guild};
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

pub async fn guild_payload(state: &Shared, guild_id: &str) -> ApiResult<Value> {
    let guild = sqlx::query_as::<_, Guild>(&format!("SELECT {GUILD_COLS} FROM guilds WHERE id = ?"))
        .bind(guild_id)
        .fetch_one(&state.db)
        .await?;
    let channels = sqlx::query_as::<_, Channel>(&format!(
        "SELECT {CHANNEL_COLS} FROM channels c WHERE c.guild_id = ? ORDER BY c.position, c.created_at"
    ))
    .bind(guild_id)
    .fetch_all(&state.db)
    .await?;
    let roles = load_roles(&state.db, guild_id).await?;
    let members = load_members(&state.db, guild_id).await?;
    Ok(json!({ "guild": guild, "channels": channels, "roles": roles, "members": members }))
}

pub async fn add_member(state: &Shared, guild_id: &str, user_id: &str) -> ApiResult<()> {
    let banned: Option<i64> = sqlx::query_scalar("SELECT 1 FROM bans WHERE guild_id = ? AND user_id = ?")
        .bind(guild_id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;
    if banned.is_some() {
        return Err(AppError::forbidden());
    }
    let r = sqlx::query("INSERT OR IGNORE INTO members (guild_id, user_id, joined_at) VALUES (?,?,?)")
        .bind(guild_id)
        .bind(user_id)
        .bind(now_ms())
        .execute(&state.db)
        .await?;
    if r.rows_affected() > 0 {
        let m = load_member(&state.db, guild_id, user_id).await?;
        state.emit_guild(guild_id, "GUILD_MEMBER_ADD", &m).await;
        let payload = guild_payload(state, guild_id).await?;
        state.hub.send_user(user_id, "GUILD_CREATE", &payload);
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct CreateGuild {
    pub name: String,
}

pub async fn create_guild(State(state): State<Shared>, auth: AuthUser, Json(req): Json<CreateGuild>) -> ApiResult<Json<Value>> {
    if state.s().guild_create != "all" && !auth.is_admin {
        return Err(AppError::forbidden());
    }
    let name: String = req.name.trim().chars().take(100).collect();
    if name.is_empty() {
        return Err(AppError::bad("name required"));
    }
    let id = new_id();
    let now = now_ms();
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO guilds (id, name, owner_id, created_at) VALUES (?,?,?,?)")
        .bind(&id).bind(&name).bind(&auth.id).bind(now).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO roles (id, guild_id, name, permissions, position) VALUES (?,?,?,?,0)")
        .bind(&id).bind(&id).bind("@everyone").bind(perms::DEFAULT_EVERYONE).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO members (guild_id, user_id, joined_at) VALUES (?,?,?)")
        .bind(&id).bind(&auth.id).bind(now).execute(&mut *tx).await?;
    let cat_text = new_id();
    let cat_voice = new_id();
    for (cid, kind, cname, parent, pos) in [
        (cat_text.clone(), "category", "Text Channels", None, 0),
        (new_id(), "text", "general", Some(cat_text.clone()), 0),
        (cat_voice.clone(), "category", "Voice Channels", None, 1),
        (new_id(), "voice", "General", Some(cat_voice.clone()), 0),
    ] {
        sqlx::query("INSERT INTO channels (id, guild_id, kind, name, parent_id, position, created_at) VALUES (?,?,?,?,?,?,?)")
            .bind(cid).bind(&id).bind(kind).bind(cname).bind(parent).bind(pos).bind(now)
            .execute(&mut *tx).await?;
    }
    tx.commit().await?;
    add_preset_roles(&state, &id).await?;
    let payload = guild_payload(&state, &id).await?;
    state.hub.send_user(&auth.id, "GUILD_CREATE", &payload);
    Ok(Json(payload))
}

/// The standard ladder below the server's Owner. Supervisor is meant to be tuned: tick the
/// admin powers you want them to have. Guest can read and listen but not post or talk.
pub const GUEST_DENY: i64 = perms::SEND | perms::ATTACH | perms::EMBED_LINKS | perms::REACT | perms::SPEAK | perms::VIDEO | perms::CREATE_INVITE | perms::MENTION_EVERYONE;

pub async fn add_preset_roles(state: &Shared, gid: &str) -> ApiResult<Vec<String>> {
    let presets: [(&str, i64, i64, i64, bool, i64); 4] = [
        ("Admin", perms::ADMINISTRATOR, 0, 0xe74c3c, true, 40),
        ("Supervisor", perms::MANAGE_MESSAGES | perms::KICK | perms::BAN | perms::MANAGE_CHANNELS | perms::CREATE_INVITE | perms::MENTION_EVERYONE, 0, 0xe67e22, true, 30),
        ("Moderator", perms::MANAGE_MESSAGES | perms::KICK, 0, 0x3498db, true, 20),
        ("Guest", 0, GUEST_DENY, 0x95a5a6, false, 10),
    ];
    let existing: Vec<String> = sqlx::query_scalar("SELECT name FROM roles WHERE guild_id = ?").bind(gid).fetch_all(&state.db).await?;
    let mut added = vec![];
    for (name, p, deny, color, hoist, pos) in presets {
        if existing.iter().any(|n| n.eq_ignore_ascii_case(name)) {
            continue;
        }
        let rid = new_id();
        sqlx::query("INSERT INTO roles (id, guild_id, name, color, permissions, position, hoist, deny) VALUES (?,?,?,?,?,?,?,?)")
            .bind(&rid)
            .bind(gid)
            .bind(name)
            .bind(color)
            .bind(p)
            .bind(pos)
            .bind(hoist)
            .bind(deny)
            .execute(&state.db)
            .await?;
        if let Ok(role) = sqlx::query_as::<_, Role>("SELECT id, guild_id, name, color, permissions, position, hoist, deny FROM roles WHERE id = ?").bind(&rid).fetch_one(&state.db).await {
            state.emit_guild(gid, "ROLE_UPDATE", &role).await;
        }
        added.push(name.to_string());
    }
    Ok(added)
}

pub async fn add_presets(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::MANAGE_ROLES).await?;
    Ok(Json(json!({ "added": add_preset_roles(&state, &gid).await? })))
}

/// Used by parents (and kicks/bans) to take someone out of a server.
pub async fn remove_member(state: &Shared, gid: &str, uid: &str) -> ApiResult<()> {
    let owner: Option<String> = sqlx::query_scalar("SELECT owner_id FROM guilds WHERE id = ?").bind(gid).fetch_optional(&state.db).await?;
    if owner.as_deref() == Some(uid) {
        return Err(AppError::bad("they own that server; it has to be deleted or handed to someone else"));
    }
    remove_member_inner(state, gid, uid).await
}

#[derive(Deserialize)]
pub struct UpdateGuild {
    pub name: Option<String>,
    pub icon_file_id: Option<Option<String>>,
    pub highlights_auto_pictures: Option<bool>,
    pub highlights_auto_recordings: Option<bool>,
}

pub async fn update_guild(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>, Json(req): Json<UpdateGuild>) -> ApiResult<Json<Guild>> {
    require_guild(&state.db, &gid, &auth.id, perms::MANAGE_GUILD).await?;
    if let Some(n) = req.name {
        let n: String = n.trim().chars().take(100).collect();
        if !n.is_empty() {
            sqlx::query("UPDATE guilds SET name = ? WHERE id = ?").bind(n).bind(&gid).execute(&state.db).await?;
        }
    }
    if let Some(icon) = req.icon_file_id {
        sqlx::query("UPDATE guilds SET icon_file_id = ? WHERE id = ?").bind(icon).bind(&gid).execute(&state.db).await?;
    }
    if let Some(v) = req.highlights_auto_pictures {
        sqlx::query("UPDATE guilds SET highlights_auto_pictures = ? WHERE id = ?").bind(v).bind(&gid).execute(&state.db).await?;
    }
    if let Some(v) = req.highlights_auto_recordings {
        sqlx::query("UPDATE guilds SET highlights_auto_recordings = ? WHERE id = ?").bind(v).bind(&gid).execute(&state.db).await?;
    }
    let g = sqlx::query_as::<_, Guild>(&format!("SELECT {GUILD_COLS} FROM guilds WHERE id = ?"))
        .bind(&gid).fetch_one(&state.db).await?;
    state.emit_guild(&gid, "GUILD_UPDATE", &g).await;
    Ok(Json(g))
}

pub async fn delete_guild(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>) -> ApiResult<Json<Value>> {
    let owner: String = sqlx::query_scalar("SELECT owner_id FROM guilds WHERE id = ?").bind(&gid).fetch_one(&state.db).await?;
    if owner != auth.id && !auth.is_admin {
        return Err(AppError::forbidden());
    }
    let members = crate::state::guild_member_ids(&state.db, &gid).await;
    sqlx::query("DELETE FROM guilds WHERE id = ?").bind(&gid).execute(&state.db).await?;
    state.hub.send_users(&members, "GUILD_DELETE", &json!({ "id": gid }));
    Ok(Json(json!({ "ok": true })))
}

// ---------- channels ----------

#[derive(Deserialize)]
pub struct CreateChannel {
    pub name: String,
    pub kind: String,
    pub parent_id: Option<String>,
    pub topic: Option<String>,
}

pub fn clean_channel_name(kind: &str, name: &str) -> String {
    let n: String = name.trim().chars().take(100).collect();
    if kind == "text" {
        n.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-")
    } else {
        n
    }
}

pub async fn create_channel(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>, Json(req): Json<CreateChannel>) -> ApiResult<Json<Channel>> {
    require_guild(&state.db, &gid, &auth.id, perms::MANAGE_CHANNELS).await?;
    if !["text", "voice", "category"].contains(&req.kind.as_str()) {
        return Err(AppError::bad("kind must be text, voice or category"));
    }
    let name = clean_channel_name(&req.kind, &req.name);
    if name.is_empty() {
        return Err(AppError::bad("name required"));
    }
    let pos: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(position)+1, 0) FROM channels WHERE guild_id = ? AND parent_id IS ?")
        .bind(&gid).bind(&req.parent_id).fetch_one(&state.db).await?;
    let id = new_id();
    sqlx::query("INSERT INTO channels (id, guild_id, kind, name, topic, parent_id, position, created_at) VALUES (?,?,?,?,?,?,?,?)")
        .bind(&id).bind(&gid).bind(&req.kind).bind(&name).bind(req.topic.unwrap_or_default())
        .bind(if req.kind == "category" { None } else { req.parent_id })
        .bind(pos).bind(now_ms())
        .execute(&state.db).await?;
    let ch = load_channel(&state.db, &id).await?;
    state.emit_guild(&gid, "CHANNEL_CREATE", &ch).await;
    Ok(Json(ch))
}

#[derive(Deserialize)]
pub struct UpdateChannel {
    pub name: Option<String>,
    pub topic: Option<String>,
    pub parent_id: Option<Option<String>>,
    pub position: Option<i64>,
    /// auto-delete messages older than N days; null turns it off
    pub retention_days: Option<Option<i64>>,
}

pub async fn update_channel(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<UpdateChannel>) -> ApiResult<Json<Channel>> {
    let ch = load_channel(&state.db, &cid).await?;
    let gid = ch.guild_id.clone().ok_or_else(AppError::forbidden)?;
    require_guild(&state.db, &gid, &auth.id, perms::MANAGE_CHANNELS).await?;
    if let Some(n) = req.name {
        let n = clean_channel_name(&ch.kind, &n);
        if !n.is_empty() {
            sqlx::query("UPDATE channels SET name = ? WHERE id = ?").bind(n).bind(&cid).execute(&state.db).await?;
        }
    }
    if let Some(t) = req.topic {
        sqlx::query("UPDATE channels SET topic = ? WHERE id = ?").bind(t.chars().take(1024).collect::<String>()).bind(&cid).execute(&state.db).await?;
    }
    if let Some(p) = req.parent_id {
        if ch.kind != "category" {
            sqlx::query("UPDATE channels SET parent_id = ? WHERE id = ?").bind(p).bind(&cid).execute(&state.db).await?;
        }
    }
    if let Some(r) = req.retention_days {
        let r = r.filter(|d| *d > 0).map(|d| d.min(3650));
        sqlx::query("UPDATE channels SET retention_days = ? WHERE id = ?").bind(r).bind(&cid).execute(&state.db).await?;
    }
    if let Some(p) = req.position {
        sqlx::query("UPDATE channels SET position = ? WHERE id = ?").bind(p).bind(&cid).execute(&state.db).await?;
    }
    let ch = load_channel(&state.db, &cid).await?;
    state.emit_guild(&gid, "CHANNEL_UPDATE", &ch).await;
    Ok(Json(ch))
}

pub async fn delete_channel(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    let ch = load_channel(&state.db, &cid).await?;
    let gid = ch.guild_id.clone().ok_or_else(AppError::forbidden)?;
    require_guild(&state.db, &gid, &auth.id, perms::MANAGE_CHANNELS).await?;
    sqlx::query("UPDATE channels SET parent_id = NULL WHERE parent_id = ?").bind(&cid).execute(&state.db).await?;
    sqlx::query("DELETE FROM channels WHERE id = ?").bind(&cid).execute(&state.db).await?;
    state.emit_guild(&gid, "CHANNEL_DELETE", &json!({ "id": cid, "guild_id": gid })).await;
    Ok(Json(json!({ "ok": true })))
}

// ---------- roles ----------

#[derive(Deserialize)]
pub struct RoleReq {
    pub name: Option<String>,
    pub color: Option<i64>,
    pub permissions: Option<i64>,
    pub position: Option<i64>,
    pub hoist: Option<bool>,
    /// permissions the role takes away (Guest-style)
    pub deny: Option<i64>,
}

pub async fn create_role(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>, Json(req): Json<RoleReq>) -> ApiResult<Json<Role>> {
    let mine = require_guild(&state.db, &gid, &auth.id, perms::MANAGE_ROLES).await?;
    let p = req.permissions.unwrap_or(0) & mine; // can't grant what you don't have
    let pos: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(position)+1, 1) FROM roles WHERE guild_id = ?")
        .bind(&gid).fetch_one(&state.db).await?;
    let id = new_id();
    sqlx::query("INSERT INTO roles (id, guild_id, name, color, permissions, position, hoist) VALUES (?,?,?,?,?,?,?)")
        .bind(&id).bind(&gid)
        .bind(req.name.unwrap_or_else(|| "new role".into()).chars().take(64).collect::<String>())
        .bind(req.color.unwrap_or(0)).bind(p).bind(pos).bind(req.hoist.unwrap_or(false))
        .execute(&state.db).await?;
    let role = sqlx::query_as::<_, Role>("SELECT id, guild_id, name, color, permissions, position, hoist, deny FROM roles WHERE id = ?")
        .bind(&id).fetch_one(&state.db).await?;
    state.emit_guild(&gid, "ROLE_UPDATE", &role).await;
    Ok(Json(role))
}

pub async fn update_role(State(state): State<Shared>, auth: AuthUser, Path((gid, rid)): Path<(String, String)>, Json(req): Json<RoleReq>) -> ApiResult<Json<Role>> {
    let mine = require_guild(&state.db, &gid, &auth.id, perms::MANAGE_ROLES).await?;
    let role = sqlx::query_as::<_, Role>("SELECT id, guild_id, name, color, permissions, position, hoist, deny FROM roles WHERE id = ? AND guild_id = ?")
        .bind(&rid).bind(&gid).fetch_one(&state.db).await?;
    if let Some(n) = req.name {
        if rid != gid {
            sqlx::query("UPDATE roles SET name = ? WHERE id = ?").bind(n.chars().take(64).collect::<String>()).bind(&rid).execute(&state.db).await?;
        }
    }
    if let Some(c) = req.color {
        sqlx::query("UPDATE roles SET color = ? WHERE id = ?").bind(c).bind(&rid).execute(&state.db).await?;
    }
    if let Some(p) = req.permissions {
        // keep bits the editor doesn't hold unchanged
        let newp = (role.permissions & !mine) | (p & mine);
        sqlx::query("UPDATE roles SET permissions = ? WHERE id = ?").bind(newp).bind(&rid).execute(&state.db).await?;
    }
    if let Some(p) = req.position {
        sqlx::query("UPDATE roles SET position = ? WHERE id = ?").bind(p).bind(&rid).execute(&state.db).await?;
    }
    if let Some(h) = req.hoist {
        sqlx::query("UPDATE roles SET hoist = ? WHERE id = ?").bind(h).bind(&rid).execute(&state.db).await?;
    }
    if let Some(d) = req.deny {
        if rid == gid {
            return Err(AppError::bad("@everyone can't take permissions away; use a Guest role"));
        }
        sqlx::query("UPDATE roles SET deny = ? WHERE id = ?").bind(d & perms::ALL & !perms::VIEW).bind(&rid).execute(&state.db).await?;
    }
    let role = sqlx::query_as::<_, Role>("SELECT id, guild_id, name, color, permissions, position, hoist, deny FROM roles WHERE id = ?")
        .bind(&rid).fetch_one(&state.db).await?;
    state.emit_guild(&gid, "ROLE_UPDATE", &role).await;
    Ok(Json(role))
}

pub async fn delete_role(State(state): State<Shared>, auth: AuthUser, Path((gid, rid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::MANAGE_ROLES).await?;
    if rid == gid {
        return Err(AppError::bad("cannot delete @everyone"));
    }
    sqlx::query("DELETE FROM roles WHERE id = ? AND guild_id = ?").bind(&rid).bind(&gid).execute(&state.db).await?;
    state.emit_guild(&gid, "ROLE_DELETE", &json!({ "id": rid, "guild_id": gid })).await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn add_member_role(State(state): State<Shared>, auth: AuthUser, Path((gid, uid, rid)): Path<(String, String, String)>) -> ApiResult<Json<Member>> {
    require_guild(&state.db, &gid, &auth.id, perms::MANAGE_ROLES).await?;
    if rid == gid {
        return Err(AppError::bad("everyone has @everyone"));
    }
    sqlx::query("INSERT OR IGNORE INTO member_roles (guild_id, user_id, role_id) SELECT ?, ?, id FROM roles WHERE id = ? AND guild_id = ?")
        .bind(&gid).bind(&uid).bind(&rid).bind(&gid).execute(&state.db).await?;
    let m = load_member(&state.db, &gid, &uid).await?;
    state.emit_guild(&gid, "GUILD_MEMBER_UPDATE", &m).await;
    Ok(Json(m))
}

pub async fn remove_member_role(State(state): State<Shared>, auth: AuthUser, Path((gid, uid, rid)): Path<(String, String, String)>) -> ApiResult<Json<Member>> {
    require_guild(&state.db, &gid, &auth.id, perms::MANAGE_ROLES).await?;
    sqlx::query("DELETE FROM member_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?")
        .bind(&gid).bind(&uid).bind(&rid).execute(&state.db).await?;
    let m = load_member(&state.db, &gid, &uid).await?;
    state.emit_guild(&gid, "GUILD_MEMBER_UPDATE", &m).await;
    Ok(Json(m))
}

#[derive(Deserialize)]
pub struct UpdateMember {
    pub nickname: Option<Option<String>>,
}

pub async fn update_member(State(state): State<Shared>, auth: AuthUser, Path((gid, uid)): Path<(String, String)>, Json(req): Json<UpdateMember>) -> ApiResult<Json<Member>> {
    let uid = if uid == "@me" { auth.id.clone() } else { uid };
    if uid != auth.id {
        require_guild(&state.db, &gid, &auth.id, perms::MANAGE_GUILD).await?;
    } else {
        require_guild(&state.db, &gid, &auth.id, perms::VIEW).await?;
    }
    if let Some(n) = req.nickname {
        let n = n.map(|s| s.trim().chars().take(32).collect::<String>()).filter(|s| !s.is_empty());
        sqlx::query("UPDATE members SET nickname = ? WHERE guild_id = ? AND user_id = ?")
            .bind(n).bind(&gid).bind(&uid).execute(&state.db).await?;
    }
    let m = load_member(&state.db, &gid, &uid).await?;
    state.emit_guild(&gid, "GUILD_MEMBER_UPDATE", &m).await;
    Ok(Json(m))
}

async fn remove_member_inner(state: &Shared, gid: &str, uid: &str) -> ApiResult<()> {
    let members = crate::state::guild_member_ids(&state.db, gid).await;
    sqlx::query("DELETE FROM members WHERE guild_id = ? AND user_id = ?").bind(gid).bind(uid).execute(&state.db).await?;
    state.hub.send_users(&members, "GUILD_MEMBER_REMOVE", &json!({ "guild_id": gid, "user_id": uid }));
    state.hub.send_user(uid, "GUILD_DELETE", &json!({ "id": gid }));
    Ok(())
}

pub async fn kick_member(State(state): State<Shared>, auth: AuthUser, Path((gid, uid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let owner: String = sqlx::query_scalar("SELECT owner_id FROM guilds WHERE id = ?").bind(&gid).fetch_one(&state.db).await?;
    if uid == "@me" || uid == auth.id {
        if owner == auth.id {
            return Err(AppError::bad("owner can't leave; delete the server or transfer it"));
        }
        remove_member_inner(&state, &gid, &auth.id).await?;
    } else {
        require_guild(&state.db, &gid, &auth.id, perms::KICK).await?;
        if uid == owner {
            return Err(AppError::forbidden());
        }
        remove_member_inner(&state, &gid, &uid).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct BanReq {
    pub reason: Option<String>,
    pub delete_messages: Option<bool>,
}

pub async fn ban_member(State(state): State<Shared>, auth: AuthUser, Path((gid, uid)): Path<(String, String)>, Json(req): Json<BanReq>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::BAN).await?;
    let owner: String = sqlx::query_scalar("SELECT owner_id FROM guilds WHERE id = ?").bind(&gid).fetch_one(&state.db).await?;
    if uid == owner || uid == auth.id {
        return Err(AppError::forbidden());
    }
    sqlx::query("INSERT OR REPLACE INTO bans (guild_id, user_id, reason, created_at) VALUES (?,?,?,?)")
        .bind(&gid).bind(&uid).bind(req.reason).bind(now_ms()).execute(&state.db).await?;
    if req.delete_messages.unwrap_or(false) {
        sqlx::query("DELETE FROM messages WHERE author_id = ? AND channel_id IN (SELECT id FROM channels WHERE guild_id = ?)")
            .bind(&uid).bind(&gid).execute(&state.db).await?;
    }
    remove_member_inner(&state, &gid, &uid).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn unban_member(State(state): State<Shared>, auth: AuthUser, Path((gid, uid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::BAN).await?;
    sqlx::query("DELETE FROM bans WHERE guild_id = ? AND user_id = ?").bind(&gid).bind(&uid).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn list_bans(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::BAN).await?;
    let rows: Vec<(String, Option<String>, i64, Option<String>)> = sqlx::query_as(
        "SELECT b.user_id, b.reason, b.created_at, u.username FROM bans b LEFT JOIN users u ON u.id = b.user_id WHERE b.guild_id = ?",
    ).bind(&gid).fetch_all(&state.db).await?;
    Ok(Json(json!(rows.into_iter().map(|(u, r, c, n)| json!({"user_id": u, "reason": r, "created_at": c, "username": n})).collect::<Vec<_>>())))
}

// ---------- invites ----------

#[derive(Deserialize)]
pub struct CreateInvite {
    pub max_uses: Option<i64>,
    /// seconds; 0/None = never
    pub expires_in: Option<i64>,
}

pub async fn create_invite(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>, Json(req): Json<CreateInvite>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::CREATE_INVITE).await?;
    let code = invite_code();
    let exp = req.expires_in.filter(|s| *s > 0).map(|s| now_ms() + s * 1000);
    sqlx::query("INSERT INTO invites (code, guild_id, creator_id, max_uses, expires_at, created_at) VALUES (?,?,?,?,?,?)")
        .bind(&code).bind(&gid).bind(&auth.id).bind(req.max_uses.unwrap_or(0).max(0)).bind(exp).bind(now_ms())
        .execute(&state.db).await?;
    Ok(Json(json!({ "code": code, "guild_id": gid, "max_uses": req.max_uses.unwrap_or(0), "expires_at": exp, "uses": 0 })))
}

pub async fn list_invites(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::MANAGE_GUILD).await?;
    let rows: Vec<(String, Option<String>, i64, i64, Option<i64>, i64)> = sqlx::query_as(
        "SELECT code, creator_id, uses, max_uses, expires_at, created_at FROM invites WHERE guild_id = ? ORDER BY created_at DESC",
    ).bind(&gid).fetch_all(&state.db).await?;
    Ok(Json(json!(rows.into_iter().map(|(code, creator, uses, max, exp, c)| json!({
        "code": code, "creator_id": creator, "uses": uses, "max_uses": max, "expires_at": exp, "created_at": c
    })).collect::<Vec<_>>())))
}

pub async fn delete_invite(State(state): State<Shared>, auth: AuthUser, Path(code): Path<String>) -> ApiResult<Json<Value>> {
    let gid: Option<String> = sqlx::query_scalar("SELECT guild_id FROM invites WHERE code = ?").bind(&code).fetch_one(&state.db).await?;
    match gid {
        Some(g) => { require_guild(&state.db, &g, &auth.id, perms::MANAGE_GUILD).await?; }
        None => if !auth.is_admin { return Err(AppError::forbidden()); },
    }
    sqlx::query("DELETE FROM invites WHERE code = ?").bind(&code).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Public: preview an invite before signing up / joining.
pub async fn preview_invite(State(state): State<Shared>, Path(code): Path<String>) -> ApiResult<Json<Value>> {
    let (gid, _) = crate::api::auth::check_invite(&state, &code).await?;
    let guild = match &gid {
        Some(g) => {
            let (name, icon): (String, Option<String>) = sqlx::query_as("SELECT name, icon_file_id FROM guilds WHERE id = ?")
                .bind(g).fetch_one(&state.db).await?;
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM members WHERE guild_id = ?").bind(g).fetch_one(&state.db).await?;
            json!({ "id": g, "name": name, "icon_file_id": icon, "member_count": count })
        }
        None => Value::Null,
    };
    Ok(Json(json!({ "code": code, "guild": guild })))
}

pub async fn accept_invite(State(state): State<Shared>, auth: AuthUser, Path(code): Path<String>) -> ApiResult<Json<Value>> {
    let (gid, grants_admin) = crate::api::auth::check_invite(&state, &code).await?;
    if grants_admin && !auth.is_kid {
        sqlx::query("UPDATE users SET is_admin = 1, instance_role = CASE WHEN instance_role = 'master' THEN 'master' ELSE 'admin' END WHERE id = ?")
            .bind(&auth.id)
            .execute(&state.db)
            .await?;
    }
    if let Some(g) = &gid {
        if !crate::kids::join_allowed(&state, &auth.id, g).await? {
            crate::api::auth::consume_invite(&state, &code).await?;
            return Ok(Json(json!({ "guild_id": gid, "pending": true })));
        }
        add_member(&state, g, &auth.id).await?;
    }
    crate::api::auth::consume_invite(&state, &code).await?;
    Ok(Json(json!({ "guild_id": gid })))
}

/// Instance admins: create an invite that makes accounts without joining a server (optionally granting admin).
#[derive(Deserialize)]
pub struct InstanceInvite {
    pub max_uses: Option<i64>,
    pub expires_in: Option<i64>,
    pub grants_admin: Option<bool>,
}

pub async fn create_instance_invite(State(state): State<Shared>, auth: AuthUser, Json(req): Json<InstanceInvite>) -> ApiResult<Json<Value>> {
    if !auth.is_admin {
        return Err(AppError::forbidden());
    }
    let code = invite_code();
    let exp = req.expires_in.filter(|s| *s > 0).map(|s| now_ms() + s * 1000);
    sqlx::query("INSERT INTO invites (code, guild_id, creator_id, max_uses, expires_at, grants_admin, created_at) VALUES (?,NULL,?,?,?,?,?)")
        .bind(&code).bind(&auth.id).bind(req.max_uses.unwrap_or(1)).bind(exp).bind(req.grants_admin.unwrap_or(false)).bind(now_ms())
        .execute(&state.db).await?;
    Ok(Json(json!({ "code": code })))
}
