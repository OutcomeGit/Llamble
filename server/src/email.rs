//! Optional email (SMTP) for password reset links. The Master Admin enters an email
//! account in Settings → Server; people add their address in My Account.
use crate::error::{new_id, now_ms, random_token, ApiResult, AppError};
use crate::state::{AuthUser, Shared};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Smtp {
    pub host: String,
    pub port: u16,
    /// starttls (usually port 587) | tls (usually 465) | none
    pub security: String,
    pub username: String,
    pub password: String,
    /// "Llamble <you@example.com>"
    pub from: String,
}

pub async fn load(state: &Shared) -> Option<Smtp> {
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'smtp'").fetch_optional(&state.db).await.ok().flatten();
    v.and_then(|s| serde_json::from_str::<Smtp>(&s).ok()).filter(|s| !s.host.is_empty() && !s.from.is_empty())
}

pub async fn configured(state: &Shared) -> bool {
    load(state).await.is_some()
}

async fn send(s: &Smtp, to: &str, subject: &str, body: String) -> Result<(), String> {
    let from: Mailbox = s.from.parse().map_err(|e| format!("'from' address: {e}"))?;
    let to: Mailbox = to.parse().map_err(|e| format!("'to' address: {e}"))?;
    let msg = Message::builder().from(from).to(to).subject(subject).body(body).map_err(|e| e.to_string())?;
    let port = if s.port == 0 { if s.security == "tls" { 465 } else { 587 } } else { s.port };
    let builder = match s.security.as_str() {
        "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(&s.host).map_err(|e| e.to_string())?,
        "none" => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&s.host),
        _ => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&s.host).map_err(|e| e.to_string())?,
    };
    let mut builder = builder.port(port).timeout(Some(std::time::Duration::from_secs(20)));
    if !s.username.is_empty() {
        builder = builder.credentials(Credentials::new(s.username.clone(), s.password.clone()));
    }
    builder.build().send(msg).await.map(|_| ()).map_err(|e| e.to_string())
}

/// Address people should open the link at: the public HTTPS address if remote access is
/// on, otherwise however this request reached us.
async fn base_url(state: &Shared, headers: &HeaderMap) -> String {
    if let Some(d) = crate::remote::public_domain(state).await {
        return format!("https://{d}");
    }
    let host = headers.get("host").and_then(|h| h.to_str().ok()).unwrap_or("localhost");
    format!("http://{host}")
}

// ---------- Master Admin: email account ----------

pub async fn get_smtp(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    let s = load(&state).await.unwrap_or_default();
    Ok(Json(json!({ "host": s.host, "port": s.port, "security": if s.security.is_empty() { "starttls".into() } else { s.security }, "username": s.username, "from": s.from, "has_password": !s.password.is_empty() })))
}

pub async fn put_smtp(State(state): State<Shared>, auth: AuthUser, Json(mut req): Json<Smtp>) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    if req.password.is_empty() {
        req.password = load(&state).await.map(|s| s.password).unwrap_or_default();
    }
    if !req.from.is_empty() && req.from.parse::<Mailbox>().is_err() {
        return Err(AppError::bad("'From' should look like: Llamble <you@example.com>"));
    }
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('smtp', ?)").bind(serde_json::to_string(&req).unwrap()).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct TestReq {
    pub to: String,
}

pub async fn test_smtp(State(state): State<Shared>, auth: AuthUser, Json(req): Json<TestReq>) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    let s = load(&state).await.ok_or_else(|| AppError::bad("save the email settings first"))?;
    send(&s, &req.to, "Llamble test email", "If you can read this, Llamble can send password reset emails.".into())
        .await
        .map_err(|e| AppError::bad(format!("couldn't send: {e}")))?;
    Ok(Json(json!({ "ok": true })))
}

// ---------- everyone: reset by email ----------

#[derive(Deserialize)]
pub struct EmailReset {
    pub username: String,
}

/// Sends a one-time link (valid 1 hour) to the account's email. Same answer whether or not
/// the account or address exists, so it can't be used to discover accounts.
pub async fn reset_by_email(State(state): State<Shared>, crate::state::ClientIp(ip): crate::state::ClientIp, headers: HeaderMap, Json(req): Json<EmailReset>) -> ApiResult<Json<Value>> {
    if let Some(mins) = state.login_guard.blocked(&ip, "#reset-email") {
        return Err(AppError(axum::http::StatusCode::TOO_MANY_REQUESTS, format!("too many requests; try again in {mins} minutes")));
    }
    state.login_guard.fail(&ip, "#reset-email");
    let Some(smtp) = load(&state).await else {
        return Err(AppError::bad("this server isn't set up to send email"));
    };
    let row: Option<(String, Option<String>, String)> = sqlx::query_as("SELECT id, email, display_name FROM users WHERE username = ? AND is_bot = 0")
        .bind(req.username.trim())
        .fetch_optional(&state.db)
        .await?;
    if let Some((uid, Some(email), name)) = row.filter(|r| r.1.as_deref().map(|e| !e.is_empty()).unwrap_or(false)) {
        let id = new_id();
        let secret = random_token(24);
        // an email link counts as already approved; it expires in an hour (see poll_reset)
        sqlx::query("INSERT INTO reset_requests (id, user_id, secret_hash, status, created_at) VALUES (?,?,?,'approved',?)")
            .bind(&id)
            .bind(&uid)
            .bind(crate::error::sha256_hex(secret.as_bytes()))
            .bind(now_ms() - 23 * 3600 * 1000) // expiry is 24h after created_at: this leaves 1 hour
            .execute(&state.db)
            .await?;
        let link = format!("{}/?reset={id}.{secret}", base_url(&state, &headers).await);
        let body = format!(
            "Hi {name},\n\nSomeone (hopefully you) asked to reset your Llamble password.\nOpen this link within an hour to choose a new one:\n\n{link}\n\nIf it wasn't you, ignore this email; your password hasn't changed."
        );
        let s2 = smtp.clone();
        tokio::spawn(async move {
            if let Err(e) = send(&s2, &email, "Reset your Llamble password", body).await {
                tracing::warn!("password reset email failed: {e}");
            }
        });
    }
    Ok(Json(json!({ "ok": true })))
}
