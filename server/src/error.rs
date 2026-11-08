use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub struct AppError(pub StatusCode, pub String);

pub type ApiResult<T> = Result<T, AppError>;

impl AppError {
    pub fn bad(msg: impl Into<String>) -> Self {
        AppError(StatusCode::BAD_REQUEST, msg.into())
    }
    pub fn unauthorized() -> Self {
        AppError(StatusCode::UNAUTHORIZED, "unauthorized".into())
    }
    pub fn forbidden() -> Self {
        AppError(StatusCode::FORBIDDEN, "missing permissions".into())
    }
    pub fn forbidden_msg(m: impl Into<String>) -> Self {
        AppError(StatusCode::FORBIDDEN, m.into())
    }
    pub fn not_found() -> Self {
        AppError(StatusCode::NOT_FOUND, "not found".into())
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        AppError(StatusCode::CONFLICT, msg.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => AppError::not_found(),
            e => {
                tracing::error!("db error: {e}");
                AppError(StatusCode::INTERNAL_SERVER_ERROR, "database error".into())
            }
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!("internal error: {e:#}");
        AppError(StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        tracing::error!("io error: {e}");
        AppError(StatusCode::INTERNAL_SERVER_ERROR, "io error".into())
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

pub fn new_id() -> String {
    ulid::Ulid::new().to_string().to_lowercase()
}

pub fn random_token(bytes: usize) -> String {
    use rand::RngCore;
    let mut b = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut b);
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

pub fn invite_code() -> String {
    use rand::Rng;
    const A: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let mut r = rand::thread_rng();
    (0..10).map(|_| A[r.gen_range(0..A.len())] as char).collect()
}

pub fn sha256_hex(s: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(s))
}
