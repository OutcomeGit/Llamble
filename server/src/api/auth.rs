use crate::api::guilds::add_member;
use crate::error::{now_ms, new_id, random_token, sha256_hex, ApiResult, AppError};
use crate::models::{get_user, UserPublic};
use crate::state::{AuthUser, Shared};
use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::State;
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
    consume_invite(&state, &req.invite).await?;
    if let Some(g) = guild_id {
        add_member(&state, &g, &id).await?;
    }
    let token = create_session(&state, &id, req.device_name.as_deref().unwrap_or("")).await?;
    let user = get_user(&state.db, &id).await?;
    Ok(Json(json!({ "token": token, "user": user })))
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
}

pub async fn update_me(State(state): State<Shared>, auth: AuthUser, Json(req): Json<UpdateMe>) -> ApiResult<Json<UserPublic>> {
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
