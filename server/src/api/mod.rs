pub mod alarms;
pub mod auth;
pub mod embeds;
pub mod files;
pub mod gifs;
pub mod highlights;
pub mod notes;
pub mod schedule;
pub mod news;
pub mod guilds;
pub mod messages;
pub mod voice;

use crate::error::{random_token, ApiResult, AppError};
use crate::models::{UserPublic, USER_COLS};
use crate::state::{AuthUser, Shared};
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn router(state: Shared) -> Router<Shared> {
    let _ = &state;
    // per-file size is enforced in files.rs from Server Settings; this is only a hard ceiling
    let upload_limit: usize = 20_000 * 1024 * 1024;
    Router::new()
        .route("/api/info", get(info))
        // shared invite links open the web app's sign-up page
        .route("/invite/{code}", get(invite_redirect))
        .route("/api/setup", post(setup))
        .route("/api/admin/ai", get(crate::ai::get_status).post(crate::ai::set_model).delete(crate::ai::disable))
        .route("/api/admin/ai/quants", get(crate::ai::get_quants))
        .route("/api/admin/ai/models", get(crate::ai::list_models).delete(crate::ai::delete_model))
        .route("/api/admin/settings", get(crate::settings::get_settings).put(crate::settings::put_settings))
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
        .route("/api/messages/{mid}/share", post(messages::share_message))
        .route("/api/home", get(notes::home))
        .route("/api/news", get(news::list_instance).post(news::create_instance))
        .route("/api/news/llamble", get(news::llamble))
        .route("/api/news/{id}", patch(news::edit).delete(news::delete))
        .route("/api/guilds/{gid}/news", get(news::list_guild).post(news::create_guild))
        .route("/api/board-prefs", get(news::get_prefs))
        .route("/api/board-prefs/{gid}", put(news::put_prefs))
        .route("/api/admin/users/{uid}/news-writer", put(news::set_news_writer))
        .route("/api/admin/llamble-news/refresh", post(news::refresh_now))
        .route("/api/guilds/{gid}/notes", get(notes::list).post(notes::create))
        .route("/api/notes/{id}", patch(notes::edit).delete(notes::delete))
        .route("/api/notes/{id}/read", post(notes::read))
        .route("/api/notes/{id}/dismiss", post(notes::dismiss))
        .route("/api/notes/{id}/undismiss", post(notes::undismiss))
        .route("/api/notes/{id}/reads", get(notes::reads))
        .route("/api/guilds/{gid}/highlights", get(highlights::list).post(highlights::create))
        .route("/api/highlights/{id}", delete(highlights::delete))
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
        .route("/api/admin/users/{uid}/role", post(admin_set_role))
        .route("/api/admin/users/{uid}/kid", post(crate::kids::admin_set_kid))
        .route("/api/admin/transfer-master", post(admin_transfer_master))
        // password recovery
        .route("/api/auth/recover", post(auth::recover_with_code))
        .route("/api/auth/reset-email", post(crate::email::reset_by_email))
        .route("/api/admin/smtp", get(crate::email::get_smtp).put(crate::email::put_smtp))
        .route("/api/admin/smtp/test", post(crate::email::test_smtp))
        .route("/api/auth/reset-request", post(auth::request_reset))
        .route("/api/auth/reset-request/{id}", post(auth::poll_reset))
        .route("/api/me/recovery-code", post(auth::regen_recovery_code))
        .route("/api/me/email", get(auth::my_email))
        .route("/api/reset-requests", get(auth::list_reset_requests))
        .route("/api/reset-requests/{id}", post(auth::decide_reset))
        // kids & parents
        .route("/api/kids", get(crate::kids::list_kids).post(crate::kids::create_kid))
        .route("/api/alarms", get(alarms::list).post(alarms::create))
        .route("/api/alarms/{id}", patch(alarms::update).delete(alarms::delete))
        .route("/api/alarms/{id}/snooze", post(alarms::snooze))
        .route("/api/alarms/{id}/dismiss", post(alarms::dismiss))
        .route("/api/kids/{kid}/alarms", get(alarms::kid_list).post(alarms::kid_create))
        .route("/api/schedule", get(schedule::get).put(schedule::put))
        .route("/api/schedule/upcoming", get(schedule::upcoming))
        .route("/api/schedule/suggestion", get(schedule::suggestion))
        .route("/api/schedule/suggestion/decline", post(schedule::decline))
        .route("/api/kids/{kid}/settings", post(crate::kids::update_kid_settings))
        .route("/api/kids/{kid}/guardians", post(crate::kids::add_guardian))
        .route("/api/kids/{kid}/guardians/{g}", delete(crate::kids::remove_guardian))
        .route("/api/kids/{kid}/contacts", post(crate::kids::add_contact))
        .route("/api/kids/{kid}/contacts/{u}", delete(crate::kids::remove_contact))
        .route("/api/kids/{kid}/password", post(crate::kids::set_kid_password))
        .route("/api/kids/{kid}/guilds", post(crate::kids::add_to_guild))
        .route("/api/kids/{kid}/guilds/{gid}", delete(crate::kids::remove_from_guild))
        .route("/api/kids/{kid}/channels", get(crate::kids::kid_channels))
        .route("/api/kid-requests/{rid}", post(crate::kids::decide_request))
        // roles & clearing
        .route("/api/guilds/{gid}/roles/presets", post(guilds::add_presets))
        // shows (recording)
        .route("/api/channels/{cid}/shows", get(crate::shows::list).post(crate::shows::create))
        .route("/api/shows", get(crate::shows::mine))
        .route("/api/guilds/{gid}/sounds", get(crate::soundboard::list).post(crate::soundboard::add))
        .route("/api/guilds/{gid}/sounds/{sid}", delete(crate::soundboard::remove))
        .route("/api/channels/{cid}/soundboard", post(crate::soundboard::play))
        .route("/api/channels/{cid}/listen", post(crate::voicebot::utterance))
        .route("/api/voice-ai/audio/{id}", get(crate::voicebot::audio))
        .route("/api/admin/voice-ai", get(crate::voicebot::get_admin).put(crate::voicebot::put_admin))
        .route("/api/admin/voice-ai/preview", post(crate::voicebot::preview))
        .route("/api/voice-ai/test", post(crate::voicebot::test_hearing))
        .route("/api/admin/bot-tools", get(crate::tools::get_admin).put(crate::tools::put_admin))
        .route("/api/channels/{cid}/imagine", post(crate::images::imagine))
        .route("/api/image-jobs/{job}", post(crate::images::job_result).layer(DefaultBodyLimit::max(32 * 1024 * 1024)))
        .route("/api/admin/images", get(crate::images::get_admin).put(crate::images::put_admin))
        .route("/api/guilds/{gid}/voice-listen", put(crate::voicebot::set_guild_listen))
        .route("/api/kids/{kid}/calls", get(crate::voicebot::kid_calls))
        .route("/api/shows/{id}", delete(crate::shows::delete))
        .route("/api/shows/{id}/consent", post(crate::shows::consent))
        .route("/api/shows/{id}/role", post(crate::shows::answer_role))
        .route("/api/shows/{id}/director", post(crate::shows::hand_off))
        .route("/api/shows/{id}/start", post(crate::shows::start))
        .route("/api/shows/{id}/state", post(crate::shows::set_state))
        .route("/api/shows/{id}/chunk", post(crate::shows::upload_chunk).layer(DefaultBodyLimit::max(64 * 1024 * 1024)))
        .route("/api/shows/{id}/stop", post(crate::shows::stop))
        .route("/api/shows/{id}/video", get(crate::shows::video))
        .route("/api/channels/{cid}/messages/bulk-delete", post(messages::bulk_delete))
        .route("/api/channels/{cid}/messages/all", delete(messages::clear_channel))
        .route("/api/guilds/{gid}/members/{uid}/messages", delete(messages::delete_user_messages))
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
    sqlx::query("INSERT INTO users (id, username, display_name, password_hash, is_admin, instance_role, created_at) VALUES (?,?,?,?,1,'master',?)")
        .bind(&id).bind(&username).bind(&display).bind(&hash).bind(crate::error::now_ms())
        .execute(&state.db).await?;
    // the bootstrap invite is no longer needed
    sqlx::query("DELETE FROM invites WHERE grants_admin = 1 AND guild_id IS NULL").execute(&state.db).await?;
    let _ = std::fs::remove_file(state.cfg.data_dir.join("ADMIN_INVITE.txt"));
    let token = auth::create_session(&state, &id, req.device_name.as_deref().unwrap_or("")).await?;

    let mut guild_id = None;
    if let Some(name) = req.server_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let auth_user = AuthUser { id: id.clone(), is_admin: true, is_master: true, is_kid: false, token_hash: String::new() };
        let g = guilds::create_guild(State(state.clone()), auth_user, Json(guilds::CreateGuild { name: name.to_string() })).await?;
        let gid = g.0["guild"]["id"].as_str().unwrap_or_default().to_string();
        sqlx::query("INSERT OR REPLACE INTO bot_settings (guild_id, enabled, system_prompt, always_channels) VALUES (?,1,'','[]')")
            .bind(&gid).execute(&state.db).await?;
        guilds::add_member(&state, &gid, &state.bot_id).await?;
        guild_id = Some(gid);
    }
    let recovery_code = auth::new_recovery_code(&state, &id).await?;
    let user = crate::models::get_user(&state.db, &id).await?;
    Ok(Json(json!({ "token": token, "user": user, "guild_id": guild_id, "recovery_code": recovery_code })))
}

async fn invite_redirect(Path(code): Path<String>) -> axum::response::Redirect {
    let code: String = code.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect();
    axum::response::Redirect::to(&format!("/?invite={code}"))
}

async fn info(State(state): State<Shared>) -> Json<Value> {
    Json(json!({
        "setup_required": setup_required(&state).await,
        "name": "Llamble",
        "version": env!("CARGO_PKG_VERSION"),
        "voice_enabled": crate::voice_server::enabled(&state),
        "version": crate::config::server_version(),
        "email_reset": crate::email::configured(&state).await,
        "max_upload_bytes": state.s().max_upload_bytes(),
        "bot_name": state.s().bot_name,
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

async fn admin_users(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Vec<Value>>> {
    if !auth.is_admin {
        return Err(AppError::forbidden());
    }
    let users = sqlx::query_as::<_, UserPublic>(&format!("SELECT {USER_COLS} FROM users ORDER BY created_at")).fetch_all(&state.db).await?;
    let writers: Vec<String> = sqlx::query_scalar("SELECT id FROM users WHERE news_writer = 1").fetch_all(&state.db).await?;
    Ok(Json(
        users
            .into_iter()
            .map(|u| {
                let mut v = serde_json::to_value(&u).unwrap_or(Value::Null);
                v["news_writer"] = json!(writers.contains(&u.id));
                v
            })
            .collect(),
    ))
}

async fn role_of(state: &Shared, uid: &str) -> ApiResult<String> {
    Ok(sqlx::query_scalar("SELECT instance_role FROM users WHERE id = ?").bind(uid).fetch_optional(&state.db).await?.ok_or_else(AppError::not_found)?)
}

#[derive(Deserialize)]
struct SetRole {
    /// admin | user
    role: String,
}

/// Master Admin only: make someone an Instance Admin, or a regular user again.
async fn admin_set_role(State(state): State<Shared>, auth: AuthUser, Path(uid): Path<String>, Json(req): Json<SetRole>) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden_msg("only the Master Admin can change admin levels"));
    }
    if role_of(&state, &uid).await? == "master" {
        return Err(AppError::bad("use 'make Master Admin' to hand over the Master role"));
    }
    if !["admin", "user"].contains(&req.role.as_str()) {
        return Err(AppError::bad("role must be admin or user"));
    }
    if req.role == "admin" && crate::kids::is_kid(&state, &uid).await {
        return Err(AppError::bad("kid accounts can't be admins"));
    }
    sqlx::query("UPDATE users SET instance_role = ?, is_admin = ? WHERE id = ? AND is_bot = 0")
        .bind(&req.role)
        .bind(req.role == "admin")
        .bind(&uid)
        .execute(&state.db)
        .await?;
    state.hub.kick_user(&uid);
    Ok(Json(json!({ "user": crate::models::get_user(&state.db, &uid).await? })))
}

#[derive(Deserialize)]
struct Transfer {
    user_id: String,
}

/// Master Admin hands the Master role to someone else (and becomes an Instance Admin).
async fn admin_transfer_master(State(state): State<Shared>, auth: AuthUser, Json(req): Json<Transfer>) -> ApiResult<Json<Value>> {
    if !auth.is_master || req.user_id == auth.id {
        return Err(AppError::forbidden());
    }
    let (kid, bot): (bool, bool) = sqlx::query_as("SELECT is_kid, is_bot FROM users WHERE id = ?").bind(&req.user_id).fetch_optional(&state.db).await?.ok_or_else(AppError::not_found)?;
    if kid || bot {
        return Err(AppError::bad("that account can't be the Master Admin"));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET instance_role = 'admin', is_admin = 1 WHERE id = ?").bind(&auth.id).execute(&mut *tx).await?;
    sqlx::query("UPDATE users SET instance_role = 'master', is_admin = 1 WHERE id = ?").bind(&req.user_id).execute(&mut *tx).await?;
    tx.commit().await?;
    state.hub.kick_user(&auth.id);
    state.hub.kick_user(&req.user_id);
    Ok(Json(json!({ "ok": true })))
}

async fn admin_delete_user(State(state): State<Shared>, auth: AuthUser, Path(uid): Path<String>) -> ApiResult<Json<Value>> {
    if !auth.is_admin || uid == auth.id {
        return Err(AppError::forbidden());
    }
    if role_of(&state, &uid).await? == "master" {
        return Err(AppError::forbidden_msg("the Master Admin can't be deleted"));
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
    if role_of(&state, &uid).await? == "master" && !auth.is_master {
        return Err(AppError::forbidden_msg("only the Master Admin can reset the Master Admin's password"));
    }
    let temp = random_token(9);
    let hash = auth::hash_password(temp.clone()).await?;
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash).bind(&uid).execute(&state.db).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?").bind(&uid).execute(&state.db).await?;
    state.hub.kick_user(&uid);
    Ok(Json(json!({ "temporary_password": temp })))
}
