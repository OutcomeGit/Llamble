//! Link previews (OpenGraph unfurl) and a signed media proxy so clients never
//! contact third-party sites directly (no IP leaks, no trackers).
use crate::error::{now_ms, sha256_hex, ApiResult, AppError};
use crate::models::{load_message, Channel};
use crate::state::{AuthUser, Shared};
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderValue};
use axum::response::Response;
use base64::Engine;
use futures::StreamExt;
use hmac::{Hmac, Mac};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use tower::ServiceExt;
use tower_http::services::ServeFile;
use url::Url;

const UA: &str = "Mozilla/5.0 (compatible; LlambleBot/0.1; +link-preview)";
const HTML_MAX: usize = 2 * 1024 * 1024;
const MEDIA_MAX: usize = 60 * 1024 * 1024;
const CACHE_TTL_MS: i64 = 24 * 3600 * 1000;

static URL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"<?https?://[^\s<>"']+>?"#).unwrap());

pub fn extract_urls(content: &str) -> Vec<String> {
    // strip code blocks / inline code so URLs in code aren't unfurled
    static CODE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)```.*?```|`[^`]*`").unwrap());
    let clean = CODE.replace_all(content, " ");
    let mut out = vec![];
    for m in URL_RE.find_iter(&clean) {
        let s = m.as_str();
        if s.starts_with('<') && s.ends_with('>') {
            continue; // <url> suppresses embeds
        }
        let s = s.trim_start_matches('<').trim_end_matches('>');
        let mut s = s.trim_end_matches(|c: char| ".,!?;:'\"".contains(c)).to_string();
        // balance a trailing ')' (e.g. wikipedia links inside parentheses)
        while s.ends_with(')') && s.matches('(').count() < s.matches(')').count() {
            s.pop();
        }
        if !out.contains(&s) {
            out.push(s);
        }
        if out.len() >= 5 {
            break;
        }
    }
    out
}

// ---------- SSRF-safe fetching ----------

fn is_public_v4(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || ip.is_multicast()
        || o[0] == 0
        || (o[0] == 100 && (o[1] & 0xC0) == 64) // CGNAT 100.64/10
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        || (o[0] == 198 && (o[1] & 0xFE) == 18) // benchmarking
        || o[0] >= 240)
}

fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let s = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xFE00) == 0xFC00 // unique local
                || (s[0] & 0xFFC0) == 0xFE80 // link local
                || (s[0] == 0x2001 && s[1] == 0x0DB8)) // documentation
        }
    }
}

pub struct Fetched {
    pub url: Url,
    pub content_type: String,
    pub body: Vec<u8>,
}

pub async fn safe_fetch(start: &str, max: usize, accept: &str) -> anyhow::Result<Fetched> {
    let mut url = Url::parse(start)?;
    for _ in 0..5 {
        if !matches!(url.scheme(), "http" | "https") {
            anyhow::bail!("bad scheme");
        }
        let host = url.host_str().ok_or_else(|| anyhow::anyhow!("no host"))?.to_string();
        let port = url.port_or_known_default().unwrap_or(443);
        let addrs: Vec<SocketAddr> = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::lookup_host((host.trim_matches(|c| c == '[' || c == ']'), port)),
        )
        .await??
        .collect();
        let addr = *addrs.first().ok_or_else(|| anyhow::anyhow!("no address"))?;
        if addrs.iter().any(|a| !is_public(a.ip())) {
            anyhow::bail!("refusing non-public address");
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(6))
            .resolve(&host, addr)
            .user_agent(UA)
            .build()?;
        let res = client.get(url.clone()).header("accept", accept).header("accept-language", "en").send().await?;
        if res.status().is_redirection() {
            let loc = res
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| anyhow::anyhow!("redirect without location"))?;
            url = url.join(loc)?;
            continue;
        }
        if !res.status().is_success() {
            anyhow::bail!("status {}", res.status());
        }
        let ct = res
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if let Some(len) = res.content_length() {
            if len as usize > max && !ct.starts_with("text/html") {
                anyhow::bail!("too large");
            }
        }
        let final_url = res.url().clone();
        let mut body = Vec::new();
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            let limit = if ct.starts_with("text/html") { HTML_MAX.min(max) } else { max };
            if body.len() + chunk.len() > limit {
                if ct.starts_with("text/html") {
                    // the <head> is all we need; truncate
                    body.extend_from_slice(&chunk[..limit - body.len()]);
                    break;
                }
                anyhow::bail!("too large");
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(Fetched { url: final_url, content_type: ct, body });
    }
    anyhow::bail!("too many redirects")
}

// ---------- signed proxy urls ----------

pub fn sign(state: &Shared, url: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(&state.secret).unwrap();
    mac.update(url.as_bytes());
    hex::encode(&mac.finalize().into_bytes()[..12])
}

pub fn proxy_url(state: &Shared, url: &str) -> String {
    let u = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(url.as_bytes());
    format!("/api/proxy?u={}&s={}", u, sign(state, url))
}

#[derive(Deserialize)]
pub struct ProxyQ {
    pub u: String,
    pub s: String,
}

pub async fn proxy(State(state): State<Shared>, _auth: AuthUser, Query(q): Query<ProxyQ>, req: Request) -> ApiResult<Response> {
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(q.u.as_bytes())
        .map_err(|_| AppError::bad("bad url"))?;
    let url = String::from_utf8(raw).map_err(|_| AppError::bad("bad url"))?;
    if sign(&state, &url) != q.s {
        return Err(AppError::forbidden());
    }
    let key = sha256_hex(url.as_bytes());
    let path = state.cfg.proxy_dir().join(&key);
    let meta = state.cfg.proxy_dir().join(format!("{key}.type"));
    let ct = match tokio::fs::read_to_string(&meta).await {
        Ok(ct) if tokio::fs::metadata(&path).await.is_ok() => ct,
        _ => {
            let f = safe_fetch(&url, MEDIA_MAX, "image/*,video/*;q=0.9,*/*;q=0.1")
                .await
                .map_err(|e| AppError(axum::http::StatusCode::BAD_GATEWAY, format!("fetch failed: {e}")))?;
            let ct = f.content_type.split(';').next().unwrap_or("").trim().to_string();
            if !(ct.starts_with("image/") || ct.starts_with("video/")) || ct == "image/svg+xml" {
                return Err(AppError(axum::http::StatusCode::UNSUPPORTED_MEDIA_TYPE, "not media".into()));
            }
            let tmp = path.with_extension("part");
            tokio::fs::write(&tmp, &f.body).await?;
            tokio::fs::rename(&tmp, &path).await?;
            tokio::fs::write(&meta, &ct).await?;
            ct
        }
    };
    let m: mime::Mime = ct.parse().unwrap_or(mime::APPLICATION_OCTET_STREAM);
    let res = ServeFile::new_with_mime(&path, &m).oneshot(req).await.map_err(|e| anyhow::anyhow!(e))?;
    let mut res = res.map(Body::new);
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=86400"));
    res.headers_mut().insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    Ok(res)
}

// ---------- unfurling ----------

fn meta_map(html: &str) -> (std::collections::HashMap<String, String>, Option<String>) {
    let doc = scraper::Html::parse_document(html);
    let sel = scraper::Selector::parse("meta").unwrap();
    let mut m = std::collections::HashMap::new();
    for el in doc.select(&sel) {
        let v = el.value();
        let key = v.attr("property").or_else(|| v.attr("name")).or_else(|| v.attr("itemprop"));
        if let (Some(k), Some(c)) = (key, v.attr("content")) {
            m.entry(k.to_ascii_lowercase()).or_insert_with(|| c.trim().to_string());
        }
    }
    let title = scraper::Selector::parse("title")
        .ok()
        .and_then(|s| doc.select(&s).next().map(|t| t.text().collect::<String>().trim().to_string()))
        .filter(|t| !t.is_empty());
    (m, title)
}

fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>().trim_end())
    }
}

fn parse_color(s: &str) -> Option<i64> {
    let s = s.trim().trim_start_matches('#');
    if s.len() == 6 {
        i64::from_str_radix(s, 16).ok()
    } else {
        None
    }
}

fn youtube_id(u: &Url) -> Option<String> {
    let host = u.host_str()?.trim_start_matches("www.").trim_start_matches("m.");
    match host {
        "youtu.be" => u.path_segments()?.next().map(|s| s.to_string()),
        "youtube.com" | "music.youtube.com" => {
            if u.path() == "/watch" {
                u.query_pairs().find(|(k, _)| k == "v").map(|(_, v)| v.into_owned())
            } else {
                let mut seg = u.path_segments()?;
                match seg.next()? {
                    "shorts" | "embed" | "live" => seg.next().map(|s| s.to_string()),
                    _ => None,
                }
            }
        }
        _ => None,
    }
    .filter(|id| id.len() >= 6 && id.len() <= 20 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
}

pub async fn unfurl_one(state: &Shared, url: &str) -> Option<Value> {
    if let Ok(Some((data, at))) = sqlx::query_as::<_, (Option<String>, i64)>("SELECT data, fetched_at FROM embed_cache WHERE url = ?")
        .bind(url)
        .fetch_optional(&state.db)
        .await
    {
        if now_ms() - at < CACHE_TTL_MS {
            return data.and_then(|d| serde_json::from_str(&d).ok());
        }
    }
    let embed = build_embed(state, url).await;
    let _ = sqlx::query("INSERT OR REPLACE INTO embed_cache (url, data, fetched_at) VALUES (?,?,?)")
        .bind(url)
        .bind(embed.as_ref().map(|e| e.to_string()))
        .bind(now_ms())
        .execute(&state.db)
        .await;
    embed
}

async fn build_embed(state: &Shared, url: &str) -> Option<Value> {
    let f = match safe_fetch(url, MEDIA_MAX, "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5").await {
        Ok(f) => f,
        Err(e) => {
            tracing::debug!("unfurl {url} failed: {e}");
            return None;
        }
    };
    let ct = f.content_type.split(';').next().unwrap_or("").trim().to_string();
    if ct.starts_with("image/") && ct != "image/svg+xml" {
        let (w, h) = image::load_from_memory(&f.body).ok().map(|i| (i.width(), i.height())).unzip();
        let key = sha256_hex(url.as_bytes());
        let _ = tokio::fs::write(state.cfg.proxy_dir().join(&key), &f.body).await;
        let _ = tokio::fs::write(state.cfg.proxy_dir().join(format!("{key}.type")), &ct).await;
        return Some(json!({
            "type": if ct == "image/gif" { "gifv" } else { "image" },
            "url": url,
            "image": { "proxy_url": proxy_url(state, url), "width": w, "height": h }
        }));
    }
    if ct.starts_with("video/") {
        return Some(json!({ "type": "video", "url": url, "video": { "proxy_url": proxy_url(state, url) } }));
    }
    if !ct.contains("html") {
        return None;
    }
    let html = String::from_utf8_lossy(&f.body).to_string();
    let (m, title_tag) = tokio::task::spawn_blocking(move || meta_map(&html)).await.ok()?;
    let get = |keys: &[&str]| keys.iter().find_map(|k| m.get(*k).filter(|v| !v.is_empty()).cloned());

    let title = get(&["og:title", "twitter:title"]).or(title_tag);
    let description = get(&["og:description", "twitter:description", "description"]);
    let site = get(&["og:site_name", "application-name"]).or_else(|| f.url.host_str().map(|h| h.trim_start_matches("www.").to_string()));
    let color = get(&["theme-color"]).and_then(|c| parse_color(&c));
    let image = get(&["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"])
        .and_then(|i| f.url.join(&i).ok())
        .filter(|u| matches!(u.scheme(), "http" | "https"));
    let img_w = get(&["og:image:width"]).and_then(|v| v.parse::<i64>().ok());
    let img_h = get(&["og:image:height"]).and_then(|v| v.parse::<i64>().ok());
    let card = get(&["twitter:card"]).unwrap_or_default();

    if title.is_none() && description.is_none() && image.is_none() {
        return None;
    }

    let mut e = json!({
        "type": "link",
        "url": f.url.as_str(),
        "title": title.map(|t| trunc(&t, 256)),
        "description": description.map(|d| trunc(&d, 350)),
        "site_name": site.map(|s| trunc(&s, 64)),
        "color": color,
    });
    if let Some(img) = &image {
        e["image"] = json!({ "proxy_url": proxy_url(state, img.as_str()), "width": img_w, "height": img_h });
        e["large_image"] = json!(card == "summary_large_image" || img_w.map(|w| w >= 400).unwrap_or(false));
    }

    // video / gif providers
    let og_video = get(&["og:video:secure_url", "og:video:url", "og:video"]).and_then(|v| f.url.join(&v).ok());
    let og_video_type = get(&["og:video:type"]).unwrap_or_default();
    let host = f.url.host_str().unwrap_or("").to_string();
    if let Some(yt) = youtube_id(&f.url).or_else(|| youtube_id(&Url::parse(url).ok()?)) {
        e["type"] = json!("video");
        e["provider"] = json!("YouTube");
        // played only on click, via the no-cookie domain
        e["embed_url"] = json!(format!("https://www.youtube-nocookie.com/embed/{yt}?autoplay=1"));
        e["large_image"] = json!(true);
    } else if let Some(v) = og_video.filter(|_| og_video_type.starts_with("video/mp4") || og_video_type.starts_with("video/webm")) {
        let gifish = host.contains("tenor") || host.contains("giphy") || host.contains("imgur") || host.contains("gfycat");
        e["type"] = json!(if gifish { "gifv" } else { "video" });
        e["video"] = json!({
            "proxy_url": proxy_url(state, v.as_str()),
            "width": get(&["og:video:width"]).and_then(|v| v.parse::<i64>().ok()),
            "height": get(&["og:video:height"]).and_then(|v| v.parse::<i64>().ok()),
        });
    }
    Some(e)
}

pub fn spawn_unfurl(state: Shared, ch: Channel, message_id: String, content: String) {
    let urls = extract_urls(&content);
    if urls.is_empty() {
        return;
    }
    tokio::spawn(async move {
        let mut embeds = vec![];
        for u in urls {
            if let Some(e) = unfurl_one(&state, &u).await {
                embeds.push(e);
            }
        }
        if embeds.is_empty() {
            return;
        }
        let r = sqlx::query("UPDATE messages SET embeds = ? WHERE id = ? AND content = ?")
            .bind(Value::Array(embeds).to_string())
            .bind(&message_id)
            .bind(&content)
            .execute(&state.db)
            .await;
        if matches!(r, Ok(ref r) if r.rows_affected() > 0) {
            if let Ok(msg) = load_message(&state.db, &message_id).await {
                state.emit_channel(&ch, "MESSAGE_UPDATE", &msg).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn urls() {
        let u = extract_urls("look https://example.com/a. and <https://hidden.com> and (https://en.wikipedia.org/wiki/Foo_(bar)) `https://code.com`");
        assert_eq!(u, vec!["https://example.com/a", "https://en.wikipedia.org/wiki/Foo_(bar)"]);
    }
    #[test]
    fn ips() {
        assert!(!is_public("127.0.0.1".parse().unwrap()));
        assert!(!is_public("192.168.1.5".parse().unwrap()));
        assert!(!is_public("100.100.1.1".parse().unwrap()));
        assert!(!is_public("::1".parse().unwrap()));
        assert!(!is_public("::ffff:10.0.0.1".parse().unwrap()));
        assert!(!is_public("fd00::1".parse().unwrap()));
        assert!(is_public("1.1.1.1".parse().unwrap()));
    }
    #[test]
    fn yt() {
        assert_eq!(youtube_id(&Url::parse("https://youtu.be/dQw4w9WgXcQ").unwrap()).as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(youtube_id(&Url::parse("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3").unwrap()).as_deref(), Some("dQw4w9WgXcQ"));
    }
}
