use crate::error::{ApiResult, AppError};
use crate::models::Channel;
use sqlx::SqlitePool;

pub const VIEW: i64 = 1 << 0;
pub const SEND: i64 = 1 << 1;
pub const ATTACH: i64 = 1 << 2;
pub const EMBED_LINKS: i64 = 1 << 3;
pub const REACT: i64 = 1 << 4;
pub const MANAGE_MESSAGES: i64 = 1 << 5;
pub const MANAGE_CHANNELS: i64 = 1 << 6;
pub const MANAGE_ROLES: i64 = 1 << 7;
pub const MANAGE_GUILD: i64 = 1 << 8;
pub const CREATE_INVITE: i64 = 1 << 9;
pub const KICK: i64 = 1 << 10;
pub const BAN: i64 = 1 << 11;
pub const CONNECT: i64 = 1 << 12;
pub const SPEAK: i64 = 1 << 13;
pub const VIDEO: i64 = 1 << 14;
pub const MENTION_EVERYONE: i64 = 1 << 15;
/// post news on the server's board ("news people")
pub const POST_NEWS: i64 = 1 << 16;
/// add messages and recordings to the server's Highlights
pub const ADD_HIGHLIGHTS: i64 = 1 << 17;
pub const ADMINISTRATOR: i64 = 1 << 30;
pub const ALL: i64 = (1 << 31) - 1;

pub const DEFAULT_EVERYONE: i64 =
    VIEW | SEND | ATTACH | EMBED_LINKS | REACT | CREATE_INVITE | CONNECT | SPEAK | VIDEO | ADD_HIGHLIGHTS;

/// Effective guild-level permissions for a user. Returns 0 if not a member.
pub async fn guild_perms(pool: &SqlitePool, guild_id: &str, user_id: &str) -> ApiResult<i64> {
    let owner: Option<String> = sqlx::query_scalar("SELECT owner_id FROM guilds WHERE id = ?")
        .bind(guild_id)
        .fetch_optional(pool)
        .await?;
    let Some(owner) = owner else { return Err(AppError::not_found()) };
    if owner == user_id {
        return Ok(ALL);
    }
    let is_member: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM members WHERE guild_id = ? AND user_id = ?")
            .bind(guild_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    if is_member.is_none() {
        return Ok(0);
    }
    // @everyone role has id == guild id
    let everyone: i64 = sqlx::query_scalar("SELECT permissions FROM roles WHERE id = ?")
        .bind(guild_id)
        .fetch_optional(pool)
        .await?
        .unwrap_or(DEFAULT_EVERYONE);
    let extra: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT r.permissions, r.deny FROM member_roles mr JOIN roles r ON r.id = mr.role_id
         WHERE mr.guild_id = ? AND mr.user_id = ?",
    )
    .bind(guild_id)
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    let p = extra.iter().fold(everyone, |a, (b, _)| a | b);
    if p & ADMINISTRATOR != 0 {
        return Ok(ALL);
    }
    // Guest-style roles take things away (viewing always stays)
    let deny = extra.iter().fold(0, |a, (_, d)| a | d) & !VIEW;
    Ok(p & !deny)
}

pub async fn require_guild(pool: &SqlitePool, guild_id: &str, user_id: &str, need: i64) -> ApiResult<i64> {
    let p = guild_perms(pool, guild_id, user_id).await?;
    if p & VIEW == 0 {
        return Err(AppError::not_found());
    }
    if p & need != need {
        return Err(AppError::forbidden());
    }
    Ok(p)
}

/// Permissions in a channel (guild channel or DM). DMs grant normal chat perms to participants.
pub async fn channel_perms(pool: &SqlitePool, ch: &Channel, user_id: &str) -> ApiResult<i64> {
    match &ch.guild_id {
        Some(g) => guild_perms(pool, g, user_id).await,
        None => {
            let ok: Option<i64> =
                sqlx::query_scalar("SELECT 1 FROM dm_members WHERE channel_id = ? AND user_id = ?")
                    .bind(&ch.id)
                    .bind(user_id)
                    .fetch_optional(pool)
                    .await?;
            Ok(if ok.is_some() {
                VIEW | SEND | ATTACH | EMBED_LINKS | REACT | CONNECT | SPEAK | VIDEO
            } else {
                0
            })
        }
    }
}

pub async fn require_channel(pool: &SqlitePool, ch: &Channel, user_id: &str, need: i64) -> ApiResult<i64> {
    let p = channel_perms(pool, ch, user_id).await?;
    if p & VIEW == 0 {
        return Err(AppError::not_found());
    }
    if p & need != need {
        return Err(AppError::forbidden());
    }
    Ok(p)
}
