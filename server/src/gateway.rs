use crate::api::guilds::guild_payload;
use crate::api::messages::dm_payload;
use crate::models::get_user;
use crate::state::{auth_token, AuthUser, Shared};
use axum::extract::ws::{Message as WsMsg, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

#[derive(Deserialize)]
pub struct GwQ {
    pub access_token: Option<String>,
}

pub async fn upgrade(State(state): State<Shared>, Query(q): Query<GwQ>, ws: WebSocketUpgrade) -> Result<Response, crate::error::AppError> {
    let token = q.access_token.ok_or_else(crate::error::AppError::unauthorized)?;
    let auth = auth_token(&state, &token).await?;
    Ok(ws.max_message_size(64 * 1024).on_upgrade(move |sock| session(state, auth, sock)))
}

async fn ready_payload(state: &Shared, auth: &AuthUser) -> anyhow::Result<Value> {
    let user = get_user(&state.db, &auth.id).await?;
    let gids: Vec<String> = sqlx::query_scalar("SELECT guild_id FROM members WHERE user_id = ? ORDER BY joined_at")
        .bind(&auth.id)
        .fetch_all(&state.db)
        .await?;
    let mut guilds = vec![];
    for g in &gids {
        if let Ok(p) = guild_payload(state, g).await {
            guilds.push(p);
        }
    }
    let dm_ids: Vec<String> = sqlx::query_scalar("SELECT channel_id FROM dm_members WHERE user_id = ?")
        .bind(&auth.id)
        .fetch_all(&state.db)
        .await?;
    let mut dms = vec![];
    for c in &dm_ids {
        if let Ok(p) = dm_payload(state, c).await {
            dms.push(p);
        }
    }
    let reads: Vec<(String, String)> = sqlx::query_as("SELECT channel_id, last_read_id FROM read_states WHERE user_id = ?")
        .bind(&auth.id)
        .fetch_all(&state.db)
        .await?;
    let related = state.related_users(&auth.id).await;
    let presences: Vec<Value> = related
        .iter()
        .filter(|u| state.hub.is_online(u) && status_of(state, u) != "invisible")
        .map(|u| json!({ "user_id": u, "status": status_of(state, u) }))
        .collect();
    let voice: Vec<Value> = state
        .hub
        .voice
        .iter()
        .filter(|v| match &v.guild_id {
            Some(g) => gids.contains(g),
            None => dm_ids.contains(&v.channel_id),
        })
        .map(|v| serde_json::to_value(v.value()).unwrap())
        .collect();
    Ok(json!({
        "user": user,
        "guilds": guilds,
        "dms": dms,
        "read_states": reads.into_iter().map(|(c, m)| json!({ "channel_id": c, "last_read_id": m })).collect::<Vec<_>>(),
        "presences": presences,
        "voice_states": voice,
        "config": {
            "voice_enabled": state.cfg.voice_enabled(),
            "max_upload_bytes": state.cfg.max_upload_bytes,
            "guild_create": state.cfg.guild_create,
            "bot": { "id": state.bot_id, "name": state.cfg.bot_name, "server_backend": state.cfg.llama_url.is_some(), "worker_policy": state.cfg.bot_workers },
        }
    }))
}

static STATUSES: once_cell::sync::Lazy<dashmap::DashMap<String, String>> = once_cell::sync::Lazy::new(Default::default);

fn status_of(_state: &Shared, uid: &str) -> String {
    STATUSES.get(uid).map(|s| s.clone()).unwrap_or_else(|| "online".into())
}

async fn session(state: Shared, auth: AuthUser, sock: WebSocket) {
    let (mut sink, mut stream) = sock.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let ready = match ready_payload(&state, &auth).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("ready failed: {e:#}");
            let _ = sink.close().await;
            return;
        }
    };
    if sink.send(WsMsg::Text(json!({ "t": "READY", "d": ready }).to_string().into())).await.is_err() {
        return;
    }
    let worker_tx = tx.clone();
    let (conn_id, first) = state.hub.register(&auth.id, tx);
    if first {
        let status = status_of(&state, &auth.id);
        state.emit_related(&auth.id, "PRESENCE_UPDATE", &json!({ "user_id": auth.id, "status": status })).await;
    }

    let mut last_seen = Instant::now();
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(text) => if sink.send(WsMsg::Text(text.into())).await.is_err() { break },
                None => break, // kicked
            },
            inc = stream.next() => match inc {
                Some(Ok(WsMsg::Text(t))) => {
                    last_seen = Instant::now();
                    if let Ok(v) = serde_json::from_str::<Value>(&t) {
                        match v["op"].as_str() {
                            Some("ping") => { let _ = sink.send(WsMsg::Text(json!({"t":"PONG"}).to_string().into())).await; }
                            Some("presence") => {
                                let st = v["status"].as_str().unwrap_or("online");
                                if ["online", "idle", "dnd", "invisible"].contains(&st) {
                                    STATUSES.insert(auth.id.clone(), st.to_string());
                                    let shown = if st == "invisible" { "offline" } else { st };
                                    state.emit_related(&auth.id, "PRESENCE_UPDATE", &json!({ "user_id": auth.id, "status": shown })).await;
                                }
                            }
                            Some("worker_register") => {
                                if crate::bot::worker_eligible(&state, &auth.id).await {
                                    state.bot.workers.insert(conn_id, crate::bot::Worker {
                                        user_id: auth.id.clone(),
                                        tx: worker_tx.clone(),
                                        gpu: v["gpu"].as_str().unwrap_or("GPU").chars().take(80).collect(),
                                        vram_mb: v["vram_mb"].as_i64().unwrap_or(0),
                                        model: v["model"].as_str().unwrap_or("").chars().take(120).collect(),
                                        active: 0,
                                    });
                                    let _ = sink.send(WsMsg::Text(json!({"t":"WORKER_ACCEPTED","d":{}}).to_string().into())).await;
                                    tracing::info!("GPU worker online: {} ({})", auth.id, v["gpu"]);
                                } else {
                                    let _ = sink.send(WsMsg::Text(json!({"t":"WORKER_REJECTED","d":{"reason":"Only server admins can lend a GPU on this server."}}).to_string().into())).await;
                                }
                            }
                            Some("worker_unregister") => crate::bot::worker_gone(&state, conn_id),
                            Some("job_chunk") | Some("job_done") | Some("job_error") => crate::bot::job_event(&state, conn_id, &v),
                            _ => {}
                        }
                    }
                }
                Some(Ok(WsMsg::Pong(_))) | Some(Ok(WsMsg::Ping(_))) => last_seen = Instant::now(),
                Some(Ok(WsMsg::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            _ = ping.tick() => {
                if last_seen.elapsed() > Duration::from_secs(90) { break; }
                if sink.send(WsMsg::Ping(Vec::new().into())).await.is_err() { break; }
            }
        }
    }

    crate::bot::worker_gone(&state, conn_id);
    if state.hub.unregister(&auth.id, conn_id) {
        // grace period so a quick reconnect doesn't flap presence / drop voice
        let st = state.clone();
        let uid = auth.id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(8)).await;
            if !st.hub.is_online(&uid) {
                crate::api::voice::leave_voice(&st, &uid).await;
                st.emit_related(&uid, "PRESENCE_UPDATE", &json!({ "user_id": uid, "status": "offline" })).await;
            }
        });
    }
}
