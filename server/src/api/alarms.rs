//! Alarms and reminders. Alarms always ring (with snooze/dismiss) and can't be switched
//! off by notification settings; reminders are ordinary dismissable notices. The server
//! keeps time: it works out each alarm's next ring, and when it's due sends ALARM_FIRE to
//! every device of that person. Parents can set locked alarms for their kids.
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::models::get_user;
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use chrono::{Datelike, NaiveDate, NaiveTime, TimeZone};
use dashmap::DashMap;
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Notify;

/// How late a missed ring may still go off (e.g. the server was restarting).
const LATE_MS: i64 = 30 * 60 * 1000;
/// Snoozes a kid gets per ring on an alarm a parent set.
const KID_SNOOZES: i64 = 2;

pub async fn migrate(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    sqlx::raw_sql(
        r#"
CREATE TABLE IF NOT EXISTS alarms (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'alarm',
    at INTEGER,
    time TEXT,
    days TEXT,
    tz TEXT NOT NULL DEFAULT 'UTC',
    sound TEXT NOT NULL DEFAULT 'classic',
    snooze_min INTEGER NOT NULL DEFAULT 10,
    enabled INTEGER NOT NULL DEFAULT 1,
    set_by TEXT,
    locked INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER,
    snoozed_until INTEGER,
    snoozes_used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alarms_user ON alarms(user_id);
CREATE INDEX IF NOT EXISTS alarms_next ON alarms(next_at);
"#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(sqlx::FromRow, Clone, Debug)]
pub struct AlarmRow {
    pub id: String,
    pub user_id: String,
    pub label: String,
    pub kind: String,
    pub at: Option<i64>,
    pub time: Option<String>,
    pub days: Option<String>,
    pub tz: String,
    pub sound: String,
    pub snooze_min: i64,
    pub enabled: bool,
    pub set_by: Option<String>,
    pub locked: bool,
    pub next_at: Option<i64>,
    pub snoozed_until: Option<i64>,
    pub snoozes_used: i64,
    pub created_at: i64,
}

const COLS: &str = "id, user_id, label, kind, at, time, days, tz, sound, snooze_min, enabled, set_by, locked, next_at, snoozed_until, snoozes_used, created_at";

/// Alarms ringing right now: alarm id → (user, occurrence_at, fired_at)
static RINGING: Lazy<DashMap<String, (String, i64, i64)>> = Lazy::new(DashMap::new);
static WAKE: Lazy<Arc<Notify>> = Lazy::new(|| Arc::new(Notify::new()));

fn days_of(a: &AlarmRow) -> Option<Vec<u32>> {
    a.days.as_ref().map(|d| d.split(',').filter_map(|x| x.trim().parse().ok()).collect())
}

pub fn parse_tz(tz: &str) -> chrono_tz::Tz {
    tz.parse().unwrap_or(chrono_tz::UTC)
}

/// The user's time zone as their app last reported it (UTC if never).
pub fn user_tz(uid: &str) -> String {
    crate::bot::USER_TZ.get(uid).map(|t| t.clone()).filter(|t| t.parse::<chrono_tz::Tz>().is_ok()).unwrap_or_else(|| "UTC".into())
}

/// A local date + time in `tz` as a moment (DST-safe: a time skipped by a clock change
/// moves forward an hour, an ambiguous one takes the earlier).
pub fn local_ms(tz: chrono_tz::Tz, date: NaiveDate, time: NaiveTime) -> Option<i64> {
    let ndt = date.and_time(time);
    match tz.from_local_datetime(&ndt) {
        chrono::LocalResult::Single(t) => Some(t.timestamp_millis()),
        chrono::LocalResult::Ambiguous(a, _) => Some(a.timestamp_millis()),
        chrono::LocalResult::None => tz.from_local_datetime(&(ndt + chrono::Duration::hours(1))).earliest().map(|t| t.timestamp_millis()),
    }
}

/// Next time a repeating alarm rings after `after` (ms).
fn next_repeat(time: &str, days: &[u32], tz: chrono_tz::Tz, after: i64) -> Option<i64> {
    let t = NaiveTime::parse_from_str(time, "%H:%M").ok()?;
    let start = tz.timestamp_millis_opt(after).single()?.date_naive();
    for i in 0..9 {
        let d = start + chrono::Duration::days(i);
        if !days.contains(&d.weekday().num_days_from_sunday()) {
            continue;
        }
        if let Some(ms) = local_ms(tz, d, t) {
            if ms > after {
                return Some(ms);
            }
        }
    }
    None
}

/// When this alarm should ring next (None = never again).
fn compute_next(a: &AlarmRow, after: i64) -> Option<i64> {
    if !a.enabled {
        return None;
    }
    if let Some(s) = a.snoozed_until {
        return Some(s);
    }
    match (&a.time, days_of(a)) {
        (Some(t), Some(days)) if !days.is_empty() => next_repeat(t, &days, parse_tz(&a.tz), after),
        _ => a.at.filter(|at| *at > after - LATE_MS),
    }
}

/// Does any of this person's enabled alarms ring between `from` and `to` (ms)?
pub async fn any_alarm_between(state: &Shared, uid: &str, from: i64, to: i64) -> bool {
    let rows = sqlx::query_as::<_, AlarmRow>(&format!("SELECT {COLS} FROM alarms WHERE user_id = ? AND enabled = 1")).bind(uid).fetch_all(&state.db).await.unwrap_or_default();
    rows.iter().any(|a| {
        let within = |t: i64| t >= from && t <= to;
        if a.snoozed_until.is_some_and(within) {
            return true;
        }
        match (&a.time, days_of(a)) {
            (Some(t), Some(days)) => next_repeat(t, &days, parse_tz(&a.tz), from - 1).is_some_and(within),
            _ => a.at.is_some_and(within),
        }
    })
}

pub async fn alarm_json(state: &Shared, a: &AlarmRow) -> Value {
    let set_by = match &a.set_by {
        Some(g) => get_user(&state.db, g).await.ok().map(|u| json!(u)).unwrap_or(Value::Null),
        None => Value::Null,
    };
    json!({
        "id": a.id, "label": a.label, "kind": a.kind, "at": a.at, "time": a.time, "days": days_of(a),
        "tz": a.tz, "sound": a.sound, "snooze_min": a.snooze_min, "enabled": a.enabled, "set_by": set_by,
        "locked": a.locked, "next_at": a.next_at, "snoozed_until": a.snoozed_until, "created_at": a.created_at,
    })
}

async fn load(state: &Shared, id: &str) -> ApiResult<AlarmRow> {
    sqlx::query_as::<_, AlarmRow>(&format!("SELECT {COLS} FROM alarms WHERE id = ?")).bind(id).fetch_optional(&state.db).await?.ok_or_else(AppError::not_found)
}

/// The owner, plus their guardians for a kid's alarms.
async fn audience(state: &Shared, a: &AlarmRow) -> Vec<String> {
    let mut v = vec![a.user_id.clone()];
    if crate::kids::is_kid(state, &a.user_id).await {
        for g in crate::kids::guardians_of(state, &a.user_id).await {
            if !v.contains(&g) {
                v.push(g);
            }
        }
    }
    v
}

async fn announce(state: &Shared, t: &str, a: &AlarmRow) {
    let v = alarm_json(state, a).await;
    let who = audience(state, a).await;
    state.hub.send_users(&who, t, &v);
}

/// Recompute and save next_at, then wake the scheduler.
async fn reschedule(state: &Shared, id: &str) -> ApiResult<AlarmRow> {
    let mut a = load(state, id).await?;
    a.next_at = compute_next(&a, now_ms());
    sqlx::query("UPDATE alarms SET next_at = ? WHERE id = ?").bind(a.next_at).bind(&a.id).execute(&state.db).await?;
    WAKE.notify_one();
    Ok(a)
}

fn stop_ringing(state: &Shared, a: &AlarmRow) {
    RINGING.remove(&a.id);
    state.hub.send_user(&a.user_id, "ALARM_STOP", &json!({ "alarm_id": a.id }));
}

// ---------------------------------------------------------------- requests

#[derive(Deserialize, Default)]
pub struct AlarmReq {
    pub label: Option<String>,
    pub kind: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub at: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub time: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub days: Option<Option<Vec<u32>>>,
    pub sound: Option<String>,
    pub snooze_min: Option<i64>,
    pub enabled: Option<bool>,
    pub locked: Option<bool>,
}

fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(d)?))
}

fn clean_label(s: &str) -> ApiResult<String> {
    let l: String = s.trim().chars().filter(|c| !c.is_control()).collect();
    if l.is_empty() || l.chars().count() > 80 {
        return Err(AppError::bad("give it a name (up to 80 characters)"));
    }
    Ok(l)
}

fn check_time(t: &str) -> ApiResult<()> {
    let ok = t.len() == 5 && NaiveTime::parse_from_str(t, "%H:%M").is_ok();
    if ok { Ok(()) } else { Err(AppError::bad("time must be HH:MM (24-hour)")) }
}

fn check_days(d: &[u32]) -> ApiResult<String> {
    let mut v: Vec<u32> = d.iter().copied().filter(|x| *x <= 6).collect();
    v.sort();
    v.dedup();
    if v.is_empty() || v.len() != d.iter().collect::<std::collections::HashSet<_>>().len() {
        return Err(AppError::bad("pick at least one day (0 = Sunday … 6 = Saturday)"));
    }
    Ok(v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","))
}

fn check_sound(s: &str) -> ApiResult<String> {
    if s.is_empty() || s.len() > 32 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::bad("unknown sound"));
    }
    Ok(s.to_string())
}

/// Make an alarm or reminder for `uid` (also used by the AI's set_reminder tool).
#[allow(clippy::too_many_arguments)]
pub async fn create_alarm(state: &Shared, uid: &str, label: &str, kind: &str, at: Option<i64>, time: Option<String>, days: Option<Vec<u32>>, tz: &str, sound: Option<String>, snooze_min: Option<i64>, set_by: Option<String>, locked: bool) -> ApiResult<AlarmRow> {
    let label = clean_label(label)?;
    if kind != "alarm" && kind != "reminder" {
        return Err(AppError::bad("kind must be alarm or reminder"));
    }
    let (at, time, days) = match (at, time, days) {
        (Some(at), None, None) => {
            if at <= now_ms() {
                return Err(AppError::bad("that time has already passed"));
            }
            (Some(at), None, None)
        }
        (None, Some(t), Some(d)) => {
            check_time(&t)?;
            (None, Some(t), Some(check_days(&d)?))
        }
        _ => return Err(AppError::bad("give either a one-time `at`, or a repeating `time` with `days`")),
    };
    let sound = check_sound(&sound.unwrap_or_else(|| "classic".into()))?;
    let snooze = snooze_min.unwrap_or(10);
    if !(1..=60).contains(&snooze) {
        return Err(AppError::bad("snooze must be 1-60 minutes"));
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM alarms WHERE user_id = ?").bind(uid).fetch_one(&state.db).await?;
    if count >= 200 {
        return Err(AppError::bad("that's a lot of alarms: delete some first"));
    }
    let id = new_id();
    sqlx::query("INSERT INTO alarms (id, user_id, label, kind, at, time, days, tz, sound, snooze_min, set_by, locked, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(&id).bind(uid).bind(&label).bind(kind).bind(at).bind(&time).bind(&days).bind(tz)
        .bind(&sound).bind(snooze).bind(&set_by).bind(locked).bind(now_ms())
        .execute(&state.db).await?;
    let a = reschedule(state, &id).await?;
    announce(state, "ALARM_CREATE", &a).await;
    Ok(a)
}

pub async fn list(State(state): State<Shared>, auth: AuthUser, headers: HeaderMap) -> ApiResult<Json<Value>> {
    crate::bot::note_tz(&auth.id, &headers);
    let rows = sqlx::query_as::<_, AlarmRow>(&format!("SELECT {COLS} FROM alarms WHERE user_id = ? ORDER BY created_at")).bind(&auth.id).fetch_all(&state.db).await?;
    let mut out = vec![];
    for a in &rows {
        out.push(alarm_json(&state, a).await);
    }
    Ok(Json(json!(out)))
}

pub async fn create(State(state): State<Shared>, auth: AuthUser, headers: HeaderMap, Json(req): Json<AlarmReq>) -> ApiResult<Json<Value>> {
    crate::bot::note_tz(&auth.id, &headers);
    let tz = user_tz(&auth.id);
    let a = create_alarm(
        &state, &auth.id, req.label.as_deref().unwrap_or(""), req.kind.as_deref().unwrap_or("alarm"),
        req.at.flatten(), req.time.flatten(), req.days.flatten(), &tz, req.sound, req.snooze_min, None, false,
    ).await?;
    Ok(Json(alarm_json(&state, &a).await))
}

/// Who may change this alarm: its owner (unless a parent locked it on a kid), or a guardian.
async fn may_edit(state: &Shared, a: &AlarmRow, who: &str) -> ApiResult<bool> {
    let guardian = a.user_id != who && crate::kids::is_guardian(state, &a.user_id, who).await;
    if guardian {
        return Ok(true);
    }
    if a.user_id != who {
        return Err(AppError::not_found());
    }
    if a.locked && a.set_by.is_some() && crate::kids::is_kid(state, who).await {
        return Err(AppError::forbidden_msg("A parent set this alarm"));
    }
    Ok(false)
}

pub async fn update(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, Json(req): Json<AlarmReq>) -> ApiResult<Json<Value>> {
    let a = load(&state, &id).await?;
    let guardian = may_edit(&state, &a, &auth.id).await?;
    let label = match &req.label {
        Some(l) => clean_label(l)?,
        None => a.label.clone(),
    };
    let kind = req.kind.clone().unwrap_or(a.kind.clone());
    if kind != "alarm" && kind != "reminder" {
        return Err(AppError::bad("kind must be alarm or reminder"));
    }
    let mut at = a.at;
    let mut time = a.time.clone();
    let mut days = a.days.clone();
    if let Some(v) = req.at {
        at = v;
        if at.is_some() {
            time = None;
            days = None;
        }
    }
    if let Some(v) = req.time.clone() {
        time = v;
        if time.is_some() {
            at = None;
        }
    }
    if let Some(v) = req.days.clone() {
        days = match v {
            Some(d) => Some(check_days(&d)?),
            None => None,
        };
    }
    match (&at, &time, &days) {
        (Some(t), None, None) => {
            if req.at.is_some() && *t <= now_ms() {
                return Err(AppError::bad("that time has already passed"));
            }
        }
        (None, Some(t), Some(_)) => check_time(t)?,
        _ => return Err(AppError::bad("give either a one-time `at`, or a repeating `time` with `days`")),
    }
    let sound = match &req.sound {
        Some(s) => check_sound(s)?,
        None => a.sound.clone(),
    };
    let snooze = req.snooze_min.unwrap_or(a.snooze_min);
    if !(1..=60).contains(&snooze) {
        return Err(AppError::bad("snooze must be 1-60 minutes"));
    }
    let enabled = req.enabled.unwrap_or(a.enabled);
    // only the parent decides whether a kid's alarm is locked
    let locked = if guardian { req.locked.unwrap_or(a.locked) } else { a.locked };
    // a changed time starts fresh
    let timing_changed = at != a.at || time != a.time || days != a.days || enabled != a.enabled;
    sqlx::query("UPDATE alarms SET label=?, kind=?, at=?, time=?, days=?, sound=?, snooze_min=?, enabled=?, locked=?, snoozed_until = CASE WHEN ? THEN NULL ELSE snoozed_until END WHERE id=?")
        .bind(&label).bind(&kind).bind(at).bind(&time).bind(&days).bind(&sound).bind(snooze).bind(enabled).bind(locked).bind(timing_changed).bind(&id)
        .execute(&state.db).await?;
    if timing_changed {
        stop_ringing(&state, &a);
    }
    let a = reschedule(&state, &id).await?;
    announce(&state, "ALARM_UPDATE", &a).await;
    Ok(Json(alarm_json(&state, &a).await))
}

pub async fn delete(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let a = load(&state, &id).await?;
    may_edit(&state, &a, &auth.id).await?;
    let who = audience(&state, &a).await;
    stop_ringing(&state, &a);
    sqlx::query("DELETE FROM alarms WHERE id = ?").bind(&id).execute(&state.db).await?;
    state.hub.send_users(&who, "ALARM_DELETE", &json!({ "id": id }));
    WAKE.notify_one();
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize, Default)]
pub struct SnoozeReq {
    pub minutes: Option<i64>,
}

pub async fn snooze(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, body: Option<Json<SnoozeReq>>) -> ApiResult<Json<Value>> {
    let a = load(&state, &id).await?;
    let guardian = a.user_id != auth.id && crate::kids::is_guardian(&state, &a.user_id, &auth.id).await;
    if a.user_id != auth.id && !guardian {
        return Err(AppError::not_found());
    }
    let minutes = body.and_then(|b| b.0.minutes).unwrap_or(a.snooze_min);
    if !(1..=120).contains(&minutes) {
        return Err(AppError::bad("snooze must be 1-120 minutes"));
    }
    if !guardian && a.locked && a.set_by.is_some() && auth.is_kid && a.snoozes_used >= KID_SNOOZES {
        return Err(AppError::forbidden_msg("No more snoozes"));
    }
    let until = now_ms() + minutes * 60_000;
    sqlx::query("UPDATE alarms SET snoozed_until = ?, snoozes_used = snoozes_used + 1 WHERE id = ?").bind(until).bind(&id).execute(&state.db).await?;
    stop_ringing(&state, &a);
    let a = reschedule(&state, &id).await?;
    announce(&state, "ALARM_UPDATE", &a).await;
    Ok(Json(alarm_json(&state, &a).await))
}

pub async fn dismiss(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let a = load(&state, &id).await?;
    let guardian = a.user_id != auth.id && crate::kids::is_guardian(&state, &a.user_id, &auth.id).await;
    if a.user_id != auth.id && !guardian {
        return Err(AppError::not_found());
    }
    let repeating = a.time.is_some();
    if repeating {
        sqlx::query("UPDATE alarms SET snoozed_until = NULL, snoozes_used = 0 WHERE id = ?").bind(&id).execute(&state.db).await?;
    } else {
        sqlx::query("UPDATE alarms SET enabled = 0, snoozed_until = NULL, snoozes_used = 0 WHERE id = ?").bind(&id).execute(&state.db).await?;
    }
    stop_ringing(&state, &a);
    let a = reschedule(&state, &id).await?;
    announce(&state, "ALARM_UPDATE", &a).await;
    Ok(Json(alarm_json(&state, &a).await))
}

// ---------------------------------------------------------------- kids

pub async fn kid_list(State(state): State<Shared>, auth: AuthUser, Path(kid): Path<String>) -> ApiResult<Json<Value>> {
    if !crate::kids::is_guardian(&state, &kid, &auth.id).await {
        return Err(AppError::forbidden());
    }
    let rows = sqlx::query_as::<_, AlarmRow>(&format!("SELECT {COLS} FROM alarms WHERE user_id = ? ORDER BY created_at")).bind(&kid).fetch_all(&state.db).await?;
    let mut out = vec![];
    for a in &rows {
        out.push(alarm_json(&state, a).await);
    }
    Ok(Json(json!(out)))
}

pub async fn kid_create(State(state): State<Shared>, auth: AuthUser, headers: HeaderMap, Path(kid): Path<String>, Json(req): Json<AlarmReq>) -> ApiResult<Json<Value>> {
    if !crate::kids::is_guardian(&state, &kid, &auth.id).await {
        return Err(AppError::forbidden());
    }
    crate::bot::note_tz(&auth.id, &headers);
    let tz = crate::bot::USER_TZ.get(&kid).map(|t| t.clone()).filter(|t| t.parse::<chrono_tz::Tz>().is_ok()).unwrap_or_else(|| user_tz(&auth.id));
    let a = create_alarm(
        &state, &kid, req.label.as_deref().unwrap_or(""), req.kind.as_deref().unwrap_or("alarm"),
        req.at.flatten(), req.time.flatten(), req.days.flatten(), &tz, req.sound, req.snooze_min, Some(auth.id.clone()), req.locked.unwrap_or(true),
    ).await?;
    Ok(Json(alarm_json(&state, &a).await))
}

// ---------------------------------------------------------------- ringing

/// After READY: anything still ringing for this person rings again on the new device.
pub async fn on_ready(state: &Shared, uid: &str) {
    let now = now_ms();
    let ringing: Vec<(String, i64)> = RINGING.iter().filter(|e| e.value().0 == uid && now - e.value().2 < LATE_MS).map(|e| (e.key().clone(), e.value().1)).collect();
    for (id, occ) in ringing {
        if let Ok(a) = load(state, &id).await {
            let v = alarm_json(state, &a).await;
            state.hub.send_user(uid, "ALARM_FIRE", &json!({ "alarm": v, "occurrence_at": occ }));
        }
    }
}

/// Fire everything due, then move each alarm to its next ring.
async fn fire_due(state: &Shared) -> anyhow::Result<()> {
    let now = now_ms();
    let due = sqlx::query_as::<_, AlarmRow>(&format!("SELECT {COLS} FROM alarms WHERE enabled = 1 AND next_at IS NOT NULL AND next_at <= ?")).bind(now).fetch_all(&state.db).await?;
    for a in due {
        let occ = a.next_at.unwrap_or(now);
        let from_snooze = a.snoozed_until.is_some();
        if now - occ < LATE_MS {
            RINGING.insert(a.id.clone(), (a.user_id.clone(), occ, now));
            let v = alarm_json(state, &a).await;
            state.hub.send_user(&a.user_id, "ALARM_FIRE", &json!({ "alarm": v, "occurrence_at": occ }));
        }
        // the next ring: a new occurrence starts the kid's snooze count again
        let mut next = a.clone();
        next.snoozed_until = None;
        let n = if a.time.is_some() { compute_next(&next, now.max(occ)) } else { None };
        let reset = if from_snooze { a.snoozes_used } else { 0 };
        sqlx::query("UPDATE alarms SET next_at = ?, snoozed_until = NULL, snoozes_used = ? WHERE id = ?").bind(n).bind(reset).bind(&a.id).execute(&state.db).await?;
    }
    // forget rings nobody answered
    RINGING.retain(|_, v| now - v.2 < LATE_MS);
    Ok(())
}

/// The alarm clock: sleeps until the next ring (or a change), fires, repeats.
pub fn start(state: Shared) {
    tokio::spawn(async move {
        // catch up on alarms whose next ring was never worked out (or changed while down)
        if let Ok(rows) = sqlx::query_as::<_, AlarmRow>(&format!("SELECT {COLS} FROM alarms WHERE enabled = 1")).fetch_all(&state.db).await {
            let now = now_ms();
            for a in rows {
                let n = match a.next_at {
                    // a ring missed while the server was down: still goes off if recent
                    Some(n) if n <= now && now - n < LATE_MS => Some(n),
                    _ => compute_next(&a, now),
                };
                let _ = sqlx::query("UPDATE alarms SET next_at = ? WHERE id = ?").bind(n).bind(&a.id).execute(&state.db).await;
            }
        }
        loop {
            if let Err(e) = fire_due(&state).await {
                tracing::warn!("alarms: {e:#}");
            }
            let soonest: Option<i64> = sqlx::query_scalar("SELECT MIN(next_at) FROM alarms WHERE enabled = 1 AND next_at IS NOT NULL").fetch_one(&state.db).await.unwrap_or(None);
            let wait = soonest.map(|n| (n - now_ms()).clamp(0, 60_000)).unwrap_or(60_000) as u64;
            let notified = WAKE.notified();
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(wait)) => {}
                _ = notified => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weekday_alarm_in_new_york() {
        // Sunday 2026-11-08 12:00 UTC → next weekday 07:30 New York is Monday 07:30 EST = 12:30 UTC
        let tz: chrono_tz::Tz = "America/New_York".parse().unwrap();
        let after = chrono::Utc.with_ymd_and_hms(2026, 11, 8, 12, 0, 0).unwrap().timestamp_millis();
        let n = next_repeat("07:30", &[1, 2, 3, 4, 5], tz, after).unwrap();
        assert_eq!(n, chrono::Utc.with_ymd_and_hms(2026, 11, 9, 12, 30, 0).unwrap().timestamp_millis());
    }

    #[test]
    fn spring_forward_gap_moves_an_hour() {
        // 2027-03-14 02:30 doesn't exist in New York → 03:30 EDT (07:30 UTC)
        let tz: chrono_tz::Tz = "America/New_York".parse().unwrap();
        let d = NaiveDate::from_ymd_opt(2027, 3, 14).unwrap();
        let ms = local_ms(tz, d, NaiveTime::from_hms_opt(2, 30, 0).unwrap()).unwrap();
        assert_eq!(ms, chrono::Utc.with_ymd_and_hms(2027, 3, 14, 7, 30, 0).unwrap().timestamp_millis());
    }
}
