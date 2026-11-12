//! Show: record a call like a produced show.
//!
//! The person who starts a show picks who is in it (and which of their voice / camera /
//! screen), which member's app records it, and who directs. Everyone picked is asked;
//! they can say yes to some streams, no, or change their mind mid-show. A kid is covered
//! by their parent when the parent starts or records the show. While recording,
//! everyone in the channel sees REC.
//!
//! The recorder's app mixes the picture and sound (auto-switching to whoever talks unless
//! the director holds a shot). Where the video goes:
//! - normally it stays on the recorder's device (their Library → Recordings). Nothing reaches
//!   the server until they choose to share it: Add to Highlights, Publish as a Show, or Post
//!   the video. Only then is it uploaded (in pieces, resumable).
//! - if the instance admin allows it (off by default) a show can instead be saved straight
//!   to the server as it records ("record_on": "server"), streamed up a few seconds at a time.
//! People in the show, their parents and admins can watch a recording that's on the server;
//! once it's published or highlighted, so can everyone who can see where it was put.
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::models::load_channel;
use crate::state::{AuthUser, Shared};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

#[derive(Serialize, Deserialize, Clone, Copy, Default, Debug, PartialEq)]
#[serde(default)]
pub struct Streams {
    pub voice: bool,
    pub camera: bool,
    pub screen: bool,
}

impl Streams {
    fn any(&self) -> bool {
        self.voice || self.camera || self.screen
    }
    fn within(self, allowed: Streams) -> Streams {
        Streams { voice: self.voice && allowed.voice, camera: self.camera && allowed.camera, screen: self.screen && allowed.screen }
    }
}

pub async fn migrate(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    sqlx::raw_sql(
        r#"
CREATE TABLE IF NOT EXISTS shows (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    initiator_id TEXT NOT NULL,
    recorder_id TEXT NOT NULL,
    director_id TEXT NOT NULL,
    recorder_ok INTEGER NOT NULL DEFAULT 0,
    director_ok INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,          -- setup | recording | ended | cancelled
    state TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    size INTEGER NOT NULL DEFAULT 0,
    next_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shows_channel ON shows(channel_id, created_at);
CREATE TABLE IF NOT EXISTS show_posts (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_show_posts_show ON show_posts(show_id);
CREATE TABLE IF NOT EXISTS show_people (
    show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    wanted TEXT NOT NULL,          -- what the starter asked for
    consent TEXT,                  -- what they agreed to (NULL = not answered yet)
    PRIMARY KEY (show_id, user_id)
);
"#,
    )
    .execute(pool)
    .await?;
    // where the recording is: 'member' (the recorder's device) or 'server' (streamed to the NAS)
    crate::db::add_column(pool, "shows", "record_on", "TEXT NOT NULL DEFAULT 'member'").await?;
    // is the video file on the server? Recordings made before this existed all were (DEFAULT 1).
    crate::db::add_column(pool, "shows", "on_server", "INTEGER NOT NULL DEFAULT 1").await?;
    // length of a recording kept on a device, as its app reported it
    crate::db::add_column(pool, "shows", "local_size", "INTEGER NOT NULL DEFAULT 0").await?;
    Ok(())
}

fn video_path(state: &Shared, id: &str) -> PathBuf {
    state.cfg.data_dir.join("recordings").join(format!("{id}.webm"))
}

#[derive(Debug)]
struct ShowRow {
    id: String,
    channel_id: String,
    title: String,
    initiator_id: String,
    recorder_id: String,
    director_id: String,
    recorder_ok: bool,
    director_ok: bool,
    status: String,
    state: String,
    created_at: i64,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    size: i64,
    next_seq: i64,
    record_on: String,
    on_server: bool,
    local_size: i64,
}

async fn load(state: &Shared, id: &str) -> ApiResult<ShowRow> {
    #[allow(clippy::type_complexity)]
    let r: Option<(String, String, String, String, String, String, bool, bool, String, String, i64, Option<i64>, Option<i64>, i64, i64)> = sqlx::query_as(
        "SELECT id, channel_id, title, initiator_id, recorder_id, director_id, recorder_ok, director_ok, status, state, created_at, started_at, ended_at, size, next_seq FROM shows WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let r = r.ok_or_else(AppError::not_found)?;
    let (record_on, on_server, local_size): (String, bool, i64) =
        sqlx::query_as("SELECT record_on, on_server, local_size FROM shows WHERE id = ?").bind(id).fetch_one(&state.db).await?;
    Ok(ShowRow {
        id: r.0,
        channel_id: r.1,
        title: r.2,
        initiator_id: r.3,
        recorder_id: r.4,
        director_id: r.5,
        recorder_ok: r.6,
        director_ok: r.7,
        status: r.8,
        state: r.9,
        created_at: r.10,
        started_at: r.11,
        ended_at: r.12,
        size: r.13,
        next_seq: r.14,
        record_on,
        on_server,
        local_size,
    })
}

async fn people(state: &Shared, show: &str) -> ApiResult<Vec<(String, Streams, Option<Streams>)>> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as("SELECT user_id, wanted, consent FROM show_people WHERE show_id = ?").bind(show).fetch_all(&state.db).await?;
    Ok(rows
        .into_iter()
        .map(|(u, w, c)| (u, serde_json::from_str(&w).unwrap_or_default(), c.and_then(|c| serde_json::from_str(&c).ok())))
        .collect())
}

async fn show_json(state: &Shared, s: &ShowRow) -> ApiResult<Value> {
    let mut ppl = vec![];
    for (u, wanted, consent) in people(state, &s.id).await? {
        ppl.push(json!({ "user_id": u, "wanted": wanted, "consent": consent }));
    }
    Ok(json!({
        "id": s.id, "channel_id": s.channel_id, "title": s.title,
        "initiator_id": s.initiator_id, "recorder_id": s.recorder_id, "director_id": s.director_id,
        "recorder_ok": s.recorder_ok, "director_ok": s.director_ok,
        "status": s.status, "state": serde_json::from_str::<Value>(&s.state).unwrap_or(json!({})),
        "created_at": s.created_at, "started_at": s.started_at, "ended_at": s.ended_at,
        "size": if s.on_server { s.size } else { s.local_size },
        "people": ppl,
        "record_on": s.record_on,
        "on_server": s.on_server && s.status == "ended" && s.size > 0,
        "video_url": has_video(s).then(|| format!("/api/shows/{}/video", s.id)),
    }))
}

fn has_video(s: &ShowRow) -> bool {
    s.status == "ended" && s.on_server && s.size > 0
}

/// Who hears about a show: everyone in the call, everyone in it, and its crew.
async fn audience(state: &Shared, s: &ShowRow) -> Vec<String> {
    let mut ids: Vec<String> = state.hub.voice.iter().filter(|v| v.channel_id == s.channel_id).map(|v| v.user_id.clone()).collect();
    ids.extend([s.initiator_id.clone(), s.recorder_id.clone(), s.director_id.clone()]);
    if let Ok(p) = people(state, &s.id).await {
        ids.extend(p.into_iter().map(|x| x.0));
    }
    ids.sort();
    ids.dedup();
    ids
}

async fn broadcast(state: &Shared, id: &str) -> ApiResult<Value> {
    let s = load(state, id).await?;
    let v = show_json(state, &s).await?;
    state.hub.send_users(&audience(state, &s).await, "SHOW_UPDATE", &v);
    // everyone else who can see the channel just learns it's recording (for the REC badge)
    if let Ok(ch) = load_channel(&state.db, &s.channel_id).await {
        let ids = crate::state::channel_audience(&state.db, &ch).await;
        state.hub.send_users(&ids, "SHOW_STATUS", &json!({ "id": s.id, "channel_id": s.channel_id, "status": s.status }));
    }
    Ok(v)
}

/// May this person watch/download the recording?
async fn can_watch(state: &Shared, auth: &AuthUser, s: &ShowRow) -> bool {
    if auth.is_admin || [&s.initiator_id, &s.recorder_id, &s.director_id].contains(&&auth.id) {
        return true;
    }
    let ppl = people(state, &s.id).await.unwrap_or_default();
    for (u, _, _) in &ppl {
        if *u == auth.id || crate::kids::is_guardian(state, u, &auth.id).await {
            return true;
        }
    }
    // shared: posted somewhere they can see, or highlighted in its own server
    let mut places: Vec<String> = sqlx::query_scalar("SELECT channel_id FROM show_posts WHERE show_id = ?").bind(&s.id).fetch_all(&state.db).await.unwrap_or_default();
    let highlighted: Option<i64> = sqlx::query_scalar("SELECT 1 FROM highlights WHERE show_id = ?").bind(&s.id).fetch_optional(&state.db).await.unwrap_or(None);
    if highlighted.is_some() {
        places.push(s.channel_id.clone());
    }
    for cid in places {
        if let Ok(ch) = load_channel(&state.db, &cid).await {
            if crate::perms::require_channel(&state.db, &ch, &auth.id, crate::perms::VIEW).await.is_ok() || crate::kids::guardian_can_read(state, &ch, &auth.id).await {
                return true;
            }
        }
    }
    false
}

/// For Home → highlights: the recording (as the recordings list shows it, plus "url" and
/// "duration_ms") if `auth` may watch it and it has video.
pub async fn recording_for(state: &Shared, auth: &AuthUser, id: &str) -> Option<Value> {
    let s = load(state, id).await.ok()?;
    if !has_video(&s) || !can_watch(state, auth, &s).await {
        return None;
    }
    let mut v = show_json(state, &s).await.ok()?;
    v["url"] = v["video_url"].clone();
    v["duration_ms"] = match (s.started_at, s.ended_at) {
        (Some(a), Some(b)) => json!(b - a),
        _ => Value::Null,
    };
    if let Ok(ch) = load_channel(&state.db, &s.channel_id).await {
        v["channel_name"] = json!(ch.name);
    }
    Some(v)
}

/// (channel id, initiator) of a show, for highlights.
pub async fn show_channel(state: &Shared, id: &str) -> Option<(String, String)> {
    sqlx::query_as("SELECT channel_id, initiator_id FROM shows WHERE id = ?").bind(id).fetch_optional(&state.db).await.ok().flatten()
}

async fn require_in_channel(state: &Shared, auth: &AuthUser, cid: &str) -> ApiResult<crate::models::Channel> {
    let ch = load_channel(&state.db, cid).await?;
    crate::perms::require_channel(&state.db, &ch, &auth.id, crate::perms::VIEW | crate::perms::CONNECT).await?;
    if ch.kind != "voice" && ch.kind != "dm" && ch.kind != "party" {
        return Err(AppError::bad("shows happen in voice channels and calls"));
    }
    Ok(ch)
}

#[derive(Deserialize)]
pub struct PersonReq {
    pub user_id: String,
    #[serde(flatten)]
    pub streams: Streams,
}

#[derive(Deserialize)]
pub struct CreateShow {
    #[serde(default)]
    pub title: String,
    pub people: Vec<PersonReq>,
    pub recorder_id: Option<String>,
    pub director_id: Option<String>,
    /// "member" (default) or "server"
    #[serde(default)]
    pub record_on: String,
}

pub async fn create(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<CreateShow>) -> ApiResult<Json<Value>> {
    let ch = require_in_channel(&state, &auth, &cid).await?;
    let on_server = req.record_on == "server";
    if on_server && !state.s().allow_server_recording {
        return Err(AppError::bad("saving recordings to the server is turned off on this instance"));
    }
    let busy: Option<String> = sqlx::query_scalar("SELECT id FROM shows WHERE channel_id = ? AND status IN ('setup','recording')").bind(&cid).fetch_optional(&state.db).await?;
    if busy.is_some() {
        return Err(AppError::conflict("there's already a show going in this channel"));
    }
    if req.people.iter().all(|p| !p.streams.any()) {
        return Err(AppError::bad("pick at least one voice, camera or screen to record"));
    }
    let recorder = req.recorder_id.clone().unwrap_or_else(|| auth.id.clone());
    let director = req.director_id.clone().unwrap_or_else(|| auth.id.clone());
    for who in [&recorder, &director] {
        crate::perms::require_channel(&state.db, &ch, who, crate::perms::VIEW).await.map_err(|_| AppError::bad("the recorder and director must be able to see this channel"))?;
        if *who == state.bot_id {
            return Err(AppError::bad("the AI can't record or direct"));
        }
    }
    let id = new_id();
    let title: String = req.title.trim().chars().take(100).collect();
    sqlx::query("INSERT INTO shows (id, channel_id, title, initiator_id, recorder_id, director_id, recorder_ok, director_ok, status, created_at, record_on, on_server) VALUES (?,?,?,?,?,?,?,?,'setup',?,?,?)")
        .bind(&id)
        .bind(&cid)
        .bind(&title)
        .bind(&auth.id)
        .bind(&recorder)
        .bind(&director)
        .bind(recorder == auth.id)
        .bind(director == auth.id)
        .bind(now_ms())
        .bind(if on_server { "server" } else { "member" })
        .bind(on_server)
        .execute(&state.db)
        .await?;
    for p in &req.people {
        if !p.streams.any() {
            continue;
        }
        // the starter agrees for themselves; parents starting or recording cover their kids
        let auto = p.user_id == auth.id || crate::kids::is_guardian(&state, &p.user_id, &auth.id).await || crate::kids::is_guardian(&state, &p.user_id, &recorder).await;
        sqlx::query("INSERT INTO show_people (show_id, user_id, wanted, consent) VALUES (?,?,?,?)")
            .bind(&id)
            .bind(&p.user_id)
            .bind(serde_json::to_string(&p.streams).unwrap())
            .bind(auto.then(|| serde_json::to_string(&p.streams).unwrap()))
            .execute(&state.db)
            .await?;
    }
    Ok(Json(broadcast(&state, &id).await?))
}

/// Say yes/no (or change your mind) about which of your streams are in the show.
/// Someone who joins the call mid-show uses this too.
pub async fn consent(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, Json(req): Json<Streams>) -> ApiResult<Json<Value>> {
    let s = load(&state, &id).await?;
    if !["setup", "recording"].contains(&s.status.as_str()) {
        return Err(AppError::bad("this show is over"));
    }
    let existing: Option<String> = sqlx::query_scalar("SELECT wanted FROM show_people WHERE show_id = ? AND user_id = ?").bind(&id).bind(&auth.id).fetch_optional(&state.db).await?;
    match existing {
        Some(w) => {
            // you can only agree to what was asked of you (or less)
            let wanted: Streams = serde_json::from_str(&w).unwrap_or_default();
            let c = req.within(wanted);
            sqlx::query("UPDATE show_people SET consent = ? WHERE show_id = ? AND user_id = ?").bind(serde_json::to_string(&c).unwrap()).bind(&id).bind(&auth.id).execute(&state.db).await?;
        }
        None => {
            // joined mid-show: you opt yourself in
            let in_call = state.hub.voice.get(&auth.id).map(|v| v.channel_id == s.channel_id).unwrap_or(false);
            if !in_call {
                return Err(AppError::forbidden_msg("join the call first"));
            }
            sqlx::query("INSERT INTO show_people (show_id, user_id, wanted, consent) VALUES (?,?,?,?)")
                .bind(&id)
                .bind(&auth.id)
                .bind(serde_json::to_string(&req).unwrap())
                .bind(serde_json::to_string(&req).unwrap())
                .execute(&state.db)
                .await?;
        }
    }
    Ok(Json(broadcast(&state, &id).await?))
}

#[derive(Deserialize)]
pub struct RoleAnswer {
    pub accept: bool,
}

/// The chosen recorder / director accepts or declines.
pub async fn answer_role(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, Json(req): Json<RoleAnswer>) -> ApiResult<Json<Value>> {
    let s = load(&state, &id).await?;
    if s.status != "setup" && !(s.status == "recording" && s.director_id == auth.id) {
        return Err(AppError::bad("too late to change that"));
    }
    if s.recorder_id == auth.id {
        if req.accept {
            sqlx::query("UPDATE shows SET recorder_ok = 1 WHERE id = ?").bind(&id).execute(&state.db).await?;
        } else {
            sqlx::query("UPDATE shows SET status = 'cancelled', ended_at = ? WHERE id = ?").bind(now_ms()).bind(&id).execute(&state.db).await?;
        }
    }
    if s.director_id == auth.id {
        if req.accept {
            sqlx::query("UPDATE shows SET director_ok = 1 WHERE id = ?").bind(&id).execute(&state.db).await?;
        } else {
            // falls back to whoever started it
            sqlx::query("UPDATE shows SET director_id = initiator_id, director_ok = 1 WHERE id = ?").bind(&id).execute(&state.db).await?;
        }
    }
    if s.recorder_id != auth.id && s.director_id != auth.id {
        return Err(AppError::forbidden());
    }
    Ok(Json(broadcast(&state, &id).await?))
}

#[derive(Deserialize)]
pub struct HandOff {
    pub director_id: String,
}

/// The director passes the controls to someone else (they're asked to accept).
pub async fn hand_off(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, Json(req): Json<HandOff>) -> ApiResult<Json<Value>> {
    let s = load(&state, &id).await?;
    if s.director_id != auth.id && s.initiator_id != auth.id {
        return Err(AppError::forbidden());
    }
    let ch = load_channel(&state.db, &s.channel_id).await?;
    crate::perms::require_channel(&state.db, &ch, &req.director_id, crate::perms::VIEW).await.map_err(|_| AppError::bad("they can't see this channel"))?;
    sqlx::query("UPDATE shows SET director_id = ?, director_ok = ? WHERE id = ?").bind(&req.director_id).bind(req.director_id == auth.id).bind(&id).execute(&state.db).await?;
    Ok(Json(broadcast(&state, &id).await?))
}

pub async fn start(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let s = load(&state, &id).await?;
    if s.recorder_id != auth.id && s.initiator_id != auth.id {
        return Err(AppError::forbidden());
    }
    if s.status != "setup" {
        return Err(AppError::bad("already started"));
    }
    if !s.recorder_ok {
        return Err(AppError::bad("waiting for the recorder to accept"));
    }
    if s.on_server {
        tokio::fs::create_dir_all(state.cfg.data_dir.join("recordings")).await.map_err(|e| AppError::bad(e.to_string()))?;
        let _ = tokio::fs::remove_file(video_path(&state, &id)).await;
    }
    sqlx::query("UPDATE shows SET status = 'recording', started_at = ?, director_ok = 1 WHERE id = ?").bind(now_ms()).bind(&id).execute(&state.db).await?;
    Ok(Json(broadcast(&state, &id).await?))
}

/// Director controls: who's on screen, hold, layout, titles. Free-form JSON the
/// recorder's compositor follows; validated loosely here.
pub async fn set_state(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, Json(req): Json<Value>) -> ApiResult<Json<Value>> {
    let s = load(&state, &id).await?;
    if s.director_id != auth.id && s.initiator_id != auth.id {
        return Err(AppError::forbidden_msg("only the director can change the shot"));
    }
    if !["setup", "recording"].contains(&s.status.as_str()) {
        return Err(AppError::bad("this show is over"));
    }
    let mut cur: Value = serde_json::from_str(&s.state).unwrap_or(json!({}));
    if let (Some(c), Some(r)) = (cur.as_object_mut(), req.as_object()) {
        for k in ["focus", "hold", "layout", "title", "lower_third", "card", "mix"] {
            if let Some(v) = r.get(k) {
                c.insert(k.to_string(), v.clone());
            }
        }
        // the recording's size and frame rate: set once before it starts
        if let Some(q) = r.get("quality") {
            if s.status != "setup" {
                return Err(AppError::bad("the quality is set before recording starts"));
            }
            let res_ok = ["1080p", "1440p", "2160p"].contains(&q.get("res").and_then(Value::as_str).unwrap_or(""));
            let fps_ok = [30, 60].contains(&q.get("fps").and_then(Value::as_i64).unwrap_or(0));
            if !res_ok || !fps_ok {
                return Err(AppError::bad("quality is 1080p, 1440p or 2160p at 30 or 60 fps"));
            }
            c.insert("quality".to_string(), json!({ "res": q["res"], "fps": q["fps"] }));
        }
    }
    let txt = serde_json::to_string(&cur).unwrap();
    if txt.len() > 8000 {
        return Err(AppError::bad("too much"));
    }
    sqlx::query("UPDATE shows SET state = ? WHERE id = ?").bind(txt).bind(&id).execute(&state.db).await?;
    Ok(Json(broadcast(&state, &id).await?))
}

/// The recorder's app sends the video in order, a few seconds at a time: live while recording
/// when the show is saved to the server, or afterwards when they share a recording kept on
/// their device (after `upload_begin`).
pub async fn upload_chunk(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> ApiResult<Json<Value>> {
    let s = load(&state, &id).await?;
    if s.recorder_id != auth.id {
        return Err(AppError::forbidden());
    }
    if s.record_on == "server" {
        let late_ok = s.status == "ended" && now_ms() - s.ended_at.unwrap_or(0) < 120_000;
        if s.status != "recording" && !late_ok {
            return Err(AppError::bad("not recording"));
        }
    } else if s.status != "ended" || s.on_server {
        return Err(AppError::bad("start the upload first"));
    }
    let seq: i64 = headers.get("x-seq").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).ok_or_else(|| AppError::bad("missing x-seq"))?;
    if seq < s.next_seq {
        return Ok(Json(json!({ "ok": true, "duplicate": true }))); // a retry of a piece we already have
    }
    if seq > s.next_seq {
        return Err(AppError::conflict(format!("expected piece {}", s.next_seq)));
    }
    let mut f = tokio::fs::OpenOptions::new().create(true).append(true).open(video_path(&state, &id)).await.map_err(|e| AppError::bad(e.to_string()))?;
    f.write_all(&body).await.map_err(|e| AppError::bad(e.to_string()))?;
    f.flush().await.map_err(|e| AppError::bad(e.to_string()))?;
    sqlx::query("UPDATE shows SET size = size + ?, next_seq = next_seq + 1 WHERE id = ?").bind(body.len() as i64).bind(&id).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct UploadDone {
    pub size: i64,
}

/// Before uploading a recording kept on the recorder's device: start a clean file.
pub async fn upload_begin(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let s = load(&state, &id).await?;
    if s.recorder_id != auth.id {
        return Err(AppError::forbidden_msg("only the device that recorded it has the video"));
    }
    if s.status != "ended" {
        return Err(AppError::bad("this show isn't finished"));
    }
    if s.on_server && s.size > 0 {
        return Ok(Json(json!({ "already": true, "show": show_json(&state, &s).await? })));
    }
    tokio::fs::create_dir_all(state.cfg.data_dir.join("recordings")).await.map_err(|e| AppError::bad(e.to_string()))?;
    let _ = tokio::fs::remove_file(video_path(&state, &id)).await;
    sqlx::query("UPDATE shows SET on_server = 0, size = 0, next_seq = 0 WHERE id = ?").bind(&id).execute(&state.db).await?;
    Ok(Json(json!({ "already": false })))
}

/// After the last piece: the server checks it got all of it and it's ready to share.
pub async fn upload_done(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, Json(req): Json<UploadDone>) -> ApiResult<Json<Value>> {
    let s = load(&state, &id).await?;
    if s.recorder_id != auth.id {
        return Err(AppError::forbidden());
    }
    if s.on_server && s.size > 0 {
        return Ok(Json(show_json(&state, &s).await?));
    }
    let on_disk = tokio::fs::metadata(video_path(&state, &id)).await.map(|m| m.len() as i64).unwrap_or(0);
    if on_disk == 0 || on_disk != req.size || s.size != req.size {
        return Err(AppError::bad(format!("the upload is incomplete ({on_disk} of {} bytes); try again", req.size)));
    }
    sqlx::query("UPDATE shows SET on_server = 1 WHERE id = ?").bind(&id).execute(&state.db).await?;
    let s = load(&state, &id).await?;
    Ok(Json(show_json(&state, &s).await?))
}

/// The recorder's app reports how big the recording it kept is (shown to the others in it).
pub async fn local_size(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, Json(req): Json<UploadDone>) -> ApiResult<Json<Value>> {
    let s = load(&state, &id).await?;
    if s.recorder_id != auth.id {
        return Err(AppError::forbidden());
    }
    sqlx::query("UPDATE shows SET local_size = ? WHERE id = ?").bind(req.size.max(0)).bind(&id).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct Publish {
    pub channel_id: String,
    /// "show" (a Show post: title, who's in it) or "video" (just the video)
    #[serde(default)]
    pub style: String,
    #[serde(default)]
    pub comment: String,
}

/// Publish as a Show / Post the video: a post in a channel that plays the recording.
/// The recording has to be on the server first (the app uploads it, then calls this).
pub async fn publish(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Publish>) -> ApiResult<Json<Value>> {
    let s = load(&state, &id).await?;
    if !can_watch(&state, &auth, &s).await || ![&s.initiator_id, &s.recorder_id, &s.director_id].contains(&&auth.id) && !auth.is_admin {
        return Err(AppError::forbidden_msg("only the show's crew can publish it"));
    }
    if !has_video(&s) {
        return Err(AppError::bad("upload the recording first"));
    }
    let style = if req.style == "video" { "video" } else { "show" };
    let title = if s.title.is_empty() { "Show".to_string() } else { s.title.clone() };
    let comment = req.comment.trim().chars().take(2000).collect::<String>();
    let content = match (style, comment.is_empty()) {
        ("show", true) => format!("🎬 **{title}**"),
        ("show", false) => format!("🎬 **{title}**\n{comment}"),
        (_, true) => "🎬".to_string(),
        (_, false) => comment.clone(),
    };
    let Json(msg) = crate::api::messages::create_message(
        State(state.clone()),
        auth.clone(),
        Path(req.channel_id.clone()),
        headers,
        Json(crate::api::messages::CreateMsg { content, reply_to: None, attachments: vec![], nonce: None, effect: None, shared_from: None }),
    )
    .await?;
    let mid = msg["id"].as_str().unwrap_or_default().to_string();
    let with: Vec<String> = people(&state, &id)
        .await?
        .into_iter()
        .filter(|(_, _, c)| c.map(|c| c.any()).unwrap_or(false))
        .map(|(u, _, _)| u)
        .collect();
    let embed = json!({
        "type": "show", "style": style, "show_id": id, "title": title,
        "url": format!("/api/shows/{id}/video"),
        "duration_ms": match (s.started_at, s.ended_at) { (Some(a), Some(b)) => json!(b - a), _ => Value::Null },
        "people": with, "recorded_at": s.started_at,
    });
    sqlx::query("INSERT OR REPLACE INTO show_posts (message_id, show_id, channel_id) VALUES (?,?,?)").bind(&mid).bind(&id).bind(&req.channel_id).execute(&state.db).await?;
    sqlx::query("UPDATE messages SET embeds = ? WHERE id = ?").bind(json!([embed]).to_string()).bind(&mid).execute(&state.db).await?;
    let ch = load_channel(&state.db, &req.channel_id).await?;
    let m = crate::models::load_message(&state.db, &mid).await?;
    let mut payload = serde_json::to_value(&m).unwrap();
    payload["guild_id"] = json!(ch.guild_id);
    state.emit_channel(&ch, "MESSAGE_UPDATE", &payload).await;
    Ok(Json(payload))
}

pub async fn stop(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let s = load(&state, &id).await?;
    if ![&s.initiator_id, &s.recorder_id, &s.director_id].contains(&&auth.id) && !auth.is_admin {
        return Err(AppError::forbidden());
    }
    let status = if s.status == "recording" { "ended" } else { "cancelled" };
    if ["setup", "recording"].contains(&s.status.as_str()) {
        sqlx::query("UPDATE shows SET status = ?, ended_at = ? WHERE id = ?").bind(status).bind(now_ms()).bind(&id).execute(&state.db).await?;
    }
    Ok(Json(broadcast(&state, &id).await?))
}

/// The live show in a channel (if any) and past recordings you're allowed to watch.
pub async fn list(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    let ch = load_channel(&state.db, &cid).await?;
    let can_see = crate::perms::require_channel(&state.db, &ch, &auth.id, crate::perms::VIEW).await.is_ok() || crate::kids::guardian_can_read(&state, &ch, &auth.id).await;
    if !can_see {
        return Err(AppError::not_found());
    }
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM shows WHERE channel_id = ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 100").bind(&cid).fetch_all(&state.db).await?;
    let mut live = Value::Null;
    let mut past = vec![];
    for id in ids {
        let s = load(&state, &id).await?;
        if ["setup", "recording"].contains(&s.status.as_str()) {
            live = show_json(&state, &s).await?;
        } else if can_watch(&state, &auth, &s).await && (has_video(&s) || s.status == "ended") {
            past.push(show_json(&state, &s).await?);
        }
    }
    Ok(Json(json!({ "live": live, "recordings": past })))
}

/// Recordings across the server that this person may watch (for parents: their kids').
pub async fn mine(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM shows WHERE status = 'ended' ORDER BY created_at DESC LIMIT 300").fetch_all(&state.db).await?;
    let mut out = vec![];
    for id in ids {
        let s = load(&state, &id).await?;
        // people only see what's theirs here (a published show is watched where it was posted)
        let theirs = auth.is_admin || [&s.initiator_id, &s.recorder_id, &s.director_id].contains(&&auth.id) || {
            let mut t = false;
            for (u, _, _) in people(&state, &s.id).await.unwrap_or_default() {
                if u == auth.id || crate::kids::is_guardian(&state, &u, &auth.id).await {
                    t = true;
                    break;
                }
            }
            t
        };
        if theirs && (has_video(&s) || s.record_on == "member") {
            let mut v = show_json(&state, &s).await?;
            if let Ok(ch) = load_channel(&state.db, &s.channel_id).await {
                v["channel_name"] = json!(ch.name);
            }
            out.push(v);
        }
    }
    Ok(Json(json!(out)))
}

pub async fn video(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, req: axum::extract::Request) -> ApiResult<axum::response::Response> {
    let s = load(&state, &id).await?;
    if !can_watch(&state, &auth, &s).await {
        return Err(AppError::not_found());
    }
    let path = video_path(&state, &id);
    let res = tower::ServiceExt::oneshot(tower_http::services::ServeFile::new_with_mime(&path, &"video/webm".parse().unwrap()), req)
        .await
        .map_err(|e| AppError::bad(e.to_string()))?;
    let mut res = res.into_response();
    let name = if s.title.is_empty() { "show".to_string() } else { s.title.replace(|c: char| !c.is_alphanumeric() && c != ' ' && c != '-', "") };
    if let Ok(v) = format!("inline; filename=\"{name}.webm\"").parse() {
        res.headers_mut().insert("content-disposition", v);
    }
    Ok(res)
}

pub async fn delete(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let s = load(&state, &id).await?;
    if s.initiator_id != auth.id && s.recorder_id != auth.id && !auth.is_admin {
        return Err(AppError::forbidden_msg("only whoever started or recorded the show (or an admin) can delete it"));
    }
    let _ = tokio::fs::remove_file(video_path(&state, &id)).await;
    // posts that played it go too
    let posts: Vec<String> = sqlx::query_scalar("SELECT message_id FROM show_posts WHERE show_id = ?").bind(&id).fetch_all(&state.db).await.unwrap_or_default();
    for mid in posts {
        crate::api::messages::remove_message(&state, &mid).await;
    }
    crate::api::highlights::forget(&state, "show_id", &id).await;
    sqlx::query("DELETE FROM shows WHERE id = ?").bind(&id).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Active shows (for REC badges when the app connects).
pub async fn active(state: &Shared) -> Vec<Value> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM shows WHERE status IN ('setup','recording')").fetch_all(&state.db).await.unwrap_or_default();
    let mut out = vec![];
    for id in ids {
        if let Ok(s) = load(state, &id).await {
            // a show left 'recording' by a server restart more than 12h ago is stale
            if now_ms() - s.created_at > 12 * 3600 * 1000 {
                let _ = sqlx::query("UPDATE shows SET status = 'ended', ended_at = ? WHERE id = ?").bind(now_ms()).bind(&id).execute(&state.db).await;
                continue;
            }
            if let Ok(v) = show_json(state, &s).await {
                out.push(v);
            }
        }
    }
    out
}

