//! News on the board, at three levels:
//! - Llamble news: from the project, fetched from a signed news file (only entries signed
//!   with the key built into this server are shown; the instance admin can turn it off)
//! - Instance news: from the instance admins and the "news writers" they pick
//! - Server news: from people with the "Post news" permission in that server
//!
//! Also here: board preferences (per person, per server: show notes / highlights / news,
//! which kinds of highlights), which sync across devices.
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::models::{get_file, get_user, FileObj};
use crate::perms::{self, require_guild};
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, Query, State};
use axum::Json;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::Duration;

pub async fn migrate(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    sqlx::raw_sql(
        r#"
CREATE TABLE IF NOT EXISTS news (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,                          -- instance | guild
    guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    image_file_id TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_news_scope ON news(scope, guild_id, created_at);
CREATE TABLE IF NOT EXISTS board_prefs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    notes INTEGER NOT NULL DEFAULT 1,
    highlights INTEGER NOT NULL DEFAULT 1,
    news INTEGER NOT NULL DEFAULT 1,
    highlight_types TEXT NOT NULL DEFAULT 'all',
    PRIMARY KEY (user_id, guild_id)
);
"#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// board preferences

pub const HIGHLIGHT_TYPES: [&str; 5] = ["pictures", "videos", "recordings", "links", "posts"];

#[derive(Clone, Debug)]
pub struct Pref {
    pub notes: bool,
    pub highlights: bool,
    pub news: bool,
    /// None = all kinds
    pub types: Option<Vec<String>>,
}

impl Default for Pref {
    fn default() -> Self {
        Pref { notes: true, highlights: true, news: true, types: None }
    }
}

impl Pref {
    pub fn wants_type(&self, t: &str) -> bool {
        self.types.as_ref().map_or(true, |ts| ts.iter().any(|x| x == t))
    }
    fn json(&self) -> Value {
        json!({
            "notes": self.notes, "highlights": self.highlights, "news": self.news,
            "highlight_types": match &self.types { None => json!("all"), Some(t) => json!(t) },
        })
    }
}

fn parse_types(s: &str) -> Option<Vec<String>> {
    if s == "all" || s.is_empty() {
        return None;
    }
    Some(s.split(',').map(|x| x.trim().to_string()).filter(|x| HIGHLIGHT_TYPES.contains(&x.as_str())).collect())
}

/// One person's preferences for every server they set any (others are defaults).
pub async fn prefs_for(state: &Shared, uid: &str) -> HashMap<String, Pref> {
    let rows: Vec<(String, bool, bool, bool, String)> =
        sqlx::query_as("SELECT guild_id, notes, highlights, news, highlight_types FROM board_prefs WHERE user_id = ?").bind(uid).fetch_all(&state.db).await.unwrap_or_default();
    rows.into_iter().map(|(g, notes, highlights, news, t)| (g, Pref { notes, highlights, news, types: parse_types(&t) })).collect()
}

pub async fn pref(state: &Shared, uid: &str, gid: &str) -> Pref {
    let r: Option<(bool, bool, bool, String)> = sqlx::query_as("SELECT notes, highlights, news, highlight_types FROM board_prefs WHERE user_id = ? AND guild_id = ?")
        .bind(uid)
        .bind(gid)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    r.map(|(notes, highlights, news, t)| Pref { notes, highlights, news, types: parse_types(&t) }).unwrap_or_default()
}

/// People in a server who turned notes off there (they get no notes from it).
pub async fn notes_off(state: &Shared, gid: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT user_id FROM board_prefs WHERE guild_id = ? AND notes = 0").bind(gid).fetch_all(&state.db).await.unwrap_or_default()
}

async fn llamble_on_for(state: &Shared, uid: &str) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT board_llamble_news FROM users WHERE id = ?").bind(uid).fetch_optional(&state.db).await.ok().flatten().unwrap_or(true)
}

/// GET /api/board-prefs
pub async fn get_prefs(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let mut guilds = serde_json::Map::new();
    for (g, p) in prefs_for(&state, &auth.id).await {
        guilds.insert(g, p.json());
    }
    Ok(Json(json!({ "guilds": guilds, "llamble_news": llamble_on_for(&state, &auth.id).await })))
}

#[derive(Deserialize)]
pub struct PrefReq {
    pub notes: Option<bool>,
    pub highlights: Option<bool>,
    pub news: Option<bool>,
    /// "all" or a list of kinds
    pub highlight_types: Option<Value>,
}

/// PUT /api/board-prefs/{gid}   (also PUT /api/board-prefs/llamble {on})
pub async fn put_prefs(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>, Json(req): Json<Value>) -> ApiResult<Json<Value>> {
    if gid == "llamble" {
        let on = req.get("on").and_then(|v| v.as_bool()).ok_or_else(|| AppError::bad("give on: true or false"))?;
        sqlx::query("UPDATE users SET board_llamble_news = ? WHERE id = ?").bind(on).bind(&auth.id).execute(&state.db).await?;
        return Ok(Json(json!({ "llamble_news": on })));
    }
    require_guild(&state.db, &gid, &auth.id, perms::VIEW).await?;
    let req: PrefReq = serde_json::from_value(req).map_err(|e| AppError::bad(e.to_string()))?;
    let mut p = pref(&state, &auth.id, &gid).await;
    if let Some(v) = req.notes {
        p.notes = v;
    }
    if let Some(v) = req.highlights {
        p.highlights = v;
    }
    if let Some(v) = req.news {
        p.news = v;
    }
    if let Some(t) = req.highlight_types {
        p.types = match t {
            Value::String(s) if s == "all" => None,
            Value::Array(a) => {
                let mut out = vec![];
                for x in a {
                    let x = x.as_str().unwrap_or_default().to_string();
                    if !HIGHLIGHT_TYPES.contains(&x.as_str()) {
                        return Err(AppError::bad("highlight_types: pictures, videos, recordings, links, posts (or \"all\")"));
                    }
                    if !out.contains(&x) {
                        out.push(x);
                    }
                }
                if out.len() == HIGHLIGHT_TYPES.len() {
                    None
                } else {
                    Some(out)
                }
            }
            _ => return Err(AppError::bad("highlight_types must be \"all\" or a list")),
        };
    }
    let types = p.types.as_ref().map_or("all".to_string(), |t| t.join(","));
    sqlx::query(
        "INSERT INTO board_prefs (user_id, guild_id, notes, highlights, news, highlight_types) VALUES (?,?,?,?,?,?)
         ON CONFLICT(user_id, guild_id) DO UPDATE SET notes = excluded.notes, highlights = excluded.highlights, news = excluded.news, highlight_types = excluded.highlight_types",
    )
    .bind(&auth.id)
    .bind(&gid)
    .bind(p.notes)
    .bind(p.highlights)
    .bind(p.news)
    .bind(&types)
    .execute(&state.db)
    .await?;
    Ok(Json(p.json()))
}

// ---------------------------------------------------------------------------------------
// instance and server news

#[derive(sqlx::FromRow, Clone)]
struct Row {
    id: String,
    scope: String,
    guild_id: Option<String>,
    author_id: String,
    title: String,
    body: String,
    image_file_id: Option<String>,
    pinned: bool,
    created_at: i64,
    edited_at: Option<i64>,
}

const COLS: &str = "id, scope, guild_id, author_id, title, body, image_file_id, pinned, created_at, edited_at";

async fn to_json(state: &Shared, r: &Row) -> Value {
    let author = get_user(&state.db, &r.author_id).await.ok().and_then(|u| serde_json::to_value(u).ok()).unwrap_or(Value::Null);
    let image = match &r.image_file_id {
        Some(fid) => match get_file(&state.db, fid).await {
            Ok(f) => {
                let mut v = serde_json::to_value(FileObj::from(&f)).unwrap_or(Value::Null);
                v["content_type"] = json!(f.mime);
                v
            }
            Err(_) => Value::Null,
        },
        None => Value::Null,
    };
    json!({
        "id": r.id, "scope": r.scope, "guild_id": r.guild_id, "author": author, "title": r.title, "body": r.body,
        "image": image, "pinned": r.pinned, "created_at": r.created_at, "edited_at": r.edited_at,
    })
}

async fn load(state: &Shared, id: &str) -> ApiResult<Row> {
    sqlx::query_as::<_, Row>(&format!("SELECT {COLS} FROM news WHERE id = ?")).bind(id).fetch_optional(&state.db).await?.ok_or_else(AppError::not_found)
}

async fn rows(state: &Shared, where_: &str, binds: &[&str], limit: i64) -> ApiResult<Vec<Value>> {
    let sql = format!("SELECT {COLS} FROM news WHERE {where_} ORDER BY pinned DESC, created_at DESC LIMIT {limit}");
    let mut q = sqlx::query_as::<_, Row>(&sql);
    for b in binds {
        q = q.bind(*b);
    }
    let mut out = vec![];
    for r in q.fetch_all(&state.db).await? {
        out.push(to_json(state, &r).await);
    }
    Ok(out)
}

/// Who receives events about a piece of news.
async fn audience(state: &Shared, r: &Row) -> Vec<String> {
    match &r.guild_id {
        Some(g) => crate::state::guild_member_ids(&state.db, g).await,
        None => state.hub.online_users(),
    }
}

async fn is_news_writer(state: &Shared, uid: &str) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT news_writer FROM users WHERE id = ?").bind(uid).fetch_optional(&state.db).await.ok().flatten().unwrap_or(false)
}

#[derive(Deserialize)]
pub struct ListQ {
    pub scope: Option<String>,
}

/// GET /api/news?scope=instance
pub async fn list_instance(State(state): State<Shared>, _auth: AuthUser, Query(q): Query<ListQ>) -> ApiResult<Json<Value>> {
    if q.scope.as_deref().unwrap_or("instance") != "instance" {
        return Err(AppError::bad("scope must be instance (server news: /api/guilds/{id}/news; Llamble news: /api/news/llamble)"));
    }
    Ok(Json(json!(rows(&state, "scope = 'instance'", &[], 50).await?)))
}

/// GET /api/guilds/{gid}/news
pub async fn list_guild(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::VIEW).await?;
    Ok(Json(json!(rows(&state, "scope = 'guild' AND guild_id = ?", &[&gid], 50).await?)))
}

#[derive(Deserialize)]
pub struct PostReq {
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub image_id: Option<String>,
    #[serde(default)]
    pub pinned: bool,
}

fn clean_title(t: &str) -> ApiResult<String> {
    let t = t.trim().to_string();
    let n = t.chars().count();
    if n == 0 || n > 120 {
        return Err(AppError::bad("news needs a title (up to 120 characters)"));
    }
    Ok(t)
}

fn clean_body(b: &str) -> ApiResult<String> {
    let b = b.trim().to_string();
    if b.chars().count() > 8000 {
        return Err(AppError::bad("news can be up to 8000 characters"));
    }
    Ok(b)
}

/// The image must be an upload by this person (like message attachments).
async fn check_image(state: &Shared, uid: &str, fid: &str) -> ApiResult<()> {
    let f = get_file(&state.db, fid).await.map_err(|_| AppError::bad("unknown image"))?;
    if f.uploader_id != uid {
        return Err(AppError::bad("unknown image"));
    }
    if !f.mime.starts_with("image/") {
        return Err(AppError::bad("the news picture has to be an image"));
    }
    Ok(())
}

async fn post(state: &Shared, auth: &AuthUser, guild: Option<&str>, req: PostReq) -> ApiResult<Value> {
    if auth.is_kid {
        return Err(AppError::forbidden_msg("kid accounts can't post news"));
    }
    let title = clean_title(&req.title)?;
    let body = clean_body(&req.body)?;
    if let Some(fid) = &req.image_id {
        check_image(state, &auth.id, fid).await?;
    }
    let id = new_id();
    sqlx::query("INSERT INTO news (id, scope, guild_id, author_id, title, body, image_file_id, pinned, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(&id)
        .bind(if guild.is_some() { "guild" } else { "instance" })
        .bind(guild)
        .bind(&auth.id)
        .bind(&title)
        .bind(&body)
        .bind(&req.image_id)
        .bind(req.pinned)
        .bind(now_ms())
        .execute(&state.db)
        .await?;
    let r = load(state, &id).await?;
    let v = to_json(state, &r).await;
    state.hub.send_users(&audience(state, &r).await, "NEWS_CREATE", &v);
    Ok(v)
}

/// POST /api/news (instance news: instance admins and news writers)
pub async fn create_instance(State(state): State<Shared>, auth: AuthUser, Json(req): Json<PostReq>) -> ApiResult<Json<Value>> {
    if !auth.is_admin && !is_news_writer(&state, &auth.id).await {
        return Err(AppError::forbidden_msg("only instance admins and news writers can post instance news"));
    }
    Ok(Json(post(&state, &auth, None, req).await?))
}

/// POST /api/guilds/{gid}/news (needs "Post news")
pub async fn create_guild(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>, Json(req): Json<PostReq>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::POST_NEWS).await?;
    Ok(Json(post(&state, &auth, Some(&gid), req).await?))
}

/// Author, or (instance news) an instance admin, or (server news) someone who can manage the server.
async fn may_change(state: &Shared, auth: &AuthUser, r: &Row) -> ApiResult<()> {
    if r.author_id == auth.id {
        return Ok(());
    }
    match &r.guild_id {
        None if auth.is_admin => Ok(()),
        None => Err(AppError::forbidden()),
        Some(g) => {
            require_guild(&state.db, g, &auth.id, perms::MANAGE_GUILD).await?;
            Ok(())
        }
    }
}

/// PATCH /api/news/{id}
pub async fn edit(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, Json(req): Json<Value>) -> ApiResult<Json<Value>> {
    let r = load(&state, &id).await?;
    may_change(&state, &auth, &r).await?;
    if let Some(t) = req.get("title").and_then(|v| v.as_str()) {
        sqlx::query("UPDATE news SET title = ? WHERE id = ?").bind(clean_title(t)?).bind(&id).execute(&state.db).await?;
    }
    if let Some(b) = req.get("body").and_then(|v| v.as_str()) {
        sqlx::query("UPDATE news SET body = ? WHERE id = ?").bind(clean_body(b)?).bind(&id).execute(&state.db).await?;
    }
    if let Some(i) = req.get("image_id") {
        let fid = match i {
            Value::Null => None,
            v => {
                let fid = v.as_str().ok_or_else(|| AppError::bad("image_id must be a file id or null"))?.to_string();
                if r.image_file_id.as_deref() != Some(fid.as_str()) {
                    check_image(&state, &auth.id, &fid).await?;
                }
                Some(fid)
            }
        };
        sqlx::query("UPDATE news SET image_file_id = ? WHERE id = ?").bind(fid).bind(&id).execute(&state.db).await?;
    }
    if let Some(p) = req.get("pinned").and_then(|v| v.as_bool()) {
        sqlx::query("UPDATE news SET pinned = ? WHERE id = ?").bind(p).bind(&id).execute(&state.db).await?;
    }
    sqlx::query("UPDATE news SET edited_at = ? WHERE id = ?").bind(now_ms()).bind(&id).execute(&state.db).await?;
    let r = load(&state, &id).await?;
    let v = to_json(&state, &r).await;
    state.hub.send_users(&audience(&state, &r).await, "NEWS_UPDATE", &v);
    Ok(Json(v))
}

/// DELETE /api/news/{id}
pub async fn delete(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let r = load(&state, &id).await?;
    may_change(&state, &auth, &r).await?;
    let who = audience(&state, &r).await;
    sqlx::query("DELETE FROM news WHERE id = ?").bind(&id).execute(&state.db).await?;
    state.hub.send_users(&who, "NEWS_DELETE", &json!({ "id": id, "scope": r.scope, "guild_id": r.guild_id }));
    Ok(Json(json!({ "ok": true })))
}

/// News for Home: instance news (latest 10) and news from servers where this person has
/// news on (latest 20), newest first.
pub async fn for_home(state: &Shared, uid: &str) -> ApiResult<Vec<Value>> {
    let prefs = prefs_for(state, uid).await;
    let mut out = rows(state, "scope = 'instance'", &[], 10).await?;
    let sql = format!(
        "SELECT {COLS} FROM news WHERE scope = 'guild'
           AND guild_id IN (SELECT guild_id FROM members WHERE user_id = ?1 UNION SELECT id FROM guilds WHERE owner_id = ?1)
         ORDER BY created_at DESC LIMIT 100"
    );
    let mut n = 0;
    for r in sqlx::query_as::<_, Row>(&sql).bind(uid).fetch_all(&state.db).await? {
        let g = r.guild_id.clone().unwrap_or_default();
        if !prefs.get(&g).map_or(true, |p| p.news) {
            continue;
        }
        out.push(to_json(state, &r).await);
        n += 1;
        if n >= 20 {
            break;
        }
    }
    out.sort_by_key(|v| std::cmp::Reverse(v["created_at"].as_i64().unwrap_or(0)));
    Ok(out)
}

/// Is this file a news picture `auth` may see? (instance news: anyone; server news: members)
pub async fn can_view_image(state: &Shared, uid: &str, fid: &str) -> bool {
    let r: Vec<(String, Option<String>)> = sqlx::query_as("SELECT scope, guild_id FROM news WHERE image_file_id = ?").bind(fid).fetch_all(&state.db).await.unwrap_or_default();
    for (scope, g) in r {
        if scope == "instance" {
            return true;
        }
        if let Some(g) = g {
            if require_guild(&state.db, &g, uid, perms::VIEW).await.is_ok() {
                return true;
            }
        }
    }
    false
}

#[derive(Deserialize)]
pub struct WriterReq {
    pub on: bool,
}

/// PUT /api/admin/users/{uid}/news-writer {on}  (instance admins)
pub async fn set_news_writer(State(state): State<Shared>, auth: AuthUser, Path(uid): Path<String>, Json(req): Json<WriterReq>) -> ApiResult<Json<Value>> {
    if !auth.is_admin {
        return Err(AppError::forbidden());
    }
    if req.on && crate::kids::is_kid(&state, &uid).await {
        return Err(AppError::bad("kid accounts can't be news writers"));
    }
    let n = sqlx::query("UPDATE users SET news_writer = ? WHERE id = ? AND is_bot = 0").bind(req.on).bind(&uid).execute(&state.db).await?.rows_affected();
    if n == 0 {
        return Err(AppError::not_found());
    }
    Ok(Json(json!({ "user_id": uid, "news_writer": req.on })))
}

pub async fn news_writer_of(state: &Shared, uid: &str) -> bool {
    is_news_writer(state, uid).await
}

// ---------------------------------------------------------------------------------------
// Llamble project news: a signed file, checked against the key built into this server

/// The project's public key (base64, Ed25519), filled in by whoever builds Llamble.
const BUILT_IN_KEY: &str = include_str!("../../news_pubkey.txt");

#[derive(Serialize, Clone, Default)]
struct Cache {
    items: Vec<Value>,
    fetched_at: Option<i64>,
    error: Option<String>,
}

static CACHE: once_cell::sync::Lazy<RwLock<Cache>> = once_cell::sync::Lazy::new(Default::default);

/// Tests can supply their own key (and a plain-http local URL) through LLAMBLE_NEWS_TEST_KEY.
fn key() -> Option<(String, bool)> {
    if let Ok(k) = std::env::var("LLAMBLE_NEWS_TEST_KEY") {
        if !k.trim().is_empty() {
            return Some((k.trim().to_string(), true));
        }
    }
    let k = BUILT_IN_KEY.trim();
    (!k.is_empty()).then(|| (k.to_string(), false))
}

fn status_json(state: &Shared) -> Value {
    let c = CACHE.read().unwrap().clone();
    json!({ "enabled": state.s().llamble_news_enabled, "items": c.items, "fetched_at": c.fetched_at, "error": c.error })
}

/// GET /api/news/llamble
pub async fn llamble(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let mut v = status_json(&state);
    v["shown"] = json!(llamble_on_for(&state, &auth.id).await);
    Ok(Json(v))
}

/// POST /api/admin/llamble-news/refresh (master): check for news now.
pub async fn refresh_now(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    refresh(&state).await;
    Ok(Json(status_json(&state)))
}

#[derive(Deserialize)]
struct SignedFile {
    payload: String,
    signature: String,
}

#[derive(Deserialize)]
struct Payload {
    version: u32,
    items: Vec<Item>,
}

#[derive(Deserialize)]
struct Item {
    id: String,
    title: String,
    #[serde(default)]
    body: String,
    url: Option<String>,
    image: Option<String>,
    published_at: i64,
}

fn https(u: Option<String>, allow_http_local: bool) -> Option<String> {
    let u = u?;
    let ok = u.starts_with("https://") || (allow_http_local && u.starts_with("http://127.0.0.1"));
    ok.then_some(u)
}

/// Check the signature, then turn the entries into News JSON.
fn verify(body: &[u8], key_b64: &str, test: bool) -> Result<Vec<Value>, String> {
    let f: SignedFile = serde_json::from_slice(body).map_err(|_| "the news file isn't in the expected format".to_string())?;
    let kb = base64::engine::general_purpose::STANDARD.decode(key_b64).map_err(|_| "the news key isn't valid base64".to_string())?;
    let kb: [u8; 32] = kb.try_into().map_err(|_| "the news key must be 32 bytes".to_string())?;
    let vk = ed25519_dalek::VerifyingKey::from_bytes(&kb).map_err(|_| "the news key isn't a valid Ed25519 key".to_string())?;
    let sb = base64::engine::general_purpose::STANDARD.decode(f.signature.trim()).map_err(|_| "the news signature isn't valid".to_string())?;
    let sb: [u8; 64] = sb.try_into().map_err(|_| "the news signature isn't valid".to_string())?;
    let sig = ed25519_dalek::Signature::from_bytes(&sb);
    vk.verify_strict(f.payload.as_bytes(), &sig).map_err(|_| "the news file's signature doesn't match (ignored it)".to_string())?;
    let p: Payload = serde_json::from_str(&f.payload).map_err(|_| "the signed news couldn't be read".to_string())?;
    if p.version != 1 {
        return Err(format!("news format version {} isn't supported by this server", p.version));
    }
    let mut items: Vec<Value> = p
        .items
        .into_iter()
        .take(50)
        .filter(|i| !i.id.trim().is_empty() && !i.title.trim().is_empty())
        .map(|i| {
            let image = https(i.image, test).map(|u| json!({ "url": u }));
            json!({
                "id": format!("llamble:{}", i.id), "scope": "llamble", "guild_id": null, "author": null,
                "title": i.title.chars().take(200).collect::<String>(), "body": i.body.chars().take(20000).collect::<String>(),
                "image": image, "pinned": false, "created_at": i.published_at, "edited_at": null,
                "url": https(i.url, test),
            })
        })
        .collect();
    items.sort_by_key(|v| std::cmp::Reverse(v["created_at"].as_i64().unwrap_or(0)));
    Ok(items)
}

async fn fetch(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Llamble-server (news)")
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = client.get(url).send().await.map_err(|e| format!("couldn't reach the news file: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("the news file answered {}", res.status()));
    }
    let mut out = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        out.extend_from_slice(&chunk);
        if out.len() > 1024 * 1024 {
            return Err("the news file is too big (over 1 MB)".into());
        }
    }
    Ok(out)
}

fn set_error(e: impl Into<String>) {
    CACHE.write().unwrap().error = Some(e.into());
}

/// Check the news file once (if enabled). New entries are sent to everyone online.
pub async fn refresh(state: &Shared) {
    let s = state.s();
    if !s.llamble_news_enabled {
        return;
    }
    let Some((key, test)) = key() else {
        set_error("no news key configured in this build");
        return;
    };
    let url = s.llamble_news_url.trim().to_string();
    let allowed = url.starts_with("https://") || (test && url.starts_with("http://127.0.0.1"));
    if !allowed {
        set_error("the news address must start with https://");
        return;
    }
    let body = match fetch(&url).await {
        Ok(b) => b,
        Err(e) => return set_error(e),
    };
    match verify(&body, &key, test) {
        Ok(items) => {
            let before: Vec<Value> = CACHE.read().unwrap().items.iter().map(|i| i["id"].clone()).collect();
            let changed = items.iter().map(|i| i["id"].clone()).collect::<Vec<_>>() != before;
            {
                let mut c = CACHE.write().unwrap();
                c.items = items.clone();
                c.fetched_at = Some(now_ms());
                c.error = None;
            }
            let _ = sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('llamble_news', ?)")
                .bind(serde_json::to_string(&json!({ "items": items, "fetched_at": now_ms() })).unwrap())
                .execute(&state.db)
                .await;
            if changed {
                let online = state.hub.online_users();
                state.hub.send_users(&online, "LLAMBLE_NEWS", &status_json(state));
            }
        }
        Err(e) => set_error(e),
    }
}

/// Load the last good copy, then check every 6 hours (first check 30 s after start).
pub fn start(state: Shared) {
    tokio::spawn(async move {
        if let Ok(Some(v)) = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'llamble_news'").fetch_optional(&state.db).await {
            if let Ok(saved) = serde_json::from_str::<Value>(&v) {
                let mut c = CACHE.write().unwrap();
                c.items = saved["items"].as_array().cloned().unwrap_or_default();
                c.fetched_at = saved["fetched_at"].as_i64();
            }
        }
        if key().is_none() {
            set_error("no news key configured in this build");
        }
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            refresh(&state).await;
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn signed_news_verifies_and_tampering_fails() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let key = base64::engine::general_purpose::STANDARD.encode(sk.verifying_key().to_bytes());
        let payload = r#"{"version":1,"items":[{"id":"a","title":"Hello","body":"hi","url":"https://llamble.com","image":"http://evil","published_at":5}]}"#;
        let sig = base64::engine::general_purpose::STANDARD.encode(sk.sign(payload.as_bytes()).to_bytes());
        let file = json!({ "payload": payload, "signature": sig }).to_string();
        let items = verify(file.as_bytes(), &key, false).unwrap();
        assert_eq!(items[0]["title"], "Hello");
        assert_eq!(items[0]["url"], "https://llamble.com");
        assert!(items[0]["image"].is_null(), "non-https image dropped");
        let bad = json!({ "payload": payload.replace("Hello", "Hacked"), "signature": sig }).to_string();
        assert!(verify(bad.as_bytes(), &key, false).is_err());
    }
}
