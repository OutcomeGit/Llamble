//! Voice/video/screen share. Media flows through a self-hosted LiveKit SFU; this server
//! authorizes joins (mints short-lived LiveKit tokens) and tracks who is in which channel.
use crate::error::{ApiResult, AppError};
use crate::models::{get_user, load_channel};
use crate::perms::{self, require_channel};
use crate::state::{channel_audience, AuthUser, Shared, VoiceState};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

async fn mint_livekit_token(state: &Shared, room: &str, identity: &str, name: &str, sources: &[&str]) -> ApiResult<String> {
    let (key, secret) = crate::voice_server::credentials(state).await.ok_or_else(|| AppError::bad("voice not configured"))?;
    let now = chrono_now();
    let claims = json!({
        "iss": key,
        "sub": identity,
        "name": name,
        "nbf": now - 10,
        "exp": now + 6 * 3600,
        "video": {
            "room": room,
            "roomJoin": true,
            "canSubscribe": true,
            "canPublish": !sources.is_empty(),
            "canPublishData": true,
            "canPublishSources": sources,
        }
    });
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| anyhow::anyhow!(e).into())
}

fn chrono_now() -> i64 {
    crate::error::now_ms() / 1000
}

pub async fn broadcast_voice(state: &Shared, channel_id: &str, payload: Value) {
    if let Ok(ch) = load_channel(&state.db, channel_id).await {
        let ids = channel_audience(&state.db, &ch).await;
        state.hub.send_users(&ids, "VOICE_STATE_UPDATE", &payload);
    }
}

pub async fn leave_voice(state: &Shared, user_id: &str) {
    if let Some((_, vs)) = state.hub.voice.remove(user_id) {
        broadcast_voice(state, &vs.channel_id, json!({ "user_id": user_id, "channel_id": null, "guild_id": vs.guild_id })).await;
    }
}

pub async fn join(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, headers: axum::http::HeaderMap) -> ApiResult<Json<Value>> {
    crate::kids::check_quiet(&state, &auth.id).await?;
    if !crate::voice_server::enabled(&state) {
        return Err(AppError::bad("voice isn't available on this server"));
    }
    crate::settings::learn_lan_ip(&state, &headers).await;
    // the built-in voice server may still be (re)starting, e.g. right after the server
    // learned its address or after an update: give it a moment instead of failing the call
    crate::voice_server::wait_ready(&state, std::time::Duration::from_secs(12)).await;
    let ch = load_channel(&state.db, &cid).await?;
    if !(ch.kind == "voice" || ch.kind == "dm") {
        return Err(AppError::bad("not a voice channel"));
    }
    let p = require_channel(&state.db, &ch, &auth.id, perms::VIEW | perms::CONNECT).await?;
    let mut sources = vec![];
    if p & perms::SPEAK != 0 {
        sources.push("microphone");
    }
    if p & perms::VIDEO != 0 {
        sources.extend(["camera", "screen_share", "screen_share_audio"]);
    }
    let user = get_user(&state.db, &auth.id).await?;
    let token = mint_livekit_token(&state, &cid, &auth.id, &user.display_name, &sources).await?;

    // moving between channels: announce leave from the old one
    if let Some(old) = state.hub.voice.get(&auth.id).map(|v| v.channel_id.clone()) {
        if old != cid {
            leave_voice(&state, &auth.id).await;
        }
    }
    let vs = VoiceState {
        user_id: auth.id.clone(),
        channel_id: cid.clone(),
        guild_id: ch.guild_id.clone(),
        muted: p & perms::SPEAK == 0,
        deafened: false,
        video: false,
        screen: false,
    };
    state.hub.voice.insert(auth.id.clone(), vs.clone());
    broadcast_voice(&state, &cid, serde_json::to_value(&vs).unwrap()).await;
    let url = crate::voice_server::client_url(&state, &headers).await;
    Ok(Json(json!({ "url": url, "token": token, "room": cid, "can_speak": p & perms::SPEAK != 0, "can_video": p & perms::VIDEO != 0 })))
}

pub async fn leave(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    leave_voice(&state, &auth.id).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct VoiceUpdate {
    pub muted: Option<bool>,
    pub deafened: Option<bool>,
    pub video: Option<bool>,
    pub screen: Option<bool>,
}

pub async fn update(State(state): State<Shared>, auth: AuthUser, Json(req): Json<VoiceUpdate>) -> ApiResult<Json<Value>> {
    let vs = {
        let mut e = state.hub.voice.get_mut(&auth.id).ok_or_else(|| AppError::bad("not in voice"))?;
        if let Some(v) = req.muted { e.muted = v; }
        if let Some(v) = req.deafened { e.deafened = v; }
        if let Some(v) = req.video { e.video = v; }
        if let Some(v) = req.screen { e.screen = v; }
        e.clone()
    };
    broadcast_voice(&state, &vs.channel_id, serde_json::to_value(&vs).unwrap()).await;
    Ok(Json(serde_json::to_value(&vs).unwrap()))
}

/// For DMs: ring the other participants.
pub async fn ring(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    let ch = load_channel(&state.db, &cid).await?;
    if ch.kind != "dm" {
        return Err(AppError::bad("only DMs can ring"));
    }
    require_channel(&state.db, &ch, &auth.id, perms::CONNECT).await?;
    let ids: Vec<String> = channel_audience(&state.db, &ch).await.into_iter().filter(|u| u != &auth.id).collect();
    state.hub.send_users(&ids, "CALL_RING", &json!({ "channel_id": cid, "from": auth.id }));
    Ok(Json(json!({ "ok": true })))
}
