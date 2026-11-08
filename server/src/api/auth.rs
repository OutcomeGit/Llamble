use crate::api::guilds::add_member;
use crate::error::{now_ms, new_id, random_token, sha256_hex, ApiResult, AppError};
use crate::models::{get_user, UserPublic};
use crate::state::{AuthUser, Shared};
use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct RegisterReq {
    pub invite: String,
    pub username: String,
    pub password: String,
    pub display_name: Option<String>,
    pub device_name: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginReq {
    pub username: String,
    pub password: String,
    pub device_name: Option<String>,
}

pub fn valid_username(u: &str) -> bool {
    (2..=32).contains(&u.len()) && u.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}

pub async fn hash_password(pw: String) -> ApiResult<String> {
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default().hash_password(pw.as_bytes(), &salt).map(|h| h.to_string())
    })
    .await
    .map_err(|e| anyhow::anyhow!(e))?
    .map_err(|e| AppError::from(anyhow::anyhow!("hash: {e}")))
}

async fn verify_password(pw: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash)
            .map(|h| Argon2::default().verify_password(pw.as_bytes(), &h).is_ok())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

pub async fn create_session(state: &Shared, user_id: &str, device: &str) -> ApiResult<String> {
    let token = random_token(32);
    let now = now_ms();
    sqlx::query("INSERT INTO sessions (token_hash, user_id, device_name, created_at, last_seen) VALUES (?,?,?,?,?)")
        .bind(sha256_hex(token.as_bytes()))
        .bind(user_id)
        .bind(device.chars().take(64).collect::<String>())
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    Ok(token)
}

/// Validates an invite and returns (guild_id, grants_admin). Does not consume it.
pub async fn check_invite(state: &Shared, code: &str) -> ApiResult<(Option<String>, bool)> {
    let row: Option<(Option<String>, i64, i64, Option<i64>, bool)> = sqlx::query_as(
        "SELECT guild_id, uses, max_uses, expires_at, grants_admin FROM invites WHERE code = ?",
    )
    .bind(code.trim())
    .fetch_optional(&state.db)
    .await?;
    let Some((guild, uses, max, exp, admin)) = row else {
        return Err(AppError::bad("invalid or expired invite"));
    };
    if (max > 0 && uses >= max) || exp.map(|e| e < now_ms()).unwrap_or(false) {
        return Err(AppError::bad("invalid or expired invite"));
    }
    Ok((guild, admin))
}

pub async fn consume_invite(state: &Shared, code: &str) -> ApiResult<()> {
    sqlx::query("UPDATE invites SET uses = uses + 1 WHERE code = ?")
        .bind(code.trim())
        .execute(&state.db)
        .await?;
    Ok(())
}

pub async fn register(State(state): State<Shared>, Json(req): Json<RegisterReq>) -> ApiResult<Json<Value>> {
    let username = req.username.trim().to_string();
    if !valid_username(&username) {
        return Err(AppError::bad("username must be 2-32 chars: letters, numbers, _ . -"));
    }
    if req.password.len() < 8 {
        return Err(AppError::bad("password must be at least 8 characters"));
    }
    let (guild_id, grants_admin) = check_invite(&state, &req.invite).await?;
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM users WHERE username = ?")
        .bind(&username)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_some() {
        return Err(AppError::conflict("username taken"));
    }
    let hash = hash_password(req.password.clone()).await?;
    let id = new_id();
    let display = req
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&username)
        .chars()
        .take(32)
        .collect::<String>();
    sqlx::query("INSERT INTO users (id, username, display_name, password_hash, is_admin, created_at) VALUES (?,?,?,?,?,?)")
        .bind(&id)
        .bind(&username)
        .bind(&display)
        .bind(&hash)
        .bind(grants_admin)
        .bind(now_ms())
        .execute(&state.db)
        .await?;
    if grants_admin {
        let has_master: Option<i64> = sqlx::query_scalar("SELECT 1 FROM users WHERE instance_role = 'master'").fetch_optional(&state.db).await?;
        sqlx::query("UPDATE users SET instance_role = ? WHERE id = ?")
            .bind(if has_master.is_some() { "admin" } else { "master" })
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    consume_invite(&state, &req.invite).await?;
    if let Some(g) = guild_id {
        add_member(&state, &g, &id).await?;
    }
    let token = create_session(&state, &id, req.device_name.as_deref().unwrap_or("")).await?;
    let recovery_code = new_recovery_code(&state, &id).await?;
    let user = get_user(&state.db, &id).await?;
    Ok(Json(json!({ "token": token, "user": user, "recovery_code": recovery_code })))
}

// ---------- password recovery ----------

/// Make a new one-time recovery code for an account (replaces the old one). Shown once.
pub async fn new_recovery_code(state: &Shared, uid: &str) -> ApiResult<String> {
    use rand::Rng;
    const ALPHA: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I mix-ups
    let raw: String = {
        let mut rng = rand::thread_rng();
        (0..16).map(|_| ALPHA[rng.gen_range(0..ALPHA.len())] as char).collect()
    };
    let code = format!("{}-{}-{}-{}", &raw[0..4], &raw[4..8], &raw[8..12], &raw[12..16]);
    let hash = hash_password(raw).await?;
    sqlx::query("UPDATE users SET recovery_hash = ? WHERE id = ?").bind(hash).bind(uid).execute(&state.db).await?;
    Ok(code)
}

fn normalize_code(c: &str) -> String {
    c.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

async fn set_password(state: &Shared, uid: &str, pw: &str) -> ApiResult<()> {
    if pw.len() < 8 {
        return Err(AppError::bad("password must be at least 8 characters"));
    }
    let hash = hash_password(pw.to_string()).await?;
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash).bind(uid).execute(&state.db).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?").bind(uid).execute(&state.db).await?;
    state.hub.kick_user(uid);
    Ok(())
}

#[derive(Deserialize)]
pub struct RegenCode {
    pub password: String,
}

/// Show a fresh recovery code (needs the current password).
pub async fn regen_recovery_code(State(state): State<Shared>, auth: AuthUser, Json(req): Json<RegenCode>) -> ApiResult<Json<Value>> {
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?").bind(&auth.id).fetch_one(&state.db).await?;
    if !verify_password(req.password, hash).await {
        return Err(AppError(axum::http::StatusCode::UNAUTHORIZED, "wrong password".into()));
    }
    Ok(Json(json!({ "recovery_code": new_recovery_code(&state, &auth.id).await? })))
}

#[derive(Deserialize)]
pub struct RecoverReq {
    pub username: String,
    pub code: String,
    pub new_password: String,
}

/// Forgot password, with the account's recovery code. Gives back a new code (each works once).
pub async fn recover_with_code(State(state): State<Shared>, crate::state::ClientIp(ip): crate::state::ClientIp, Json(req): Json<RecoverReq>) -> ApiResult<Json<Value>> {
    let key = format!("recover:{}", req.username);
    if let Some(mins) = state.login_guard.blocked(&ip, &key) {
        return Err(AppError(axum::http::StatusCode::TOO_MANY_REQUESTS, format!("too many tries; try again in {mins} minutes")));
    }
    let row: Option<(String, Option<String>)> = sqlx::query_as("SELECT id, recovery_hash FROM users WHERE username = ? AND is_bot = 0")
        .bind(req.username.trim())
        .fetch_optional(&state.db)
        .await?;
    let ok = match &row {
        Some((_, Some(h))) => verify_password(normalize_code(&req.code), h.clone()).await,
        _ => false,
    };
    if !ok {
        state.login_guard.fail(&ip, &key);
        return Err(AppError(axum::http::StatusCode::UNAUTHORIZED, "that recovery code doesn't match".into()));
    }
    let uid = row.unwrap().0;
    set_password(&state, &uid, &req.new_password).await?;
    let code = new_recovery_code(&state, &uid).await?;
    let token = create_session(&state, &uid, "").await?;
    let user = get_user(&state.db, &uid).await?;
    Ok(Json(json!({ "token": token, "user": user, "recovery_code": code })))
}

#[derive(Deserialize)]
pub struct ResetRequestReq {
    pub username: String,
}

/// Who may approve a reset for this account: its parents (kids), otherwise admins; the
/// Master Admin's own reset can only be approved by another admin.
pub async fn reset_approvers(state: &Shared, uid: &str) -> ApiResult<Vec<String>> {
    let (is_kid, role): (bool, String) = sqlx::query_as("SELECT is_kid, instance_role FROM users WHERE id = ?").bind(uid).fetch_one(&state.db).await?;
    let mut ids: Vec<String> = if is_kid {
        sqlx::query_scalar("SELECT guardian_id FROM guardians WHERE kid_id = ?").bind(uid).fetch_all(&state.db).await?
    } else {
        vec![]
    };
    let admins: Vec<String> = sqlx::query_scalar("SELECT id FROM users WHERE instance_role IN ('master','admin') AND is_bot = 0 AND id != ?")
        .bind(uid)
        .fetch_all(&state.db)
        .await?;
    // kids: parents first, admins too (so a kid is never stuck). The Master Admin's account
    // can't be unlocked by anyone else: recovery code, email, or the server shell.
    if role == "master" {
        return Ok(vec![]);
    }
    ids.extend(admins);
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// "Forgot password" without a code: ask an admin (or a kid's parents) to approve.
/// The returned secret lets this screen check back and then set the new password itself.
pub async fn request_reset(State(state): State<Shared>, crate::state::ClientIp(ip): crate::state::ClientIp, Json(req): Json<ResetRequestReq>) -> ApiResult<Json<Value>> {
    if let Some(mins) = state.login_guard.blocked(&ip, "#reset-request") {
        return Err(AppError(axum::http::StatusCode::TOO_MANY_REQUESTS, format!("too many requests; try again in {mins} minutes")));
    }
    state.login_guard.fail(&ip, "#reset-request"); // counts requests, not just failures
    let secret = random_token(24);
    let id = new_id();
    let uid: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE username = ? AND is_bot = 0").bind(req.username.trim()).fetch_optional(&state.db).await?;
    // same answer whether or not the account exists, so this can't be used to find usernames
    if let Some(uid) = uid {
        sqlx::query("UPDATE reset_requests SET status = 'replaced' WHERE user_id = ? AND status = 'pending'").bind(&uid).execute(&state.db).await?;
        sqlx::query("INSERT INTO reset_requests (id, user_id, secret_hash, created_at) VALUES (?,?,?,?)")
            .bind(&id)
            .bind(&uid)
            .bind(crate::error::sha256_hex(secret.as_bytes()))
            .bind(now_ms())
            .execute(&state.db)
            .await?;
        let user = get_user(&state.db, &uid).await?;
        let approvers = reset_approvers(&state, &uid).await?;
        state.hub.send_users(&approvers, "RESET_REQUEST", &json!({ "id": id, "user": user }));
    }
    Ok(Json(json!({ "id": id, "secret": secret })))
}

#[derive(Deserialize)]
pub struct ResetPoll {
    pub secret: String,
    pub new_password: Option<String>,
}

async fn load_reset(state: &Shared, id: &str, secret: &str) -> ApiResult<(String, String, i64)> {
    let row: Option<(String, String, String, i64)> = sqlx::query_as("SELECT user_id, secret_hash, status, created_at FROM reset_requests WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    match row {
        Some((uid, h, status, at)) if h == crate::error::sha256_hex(secret.as_bytes()) => Ok((uid, status, at)),
        _ => Ok((String::new(), "pending".into(), now_ms())), // unknown request: looks pending forever
    }
}

/// The waiting screen checks here. Once approved, it sends the new password.
pub async fn poll_reset(State(state): State<Shared>, Path(id): Path<String>, Json(req): Json<ResetPoll>) -> ApiResult<Json<Value>> {
    let (uid, status, at) = load_reset(&state, &id, &req.secret).await?;
    let expired = now_ms() - at > 24 * 3600 * 1000;
    let status = if expired && (status == "pending" || status == "approved") { "expired".to_string() } else { status };
    if status == "approved" && !uid.is_empty() {
        if let Some(pw) = req.new_password {
            set_password(&state, &uid, &pw).await?;
            sqlx::query("UPDATE reset_requests SET status = 'done' WHERE id = ?").bind(&id).execute(&state.db).await?;
            let token = create_session(&state, &uid, "").await?;
            let user = get_user(&state.db, &uid).await?;
            return Ok(Json(json!({ "status": "done", "token": token, "user": user })));
        }
    }
    Ok(Json(json!({ "status": status })))
}

/// Pending reset requests this person can approve.
pub async fn list_reset_requests(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT id, user_id, created_at FROM reset_requests WHERE status = 'pending' AND created_at > ? ORDER BY created_at DESC",
    )
    .bind(now_ms() - 24 * 3600 * 1000)
    .fetch_all(&state.db)
    .await?;
    let mut out = vec![];
    for (id, uid, at) in rows {
        if reset_approvers(&state, &uid).await?.contains(&auth.id) {
            out.push(json!({ "id": id, "user": get_user(&state.db, &uid).await?, "created_at": at }));
        }
    }
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
pub struct DecideReset {
    pub approve: bool,
}

pub async fn decide_reset(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, Json(req): Json<DecideReset>) -> ApiResult<Json<Value>> {
    let uid: Option<String> = sqlx::query_scalar("SELECT user_id FROM reset_requests WHERE id = ? AND status = 'pending'").bind(&id).fetch_optional(&state.db).await?;
    let Some(uid) = uid else { return Err(AppError::not_found()) };
    if !reset_approvers(&state, &uid).await?.contains(&auth.id) {
        return Err(AppError::forbidden());
    }
    sqlx::query("UPDATE reset_requests SET status = ?, decided_by = ? WHERE id = ?")
        .bind(if req.approve { "approved" } else { "denied" })
        .bind(&auth.id)
        .bind(&id)
        .execute(&state.db)
        .await?;
    let approvers = reset_approvers(&state, &uid).await?;
    state.hub.send_users(&approvers, "RESET_REQUEST_DONE", &json!({ "id": id }));
    Ok(Json(json!({ "ok": true })))
}

pub async fn login(State(state): State<Shared>, crate::state::ClientIp(ip): crate::state::ClientIp, Json(req): Json<LoginReq>) -> ApiResult<Json<Value>> {
    if let Some(mins) = state.login_guard.blocked(&ip, &req.username) {
        return Err(AppError(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            format!("too many wrong passwords; try again in {mins} minute{}", if mins == 1 { "" } else { "s" }),
        ));
    }
    let row: Option<(String, String)> = sqlx::query_as("SELECT id, password_hash FROM users WHERE username = ?")
        .bind(req.username.trim())
        .fetch_optional(&state.db)
        .await?;
    // constant-ish work even when user doesn't exist
    let (id, hash) = row.unwrap_or_else(|| {
        (String::new(), "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$5Y1ZBvM6eN0m3e5dqK9H2bJm2w5u5bK5O6YqYV6m1sQ".into())
    });
    if !verify_password(req.password, hash).await || id.is_empty() {
        state.login_guard.fail(&ip, &req.username);
        tracing::info!("failed sign-in for {:?} from {ip}", req.username.trim());
        return Err(AppError(axum::http::StatusCode::UNAUTHORIZED, "wrong username or password".into()));
    }
    state.login_guard.success(&ip, &req.username);
    let token = create_session(&state, &id, req.device_name.as_deref().unwrap_or("")).await?;
    let user = get_user(&state.db, &id).await?;
    Ok(Json(json!({ "token": token, "user": user })))
}

pub async fn logout(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
        .bind(&auth.token_hash)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn me(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<UserPublic>> {
    Ok(Json(get_user(&state.db, &auth.id).await?))
}

#[derive(Deserialize)]
pub struct UpdateMe {
    pub display_name: Option<String>,
    pub avatar_file_id: Option<Option<String>>,
    pub current_password: Option<String>,
    pub new_password: Option<String>,
    /// for password reset emails; "" removes it
    pub email: Option<String>,
}

pub async fn update_me(State(state): State<Shared>, auth: AuthUser, Json(req): Json<UpdateMe>) -> ApiResult<Json<UserPublic>> {
    if let Some(e) = &req.email {
        let e = e.trim();
        if !e.is_empty() && (!e.contains('@') || e.len() > 200 || e.contains(char::is_whitespace)) {
            return Err(AppError::bad("that doesn't look like an email address"));
        }
        sqlx::query("UPDATE users SET email = ? WHERE id = ?").bind((!e.is_empty()).then_some(e)).bind(&auth.id).execute(&state.db).await?;
    }
    if let Some(d) = req.display_name {
        let d: String = d.trim().chars().take(32).collect();
        if d.is_empty() {
            return Err(AppError::bad("display name required"));
        }
        sqlx::query("UPDATE users SET display_name = ? WHERE id = ?").bind(d).bind(&auth.id).execute(&state.db).await?;
    }
    if let Some(av) = req.avatar_file_id {
        if let Some(fid) = &av {
            let f = crate::models::get_file(&state.db, fid).await?;
            if !f.mime.starts_with("image/") {
                return Err(AppError::bad("avatar must be an image"));
            }
        }
        sqlx::query("UPDATE users SET avatar_file_id = ? WHERE id = ?").bind(av).bind(&auth.id).execute(&state.db).await?;
    }
    if let Some(np) = req.new_password {
        if np.len() < 8 {
            return Err(AppError::bad("password must be at least 8 characters"));
        }
        let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?")
            .bind(&auth.id)
            .fetch_one(&state.db)
            .await?;
        if !verify_password(req.current_password.unwrap_or_default(), hash).await {
            return Err(AppError::bad("current password is wrong"));
        }
        let h = hash_password(np).await?;
        sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?").bind(h).bind(&auth.id).execute(&state.db).await?;
        // sign out other devices
        sqlx::query("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
            .bind(&auth.id)
            .bind(&auth.token_hash)
            .execute(&state.db)
            .await?;
    }
    let user = get_user(&state.db, &auth.id).await?;
    state.emit_related(&auth.id, "USER_UPDATE", &serde_json::to_value(&user).unwrap()).await;
    Ok(Json(user))
}

pub async fn sessions(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT token_hash, device_name, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC",
    )
    .bind(&auth.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!(rows
        .into_iter()
        .map(|(h, d, c, l)| json!({ "id": &h[..16], "device_name": d, "created_at": c, "last_seen": l, "current": h == auth.token_hash }))
        .collect::<Vec<_>>())))
}

pub async fn my_email(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let e: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = ?").bind(&auth.id).fetch_one(&state.db).await?;
    Ok(Json(json!({ "email": e, "server_can_email": crate::email::configured(&state).await })))
}
