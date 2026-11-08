use crate::error::{now_ms, new_id, ApiResult, AppError};
use crate::models::*;
use crate::perms;
use crate::state::{AuthUser, Shared};
use axum::body::Body;
use axum::extract::{Multipart, Path, Request, State};
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::Json;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::services::ServeFile;

const THUMB_MAX: u32 = 640;

fn sanitize_filename(name: &str) -> String {
    let n: String = name
        .chars()
        .filter(|c| !c.is_control() && !"/\\:*?\"<>|".contains(*c))
        .take(200)
        .collect();
    let n = n.trim().trim_start_matches('.').to_string();
    if n.is_empty() { "file".into() } else { n }
}

fn guess_mime(filename: &str, declared: Option<&str>, head: &[u8]) -> String {
    if let Ok(fmt) = image::guess_format(head) {
        return fmt.to_mime_type().to_string();
    }
    // a few common magic numbers
    if head.len() > 12 && &head[4..8] == b"ftyp" {
        let brand = &head[8..12];
        if brand == b"qt  " {
            return "video/quicktime".into();
        }
        if brand.starts_with(b"M4A") {
            return "audio/mp4".into();
        }
        return "video/mp4".into();
    }
    if head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return "video/webm".into();
    }
    if head.starts_with(b"%PDF") {
        return "application/pdf".into();
    }
    if head.starts_with(b"OggS") {
        return "audio/ogg".into();
    }
    if head.starts_with(b"ID3") || (head.len() > 1 && head[0] == 0xFF && head[1] & 0xE0 == 0xE0) {
        return "audio/mpeg".into();
    }
    if head.starts_with(b"RIFF") && head.len() > 12 && &head[8..12] == b"WAVE" {
        return "audio/wav".into();
    }
    let by_ext = mime_from_ext(filename);
    if let Some(m) = by_ext {
        return m.into();
    }
    declared.filter(|d| !d.is_empty()).unwrap_or("application/octet-stream").to_string()
}

fn mime_from_ext(name: &str) -> Option<&'static str> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "txt" | "log" | "md" => "text/plain",
        "json" => "application/json",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "csv" => "text/csv",
        "svg" => "image/svg+xml",
        "html" | "htm" => "text/html",
        _ => return None,
    })
}

/// mimes that are safe to render inline in the client
fn inline_safe(mime: &str) -> bool {
    (mime.starts_with("image/") && mime != "image/svg+xml")
        || mime.starts_with("video/")
        || mime.starts_with("audio/")
        || mime == "application/pdf"
        || mime == "text/plain"
}

pub fn file_path(state: &Shared, id: &str) -> PathBuf {
    state.cfg.files_dir().join(id)
}
pub fn thumb_path(state: &Shared, id: &str) -> PathBuf {
    state.cfg.thumbs_dir().join(format!("{id}.jpg"))
}

/// Upload a single file (multipart field "file"). Returns the file object.
pub async fn upload(State(state): State<Shared>, auth: AuthUser, mut mp: Multipart) -> ApiResult<Json<FileObj>> {
    while let Some(mut field) = mp.next_field().await.map_err(|e| AppError::bad(e.to_string()))? {
        if field.name() != Some("file") {
            continue;
        }
        let filename = sanitize_filename(field.file_name().unwrap_or("file"));
        let declared = field.content_type().map(|s| s.to_string());
        let id = new_id();
        let path = file_path(&state, &id);
        let tmp = path.with_extension("part");
        let mut f = tokio::fs::File::create(&tmp).await?;
        let mut hasher = Sha256::new();
        let mut size: u64 = 0;
        let mut head: Vec<u8> = Vec::with_capacity(64);
        loop {
            let chunk = match field.chunk().await {
                Ok(Some(c)) => c,
                Ok(None) => break,
                Err(e) => {
                    let _ = tokio::fs::remove_file(&tmp).await;
                    return Err(AppError::bad(format!("upload failed: {e}")));
                }
            };
            size += chunk.len() as u64;
            if size > state.s().max_upload_bytes() {
                drop(f);
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(AppError(axum::http::StatusCode::PAYLOAD_TOO_LARGE, "file too large".into()));
            }
            if head.len() < 64 {
                let need = 64 - head.len();
                head.extend_from_slice(&chunk[..need.min(chunk.len())]);
            }
            hasher.update(&chunk);
            f.write_all(&chunk).await?;
        }
        f.flush().await?;
        drop(f);
        if size == 0 {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(AppError::bad("empty file"));
        }
        tokio::fs::rename(&tmp, &path).await?;
        let mime = guess_mime(&filename, declared.as_deref(), &head);
        let sha = hex::encode(hasher.finalize());

        let (width, height, has_thumb) = make_preview(&state, &id, &mime).await;

        sqlx::query("INSERT INTO files (id, uploader_id, filename, mime, size, width, height, has_thumb, sha256, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
            .bind(&id).bind(&auth.id).bind(&filename).bind(&mime).bind(size as i64)
            .bind(width).bind(height).bind(has_thumb).bind(&sha).bind(now_ms())
            .execute(&state.db).await?;
        let row = get_file(&state.db, &id).await?;
        return Ok(Json(FileObj::from(&row)));
    }
    Err(AppError::bad("no file field"))
}

/// Save bytes the server made itself (e.g. a generated picture) as a file. Returns its id.
pub async fn store_bytes(state: &Shared, uploader: &str, filename: &str, mime: &str, bytes: &[u8]) -> anyhow::Result<String> {
    let id = new_id();
    tokio::fs::write(file_path(state, &id), bytes).await?;
    let sha = hex::encode(Sha256::digest(bytes));
    let (width, height, has_thumb) = make_preview(state, &id, mime).await;
    sqlx::query("INSERT INTO files (id, uploader_id, filename, mime, size, width, height, has_thumb, sha256, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(&id).bind(uploader).bind(filename).bind(mime).bind(bytes.len() as i64)
        .bind(width).bind(height).bind(has_thumb).bind(&sha).bind(now_ms())
        .execute(&state.db).await?;
    Ok(id)
}

/// Returns (width, height, has_thumb)
async fn make_preview(state: &Shared, id: &str, mime: &str) -> (Option<i64>, Option<i64>, bool) {
    let src = file_path(state, id);
    let dst = thumb_path(state, id);
    if mime.starts_with("image/") && mime != "image/svg+xml" {
        let animated = mime == "image/gif" || mime == "image/webp";
        let res = tokio::task::spawn_blocking(move || -> anyhow::Result<(u32, u32, bool)> {
            let (w, h) = image::ImageReader::open(&src)?.with_guessed_format()?.into_dimensions()?;
            // keep animated formats as-is (client plays original); make thumbs for big stills
            if animated || (w <= THUMB_MAX && h <= THUMB_MAX) {
                return Ok((w, h, false));
            }
            if (w as u64) * (h as u64) > 100_000_000 {
                return Ok((w, h, false)); // refuse to decode absurd images
            }
            let img = image::ImageReader::open(&src)?.with_guessed_format()?.decode()?;
            let t = img.thumbnail(THUMB_MAX, THUMB_MAX).to_rgb8();
            t.save_with_format(&dst, image::ImageFormat::Jpeg)?;
            Ok((w, h, true))
        })
        .await;
        return match res {
            Ok(Ok((w, h, t))) => (Some(w as i64), Some(h as i64), t),
            _ => (None, None, false),
        };
    }
    if mime.starts_with("video/") {
        // Poster frame via ffmpeg if installed (bundled in the Docker image).
        let out = tokio::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-y", "-ss", "0.5", "-i"])
            .arg(&src)
            .args(["-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-f", "image2"])
            .arg(&dst)
            .kill_on_drop(true)
            .output();
        if let Ok(Ok(o)) = tokio::time::timeout(std::time::Duration::from_secs(20), out).await {
            if o.status.success() {
                let probe = tokio::process::Command::new("ffprobe")
                    .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x"])
                    .arg(file_path(state, id))
                    .output()
                    .await;
                let (mut w, mut h) = (None, None);
                if let Ok(p) = probe {
                    let s = String::from_utf8_lossy(&p.stdout);
                    let mut it = s.trim().split('x');
                    w = it.next().and_then(|v| v.parse().ok());
                    h = it.next().and_then(|v| v.parse().ok());
                }
                return (w, h, true);
            }
        }
    }
    (None, None, false)
}

pub async fn can_view_file(state: &Shared, auth: &AuthUser, f: &FileRow) -> ApiResult<bool> {
    if f.uploader_id == auth.id || auth.is_admin {
        return Ok(true);
    }
    let public: Option<i64> = sqlx::query_scalar(
        "SELECT 1 WHERE EXISTS (SELECT 1 FROM gifs WHERE file_id = ?1)
         OR EXISTS (SELECT 1 FROM users WHERE avatar_file_id = ?1)
         OR EXISTS (SELECT 1 FROM guilds WHERE icon_file_id = ?1)",
    )
    .bind(&f.id)
    .fetch_optional(&state.db)
    .await?;
    if public.is_some() {
        return Ok(true);
    }
    let channels: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT m.channel_id FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE ma.file_id = ? LIMIT 20",
    )
    .bind(&f.id)
    .fetch_all(&state.db)
    .await?;
    for c in channels {
        if let Ok(ch) = load_channel(&state.db, &c).await {
            if perms::channel_perms(&state.db, &ch, &auth.id).await? & perms::VIEW != 0 {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

async fn serve(path: PathBuf, mime: &str, filename: &str, req: Request) -> ApiResult<Response> {
    let safe = inline_safe(mime);
    let served_mime = if safe { mime.to_string() } else { "application/octet-stream".into() };
    let res = ServeFile::new_with_mime(&path, &served_mime.parse::<mime::Mime>().unwrap_or(mime_octet()))
        .oneshot(req)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    let mut res = res.map(Body::new);
    let h = res.headers_mut();
    let disp = format!(
        "{}; filename*=UTF-8''{}",
        if safe { "inline" } else { "attachment" },
        urlencode(filename)
    );
    if let Ok(v) = HeaderValue::from_str(&disp) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=31536000, immutable"));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert("content-security-policy", HeaderValue::from_static("default-src 'none'; sandbox"));
    Ok(res)
}

fn mime_octet() -> mime::Mime {
    mime::APPLICATION_OCTET_STREAM
}

pub async fn get_file_handler(State(state): State<Shared>, auth: AuthUser, Path(params): Path<Vec<String>>, req: Request) -> ApiResult<Response> {
    let id = params.first().cloned().ok_or_else(AppError::not_found)?;
    let f = get_file(&state.db, &id).await?;
    if !can_view_file(&state, &auth, &f).await? {
        return Err(AppError::not_found());
    }
    serve(file_path(&state, &f.id), &f.mime, &f.filename, req).await
}

pub async fn get_thumb(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, req: Request) -> ApiResult<Response> {
    let f = get_file(&state.db, &id).await?;
    if !can_view_file(&state, &auth, &f).await? {
        return Err(AppError::not_found());
    }
    if !f.has_thumb {
        return Ok(axum::http::StatusCode::NOT_FOUND.into_response());
    }
    serve(thumb_path(&state, &f.id), "image/jpeg", "thumb.jpg", req).await
}
