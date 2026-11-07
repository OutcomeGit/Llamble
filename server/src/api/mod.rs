pub mod auth;
pub mod embeds;
pub mod files;
pub mod gifs;
pub mod guilds;
pub mod messages;
pub mod voice;

use crate::error::{random_token, ApiResult, AppError};
use crate::models::{UserPublic, USER_COLS};
use crate::state::{AuthUser, Shared};
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use serde_json::{json, Value};

pub fn router(state: Shared) -> Router<Shared> {
    let upload_limit = state.cfg.max_upload_bytes as usize + 1024 * 1024;
    Router::new()
        .route("/api/info", get(info))
        .route("/api/setup", post(setup))
        .route("/api/admin/ai", get(crate::ai::get_status).post(crate::ai::set_model).delete(crate::ai::disable))
        .route("/api/admin/ai/quants", get(crate::ai::get_quants))
        .route("/api/admin/remote", get(crate::remote::get_remote).put(crate::remote::set_remote))
        .route("/livekit/{*rest}", axum::routing::any(crate::remote::livekit_proxy))
        .route("/api/admin/gpu", get(crate::bot::get_gpu_pool).patch(crate::bot::set_gpu_policy))
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/users/@me", get(auth::me).patch(auth::update_me))
        .route("/api/users/@me/sessions", get(auth::sessions))
        .route("/api/users/@me/channels", post(messages::open_dm))
        .route("/api/guilds", post(guilds::create_guild))
        .route("/api/guilds/{gid}", patch(guilds::update_guild).delete(guilds::delete_guild))
        .route("/api/guilds/{gid}/channels", post(guilds::create_channel))
        .route("/api/guilds/{gid}/roles", post(guilds::create_role))
        .route("/api/guilds/{gid}/roles/{rid}", patch(guilds::update_role).delete(guilds::delete_role))
        .route("/api/guilds/{gid}/members/{uid}", patch(guilds::update_member).delete(guilds::kick_member))
        .route("/api/guilds/{gid}/members/{uid}/roles/{rid}", put(guilds::add_member_role).delete(guilds::remove_member_role))
        .route("/api/guilds/{gid}/bans", get(guilds::list_bans))
        .route("/api/guilds/{gid}/bans/{uid}", put(guilds::ban_member).delete(guilds::unban_member))
        .route("/api/guilds/{gid}/invites", post(guilds::create_invite).get(guilds::list_invites))
        .route("/api/invites/{code}", get(guilds::preview_invite).post(guilds::accept_invite).delete(guilds::delete_invite))
        .route("/api/channels/{cid}", patch(guilds::update_channel).delete(guilds::delete_channel))
        .route("/api/channels/{cid}/messages", get(messages::list_messages).post(messages::create_message))
        .route("/api/channels/{cid}/search", get(messages::search))
        .route("/api/channels/{cid}/typing", post(messages::typing))
        .route("/api/channels/{cid}/ack", post(messages::ack))
        .route("/api/channels/{cid}/voice", post(voice::join))
        .route("/api/channels/{cid}/ring", post(voice::ring))
        .route("/api/voice/leave", post(voice::leave))
        .route("/api/voice/state", patch(voice::update))
        .route("/api/messages/{mid}", patch(messages::edit_message).delete(messages::delete_message))
        .route("/api/messages/{mid}/reactions/{emoji}", put(messages::add_reaction).delete(messages::remove_reaction))
        .route("/api/files", post(files::upload).layer(DefaultBodyLimit::max(upload_limit)))
        .route("/api/files/{id}", get(files::get_file_handler))
        .route("/api/files/{id}/{name}", get(files::get_file_handler))
        .route("/api/thumbs/{id}", get(files::get_thumb))
        .route("/api/proxy", get(embeds::proxy))
        .route("/api/gifs", get(gifs::list).post(gifs::add))
        .route("/api/gifs/{id}", patch(gifs::edit).delete(gifs::remove))
        .route("/api/gifs/{id}/favorite", put(gifs::favorite).delete(gifs::unfavorite))
        .route("/api/admin/users", get(admin_users))
        .route("/api/admin/users/{uid}", delete(admin_delete_user))
        .route("/api/admin/users/{uid}/reset-password", post(admin_reset_password))
        .route("/api/admin/invites", post(guilds::create_instance_invite))
        .route("/api/gateway", get(crate::gateway::upgrade))
        .route("/api/bot", get(crate::bot::status))
        .route("/api/bot/dm", post(bot_dm))
        .route("/api/guilds/{gid}/bot", get(crate::bot::get_settings).patch(crate::bot::update_settings))
}

async fn setup_required(state: &Shared) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users WHERE is_bot = 0")
        .fetch_one(&state.db)
        .await
        .map(|n| n == 0)
        .unwrap_or(false)
}

#[derive(serde::Deserialize)]
struct SetupReq {
    username: String,
    password: String,
    display_name: Option<String>,
    server_name: Option<String>,
    device_name: Option<String>,
}

/// First-run setup: creates the instance admin (only while no accounts exist),
/// optionally the first server with the AI bot enabled, and signs in.
async fn setup(State(state): State<Shared>, Json(req): Json<SetupReq>) -> ApiResult<Json<Value>> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _g = LOCK.lock().await;
    if !setup_required(&state).await {
        return Err(AppError::conflict("setup is already complete — sign in instead"));
    }
    let username = req.username.trim().to_string();
    if !auth::valid_username(&username) {
        return Err(AppError::bad("username must be 2-32 chars: letters, numbers, _ . -"));
    }
    if req.password.len() < 8 {
        return Err(AppError::bad("password must be at least 8 characters"));
    }
    let id = crate::error::new_id();
    let display: String = req.display_name.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&username).chars().take(32).collect();
    let hash = auth::hash_password(req.password.clone()).await?;
    sqlx::query("INSERT INTO users (id, username, display_name, password_hash, is_admin, created_at) VALUES (?,?,?,?,1,?)")
        .bind(&id).bind(&username).bind(&display).bind(&hash).bind(crate::error::now_ms())
        .execute(&state.db).await?;
    // the bootstrap invite is no longer needed
    sqlx::query("DELETE FROM invites WHERE grants_admin = 1 AND guild_id IS NULL").execute(&state.db).await?;
    let _ = std::fs::remove_file(state.cfg.data_dir.join("ADMIN_INVITE.txt"));
    let token = auth::create_session(&state, &id, req.device_name.as_deref().unwrap_or("")).await?;

    let mut guild_id = None;
    if let Some(name) = req.server_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let auth_user = AuthUser { id: id.clone(), is_admin: true, token_hash: String::new() };
        let g = guilds::create_guild(State(state.clone()), auth_user, Json(guilds::CreateGuild { name: name.to_string() })).await?;
        let gid = g.0["guild"]["id"].as_str().unwrap_or_default().to_string();
        sqlx::query("INSERT OR REPLACE INTO bot_settings (guild_id, enabled, system_prompt, always_channels) VALUES (?,1,'','[]')")
            .bind(&gid).execute(&state.db).await?;
        guilds::add_member(&state, &gid, &state.bot_id).await?;
        guild_id = Some(gid);
    }
    let user = crate::models::get_user(&state.db, &id).await?;
    Ok(Json(json!({ "token": token, "user": user, "guild_id": guild_id })))
}

async fn info(State(state): State<Shared>) -> Json<Value> {
    Json(json!({
        "setup_required": setup_required(&state).await,
        "name": "Llamble",
        "version": env!("CARGO_PKG_VERSION"),
        "voice_enabled": state.cfg.voice_enabled(),
        "max_upload_bytes": state.cfg.max_upload_bytes,
        "bot_name": state.cfg.bot_name,
    }))
}

/// Open (or reuse) a DM with the AI bot.
async fn bot_dm(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT a.channel_id FROM dm_members a JOIN dm_members b ON a.channel_id = b.channel_id
         WHERE a.user_id = ? AND b.user_id = ? LIMIT 1",
    ).bind(&auth.id).bind(&state.bot_id).fetch_optional(&state.db).await?;
    let cid = match existing {
        Some(c) => c,
        None => {
            let c = crate::error::new_id();
            sqlx::query("INSERT INTO channels (id, guild_id, kind, created_at) VALUES (?, NULL, 'dm', ?)")
                .bind(&c).bind(crate::error::now_ms()).execute(&state.db).await?;
            for u in [&auth.id, &state.bot_id] {
                sqlx::query("INSERT INTO dm_members (channel_id, user_id) VALUES (?,?)").bind(&c).bind(u).execute(&state.db).await?;
            }
            c
        }
    };
    let payload = messages::dm_payload(&state, &cid).await?;
    state.hub.send_user(&auth.id, "CHANNEL_CREATE", &payload);
    Ok(Json(payload))
}

async fn admin_users(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Vec<UserPublic>>> {
    if !auth.is_admin {
        return Err(AppError::forbidden());
    }
    Ok(Json(
        sqlx::query_as::<_, UserPublic>(&format!("SELECT {USER_COLS} FROM users ORDER BY created_at"))
            .fetch_all(&state.db)
            .await?,
    ))
}

async fn admin_delete_user(State(state): State<Shared>, auth: AuthUser, Path(uid): Path<String>) -> ApiResult<Json<Value>> {
    if !auth.is_admin || uid == auth.id {
        return Err(AppError::forbidden());
    }
    let owns: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guilds WHERE owner_id = ?").bind(&uid).fetch_one(&state.db).await?;
    if owns > 0 {
        return Err(AppError::bad("user owns servers; delete or transfer them first"));
    }
    // Keep messages (authored by "Deleted User"); remove login + memberships.
    sqlx::query("DELETE FROM sessions WHERE user_id = ?").bind(&uid).execute(&state.db).await?;
    sqlx::query("DELETE FROM members WHERE user_id = ?").bind(&uid).execute(&state.db).await?;
    sqlx::query("UPDATE users SET username = 'deleted-' || id, display_name = 'Deleted User', password_hash = '!', avatar_file_id = NULL, is_admin = 0 WHERE id = ?")
        .bind(&uid).execute(&state.db).await?;
    state.hub.kick_user(&uid);
    Ok(Json(json!({ "ok": true })))
}

async fn admin_reset_password(State(state): State<Shared>, auth: AuthUser, Path(uid): Path<String>) -> ApiResult<Json<Value>> {
    if !auth.is_admin {
        return Err(AppError::forbidden());
    }
    let temp = random_token(9);
    let hash = auth::hash_password(temp.clone()).await?;
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash).bind(&uid).execute(&state.db).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?").bind(&uid).execute(&state.db).await?;
    state.hub.kick_user(&uid);
    Ok(Json(json!({ "temporary_password": temp })))
}
