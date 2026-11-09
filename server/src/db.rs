use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;
use std::path::Path;
use std::str::FromStr;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_file_id TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_bot INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guilds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon_file_id TEXT,
    owner_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color INTEGER NOT NULL DEFAULT 0,
    permissions INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    hoist INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS members (
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname TEXT,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS member_roles (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (guild_id, user_id, role_id),
    FOREIGN KEY (guild_id, user_id) REFERENCES members(guild_id, user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bans (
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    parent_id TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_guild ON channels(guild_id);
CREATE TABLE IF NOT EXISTS dm_members (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    uploader_id TEXT NOT NULL REFERENCES users(id),
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    has_thumb INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL DEFAULT '',
    reply_to TEXT,
    embeds TEXT NOT NULL DEFAULT '[]',
    edited_at INTEGER,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
CREATE TABLE IF NOT EXISTS message_attachments (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id),
    position INTEGER NOT NULL DEFAULT 0,
    spoiler INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (message_id, file_id)
);
CREATE TABLE IF NOT EXISTS reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
    creator_id TEXT REFERENCES users(id),
    uses INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    grants_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gifs (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL REFERENCES files(id),
    title TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    uploader_id TEXT NOT NULL REFERENCES users(id),
    uses INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gif_favorites (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gif_id TEXT NOT NULL REFERENCES gifs(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, gif_id)
);
CREATE TABLE IF NOT EXISTS embed_cache (
    url TEXT PRIMARY KEY,
    data TEXT,
    fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_settings (
    guild_id TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,
    system_prompt TEXT NOT NULL DEFAULT '',
    always_channels TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS read_states (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id TEXT NOT NULL,
    PRIMARY KEY (user_id, channel_id)
);
"#;

pub async fn connect(data_dir: &Path) -> anyhow::Result<SqlitePool> {
    let path = data_dir.join("llamble.db");
    let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(10));
    let pool = SqlitePoolOptions::new().max_connections(8).connect_with(opts).await?;
    sqlx::raw_sql(SCHEMA).execute(&pool).await?;
    migrate(&pool).await?;
    Ok(pool)
}

async fn add_column(pool: &SqlitePool, table: &str, col: &str, def: &str) -> anyhow::Result<()> {
    let cols: Vec<String> = sqlx::query_scalar(&format!("SELECT name FROM pragma_table_info('{table}')")).fetch_all(pool).await?;
    if !cols.iter().any(|c| c == col) {
        sqlx::query(&format!("ALTER TABLE {table} ADD COLUMN {col} {def}")).execute(pool).await?;
    }
    Ok(())
}

/// Changes to existing installs. Each step is safe to run again.
async fn migrate(pool: &SqlitePool) -> anyhow::Result<()> {
    // account levels: master | admin | user  (is_admin stays in sync = master or admin)
    add_column(pool, "users", "instance_role", "TEXT NOT NULL DEFAULT 'user'").await?;
    add_column(pool, "users", "is_kid", "INTEGER NOT NULL DEFAULT 0").await?;
    add_column(pool, "users", "recovery_hash", "TEXT").await?;
    add_column(pool, "users", "email", "TEXT").await?;
    sqlx::query("UPDATE users SET instance_role = 'admin' WHERE is_admin = 1 AND instance_role = 'user' AND is_bot = 0").execute(pool).await?;
    let has_master: Option<i64> = sqlx::query_scalar("SELECT 1 FROM users WHERE instance_role = 'master'").fetch_optional(pool).await?;
    if has_master.is_none() {
        // the oldest admin is the one who set the server up
        sqlx::query("UPDATE users SET instance_role = 'master' WHERE id = (SELECT id FROM users WHERE is_admin = 1 AND is_bot = 0 ORDER BY created_at LIMIT 1)")
            .execute(pool)
            .await?;
    }
    // guest-style roles take permissions away
    add_column(pool, "roles", "deny", "INTEGER NOT NULL DEFAULT 0").await?;
    // auto-delete old messages per channel
    add_column(pool, "channels", "retention_days", "INTEGER").await?;
    // Home → highlights: auto-add AI pictures / finished recordings (per server)
    add_column(pool, "guilds", "highlights_auto_pictures", "INTEGER NOT NULL DEFAULT 1").await?;
    add_column(pool, "guilds", "highlights_auto_recordings", "INTEGER NOT NULL DEFAULT 1").await?;
    // news: instance "news writers"; per-person show/hide for Llamble news on Home
    add_column(pool, "users", "news_writer", "INTEGER NOT NULL DEFAULT 0").await?;
    add_column(pool, "users", "board_llamble_news", "INTEGER NOT NULL DEFAULT 1").await?;
    // "Add highlights" became a permission: give it once to everyone who already had it
    // (as an @everyone default), so nothing changes for existing servers
    let done: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'migr_add_highlights'").fetch_optional(pool).await.unwrap_or(None);
    if done.is_none() {
        sqlx::query("UPDATE roles SET permissions = permissions | ? WHERE id = guild_id").bind(crate::perms::ADD_HIGHLIGHTS).execute(pool).await?;
        sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('migr_add_highlights', '1')").execute(pool).await?;
    }
    // AI pictures are no longer auto-added to Highlights by default: switch it off once for
    // existing servers (admins can turn it back on; that choice then sticks)
    let done: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'migr_auto_pictures_off'").fetch_optional(pool).await.unwrap_or(None);
    if done.is_none() {
        sqlx::query("UPDATE guilds SET highlights_auto_pictures = 0").execute(pool).await?;
        sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('migr_auto_pictures_off', '1')").execute(pool).await?;
    }
    sqlx::raw_sql(
        r#"
CREATE TABLE IF NOT EXISTS guardians (
    kid_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guardian_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (kid_id, guardian_id)
);
CREATE INDEX IF NOT EXISTS idx_guardians_g ON guardians(guardian_id);
CREATE TABLE IF NOT EXISTS kid_settings (
    kid_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kid_contacts (
    kid_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (kid_id, user_id)
);
CREATE TABLE IF NOT EXISTS kid_requests (
    id TEXT PRIMARY KEY,
    kid_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,          -- dm | join
    target TEXT NOT NULL,        -- user id (dm) or guild id (join)
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    decided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_kid_requests ON kid_requests(kid_id, status);
CREATE TABLE IF NOT EXISTS reset_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | denied | done
    created_at INTEGER NOT NULL,
    decided_by TEXT
);
"#,
    )
    .execute(pool)
    .await?;
    Ok(())
}
