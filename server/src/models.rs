use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use std::collections::HashMap;

#[derive(Serialize, FromRow, Clone, Debug)]
pub struct UserPublic {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_file_id: Option<String>,
    #[sqlx(default)]
    pub is_admin: bool,
    #[sqlx(default)]
    pub is_bot: bool,
    /// master | admin | user
    #[sqlx(default)]
    pub instance_role: String,
    #[sqlx(default)]
    pub is_kid: bool,
}

#[derive(Serialize, FromRow, Clone, Debug)]
pub struct Guild {
    pub id: String,
    pub name: String,
    pub icon_file_id: Option<String>,
    pub owner_id: String,
    pub created_at: i64,
    /// Home → highlights: AI pictures drawn here are added automatically
    pub highlights_auto_pictures: bool,
    /// Home → highlights: finished show recordings are added automatically
    pub highlights_auto_recordings: bool,
}

pub const GUILD_COLS: &str = "id, name, icon_file_id, owner_id, created_at, highlights_auto_pictures, highlights_auto_recordings";

#[derive(Serialize, FromRow, Clone, Debug)]
pub struct Role {
    pub id: String,
    pub guild_id: String,
    pub name: String,
    pub color: i64,
    pub permissions: i64,
    pub position: i64,
    pub hoist: bool,
    /// permissions this role takes away (e.g. Guest: read and listen only)
    #[sqlx(default)]
    pub deny: i64,
}

#[derive(Serialize, FromRow, Clone, Debug)]
pub struct Channel {
    pub id: String,
    pub guild_id: Option<String>,
    pub kind: String,
    pub name: String,
    pub topic: String,
    pub parent_id: Option<String>,
    pub position: i64,
    pub created_at: i64,
    #[sqlx(default)]
    pub last_message_id: Option<String>,
    /// messages older than this many days are deleted automatically
    #[sqlx(default)]
    pub retention_days: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Member {
    pub guild_id: String,
    pub user: UserPublic,
    pub nickname: Option<String>,
    pub roles: Vec<String>,
    pub joined_at: i64,
}

#[derive(Serialize, FromRow, Clone, Debug)]
pub struct FileRow {
    pub id: String,
    pub uploader_id: String,
    pub filename: String,
    pub mime: String,
    pub size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub has_thumb: bool,
    pub created_at: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct FileObj {
    pub id: String,
    pub filename: String,
    pub mime: String,
    pub size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub url: String,
    pub thumb_url: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub spoiler: bool,
}

impl From<&FileRow> for FileObj {
    fn from(f: &FileRow) -> Self {
        FileObj {
            id: f.id.clone(),
            filename: f.filename.clone(),
            mime: f.mime.clone(),
            size: f.size,
            width: f.width,
            height: f.height,
            url: format!("/api/files/{}/{}", f.id, urlencode(&f.filename)),
            thumb_url: if f.has_thumb { Some(format!("/api/thumbs/{}", f.id)) } else { None },
            spoiler: false,
        }
    }
}

pub fn urlencode(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

#[derive(Serialize, Clone, Debug)]
pub struct ReactionGroup {
    pub emoji: String,
    pub users: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ReplyPreview {
    pub id: String,
    pub author_id: String,
    pub content: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Message {
    pub id: String,
    pub channel_id: String,
    pub author: UserPublic,
    pub content: String,
    pub reply_to: Option<ReplyPreview>,
    pub attachments: Vec<FileObj>,
    pub embeds: serde_json::Value,
    pub reactions: Vec<ReactionGroup>,
    pub edited_at: Option<i64>,
    pub created_at: i64,
}

#[derive(FromRow, Clone, Debug)]
pub struct MessageRow {
    pub id: String,
    pub channel_id: String,
    pub author_id: String,
    pub content: String,
    pub reply_to: Option<String>,
    pub embeds: String,
    pub edited_at: Option<i64>,
    pub created_at: i64,
}

pub const USER_COLS: &str = "id, username, display_name, avatar_file_id, is_admin, is_bot, instance_role, is_kid";

pub async fn load_users(pool: &SqlitePool, ids: &[String]) -> sqlx::Result<HashMap<String, UserPublic>> {
    let mut out = HashMap::new();
    for chunk in ids.chunks(200) {
        if chunk.is_empty() {
            continue;
        }
        let q = format!(
            "SELECT {USER_COLS} FROM users WHERE id IN ({})",
            vec!["?"; chunk.len()].join(",")
        );
        let mut qq = sqlx::query_as::<_, UserPublic>(&q);
        for id in chunk {
            qq = qq.bind(id);
        }
        for u in qq.fetch_all(pool).await? {
            out.insert(u.id.clone(), u);
        }
    }
    Ok(out)
}

pub async fn get_user(pool: &SqlitePool, id: &str) -> sqlx::Result<UserPublic> {
    sqlx::query_as::<_, UserPublic>(&format!("SELECT {USER_COLS} FROM users WHERE id = ?"))
        .bind(id)
        .fetch_one(pool)
        .await
}

pub async fn get_file(pool: &SqlitePool, id: &str) -> sqlx::Result<FileRow> {
    sqlx::query_as::<_, FileRow>(
        "SELECT id, uploader_id, filename, mime, size, width, height, has_thumb, created_at FROM files WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

/// Turn message rows into full message objects (authors, attachments, reactions, reply previews).
pub async fn hydrate_messages(pool: &SqlitePool, rows: Vec<MessageRow>) -> sqlx::Result<Vec<Message>> {
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    let ph = placeholders(ids.len());

    // attachments
    let q = format!(
        "SELECT ma.message_id, ma.spoiler, f.id, f.uploader_id, f.filename, f.mime, f.size, f.width, f.height, f.has_thumb, f.created_at
         FROM message_attachments ma JOIN files f ON f.id = ma.file_id
         WHERE ma.message_id IN ({ph}) ORDER BY ma.position"
    );
    let mut qq = sqlx::query_as::<_, (String, bool, String, String, String, String, i64, Option<i64>, Option<i64>, bool, i64)>(&q);
    for id in &ids {
        qq = qq.bind(id);
    }
    let mut atts: HashMap<String, Vec<FileObj>> = HashMap::new();
    for (mid, spoiler, id, uploader_id, filename, mime, size, width, height, has_thumb, created_at) in qq.fetch_all(pool).await? {
        let row = FileRow { id, uploader_id, filename, mime, size, width, height, has_thumb, created_at };
        let mut fo = FileObj::from(&row);
        fo.spoiler = spoiler;
        atts.entry(mid).or_default().push(fo);
    }

    // reactions
    let q = format!(
        "SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN ({ph}) ORDER BY created_at"
    );
    let mut qq = sqlx::query_as::<_, (String, String, String)>(&q);
    for id in &ids {
        qq = qq.bind(id);
    }
    let mut reacts: HashMap<String, Vec<ReactionGroup>> = HashMap::new();
    for (mid, emoji, uid) in qq.fetch_all(pool).await? {
        let groups = reacts.entry(mid).or_default();
        if let Some(g) = groups.iter_mut().find(|g| g.emoji == emoji) {
            g.users.push(uid);
        } else {
            groups.push(ReactionGroup { emoji, users: vec![uid] });
        }
    }

    // reply previews
    let reply_ids: Vec<String> = rows.iter().filter_map(|r| r.reply_to.clone()).collect();
    let mut replies: HashMap<String, ReplyPreview> = HashMap::new();
    if !reply_ids.is_empty() {
        let q = format!(
            "SELECT id, author_id, content FROM messages WHERE id IN ({})",
            placeholders(reply_ids.len())
        );
        let mut qq = sqlx::query_as::<_, (String, String, String)>(&q);
        for id in &reply_ids {
            qq = qq.bind(id);
        }
        for (id, author_id, content) in qq.fetch_all(pool).await? {
            let content: String = content.chars().take(140).collect();
            replies.insert(id.clone(), ReplyPreview { id, author_id, content });
        }
    }

    let mut author_ids: Vec<String> = rows.iter().map(|r| r.author_id.clone()).collect();
    author_ids.sort();
    author_ids.dedup();
    let users = load_users(pool, &author_ids).await?;

    Ok(rows
        .into_iter()
        .map(|r| {
            let author = users.get(&r.author_id).cloned().unwrap_or(UserPublic {
                id: r.author_id.clone(),
                username: "deleted".into(),
                display_name: "Deleted User".into(),
                avatar_file_id: None,
                is_admin: false,
                is_bot: false,
                instance_role: "user".into(),
                is_kid: false,
            });
            Message {
                reply_to: r.reply_to.as_ref().and_then(|id| replies.get(id).cloned()).or_else(|| {
                    r.reply_to.as_ref().map(|id| ReplyPreview {
                        id: id.clone(),
                        author_id: String::new(),
                        content: String::new(),
                    })
                }),
                attachments: atts.remove(&r.id).unwrap_or_default(),
                reactions: reacts.remove(&r.id).unwrap_or_default(),
                embeds: serde_json::from_str(&r.embeds).unwrap_or(serde_json::json!([])),
                id: r.id,
                channel_id: r.channel_id,
                author,
                content: r.content,
                edited_at: r.edited_at,
                created_at: r.created_at,
            }
        })
        .collect())
}

pub const MSG_COLS: &str = "id, channel_id, author_id, content, reply_to, embeds, edited_at, created_at";

pub async fn load_message(pool: &SqlitePool, id: &str) -> sqlx::Result<Message> {
    let row = sqlx::query_as::<_, MessageRow>(&format!("SELECT {MSG_COLS} FROM messages WHERE id = ?"))
        .bind(id)
        .fetch_one(pool)
        .await?;
    Ok(hydrate_messages(pool, vec![row]).await?.remove(0))
}

pub async fn load_members(pool: &SqlitePool, guild_id: &str) -> sqlx::Result<Vec<Member>> {
    let rows = sqlx::query_as::<_, (String, String, String, Option<String>, bool, bool, Option<String>, i64, String, bool)>(
        "SELECT u.id, u.username, u.display_name, u.avatar_file_id, u.is_admin, u.is_bot, m.nickname, m.joined_at, u.instance_role, u.is_kid
         FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ?",
    )
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    let roles = sqlx::query_as::<_, (String, String)>(
        "SELECT user_id, role_id FROM member_roles WHERE guild_id = ?",
    )
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    let mut rmap: HashMap<String, Vec<String>> = HashMap::new();
    for (u, r) in roles {
        rmap.entry(u).or_default().push(r);
    }
    Ok(rows
        .into_iter()
        .map(|(id, username, display_name, avatar_file_id, is_admin, is_bot, nickname, joined_at, instance_role, is_kid)| Member {
            guild_id: guild_id.to_string(),
            roles: rmap.remove(&id).unwrap_or_default(),
            user: UserPublic { id, username, display_name, avatar_file_id, is_admin, is_bot, instance_role, is_kid },
            nickname,
            joined_at,
        })
        .collect())
}

pub async fn load_member(pool: &SqlitePool, guild_id: &str, user_id: &str) -> sqlx::Result<Member> {
    let (nickname, joined_at) = sqlx::query_as::<_, (Option<String>, i64)>(
        "SELECT nickname, joined_at FROM members WHERE guild_id = ? AND user_id = ?",
    )
    .bind(guild_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    let roles = sqlx::query_scalar::<_, String>(
        "SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?",
    )
    .bind(guild_id)
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(Member {
        guild_id: guild_id.into(),
        user: get_user(pool, user_id).await?,
        nickname,
        roles,
        joined_at,
    })
}

pub const CHANNEL_COLS: &str = "c.id, c.guild_id, c.kind, c.name, c.topic, c.parent_id, c.position, c.created_at, c.retention_days,
    (SELECT MAX(m.id) FROM messages m WHERE m.channel_id = c.id) AS last_message_id";

pub async fn load_channel(pool: &SqlitePool, id: &str) -> sqlx::Result<Channel> {
    sqlx::query_as::<_, Channel>(&format!("SELECT {CHANNEL_COLS} FROM channels c WHERE c.id = ?"))
        .bind(id)
        .fetch_one(pool)
        .await
}

pub async fn load_roles(pool: &SqlitePool, guild_id: &str) -> sqlx::Result<Vec<Role>> {
    sqlx::query_as::<_, Role>(
        "SELECT id, guild_id, name, color, permissions, position, hoist, deny FROM roles WHERE guild_id = ? ORDER BY position",
    )
    .bind(guild_id)
    .fetch_all(pool)
    .await
}

pub async fn load_channels(pool: &SqlitePool, guild_id: &str) -> sqlx::Result<Vec<Channel>> {
    sqlx::query_as::<_, Channel>(&format!("SELECT {CHANNEL_COLS} FROM channels c WHERE c.guild_id = ? ORDER BY c.position, c.created_at"))
        .bind(guild_id)
        .fetch_all(pool)
        .await
}
