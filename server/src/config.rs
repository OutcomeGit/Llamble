use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: String,
    pub data_dir: PathBuf,
    pub public_url: String,
    pub max_upload_bytes: u64,
    pub livekit_url: Option<String>,
    pub livekit_key: Option<String>,
    pub livekit_secret: Option<String>,
    /// "admin" (only instance admins can create guilds) or "all"
    pub guild_create: String,
    pub unfurl_links: bool,
    /// OpenAI-compatible llama.cpp server running next to Llamble (fallback backend)
    pub llama_url: Option<String>,
    pub bot_name: String,
    /// who may lend a GPU: "admins" (default) or "members"
    pub bot_workers: String,
    pub bot_max_tokens: i64,
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.trim().is_empty())
}

impl Config {
    pub fn from_env() -> Self {
        Config {
            bind: env("LLAMBLE_BIND").unwrap_or_else(|| "0.0.0.0:8080".into()),
            data_dir: PathBuf::from(env("LLAMBLE_DATA").unwrap_or_else(|| "./data".into())),
            public_url: env("LLAMBLE_PUBLIC_URL").unwrap_or_else(|| "http://localhost:8080".into()),
            max_upload_bytes: env("LLAMBLE_MAX_UPLOAD_MB")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(500)
                * 1024
                * 1024,
            livekit_url: env("LIVEKIT_URL"),
            livekit_key: env("LIVEKIT_API_KEY"),
            livekit_secret: env("LIVEKIT_API_SECRET"),
            guild_create: env("LLAMBLE_GUILD_CREATE").unwrap_or_else(|| "admin".into()),
            unfurl_links: env("LLAMBLE_UNFURL").map(|v| v != "0" && v != "false").unwrap_or(true),
            llama_url: env("LLAMBLE_LLAMA_URL").map(|u| u.trim_end_matches('/').to_string()),
            bot_name: env("LLAMBLE_BOT_NAME").unwrap_or_else(|| "Llamble".into()),
            bot_workers: env("LLAMBLE_BOT_WORKERS").unwrap_or_else(|| "admins".into()),
            bot_max_tokens: env("LLAMBLE_BOT_MAX_TOKENS").and_then(|v| v.parse().ok()).unwrap_or(1024),
        }
    }

    pub fn files_dir(&self) -> PathBuf {
        self.data_dir.join("files")
    }
    pub fn thumbs_dir(&self) -> PathBuf {
        self.data_dir.join("thumbs")
    }
    pub fn proxy_dir(&self) -> PathBuf {
        self.data_dir.join("proxy_cache")
    }
    pub fn voice_enabled(&self) -> bool {
        self.livekit_url.is_some() && self.livekit_key.is_some() && self.livekit_secret.is_some()
    }
}
