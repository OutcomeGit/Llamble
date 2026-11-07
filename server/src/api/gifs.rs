//! Self-hosted GIF library: shared across the instance, searchable by title/tags,
//! with per-user favorites. No Tenor/Giphy API calls.
use crate::api::files::{can_view_file, file_path};
use crate::error::{now_ms, new_id, ApiResult, AppError};
use crate::models::*;
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

fn gif_mime(m: &str) -> bool {
    matches!(m, "image/gif" | "image/webp" | "image/png" | "video/mp4" | "video/webm")
}

#[derive(Deserialize)]
pub struct GifQ {
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub favorites: Option<bool>,
}

pub async fn list(State(state): State<Shared>, auth: AuthUser, Query(q): Query<GifQ>) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(40).clamp(1, 100);
    let offset = q.offset.unwrap_or(0).max(0);
    let term = q.q.unwrap_or_default().trim().to_lowercase();
    let words: Vec<String> = term.split_whitespace().take(5).map(|w| format!("%{}%", w.replace('%', ""))).collect();
    let mut sql = String::from(
        "SELECT g.id, g.title, g.tags, g.uses, g.uploader_id, (fav.user_id IS NOT NULL) AS fav,
                f.id, f.uploader_id, f.filename, f.mime, f.size, f.width, f.height, f.has_thumb, f.created_at
         FROM gifs g JOIN files f ON f.id = g.file_id
         LEFT JOIN gif_favorites fav ON fav.gif_id = g.id AND fav.user_id = ?
         WHERE 1=1",
    );
    for _ in &words {
        sql.push_str(" AND (lower(g.title) LIKE ? OR lower(g.tags) LIKE ?)");
    }
    if q.favorites.unwrap_or(false) {
        sql.push_str(" AND fav.user_id IS NOT NULL");
    }
    sql.push_str(" ORDER BY fav DESC, g.uses DESC, g.created_at DESC LIMIT ? OFFSET ?");
    let mut qq = sqlx::query_as::<_, (String, String, String, i64, String, bool, String, String, String, String, i64, Option<i64>, Option<i64>, bool, i64)>(&sql)
        .bind(&auth.id);
    for w in &words {
        qq = qq.bind(w).bind(w);
    }
    let rows = qq.bind(limit).bind(offset).fetch_all(&state.db).await?;
    let out: Vec<Value> = rows
        .into_iter()
        .map(|(id, title, tags, uses, uploader, fav, fid, fup, fname, mime, size, w, h, thumb, created)| {
            let f = FileRow { id: fid, uploader_id: fup, filename: fname, mime, size, width: w, height: h, has_thumb: thumb, created_at: created };
            json!({ "id": id, "title": title, "tags": tags, "uses": uses, "uploader_id": uploader, "favorite": fav, "file": FileObj::from(&f) })
        })
        .collect();
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
pub struct AddGif {
    pub file_id: Option<String>,
    pub url: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub tags: String,
}

pub async fn add(State(state): State<Shared>, auth: AuthUser, Json(req): Json<AddGif>) -> ApiResult<Json<Value>> {
    let file_id = match (req.file_id, req.url) {
        (Some(fid), _) => {
            let f = get_file(&state.db, &fid).await?;
            if !can_view_file(&state, &auth, &f).await? {
                return Err(AppError::not_found());
            }
            if !gif_mime(&f.mime) {
                return Err(AppError::bad("GIF library accepts gif, webp, png, mp4 or webm"));
            }
            fid
        }
        (None, Some(url)) => import_url(&state, &auth, &url).await?,
        _ => return Err(AppError::bad("file_id or url required")),
    };
    if let Some(existing) = sqlx::query_scalar::<_, String>("SELECT id FROM gifs WHERE file_id = ?")
        .bind(&file_id).fetch_optional(&state.db).await?
    {
        favorite_inner(&state, &auth.id, &existing).await?;
        return Ok(Json(json!({ "id": existing, "existing": true })));
    }
    // dedupe by content hash too
    let sha: String = sqlx::query_scalar("SELECT sha256 FROM files WHERE id = ?").bind(&file_id).fetch_one(&state.db).await?;
    if let Some(existing) = sqlx::query_scalar::<_, String>(
        "SELECT g.id FROM gifs g JOIN files f ON f.id = g.file_id WHERE f.sha256 = ? AND f.sha256 != '' LIMIT 1",
    ).bind(&sha).fetch_optional(&state.db).await?
    {
        favorite_inner(&state, &auth.id, &existing).await?;
        return Ok(Json(json!({ "id": existing, "existing": true })));
    }
    let id = new_id();
    let tags = req.tags.to_lowercase().split(|c: char| c == ',' || c.is_whitespace()).filter(|t| !t.is_empty()).take(20).collect::<Vec<_>>().join(" ");
    sqlx::query("INSERT INTO gifs (id, file_id, title, tags, uploader_id, created_at) VALUES (?,?,?,?,?,?)")
        .bind(&id).bind(&file_id).bind(req.title.trim().chars().take(100).collect::<String>()).bind(tags).bind(&auth.id).bind(now_ms())
        .execute(&state.db).await?;
    favorite_inner(&state, &auth.id, &id).await?;
    Ok(Json(json!({ "id": id, "existing": false })))
}

/// Download a GIF/video from a URL (e.g. a link someone pasted) into local storage.
async fn import_url(state: &Shared, auth: &AuthUser, url: &str) -> ApiResult<String> {
    // If it's a page (tenor/giphy), resolve to its og:video / image first.
    let target = match crate::api::embeds::unfurl_one(state, url).await {
        Some(e) => original_media_url(&e).unwrap_or_else(|| url.to_string()),
        None => url.to_string(),
    };
    let f = crate::api::embeds::safe_fetch(&target, 30 * 1024 * 1024, "image/gif,image/webp,video/mp4,video/webm,*/*;q=0.5")
        .await
        .map_err(|e| AppError::bad(format!("couldn't fetch: {e}")))?;
    let ct = f.content_type.split(';').next().unwrap_or("").trim().to_string();
    if !gif_mime(&ct) {
        return Err(AppError::bad("that link isn't a GIF or short video"));
    }
    let id = new_id();
    tokio::fs::write(file_path(state, &id), &f.body).await?;
    let (w, h) = image::load_from_memory(&f.body).ok().map(|i| (i.width() as i64, i.height() as i64)).unzip();
    let ext = match ct.as_str() { "image/gif" => "gif", "image/webp" => "webp", "image/png" => "png", "video/webm" => "webm", _ => "mp4" };
    sqlx::query("INSERT INTO files (id, uploader_id, filename, mime, size, width, height, has_thumb, sha256, created_at) VALUES (?,?,?,?,?,?,?,0,?,?)")
        .bind(&id).bind(&auth.id).bind(format!("gif.{ext}")).bind(&ct).bind(f.body.len() as i64).bind(w).bind(h)
        .bind(crate::error::sha256_hex(&f.body)).bind(now_ms())
        .execute(&state.db).await?;
    Ok(id)
}

/// Recover the original remote URL from a proxied embed (decode the signed proxy link).
fn original_media_url(e: &Value) -> Option<String> {
    use base64::Engine;
    let p = e["video"]["proxy_url"].as_str().or(e["image"]["proxy_url"].as_str())?;
    let u = p.split("u=").nth(1)?.split('&').next()?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(u).ok()?;
    String::from_utf8(raw).ok()
}

async fn favorite_inner(state: &Shared, uid: &str, gid: &str) -> ApiResult<()> {
    sqlx::query("INSERT OR IGNORE INTO gif_favorites (user_id, gif_id, created_at) VALUES (?,?,?)")
        .bind(uid).bind(gid).bind(now_ms()).execute(&state.db).await?;
    Ok(())
}

pub async fn favorite(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    favorite_inner(&state, &auth.id, &id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn unfavorite(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    sqlx::query("DELETE FROM gif_favorites WHERE user_id = ? AND gif_id = ?").bind(&auth.id).bind(&id).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct EditGif {
    pub title: Option<String>,
    pub tags: Option<String>,
}

pub async fn edit(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, Json(req): Json<EditGif>) -> ApiResult<Json<Value>> {
    let up: String = sqlx::query_scalar("SELECT uploader_id FROM gifs WHERE id = ?").bind(&id).fetch_one(&state.db).await?;
    if up != auth.id && !auth.is_admin {
        return Err(AppError::forbidden());
    }
    if let Some(t) = req.title {
        sqlx::query("UPDATE gifs SET title = ? WHERE id = ?").bind(t.trim().chars().take(100).collect::<String>()).bind(&id).execute(&state.db).await?;
    }
    if let Some(t) = req.tags {
        sqlx::query("UPDATE gifs SET tags = ? WHERE id = ?").bind(t.to_lowercase()).bind(&id).execute(&state.db).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn remove(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let up: String = sqlx::query_scalar("SELECT uploader_id FROM gifs WHERE id = ?").bind(&id).fetch_one(&state.db).await?;
    if up != auth.id && !auth.is_admin {
        return Err(AppError::forbidden());
    }
    sqlx::query("DELETE FROM gifs WHERE id = ?").bind(&id).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}
