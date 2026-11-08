//! Show: record a call like a produced show.
//!
//! The person who starts a show picks who is in it (and which of their voice / camera /
//! screen), which member's app records it, and who directs. Everyone picked is asked;
//! they can say yes to some streams, no, or change their mind mid-show. A kid is covered
//! by their parent when the parent starts or records the show. While recording,
//! everyone in the channel sees REC.
//!
//! The recorder's app mixes the picture and sound (auto-switching to whoever talks unless
//! the director holds a shot) and uploads the video in pieces as it goes, so a crash
//! doesn't lose the recording. People in the show, their parents and admins can watch it.
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
}

async fn load(state: &Shared, id: &str) -> ApiResult<ShowRow> {
    let r: Option<(String, String, String, String, String, String, bool, bool, String, String, i64, Option<i64>, Option<i64>, i64, i64)> = sqlx::query_as(
        "SELECT id, channel_id, title, initiator_id, recorder_id, director_id, recorder_ok, director_ok, status, state, created_at, started_at, ended_at, size, next_seq FROM shows WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let r = r.ok_or_else(AppError::not_found)?;
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
        "created_at": s.created_at, "started_at": s.started_at, "ended_at": s.ended_at, "size": s.size,
        "people": ppl,
        "video_url": (s.status == "ended" && s.size > 0).then(|| format!("/api/shows/{}/video", s.id)),
    }))
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
    false
}

async fn require_in_channel(state: &Shared, auth: &AuthUser, cid: &str) -> ApiResult<crate::models::Channel> {
    let ch = load_channel(&state.db, cid).await?;
    crate::perms::require_channel(&state.db, &ch, &auth.id, crate::perms::VIEW | crate::perms::CONNECT).await?;
    if ch.kind != "voice" && ch.kind != "dm" {
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
    if req.record_on == "server" {
        if !state.s().allow_server_recording {
            return Err(AppError::bad("recording on the server is turned off (Master Admin: Settings → Server)"));
        }
        return Err(AppError::bad("recording on the server isn't available yet; pick a member's app"));
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
    sqlx::query("INSERT INTO shows (id, channel_id, title, initiator_id, recorder_id, director_id, recorder_ok, director_ok, status, created_at) VALUES (?,?,?,?,?,?,?,?,'setup',?)")
        .bind(&id)
        .bind(&cid)
        .bind(&title)
        .bind(&auth.id)
        .bind(&recorder)
        .bind(&director)
        .bind(recorder == auth.id)
        .bind(director == auth.id)
        .bind(now_ms())
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
    tokio::fs::create_dir_all(state.cfg.data_dir.join("recordings")).await.map_err(|e| AppError::bad(e.to_string()))?;
    let _ = tokio::fs::remove_file(video_path(&state, &id)).await;
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
        for k in ["focus", "hold", "layout", "title", "lower_third", "card"] {
            if let Some(v) = r.get(k) {
                c.insert(k.to_string(), v.clone());
            }
        }
    }
    let txt = serde_json::to_string(&cur).unwrap();
    if txt.len() > 8000 {
        return Err(AppError::bad("too much"));
    }
    sqlx::query("UPDATE shows SET state = ? WHERE id = ?").bind(txt).bind(&id).execute(&state.db).await?;
    Ok(Json(broadcast(&state, &id).await?))
}

/// The recorder's app sends the video in order, a few seconds at a time.
pub async fn upload_chunk(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> ApiResult<Json<Value>> {
    let s = load(&state, &id).await?;
    if s.recorder_id != auth.id {
        return Err(AppError::forbidden());
    }
    let late_ok = s.status == "ended" && now_ms() - s.ended_at.unwrap_or(0) < 120_000;
    if s.status != "recording" && !late_ok {
        return Err(AppError::bad("not recording"));
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
        } else if can_watch(&state, &auth, &s).await && s.size > 0 {
            past.push(show_json(&state, &s).await?);
        }
    }
    Ok(Json(json!({ "live": live, "recordings": past })))
}

/// Recordings across the server that this person may watch (for parents: their kids').
pub async fn mine(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM shows WHERE status = 'ended' AND size > 0 ORDER BY created_at DESC LIMIT 300").fetch_all(&state.db).await?;
    let mut out = vec![];
    for id in ids {
        let s = load(&state, &id).await?;
        if can_watch(&state, &auth, &s).await {
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
    if s.initiator_id != auth.id && !auth.is_admin {
        return Err(AppError::forbidden_msg("only whoever started the show (or an admin) can delete it"));
    }
    let _ = tokio::fs::remove_file(video_path(&state, &id)).await;
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

