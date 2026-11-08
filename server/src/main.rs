mod ai;
mod api;
mod bot;
mod config;
mod db;
mod email;
mod error;
mod gateway;
mod images;
mod kids;
mod models;
mod perms;
mod relay;
mod remote;
mod settings;
mod shows;
mod soundboard;
mod state;
mod voice_server;
mod tools;
mod voicebot;

use crate::error::{invite_code, now_ms};
use crate::state::{AppState, Hub, Shared};
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "llamble_server=info,tower_http=warn".into()),
        )
        .init();

    if std::env::args().nth(1).as_deref() == Some("relay") {
        let _ = rustls::crypto::ring::default_provider().install_default();
        return relay::run_relay_server().await;
    }
    let cfg = config::Config::from_env();
    for d in [cfg.data_dir.clone(), cfg.files_dir(), cfg.thumbs_dir(), cfg.proxy_dir()] {
        std::fs::create_dir_all(&d)?;
    }
    let pool = db::connect(&cfg.data_dir).await?;

    // recovery from the container's shell (TrueNAS: Apps → llamble → Shell):
    //   llamble-server reset-password            lists accounts
    //   llamble-server reset-password <username> sets a temporary password
    if std::env::args().nth(1).as_deref() == Some("reset-password") {
        return reset_password_cli(&pool, std::env::args().nth(2)).await;
    }

    let secret_path = cfg.data_dir.join("secret.key");
    let secret = match std::fs::read(&secret_path) {
        Ok(s) if s.len() >= 32 => s,
        _ => {
            use rand::RngCore;
            let mut s = vec![0u8; 32];
            rand::thread_rng().fill_bytes(&mut s);
            std::fs::write(&secret_path, &s)?;
            s
        }
    };

    let bot_id = bot::ensure_bot_user(&pool, &cfg.bot_name).await?;
    let state: Shared = Arc::new(AppState {
        db: pool,
        cfg: cfg.clone(),
        hub: Hub::default(),
        secret,
        bot_id,
        bot: bot::BotRuntime::default(),
        ai: ai::AiManager::default(),
        remote: remote::Remote::default(),
        voice: voice_server::VoiceServer::default(),
        settings: std::sync::RwLock::new(settings::ServerSettings::defaults(&cfg)),
        login_guard: Default::default(),
    });

    shows::migrate(&state.db).await?;
    soundboard::migrate(&state.db).await?;
    voicebot::migrate(&state.db).await?;
    settings::load_into_cache(&state).await;
    // once: give servers made before role presets existed the standard roles
    let done: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'presets_v1'").fetch_optional(&state.db).await?;
    if done.is_none() {
        let gids: Vec<String> = sqlx::query_scalar("SELECT id FROM guilds").fetch_all(&state.db).await?;
        for g in gids {
            let _ = api::guilds::add_preset_roles(&state, &g).await;
        }
        sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('presets_v1', '1')").execute(&state.db).await?;
    }
    bootstrap(&state).await?;
    tokio::spawn(janitor(state.clone()));
    tokio::spawn(ai::boot(state.clone()));
    voicebot::boot(state.clone());
    images::boot(state.clone());

    let mut app = api::router(state.clone());
    if let Ok(web) = std::env::var("LLAMBLE_WEB_DIR") {
        let index = std::path::Path::new(&web).join("index.html");
        if index.exists() {
            tracing::info!("serving web client from {web}");
            app = app.fallback_service(ServeDir::new(&web).fallback(ServeFile::new(index)));
        }
    }
    let app = app
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());
    remote::init(state.clone(), app.clone());
    voice_server::refresh(state.clone());

    tracing::info!(
        "Llamble listening on {} (public url {}, voice {}, server llama {})",
        cfg.bind,
        cfg.public_url,
        if voice_server::enabled(&state) { "enabled" } else { "disabled" },
        cfg.llama_url.as_deref().unwrap_or("built-in")
    );
    let listener = tokio::net::TcpListener::bind(&cfg.bind).await?;
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).with_graceful_shutdown(shutdown()).await?;
    Ok(())
}

async fn shutdown() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
        tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    let _ = ctrl_c.await;
}

async fn reset_password_cli(pool: &sqlx::SqlitePool, username: Option<String>) -> anyhow::Result<()> {
    let Some(name) = username else {
        let rows: Vec<(String, bool)> = sqlx::query_as("SELECT username, is_admin FROM users WHERE is_bot = 0 ORDER BY is_admin DESC, username").fetch_all(pool).await?;
        println!("Accounts on this server:");
        for (u, admin) in rows {
            println!("  {u}{}", if admin { "  (admin)" } else { "" });
        }
        println!("\nTo set a new temporary password:  llamble-server reset-password <username>");
        return Ok(());
    };
    let id: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE username = ? AND is_bot = 0").bind(&name).fetch_optional(pool).await?;
    let Some(id) = id else {
        anyhow::bail!("no account named {name:?}. Run `llamble-server reset-password` to list them.");
    };
    let temp = error::random_token(9);
    let hash = api::auth::hash_password(temp.clone()).await.map_err(|e| anyhow::anyhow!("{}", e.1))?;
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash).bind(&id).execute(pool).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?").bind(&id).execute(pool).await?;
    println!("\nNew temporary password for {name}:  {temp}\n");
    println!("Sign in with it, then change it in Settings → My Account.");
    println!("(Every device signed in as {name} has been signed out.)");
    Ok(())
}

/// On a fresh install, create a one-time admin invite so the owner can sign up.
async fn bootstrap(state: &Shared) -> anyhow::Result<()> {
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE is_bot = 0").fetch_one(&state.db).await?;
    if users > 0 {
        return Ok(());
    }
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT code FROM invites WHERE grants_admin = 1 AND guild_id IS NULL AND uses = 0 LIMIT 1",
    )
    .fetch_optional(&state.db)
    .await?;
    let code = match existing {
        Some(c) => c,
        None => {
            let c = std::env::var("LLAMBLE_BOOTSTRAP_INVITE").ok().filter(|s| s.len() >= 6).unwrap_or_else(invite_code);
            sqlx::query("INSERT INTO invites (code, guild_id, creator_id, max_uses, grants_admin, created_at) VALUES (?, NULL, NULL, 1, 1, ?)")
                .bind(&c)
                .bind(now_ms())
                .execute(&state.db)
                .await?;
            c
        }
    };
    std::fs::write(state.cfg.data_dir.join("ADMIN_INVITE.txt"), format!("{code}\n"))?;
    tracing::warn!("================================================================");
    tracing::warn!(" No accounts yet. Open {} in a browser or the Llamble app to run setup,", state.cfg.public_url);
    tracing::warn!(" or register with this one-time admin invite code:");
    tracing::warn!("     {code}");
    tracing::warn!(" (also saved to {}/ADMIN_INVITE.txt)", state.cfg.data_dir.display());
    tracing::warn!("================================================================");
    Ok(())
}

/// Periodic cleanup: orphaned uploads, stale proxy cache, expired invites, old sessions.
async fn janitor(state: Shared) {
    let mut tick = tokio::time::interval(Duration::from_secs(3600));
    loop {
        tick.tick().await;
        let day = 24 * 3600 * 1000;
        let cutoff = now_ms() - day;
        let orphans: Vec<String> = sqlx::query_scalar(
            "SELECT f.id FROM files f WHERE f.created_at < ?
             AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.file_id = f.id)
             AND NOT EXISTS (SELECT 1 FROM gifs g WHERE g.file_id = f.id)
             AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = f.id)
             AND NOT EXISTS (SELECT 1 FROM guilds g2 WHERE g2.icon_file_id = f.id)
             AND NOT EXISTS (SELECT 1 FROM sounds s WHERE s.file_id = f.id)",
        )
        .bind(cutoff)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
        for id in &orphans {
            let _ = tokio::fs::remove_file(api::files::file_path(&state, id)).await;
            let _ = tokio::fs::remove_file(api::files::thumb_path(&state, id)).await;
            let _ = sqlx::query("DELETE FROM files WHERE id = ?").bind(id).execute(&state.db).await;
        }
        if !orphans.is_empty() {
            tracing::info!("janitor: removed {} orphaned uploads", orphans.len());
        }
        let _ = sqlx::query("DELETE FROM invites WHERE expires_at IS NOT NULL AND expires_at < ?").bind(now_ms()).execute(&state.db).await;
        let removed = api::messages::apply_retention(&state).await;
        if removed > 0 {
            tracing::info!("auto-delete: removed {removed} old messages");
        }
        let _ = sqlx::query("DELETE FROM sessions WHERE last_seen < ?").bind(now_ms() - 90 * day).execute(&state.db).await;
        let _ = sqlx::query("DELETE FROM embed_cache WHERE fetched_at < ?").bind(now_ms() - 7 * day).execute(&state.db).await;
        if let Ok(mut rd) = tokio::fs::read_dir(state.cfg.proxy_dir()).await {
            while let Ok(Some(e)) = rd.next_entry().await {
                if let Ok(m) = e.metadata().await {
                    if m.modified().ok().and_then(|t| t.elapsed().ok()).map(|d| d > Duration::from_secs(7 * 86400)).unwrap_or(false) {
                        let _ = tokio::fs::remove_file(e.path()).await;
                    }
                }
            }
        }
    }
}
