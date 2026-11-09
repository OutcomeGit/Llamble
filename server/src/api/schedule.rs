//! A person's schedule: a private calendar link (ICS) and/or a simple work schedule,
//! used to suggest a "get off" alarm the night before an early start.
use crate::api::alarms::{local_ms, parse_tz, user_tz};
use crate::error::{now_ms, ApiResult, AppError};
use crate::state::{AuthUser, Shared};
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::Json;
use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

const DAY_MS: i64 = 86_400_000;
const MAX_BYTES: usize = 5 * 1024 * 1024;
const REFRESH_MS: i64 = 15 * 60 * 1000;
const WINDOW_DAYS: i64 = 14;

pub async fn migrate(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    sqlx::raw_sql(
        r#"
CREATE TABLE IF NOT EXISTS schedules (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    calendar_url TEXT,
    calendar_error TEXT,
    calendar_fetched_at INTEGER,
    calendar_tried_at INTEGER,
    calendar_events TEXT,
    manual TEXT,
    sleep_hours REAL NOT NULL DEFAULT 8,
    ready_minutes INTEGER NOT NULL DEFAULT 60,
    suggest INTEGER NOT NULL DEFAULT 1,
    suggestion_declined_for TEXT,
    tz TEXT
);
"#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(sqlx::FromRow, Clone, Default)]
struct Row {
    user_id: String,
    calendar_url: Option<String>,
    calendar_error: Option<String>,
    calendar_fetched_at: Option<i64>,
    calendar_events: Option<String>,
    manual: Option<String>,
    sleep_hours: f64,
    ready_minutes: i64,
    suggest: bool,
    suggestion_declined_for: Option<String>,
    tz: Option<String>,
}

const COLS: &str = "user_id, calendar_url, calendar_error, calendar_fetched_at, calendar_events, manual, sleep_hours, ready_minutes, suggest, suggestion_declined_for, tz";

async fn load(state: &Shared, uid: &str) -> ApiResult<Row> {
    let r = sqlx::query_as::<_, Row>(&format!("SELECT {COLS} FROM schedules WHERE user_id = ?")).bind(uid).fetch_optional(&state.db).await?;
    Ok(r.unwrap_or(Row { user_id: uid.into(), sleep_hours: 8.0, ready_minutes: 60, suggest: true, ..Default::default() }))
}

async fn ensure_row(state: &Shared, uid: &str) -> ApiResult<()> {
    sqlx::query("INSERT OR IGNORE INTO schedules (user_id) VALUES (?)").bind(uid).execute(&state.db).await?;
    Ok(())
}

/// The person's time zone: what their app reports now, else what we saw last.
fn tz_of(r: &Row) -> chrono_tz::Tz {
    match crate::bot::USER_TZ.get(&r.user_id) {
        Some(t) => parse_tz(&t),
        None => parse_tz(r.tz.as_deref().unwrap_or("UTC")),
    }
}

async fn remember_tz(state: &Shared, uid: &str, headers: &HeaderMap) {
    crate::bot::note_tz(uid, headers);
    if crate::bot::USER_TZ.contains_key(uid) {
        let tz = user_tz(uid);
        let _ = sqlx::query("UPDATE schedules SET tz = ? WHERE user_id = ?").bind(tz).bind(uid).execute(&state.db).await;
    }
}

fn view(r: &Row) -> Value {
    json!({
        "calendar": { "set": r.calendar_url.is_some(), "error": r.calendar_error, "fetched_at": r.calendar_fetched_at },
        "manual": r.manual.as_deref().and_then(|m| serde_json::from_str::<Value>(m).ok()),
        "sleep_hours": r.sleep_hours, "ready_minutes": r.ready_minutes, "suggest": r.suggest,
    })
}

// ---------------------------------------------------------------- events

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Event {
    pub title: String,
    pub start: i64,
    pub end: Option<i64>,
    pub all_day: bool,
    #[serde(default = "cal")]
    pub source: String,
}
fn cal() -> String {
    "calendar".into()
}

/// The manual work schedule's shifts from `from_day` for `n` days, in tz.
fn manual_events(manual: &Value, tz: chrono_tz::Tz, from_day: NaiveDate, n: i64) -> Vec<Event> {
    let days: Vec<u32> = manual["days"].as_array().map(|a| a.iter().filter_map(|d| d.as_u64().map(|x| x as u32)).collect()).unwrap_or_default();
    let Some(start) = manual["start"].as_str().and_then(|s| NaiveTime::parse_from_str(s, "%H:%M").ok()) else { return vec![] };
    let end = manual["end"].as_str().and_then(|s| NaiveTime::parse_from_str(s, "%H:%M").ok());
    let title = manual["title"].as_str().unwrap_or("Work").to_string();
    let mut out = vec![];
    for i in 0..n {
        let d = from_day + chrono::Duration::days(i);
        if !days.contains(&d.weekday().num_days_from_sunday()) {
            continue;
        }
        let Some(s) = local_ms(tz, d, start) else { continue };
        let e = end.and_then(|e| {
            let day = if e <= start { d + chrono::Duration::days(1) } else { d };
            local_ms(tz, day, e)
        });
        out.push(Event { title: title.clone(), start: s, end: e, all_day: false, source: "manual".into() });
    }
    out
}

/// Everything known for this person: the cached calendar plus manual shifts.
fn all_events(r: &Row) -> Vec<Event> {
    let tz = tz_of(r);
    let mut v: Vec<Event> = r.calendar_events.as_deref().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
    if let Some(m) = r.manual.as_deref().and_then(|m| serde_json::from_str::<Value>(m).ok()) {
        let today = tz.timestamp_millis_opt(now_ms()).single().map(|t| t.date_naive()).unwrap_or_default();
        v.extend(manual_events(&m, tz, today - chrono::Duration::days(1), WINDOW_DAYS + 2));
    }
    v.sort_by_key(|e| e.start);
    v
}

// ---------------------------------------------------------------- ICS

struct Prop {
    name: String,
    params: HashMap<String, String>,
    value: String,
}

fn parse_prop(line: &str) -> Option<Prop> {
    // NAME;P=V;P="V:x":VALUE (colons inside quotes belong to params)
    let mut in_q = false;
    let mut split = None;
    for (i, c) in line.char_indices() {
        match c {
            '"' => in_q = !in_q,
            ':' if !in_q => {
                split = Some(i);
                break;
            }
            _ => {}
        }
    }
    let i = split?;
    let (head, value) = (&line[..i], &line[i + 1..]);
    let mut parts = head.split(';');
    let name = parts.next()?.trim().to_ascii_uppercase();
    let params = parts.filter_map(|p| p.split_once('=')).map(|(k, v)| (k.trim().to_ascii_uppercase(), v.trim().trim_matches('"').to_string())).collect();
    Some(Prop { name, params, value: value.trim().to_string() })
}

fn unescape(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            match it.next() {
                Some('n') | Some('N') => out.push(' '),
                Some(x) => out.push(x),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}

/// Common Windows zone names some calendar servers put in TZID.
fn windows_tz(name: &str) -> Option<&'static str> {
    Some(match name {
        "Eastern Standard Time" => "America/New_York",
        "Central Standard Time" => "America/Chicago",
        "Mountain Standard Time" => "America/Denver",
        "US Mountain Standard Time" => "America/Phoenix",
        "Pacific Standard Time" => "America/Los_Angeles",
        "Alaskan Standard Time" => "America/Anchorage",
        "Hawaiian Standard Time" => "Pacific/Honolulu",
        "Atlantic Standard Time" => "America/Halifax",
        "Newfoundland Standard Time" => "America/St_Johns",
        "GMT Standard Time" => "Europe/London",
        "Greenwich Standard Time" => "Atlantic/Reykjavik",
        "W. Europe Standard Time" => "Europe/Berlin",
        "Romance Standard Time" => "Europe/Paris",
        "Central Europe Standard Time" => "Europe/Budapest",
        "Central European Standard Time" => "Europe/Warsaw",
        "E. Europe Standard Time" => "Europe/Chisinau",
        "FLE Standard Time" => "Europe/Kiev",
        "Russian Standard Time" => "Europe/Moscow",
        "India Standard Time" => "Asia/Kolkata",
        "China Standard Time" => "Asia/Shanghai",
        "Tokyo Standard Time" => "Asia/Tokyo",
        "Korea Standard Time" => "Asia/Seoul",
        "AUS Eastern Standard Time" => "Australia/Sydney",
        "New Zealand Standard Time" => "Pacific/Auckland",
        "UTC" | "Coordinated Universal Time" => "UTC",
        _ => return None,
    })
}

fn tz_from_id(id: &str, fallback: chrono_tz::Tz) -> chrono_tz::Tz {
    if let Ok(t) = id.parse() {
        return t;
    }
    if let Some(t) = windows_tz(id).and_then(|w| w.parse().ok()) {
        return t;
    }
    // e.g. "/mozilla.org/20070129_1/America/New_York"
    let parts: Vec<&str> = id.split('/').filter(|p| !p.is_empty()).collect();
    for i in 0..parts.len() {
        if let Ok(t) = parts[i..].join("/").parse() {
            return t;
        }
    }
    fallback
}

/// A parsed DTSTART-like value.
#[derive(Clone, Copy)]
struct When {
    local: NaiveDateTime,
    tz: chrono_tz::Tz,
    all_day: bool,
    ms: i64,
}

fn parse_when(p: &Prop, user: chrono_tz::Tz) -> Vec<When> {
    p.value.split(',').filter_map(|v| parse_one(v.trim(), &p.params, user)).collect()
}

fn parse_one(v: &str, params: &HashMap<String, String>, user: chrono_tz::Tz) -> Option<When> {
    let date_only = params.get("VALUE").is_some_and(|x| x.eq_ignore_ascii_case("DATE")) || (v.len() == 8 && !v.contains('T'));
    if date_only {
        let d = NaiveDate::parse_from_str(&v[..8.min(v.len())], "%Y%m%d").ok()?;
        let local = d.and_time(NaiveTime::MIN);
        return Some(When { local, tz: user, all_day: true, ms: local_ms(user, d, NaiveTime::MIN)? });
    }
    let utc = v.ends_with('Z') || v.ends_with('z');
    let local = NaiveDateTime::parse_from_str(v.trim_end_matches(['Z', 'z']), "%Y%m%dT%H%M%S").ok()?;
    if utc {
        return Some(When { local, tz: chrono_tz::UTC, all_day: false, ms: chrono::Utc.from_utc_datetime(&local).timestamp_millis() });
    }
    let tz = params.get("TZID").map(|t| tz_from_id(t, user)).unwrap_or(user);
    Some(When { local, tz, all_day: false, ms: local_ms(tz, local.date(), local.time())? })
}

#[derive(Default)]
struct VEvent {
    uid: String,
    summary: String,
    start: Option<When>,
    end: Option<When>,
    duration: Option<i64>,
    rrule: Option<String>,
    exdates: Vec<i64>,
    recurrence_id: Option<i64>,
    cancelled: bool,
}

/// ISO-8601 duration like PT1H30M / P1D (seconds → ms).
fn parse_duration(s: &str) -> Option<i64> {
    let (neg, s) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let s = s.strip_prefix('P')?;
    let mut total = 0i64;
    let mut num = String::new();
    for c in s.chars() {
        match c {
            '0'..='9' => num.push(c),
            'T' => {}
            'W' | 'D' | 'H' | 'M' | 'S' => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                total += n * match c { 'W' => 604_800, 'D' => 86_400, 'H' => 3600, 'M' => 60, _ => 1 };
            }
            _ => return None,
        }
    }
    Some(if neg { -total } else { total } * 1000)
}

fn parse_ics(text: &str, user: chrono_tz::Tz) -> anyhow::Result<Vec<VEvent>> {
    // unfold continuation lines
    let mut lines: Vec<String> = vec![];
    for raw in text.split('\n') {
        let l = raw.strip_suffix('\r').unwrap_or(raw);
        if (l.starts_with(' ') || l.starts_with('\t')) && !lines.is_empty() {
            lines.last_mut().unwrap().push_str(&l[1..]);
        } else {
            lines.push(l.to_string());
        }
    }
    if !lines.iter().any(|l| l.trim().eq_ignore_ascii_case("BEGIN:VCALENDAR")) {
        anyhow::bail!("not a calendar");
    }
    let mut out = vec![];
    let mut cur: Option<VEvent> = None;
    let mut depth = 0; // nested blocks inside a VEVENT (VALARM)
    for l in &lines {
        let Some(p) = parse_prop(l) else { continue };
        match (p.name.as_str(), p.value.to_ascii_uppercase().as_str()) {
            ("BEGIN", "VEVENT") => {
                cur = Some(VEvent::default());
                depth = 0;
                continue;
            }
            ("END", "VEVENT") => {
                if let Some(e) = cur.take() {
                    out.push(e);
                }
                continue;
            }
            ("BEGIN", _) if cur.is_some() => depth += 1,
            ("END", _) if cur.is_some() => depth -= 1,
            _ => {}
        }
        let Some(e) = cur.as_mut() else { continue };
        if depth > 0 {
            continue;
        }
        match p.name.as_str() {
            "UID" => e.uid = p.value.clone(),
            "SUMMARY" => e.summary = unescape(&p.value),
            "DTSTART" => e.start = parse_when(&p, user).into_iter().next(),
            "DTEND" => e.end = parse_when(&p, user).into_iter().next(),
            "DURATION" => e.duration = parse_duration(&p.value),
            "RRULE" => e.rrule = Some(p.value.clone()),
            "EXDATE" => e.exdates.extend(parse_when(&p, user).iter().map(|w| w.ms)),
            "RECURRENCE-ID" => e.recurrence_id = parse_when(&p, user).first().map(|w| w.ms),
            "STATUS" => e.cancelled = p.value.eq_ignore_ascii_case("CANCELLED"),
            _ => {}
        }
    }
    Ok(out)
}

/// UNTIL must be UTC when DTSTART has a zone; DATE-only/floating values are made so.
fn fix_until(rule: &str) -> String {
    rule.split(';')
        .map(|part| match part.split_once('=') {
            Some((k, v)) if k.eq_ignore_ascii_case("UNTIL") && !v.ends_with('Z') => {
                if v.len() == 8 { format!("UNTIL={v}T235959Z") } else { format!("UNTIL={v}Z") }
            }
            _ => part.to_string(),
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// Start times (ms) of a repeating event inside [from, to).
fn expand_rrule(start: &When, rule: &str, from: i64, to: i64) -> Option<Vec<i64>> {
    let text = format!("DTSTART;TZID={}:{}\nRRULE:{}", start.tz.name(), start.local.format("%Y%m%dT%H%M%S"), fix_until(rule));
    let set: rrule::RRuleSet = text.parse().ok()?;
    let utc = |ms: i64| chrono::DateTime::from_timestamp_millis(ms).map(|d| d.with_timezone(&rrule::Tz::UTC));
    // `after` is exclusive; step back a moment so an instance right at `from` counts
    let res = set.after(utc(from - 1)?).before(utc(to)?).all(200);
    Some(res.dates.iter().map(|d| d.timestamp_millis()).collect())
}

/// All instances of the calendar in [from, to).
fn expand(events: Vec<VEvent>, from: i64, to: i64) -> Vec<Event> {
    // moved/changed single instances replace the regular one with the same UID
    let mut overridden: HashMap<String, HashSet<i64>> = HashMap::new();
    for e in &events {
        if let Some(r) = e.recurrence_id {
            overridden.entry(e.uid.clone()).or_default().insert(r);
        }
    }
    let mut out = vec![];
    for e in events {
        let Some(start) = e.start else { continue };
        let length = match (e.end, e.duration) {
            (Some(end), _) => Some(end.ms - start.ms),
            (None, Some(d)) => Some(d),
            (None, None) if start.all_day => Some(DAY_MS),
            _ => None,
        }
        .filter(|l| *l >= 0);
        let starts = match (&e.rrule, e.recurrence_id) {
            (Some(rule), None) => expand_rrule(&start, rule, from, to).unwrap_or_else(|| vec![start.ms]),
            _ => vec![start.ms],
        };
        let skip = overridden.get(&e.uid);
        for s in starts {
            if e.cancelled || s < from - length.unwrap_or(0) || s >= to {
                continue;
            }
            if e.recurrence_id.is_none() && (e.exdates.contains(&s) || skip.is_some_and(|k| k.contains(&s))) {
                continue;
            }
            out.push(Event { title: if e.summary.is_empty() { "Busy".into() } else { e.summary.clone() }, start: s, end: length.map(|l| s + l), all_day: start.all_day, source: "calendar".into() });
            if out.len() >= 1000 {
                break;
            }
        }
    }
    out.sort_by_key(|e| e.start);
    out
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("Llamble-calendar/0.1")
        .build()
        .unwrap()
}

/// Download and expand a calendar link. Errors are friendly sentences.
async fn fetch_calendar(url: &str, tz: chrono_tz::Tz) -> Result<Vec<Event>, String> {
    let res = http().get(url).send().await.map_err(|e| {
        if e.is_timeout() { "The calendar link took too long to answer.".to_string() } else { "Couldn't reach the calendar link. Check that it's right and still shared.".to_string() }
    })?;
    if !res.status().is_success() {
        let code = res.status().as_u16();
        return Err(if code == 401 || code == 403 || code == 404 {
            format!("The calendar link no longer works ({code}). It may have been reset: copy a fresh private link.")
        } else {
            format!("The calendar server answered with an error ({code}).")
        });
    }
    let mut body = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The calendar download was cut off.".to_string())?;
        if body.len() + chunk.len() > MAX_BYTES {
            return Err("That calendar is too big (over 5 MB).".into());
        }
        body.extend_from_slice(&chunk);
    }
    let text = String::from_utf8_lossy(&body);
    let events = parse_ics(&text, tz).map_err(|_| "That link isn't a calendar file. Use the private iCal / ICS address.".to_string())?;
    let now = now_ms();
    Ok(expand(events, now - DAY_MS, now + WINDOW_DAYS * DAY_MS))
}

async fn refresh(state: &Shared, uid: &str) {
    let Ok(r) = load(state, uid).await else { return };
    let Some(url) = r.calendar_url.clone() else { return };
    let now = now_ms();
    let _ = sqlx::query("UPDATE schedules SET calendar_tried_at = ? WHERE user_id = ?").bind(now).bind(uid).execute(&state.db).await;
    match fetch_calendar(&url, tz_of(&r)).await {
        Ok(ev) => {
            let _ = sqlx::query("UPDATE schedules SET calendar_events = ?, calendar_error = NULL, calendar_fetched_at = ? WHERE user_id = ? AND calendar_url = ?")
                .bind(serde_json::to_string(&ev).unwrap_or_default()).bind(now).bind(uid).bind(&url).execute(&state.db).await;
        }
        Err(msg) => {
            // keep the old events: a flaky server shouldn't wipe tomorrow's shift
            let _ = sqlx::query("UPDATE schedules SET calendar_error = ? WHERE user_id = ? AND calendar_url = ?").bind(msg).bind(uid).bind(&url).execute(&state.db).await;
        }
    }
}

/// Re-download calendars every 15 minutes, a few at a time.
pub fn start(state: Shared) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let due: Vec<String> = sqlx::query_scalar("SELECT user_id FROM schedules WHERE calendar_url IS NOT NULL AND COALESCE(calendar_tried_at, 0) < ? ORDER BY COALESCE(calendar_tried_at, 0) LIMIT 40")
                .bind(now_ms() - REFRESH_MS)
                .fetch_all(&state.db)
                .await
                .unwrap_or_default();
            futures::stream::iter(due).for_each_concurrent(4, |uid| {
                let state = state.clone();
                async move { refresh(&state, &uid).await }
            }).await;
        }
    });
}

// ---------------------------------------------------------------- endpoints

pub async fn get(State(state): State<Shared>, auth: AuthUser, headers: HeaderMap) -> ApiResult<Json<Value>> {
    crate::bot::note_tz(&auth.id, &headers);
    Ok(Json(view(&load(&state, &auth.id).await?)))
}

fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(d)?))
}

#[derive(Deserialize)]
pub struct PutReq {
    #[serde(default, deserialize_with = "double_option")]
    calendar_url: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    manual: Option<Option<Value>>,
    sleep_hours: Option<f64>,
    ready_minutes: Option<i64>,
    suggest: Option<bool>,
}

fn clean_url(u: &str) -> ApiResult<String> {
    let u = u.trim();
    let lower = u.to_ascii_lowercase();
    let u = if lower.starts_with("webcal://") {
        format!("https://{}", &u[9..])
    } else if lower.starts_with("webcals://") {
        format!("https://{}", &u[10..])
    } else {
        u.to_string()
    };
    let parsed = reqwest::Url::parse(&u).map_err(|_| AppError::bad("that doesn't look like a calendar link"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() || u.len() > 2000 {
        return Err(AppError::bad("use the calendar's http(s) or webcal link"));
    }
    Ok(u)
}

fn clean_manual(m: &Value) -> ApiResult<Value> {
    let days: Vec<u64> = m["days"].as_array().ok_or_else(|| AppError::bad("manual.days must be a list"))?.iter().map(|d| d.as_u64().filter(|x| *x <= 6)).collect::<Option<_>>().ok_or_else(|| AppError::bad("days are 0 (Sunday) to 6"))?;
    let mut days = days;
    days.sort();
    days.dedup();
    if days.is_empty() {
        return Err(AppError::bad("pick at least one work day"));
    }
    let hhmm = |v: &Value| v.as_str().filter(|s| s.len() == 5 && NaiveTime::parse_from_str(s, "%H:%M").is_ok()).map(|s| s.to_string());
    let start = hhmm(&m["start"]).ok_or_else(|| AppError::bad("start must be HH:MM"))?;
    let end = match &m["end"] {
        Value::Null => None,
        v => Some(hhmm(v).ok_or_else(|| AppError::bad("end must be HH:MM"))?),
    };
    let title = m["title"].as_str().map(|t| t.trim()).filter(|t| !t.is_empty()).unwrap_or("Work");
    if title.chars().count() > 80 {
        return Err(AppError::bad("title is too long"));
    }
    Ok(json!({ "days": days, "start": start, "end": end, "title": title }))
}

pub async fn put(State(state): State<Shared>, auth: AuthUser, headers: HeaderMap, Json(req): Json<PutReq>) -> ApiResult<Json<Value>> {
    ensure_row(&state, &auth.id).await?;
    remember_tz(&state, &auth.id, &headers).await;
    if let Some(h) = req.sleep_hours {
        if !(5.0..=12.0).contains(&h) {
            return Err(AppError::bad("sleep must be 5-12 hours"));
        }
    }
    if let Some(m) = req.ready_minutes {
        if !(0..=240).contains(&m) {
            return Err(AppError::bad("getting ready must be 0-240 minutes"));
        }
    }
    let manual = match &req.manual {
        Some(Some(m)) => Some(Some(clean_manual(m)?.to_string())),
        Some(None) => Some(None),
        None => None,
    };
    let url = match &req.calendar_url {
        Some(Some(u)) if !u.trim().is_empty() => Some(Some(clean_url(u)?)),
        Some(_) => Some(None),
        None => None,
    };
    if let Some(m) = manual {
        sqlx::query("UPDATE schedules SET manual = ? WHERE user_id = ?").bind(m).bind(&auth.id).execute(&state.db).await?;
    }
    if let Some(h) = req.sleep_hours {
        sqlx::query("UPDATE schedules SET sleep_hours = ? WHERE user_id = ?").bind(h).bind(&auth.id).execute(&state.db).await?;
    }
    if let Some(m) = req.ready_minutes {
        sqlx::query("UPDATE schedules SET ready_minutes = ? WHERE user_id = ?").bind(m).bind(&auth.id).execute(&state.db).await?;
    }
    if let Some(s) = req.suggest {
        sqlx::query("UPDATE schedules SET suggest = ? WHERE user_id = ?").bind(s).bind(&auth.id).execute(&state.db).await?;
    }
    if let Some(u) = url {
        let old = load(&state, &auth.id).await?.calendar_url;
        if u != old {
            sqlx::query("UPDATE schedules SET calendar_url = ?, calendar_events = NULL, calendar_error = NULL, calendar_fetched_at = NULL, calendar_tried_at = NULL WHERE user_id = ?").bind(&u).bind(&auth.id).execute(&state.db).await?;
        }
        if u.is_some() {
            refresh(&state, &auth.id).await;
        }
    }
    Ok(Json(view(&load(&state, &auth.id).await?)))
}

#[derive(Deserialize)]
pub struct UpcomingQ {
    days: Option<i64>,
}

pub async fn upcoming(State(state): State<Shared>, auth: AuthUser, headers: HeaderMap, Query(q): Query<UpcomingQ>) -> ApiResult<Json<Value>> {
    crate::bot::note_tz(&auth.id, &headers);
    let days = q.days.unwrap_or(2).clamp(1, WINDOW_DAYS);
    let r = load(&state, &auth.id).await?;
    let now = now_ms();
    let v: Vec<Event> = all_events(&r).into_iter().filter(|e| e.end.unwrap_or(e.start) >= now && e.start < now + days * DAY_MS).collect();
    Ok(Json(json!(v)))
}

fn clock(tz: chrono_tz::Tz, ms: i64) -> String {
    tz.timestamp_millis_opt(ms).single().map(|t| {
        let (pm, h) = t.hour12();
        format!("{h}:{:02} {}", t.minute(), if pm { "PM" } else { "AM" })
    }).unwrap_or_default()
}

/// The early start tomorrow and when to get off, if worth suggesting.
async fn compute_suggestion(state: &Shared, r: &Row) -> Option<(Event, i64, String)> {
    if !r.suggest {
        return None;
    }
    let tz = tz_of(r);
    let now = now_ms();
    let tomorrow = tz.timestamp_millis_opt(now).single()?.date_naive() + chrono::Duration::days(1);
    if r.suggestion_declined_for.as_deref() == Some(tomorrow.format("%Y-%m-%d").to_string().as_str()) {
        return None;
    }
    let ev = all_events(r).into_iter().find(|e| {
        if e.all_day {
            return false;
        }
        let Some(t) = tz.timestamp_millis_opt(e.start).single() else { return false };
        t.date_naive() == tomorrow && t.hour() < 11
    })?;
    let alarm_at = ev.start - r.ready_minutes * 60_000 - (r.sleep_hours * 3_600_000.0) as i64;
    if alarm_at <= now {
        return None;
    }
    if crate::api::alarms::any_alarm_between(state, &r.user_id, alarm_at - 3_600_000, alarm_at + 3_600_000).await {
        return None;
    }
    let msg = format!("You have {} at {} tomorrow. Get-off alarm at {}?", ev.title, clock(tz, ev.start), clock(tz, alarm_at));
    Some((ev, alarm_at, msg))
}

pub async fn suggestion(State(state): State<Shared>, auth: AuthUser, headers: HeaderMap) -> ApiResult<Json<Value>> {
    remember_tz(&state, &auth.id, &headers).await;
    let r = load(&state, &auth.id).await?;
    Ok(Json(match compute_suggestion(&state, &r).await {
        Some((ev, at, msg)) => json!({ "event": { "title": ev.title, "start": ev.start }, "alarm_at": at, "message": msg }),
        None => Value::Null,
    }))
}

pub async fn decline(State(state): State<Shared>, auth: AuthUser, headers: HeaderMap) -> ApiResult<Json<Value>> {
    ensure_row(&state, &auth.id).await?;
    crate::bot::note_tz(&auth.id, &headers);
    let r = load(&state, &auth.id).await?;
    let tz = tz_of(&r);
    let tomorrow = tz.timestamp_millis_opt(now_ms()).single().map(|t| t.date_naive() + chrono::Duration::days(1)).unwrap_or_default();
    sqlx::query("UPDATE schedules SET suggestion_declined_for = ? WHERE user_id = ?").bind(tomorrow.format("%Y-%m-%d").to_string()).bind(&auth.id).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weekly_with_exdate_and_tzid() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Shift\\, early\r\nDTSTART;TZID=America/New_York:20261102T050000\r\nDTEND;TZID=America/New_York:20261102T130000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE\r\nEXDATE;TZID=America/New_York:20261104T050000\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20261105\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let tz: chrono_tz::Tz = "America/New_York".parse().unwrap();
        let ev = parse_ics(ics, tz).unwrap();
        let from = chrono::Utc.with_ymd_and_hms(2026, 11, 1, 0, 0, 0).unwrap().timestamp_millis();
        let out = expand(ev, from, from + 11 * DAY_MS);
        let shifts: Vec<_> = out.iter().filter(|e| !e.all_day).map(|e| e.start).collect();
        let at = |d, h| chrono::Utc.with_ymd_and_hms(2026, 11, d, h, 0, 0).unwrap().timestamp_millis();
        // Nov 2 (Mon) 05:00 EST = 10:00Z; Nov 4 excluded; Nov 9 Mon; Nov 11 Wed
        assert_eq!(shifts, vec![at(2, 10), at(9, 10), at(11, 10)]);
        assert_eq!(out.iter().find(|e| e.all_day).unwrap().title, "Holiday");
        assert_eq!(out[0].title, "Shift, early");
    }
}
