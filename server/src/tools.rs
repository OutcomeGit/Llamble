//! Things the bot can look up or work out instead of guessing: the time, maths, the weather,
//! a web search, and reading a web page. Used in chat and in voice ("Hey Llamble").
//! The model asks for a tool (OpenAI-style tool calls); the server runs it and hands back
//! the result. Internet tools can be switched off by the Master Admin.
use crate::state::Shared;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct ToolSettings {
    /// time + calculator (no internet)
    pub basic: bool,
    /// web search, reading pages, weather (uses the internet)
    pub web: bool,
    /// your own SearXNG (e.g. http://192.168.1.20:8888); empty = DuckDuckGo
    pub searxng_url: String,
}

impl Default for ToolSettings {
    fn default() -> Self {
        ToolSettings { basic: true, web: true, searxng_url: String::new() }
    }
}

pub async fn settings(state: &Shared) -> ToolSettings {
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'bot_tools'").fetch_optional(&state.db).await.ok().flatten();
    v.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

pub async fn save(state: &Shared, s: &ToolSettings) -> anyhow::Result<()> {
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('bot_tools', ?)").bind(serde_json::to_string(s)?).execute(&state.db).await?;
    Ok(())
}

/// Who's asking, for tools that depend on it.
#[derive(Clone, Default)]
pub struct Ctx {
    /// the asker's time zone (from their app), e.g. "America/New_York"
    pub tz: Option<String>,
    /// a kid is in the conversation: strict safe search
    pub kid: bool,
    /// chat (not voice): where a picture would be posted, and who asked
    pub channel: Option<crate::models::Channel>,
    pub user: Option<String>,
    pub user_is_admin: bool,
}

fn func(name: &str, desc: &str, params: Value) -> Value {
    json!({ "type": "function", "function": { "name": name, "description": desc, "parameters": params } })
}

/// The tool list sent to the model.
pub async fn definitions(state: &Shared, ctx: &Ctx) -> Vec<Value> {
    let s = settings(state).await;
    let mut out = vec![];
    if let (Some(_), Some(u)) = (&ctx.channel, &ctx.user) {
        if crate::images::may_draw(state, u, ctx.user_is_admin).await.is_ok() {
            out.push(func("generate_image", "Draw a picture and post it in the chat. Use when someone asks you to draw, make, generate or show a picture/image/drawing. Write a detailed visual description as the prompt.", json!({
                "type": "object", "properties": {
                    "prompt": { "type": "string", "description": "Detailed description of the picture: subject, setting, style, lighting" },
                    "shape": { "type": "string", "enum": ["square", "wide", "tall"] } }, "required": ["prompt"] })));
        }
    }
    if s.basic {
        out.push(func("get_current_time", "Get the current date and time. Use for any question about today's date, the time, or the day of the week.", json!({
            "type": "object", "properties": { "timezone": { "type": "string", "description": "IANA time zone like America/New_York. Leave out to use the asker's own." } } })));
        out.push(func("calculate", "Work out arithmetic exactly. Supports + - * / ^ % parentheses and sqrt, abs, round, floor, ceil, sin, cos, tan, ln, log10, pi, e.", json!({
            "type": "object", "properties": { "expression": { "type": "string" } }, "required": ["expression"] })));
        if ctx.user.is_some() {
            out.push(func("set_reminder", "Set a one-time reminder for the person asking. It pops up as a notification on all their devices at that time. Use when someone says \"remind me ...\".", json!({
                "type": "object", "properties": {
                    "text": { "type": "string", "description": "What to remind them of, short, e.g. \"Take the bins out\"" },
                    "at": { "type": "string", "description": "Local date and time, ISO-8601, e.g. 2026-11-10T07:30. Use this OR minutes_from_now." },
                    "minutes_from_now": { "type": "integer", "description": "Minutes from now, e.g. 20" } }, "required": ["text"] })));
        }
    }
    if s.web {
        out.push(func("get_weather", "Current weather and the next days' forecast for a place.", json!({
            "type": "object", "properties": { "location": { "type": "string", "description": "City or place, e.g. \"Louisville, KY\"" }, "days": { "type": "integer", "description": "1-7" } }, "required": ["location"] })));
        out.push(func("web_search", "Search the web for current information, news, facts, prices, sports scores, people, places.", json!({
            "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] })));
        out.push(func("read_webpage", "Read the text of a web page (for example a search result) to answer from it.", json!({
            "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"] })));
    }
    out
}

/// Run one tool call; the result is plain text for the model.
pub async fn run(state: &Shared, ctx: &Ctx, name: &str, args: &Value) -> String {
    let s = settings(state).await;
    let r = match name {
        "get_current_time" if s.basic => Ok(now_in(args["timezone"].as_str().map(String::from).or(ctx.tz.clone()))),
        "calculate" if s.basic => calc(args["expression"].as_str().unwrap_or("")).map(|v| format!("{}", fmt_num(v))),
        "get_weather" if s.web => weather(args["location"].as_str().unwrap_or(""), args["days"].as_i64().unwrap_or(3)).await,
        "web_search" if s.web => search(&s, args["query"].as_str().unwrap_or(""), ctx.kid).await,
        "read_webpage" if s.web => read_page(args["url"].as_str().unwrap_or("")).await,
        "generate_image" => draw(state, ctx, args).await,
        "set_reminder" if s.basic => set_reminder(state, ctx, args).await,
        _ => Err(anyhow::anyhow!("that tool isn't available")),
    };
    match r {
        Ok(t) => t.chars().take(8000).collect(),
        Err(e) => format!("Error: {e}"),
    }
}

// ---------------------------------------------------------------- reminders

/// "remind me …": a one-time reminder in the asker's own time zone.
async fn set_reminder(state: &Shared, ctx: &Ctx, args: &Value) -> anyhow::Result<String> {
    use chrono::TimeZone;
    let Some(uid) = ctx.user.clone() else { anyhow::bail!("reminders need a signed-in person") };
    let text = args["text"].as_str().unwrap_or("").trim();
    if text.is_empty() {
        anyhow::bail!("say what the reminder is for");
    }
    let tz_name = ctx.tz.clone().filter(|t| t.parse::<chrono_tz::Tz>().is_ok()).unwrap_or_else(|| crate::api::alarms::user_tz(&uid));
    let tz = crate::api::alarms::parse_tz(&tz_name);
    let now = crate::error::now_ms();
    let at = if let Some(m) = args["minutes_from_now"].as_f64().or_else(|| args["minutes_from_now"].as_str().and_then(|s| s.trim().parse().ok())) {
        if !(1.0..=60.0 * 24.0 * 366.0).contains(&m) {
            anyhow::bail!("pick a time from 1 minute to a year away");
        }
        now + (m * 60_000.0) as i64
    } else if let Some(s) = args["at"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
            t.timestamp_millis()
        } else {
            let naive = ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"].iter().find_map(|f| chrono::NaiveDateTime::parse_from_str(s, f).ok());
            let Some(n) = naive else { anyhow::bail!("couldn't read the time {s:?}: use YYYY-MM-DDTHH:MM") };
            crate::api::alarms::local_ms(tz, n.date(), n.time()).ok_or_else(|| anyhow::anyhow!("that time doesn't exist there"))?
        }
    } else {
        anyhow::bail!("say when: a time or minutes_from_now");
    };
    let label: String = text.chars().take(80).collect();
    let a = crate::api::alarms::create_alarm(state, &uid, &label, "reminder", Some(at), None, None, &tz_name, None, None, None, false)
        .await
        .map_err(|e| anyhow::anyhow!(e.1))?;
    let when = tz.timestamp_millis_opt(a.at.unwrap_or(at)).single().map(|t| t.format("%A %-d %B at %-I:%M %p").to_string()).unwrap_or_default();
    Ok(format!("Reminder set: \"{label}\" on {when}."))
}

// ---------------------------------------------------------------- pictures

async fn draw(state: &Shared, ctx: &Ctx, args: &Value) -> anyhow::Result<String> {
    let (Some(ch), Some(uid)) = (ctx.channel.clone(), ctx.user.clone()) else { anyhow::bail!("pictures can only be posted in chat") };
    let s = crate::images::may_draw(state, &uid, ctx.user_is_admin).await.map_err(|e| anyhow::anyhow!(e))?;
    let prompt: String = args["prompt"].as_str().unwrap_or("").trim().chars().take(600).collect();
    if prompt.len() < 3 {
        anyhow::bail!("no description given");
    }
    crate::images::start(state.clone(), ch, uid, s, prompt, args["shape"].as_str().unwrap_or("square").to_string()).await?;
    Ok("The picture is being drawn and will appear in the chat by itself in a moment. Tell them briefly; don't describe it in detail.".into())
}

// ---------------------------------------------------------------- time

fn now_in(tz: Option<String>) -> String {
    let utc = chrono::Utc::now();
    if let Some(tz) = tz.as_deref().and_then(|t| t.parse::<chrono_tz::Tz>().ok()) {
        let t = utc.with_timezone(&tz);
        return format!("{} ({})", t.format("%A, %B %-d, %Y, %-I:%M %p"), tz.name());
    }
    format!("{} (UTC)", utc.format("%A, %B %-d, %Y, %-I:%M %p"))
}

// ---------------------------------------------------------------- calculator

fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        let s = format!("{:.10}", v);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// Small, safe expression evaluator (no code runs).
pub fn calc(src: &str) -> anyhow::Result<f64> {
    struct P<'a> {
        s: &'a [u8],
        i: usize,
    }
    impl P<'_> {
        fn ws(&mut self) {
            while self.i < self.s.len() && (self.s[self.i] as char).is_whitespace() {
                self.i += 1;
            }
        }
        fn eat(&mut self, c: u8) -> bool {
            self.ws();
            if self.i < self.s.len() && self.s[self.i] == c {
                self.i += 1;
                true
            } else {
                false
            }
        }
        fn expr(&mut self) -> anyhow::Result<f64> {
            let mut v = self.term()?;
            loop {
                if self.eat(b'+') {
                    v += self.term()?;
                } else if self.eat(b'-') {
                    v -= self.term()?;
                } else {
                    return Ok(v);
                }
            }
        }
        fn term(&mut self) -> anyhow::Result<f64> {
            let mut v = self.unary()?;
            loop {
                if self.eat(b'*') || self.eat(b'x') {
                    v *= self.unary()?;
                } else if self.eat(b'/') {
                    v /= self.unary()?;
                } else if self.eat(b'%') {
                    v %= self.unary()?;
                } else {
                    return Ok(v);
                }
            }
        }
        fn pow(&mut self) -> anyhow::Result<f64> {
            let b = self.atom()?;
            if self.eat(b'^') {
                return Ok(b.powf(self.unary()?));
            }
            Ok(b)
        }
        fn unary(&mut self) -> anyhow::Result<f64> {
            if self.eat(b'-') {
                return Ok(-self.unary()?);
            }
            if self.eat(b'+') {
                return self.unary();
            }
            self.pow()
        }
        fn atom(&mut self) -> anyhow::Result<f64> {
            self.ws();
            if self.eat(b'(') {
                let v = self.expr()?;
                if !self.eat(b')') {
                    anyhow::bail!("missing )");
                }
                return Ok(v);
            }
            let start = self.i;
            while self.i < self.s.len() && ((self.s[self.i] as char).is_ascii_digit() || self.s[self.i] == b'.' || self.s[self.i] == b',') {
                self.i += 1;
            }
            if self.i > start {
                let t = std::str::from_utf8(&self.s[start..self.i])?.replace(',', "");
                return Ok(t.parse()?);
            }
            while self.i < self.s.len() && (self.s[self.i] as char).is_ascii_alphabetic() {
                self.i += 1;
            }
            let name = std::str::from_utf8(&self.s[start..self.i])?.to_lowercase();
            match name.as_str() {
                "pi" => return Ok(std::f64::consts::PI),
                "e" => return Ok(std::f64::consts::E),
                "" => anyhow::bail!("expected a number"),
                _ => {}
            }
            if !self.eat(b'(') {
                anyhow::bail!("unknown name {name}");
            }
            let a = self.expr()?;
            if !self.eat(b')') {
                anyhow::bail!("missing )");
            }
            Ok(match name.as_str() {
                "sqrt" => a.sqrt(),
                "abs" => a.abs(),
                "round" => a.round(),
                "floor" => a.floor(),
                "ceil" => a.ceil(),
                "sin" => a.sin(),
                "cos" => a.cos(),
                "tan" => a.tan(),
                "ln" => a.ln(),
                "log" | "log10" => a.log10(),
                _ => anyhow::bail!("unknown function {name}"),
            })
        }
    }
    let mut p = P { s: src.as_bytes(), i: 0 };
    let v = p.expr()?;
    p.ws();
    if p.i != p.s.len() {
        anyhow::bail!("couldn't read the whole expression");
    }
    if !v.is_finite() {
        anyhow::bail!("not a finite number");
    }
    Ok(v)
}

// ---------------------------------------------------------------- weather (Open-Meteo, no key)

fn http() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(15)).user_agent("Mozilla/5.0 (compatible; Llamble/0.1)").build().unwrap()
}

fn weather_text(code: i64) -> &'static str {
    match code {
        0 => "clear",
        1 | 2 => "partly cloudy",
        3 => "overcast",
        45 | 48 => "foggy",
        51..=57 => "drizzle",
        61..=67 => "rain",
        71..=77 => "snow",
        80..=82 => "rain showers",
        85 | 86 => "snow showers",
        95..=99 => "thunderstorms",
        _ => "mixed",
    }
}

async fn weather(location: &str, days: i64) -> anyhow::Result<String> {
    let base = std::env::var("LLAMBLE_WEATHER_API").unwrap_or_else(|_| "https://api.open-meteo.com".into());
    let geo_base = std::env::var("LLAMBLE_GEOCODE_API").unwrap_or_else(|_| "https://geocoding-api.open-meteo.com".into());
    // "Louisville, KY" → search the city name, prefer a match on the rest
    let mut parts = location.split(',').map(|p| p.trim());
    let city = parts.next().unwrap_or("");
    let hint = parts.collect::<Vec<_>>().join(" ").to_lowercase();
    let g: Value = http().get(format!("{geo_base}/v1/search")).query(&[("name", city), ("count", "10"), ("language", "en")]).send().await?.json().await?;
    let results = g["results"].as_array().cloned().unwrap_or_default();
    let place = results
        .iter()
        .find(|r| !hint.is_empty() && [r["admin1"].as_str(), r["country"].as_str(), r["country_code"].as_str()].iter().flatten().any(|v| v.to_lowercase().contains(&hint) || abbrev(v) == hint))
        .or(results.first())
        .ok_or_else(|| anyhow::anyhow!("couldn't find {location}"))?;
    let (lat, lon) = (place["latitude"].as_f64().unwrap_or(0.0), place["longitude"].as_f64().unwrap_or(0.0));
    let us = place["country_code"].as_str() == Some("US");
    let (tu, wu) = if us { ("fahrenheit", "mph") } else { ("celsius", "kmh") };
    let w: Value = http()
        .get(format!("{base}/v1/forecast"))
        .query(&[
            ("latitude", lat.to_string()),
            ("longitude", lon.to_string()),
            ("current", "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m".into()),
            ("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max".into()),
            ("temperature_unit", tu.into()),
            ("wind_speed_unit", wu.into()),
            ("timezone", "auto".into()),
            ("forecast_days", days.clamp(1, 7).to_string()),
        ])
        .send()
        .await?
        .json()
        .await?;
    let deg = if us { "°F" } else { "°C" };
    let c = &w["current"];
    let mut out = format!(
        "{}, {}: now {}{deg} (feels like {}{deg}), {}, wind {} {wu}, humidity {}%.",
        place["name"].as_str().unwrap_or(city),
        place["admin1"].as_str().or(place["country"].as_str()).unwrap_or(""),
        c["temperature_2m"],
        c["apparent_temperature"],
        weather_text(c["weather_code"].as_i64().unwrap_or(-1)),
        c["wind_speed_10m"],
        c["relative_humidity_2m"]
    );
    if let Some(dates) = w["daily"]["time"].as_array() {
        for (i, d) in dates.iter().enumerate() {
            out.push_str(&format!(
                "\n{}: {}, high {}{deg}, low {}{deg}, {}% chance of rain.",
                d.as_str().unwrap_or(""),
                weather_text(w["daily"]["weather_code"][i].as_i64().unwrap_or(-1)),
                w["daily"]["temperature_2m_max"][i],
                w["daily"]["temperature_2m_min"][i],
                w["daily"]["precipitation_probability_max"][i]
            ));
        }
    }
    Ok(out)
}

/// "Kentucky" → "ky" (US states only; enough to match "City, ST")
fn abbrev(state: &str) -> String {
    const S: &[(&str, &str)] = &[
        ("alabama", "al"), ("alaska", "ak"), ("arizona", "az"), ("arkansas", "ar"), ("california", "ca"), ("colorado", "co"), ("connecticut", "ct"), ("delaware", "de"), ("florida", "fl"), ("georgia", "ga"),
        ("hawaii", "hi"), ("idaho", "id"), ("illinois", "il"), ("indiana", "in"), ("iowa", "ia"), ("kansas", "ks"), ("kentucky", "ky"), ("louisiana", "la"), ("maine", "me"), ("maryland", "md"),
        ("massachusetts", "ma"), ("michigan", "mi"), ("minnesota", "mn"), ("mississippi", "ms"), ("missouri", "mo"), ("montana", "mt"), ("nebraska", "ne"), ("nevada", "nv"), ("new hampshire", "nh"), ("new jersey", "nj"),
        ("new mexico", "nm"), ("new york", "ny"), ("north carolina", "nc"), ("north dakota", "nd"), ("ohio", "oh"), ("oklahoma", "ok"), ("oregon", "or"), ("pennsylvania", "pa"), ("rhode island", "ri"), ("south carolina", "sc"),
        ("south dakota", "sd"), ("tennessee", "tn"), ("texas", "tx"), ("utah", "ut"), ("vermont", "vt"), ("virginia", "va"), ("washington", "wa"), ("west virginia", "wv"), ("wisconsin", "wi"), ("wyoming", "wy"),
    ];
    let l = state.to_lowercase();
    S.iter().find(|(n, _)| *n == l).map(|(_, a)| a.to_string()).unwrap_or(l)
}

// ---------------------------------------------------------------- web search

async fn search(s: &ToolSettings, q: &str, kid: bool) -> anyhow::Result<String> {
    if q.trim().is_empty() {
        anyhow::bail!("empty search");
    }
    let mut lines = vec![];
    if !s.searxng_url.trim().is_empty() {
        let v: Value = http()
            .get(format!("{}/search", s.searxng_url.trim_end_matches('/')))
            .query(&[("q", q), ("format", "json"), ("safesearch", if kid { "2" } else { "1" })])
            .send()
            .await?
            .json()
            .await?;
        for r in v["results"].as_array().into_iter().flatten().take(6) {
            lines.push(format!("- {} ({})\n  {}", r["title"].as_str().unwrap_or(""), r["url"].as_str().unwrap_or(""), r["content"].as_str().unwrap_or("")));
        }
    } else {
        let base = std::env::var("LLAMBLE_SEARCH_URL").unwrap_or_else(|_| "https://html.duckduckgo.com/html/".into());
        let html = http().post(&base).form(&[("q", q), ("kp", if kid { "1" } else { "-1" })]).send().await?.text().await?;
        let doc = scraper::Html::parse_document(&html);
        let res = scraper::Selector::parse(".result").unwrap();
        let a = scraper::Selector::parse(".result__a").unwrap();
        let snip = scraper::Selector::parse(".result__snippet").unwrap();
        for r in doc.select(&res).take(6) {
            let Some(link) = r.select(&a).next() else { continue };
            let mut url = link.value().attr("href").unwrap_or("").to_string();
            // DuckDuckGo wraps links: //duckduckgo.com/l/?uddg=<real url>
            if let Some(i) = url.find("uddg=") {
                let enc = url[i + 5..].split('&').next().unwrap_or("");
                url = percent_encoding::percent_decode_str(enc).decode_utf8_lossy().to_string();
            }
            let title = link.text().collect::<String>();
            let text = r.select(&snip).next().map(|s| s.text().collect::<String>()).unwrap_or_default();
            lines.push(format!("- {} ({})\n  {}", title.trim(), url, text.trim()));
        }
    }
    if lines.is_empty() {
        return Ok(format!("No results for \"{q}\"."));
    }
    Ok(format!("Search results for \"{q}\":\n{}", lines.join("\n")))
}

async fn read_page(url: &str) -> anyhow::Result<String> {
    let f = crate::api::embeds::safe_fetch(url, 2 * 1024 * 1024, "text/html,application/xhtml+xml,text/plain;q=0.8").await?;
    let body = String::from_utf8_lossy(&f.body).to_string();
    if !f.content_type.contains("html") {
        return Ok(body.chars().take(6000).collect());
    }
    let doc = scraper::Html::parse_document(&body);
    let title = scraper::Selector::parse("title").unwrap();
    let main = ["article", "main", "body"].iter().find_map(|s| doc.select(&scraper::Selector::parse(s).unwrap()).next());
    let skip = ["script", "style", "nav", "header", "footer", "noscript", "svg", "form", "aside"];
    let mut text = String::new();
    if let Some(m) = main {
        for node in m.descendants() {
            if let Some(t) = node.value().as_text() {
                let inside_skip = node.ancestors().any(|a| a.value().as_element().map(|e| skip.contains(&e.name())).unwrap_or(false));
                if !inside_skip {
                    let t = t.trim();
                    if !t.is_empty() {
                        text.push_str(t);
                        text.push(' ');
                    }
                }
            }
        }
    }
    let t = doc.select(&title).next().map(|t| t.text().collect::<String>()).unwrap_or_default();
    Ok(format!("{}\n{}", t.trim(), text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(6000).collect::<String>()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calculator() {
        assert_eq!(calc("2 + 2").unwrap(), 4.0);
        assert_eq!(calc("(1+2)*3^2").unwrap(), 27.0);
        assert_eq!(calc("-2^2").unwrap(), -4.0);
        assert_eq!(calc("1,234 * 2").unwrap(), 2468.0);
        assert_eq!(fmt_num(calc("10/4").unwrap()), "2.5");
        assert!((calc("sqrt(16) + pi").unwrap() - (4.0 + std::f64::consts::PI)).abs() < 1e-9);
        assert!(calc("2 +").is_err());
        assert!(calc("system(1)").is_err());
    }
    #[test]
    fn time_zone() {
        assert!(now_in(Some("America/New_York".into())).contains("America/New_York"));
        assert!(now_in(Some("Nope/Zone".into())).ends_with("(UTC)"));
    }
}

// ---------------------------------------------------------------- admin API

pub async fn get_admin(axum::extract::State(state): axum::extract::State<Shared>, auth: crate::state::AuthUser) -> crate::error::ApiResult<axum::Json<Value>> {
    if !auth.is_master {
        return Err(crate::error::AppError::forbidden());
    }
    Ok(axum::Json(json!(settings(&state).await)))
}

pub async fn put_admin(axum::extract::State(state): axum::extract::State<Shared>, auth: crate::state::AuthUser, axum::Json(req): axum::Json<ToolSettings>) -> crate::error::ApiResult<axum::Json<Value>> {
    if !auth.is_master {
        return Err(crate::error::AppError::forbidden());
    }
    let mut s = req;
    s.searxng_url = s.searxng_url.trim().trim_end_matches('/').to_string();
    if !s.searxng_url.is_empty() && !(s.searxng_url.starts_with("http://") || s.searxng_url.starts_with("https://")) {
        return Err(crate::error::AppError::bad("the SearXNG address should start with http:// or https://"));
    }
    save(&state, &s).await.map_err(|e| crate::error::AppError::bad(e.to_string()))?;
    Ok(axum::Json(json!(s)))
}
