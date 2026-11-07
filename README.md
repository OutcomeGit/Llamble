# Llamble

A self-hosted Discord-style chat server for your clients. Rust server on TrueNAS, Windows desktop app (Electron), voice/video/screen share through a self-hosted LiveKit SFU, and an AI bot powered by llama.cpp.

```
llamble/
  server/        Rust (Axum + SQLite) — API, WebSocket gateway, files, link previews, GIF library, AI bot
  client/        Electron + React desktop app (the same UI is also served as a web app by the server)
  deploy/        TrueNAS compose YAML (self-contained)
  .github/       CI: builds the server image (GHCR) + Windows installer
  tests/         API smoke test, bot test, mock llama server
  Dockerfile     Builds the server image (web client + ffmpeg included)
```

## Features

- **Servers, channels, categories, roles and permissions** (16 permission bits, hoisted roles, colors), kicks and bans, nicknames, invites with expiry and max uses
- **Messages**: markdown (bold, italic, underline, strike, `code`, code blocks, quotes, headings, ||spoilers||, masked links), replies, edits, deletes, reactions, @mentions with autocomplete, `:emoji:` autocomplete, typing indicators, unread markers and mention badges, per-channel search, jump to message
- **Files**: drag-drop or paste, up to 10 per message, upload progress, spoilers, image grid and lightbox, inline video (seekable, with range requests and ffmpeg poster frames), audio player, file cards. Thumbnails are generated server-side.
- **Link previews**: OpenGraph cards, direct image/video/GIF links, YouTube (plays via youtube-nocookie only after you click). Previews and images go through an SSRF-safe, HMAC-signed proxy, so clients' IPs never reach outside sites.
- **GIFs**: a self-hosted, searchable GIF library with favorites. You can save any GIF from chat, or import from a Tenor/Giphy link (it's downloaded once). No GIF API is called at runtime.
- **Voice/video**: Discord-style voice channels, DM calls with ringing, camera, screen share (pick a screen or window, up to 1440p30 or 1080p60, with system audio on Windows), per-user volume, speaking rings, mute/deafen, global hotkeys (Ctrl+Shift+M / Ctrl+Shift+D), and device picker with mic test. Opus at 96 kbps by default (configurable up to 256).
- **Desktop**: tray, minimize to tray, notifications plus taskbar flash for DMs and mentions, unread count in the title, `llamble://invite/CODE@host` links, spellcheck menu, autostart option
- **AI bot** (see below)
- **Admin**: one-time admin invite on first boot, account invites, password resets, user deletion, device list. A janitor cleans orphaned uploads, stale cache and expired invites.

## The AI bot

Each server can turn the bot on under **Server Settings → AI Bot**, and give it a personality prompt there. It replies when:

- someone **@mentions** it (`@Llamble …`, which autocompletes in the composer)
- someone **replies** to one of its messages
- a message **starts with its name**: `llamble, …`, `hey llamble …`
- it's a **DM** with the bot (Home → "Chat with Llamble")
- the channel is marked **always-on** (it then answers every message)

It reads the last ~40 messages for context, shows a typing indicator, streams its reply live into the message, and hides `<think>` reasoning from models like Qwen3.

**Where it runs: a shared GPU pool.**

1. **Members' GPUs.** Anyone allowed can offer their graphics card from the desktop app (**User Settings → AI & GPU**, off until they accept a consent screen). The app runs `llama-server` pinned to that PC's best card. The server always uses the **best available GPU among everyone currently lending**:
   - A lender's PC only counts as *available* while its owner is **away** (no input for N minutes, or locked; on by default) and its GPU **isn't busy with something else**, like a game (over 30% use).
   - While paused, the app **unloads the model to free the VRAM**, and the server switches to the next-best GPU.
   - When the owner is idle again it reloads and rejoins. Logging off hands over immediately.
2. **The server itself.** The built-in model from setup is the fallback whenever no lent GPU is available.

**Admin switch:** **Settings → AI Model → GPU sharing** sets who may lend a GPU: *Off (server only)*, *Admins only* (default), or *Any member*. It also shows every lent GPU live: in use, standby, or paused and why.

**Privacy rule (built in):** a lent GPU only ever receives conversations from channels its owner can already read.

Recommended for your 4090: a Qwen3-14B or Gemma-3-27B class instruct GGUF at Q4_K_M with 16k context. Use the **CUDA** build of llama.cpp for Windows (from the llama.cpp GitHub releases). The NAS CPU fallback should use a small 3–4B Q4 model.

## Deploy on TrueNAS SCALE (Install via YAML)

GitHub Actions builds the server image (`ghcr.io/outcomegit/llamble:latest`, public) and the Windows installer on every push to `main`. TrueNAS pulls the image, so nothing is copied to the NAS and no registry login is needed.

1. **Apps → Discover Apps → ⋮ → Install via YAML.** Name it `llamble` and paste `deploy/truenas-compose.yaml` after replacing:
   - `NAS_IP`: your NAS's LAN IP
   - `SECRET`: one long random string, in both places
   Storage (`llamble-data`) is created automatically on your apps pool.
2. **Run setup:** open `http://NAS_IP:8090` in a browser, or enter that address in the Llamble app. A fresh server shows the setup wizard:
   - **Admin account:** creates the owner. Setup locks once it exists.
   - **First server name:** optional; the AI bot is switched on in it.
   - **AI model:** pick from the list (sizes and RAM needs shown) or paste any Hugging Face GGUF repo and choose a quantization. It downloads in the background with progress, then `llama-server` (bundled in the image) runs it on the NAS. Change it later under **Settings → AI Model**.
3. **Desktop app:** **https://github.com/OutcomeGit/Llamble/releases/latest/download/Llamble-Setup.exe**. It updates itself.

**Updating the server:** push to `main`, wait for the Actions build, then **Update** the app in TrueNAS (`pull_policy: always`). Models and data survive updates.

### Access from outside your house

- **Chat/API:** put Llamble behind HTTPS (Nginx Proxy Manager or Caddy on TrueNAS) at e.g. `https://chat.example.com` → `NAS:8090`. WebSockets must be allowed.
- **Voice:** forward **7881/tcp** and **50000–50100/udp** to the NAS, and set `node_ip` (in the compose file's LIVEKIT_CONFIG) to your public IP. Expose the 7880 signaling port as `wss://voice.example.com` through the same reverse proxy, and set `LIVEKIT_URL` to that.
- Cloudflare Tunnel works for chat but **not** for voice media (no UDP).

## Desktop app (Windows)

```sh
cd client
npm install
npm run dev        # dev mode (Vite + Electron)
npm run dist       # builds release/Llamble-Setup.exe locally (CI publishes releases automatically)
```

The installer registers the `llamble://` protocol, so invite links open the app.

## Server configuration (env)

| Var | Default | |
|---|---|---|
| `LLAMBLE_DATA` | `./data` | SQLite DB, files, thumbnails, proxy cache, secret key |
| `LLAMBLE_BIND` | `0.0.0.0:8080` | |
| `LLAMBLE_PUBLIC_URL` | — | informational |
| `LLAMBLE_MAX_UPLOAD_MB` | `500` | per file |
| `LLAMBLE_GUILD_CREATE` | `admin` | `all` = anyone can create servers |
| `LLAMBLE_UNFURL` | `1` | link previews on/off |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | — | voice off if unset |
| `LLAMBLE_LLAMA_URL` | — | optional: use an external llama-server instead of the built-in one |
| `HF_TOKEN` | — | optional: Hugging Face token for gated models |
| `LLAMBLE_BOT_NAME` | `Llamble` | |
| `LLAMBLE_BOT_WORKERS` | `admins` | default for who may lend a GPU (`off` / `admins` / `members`); admins change it in Settings |
| `LLAMBLE_BOT_MAX_TOKENS` | `1024` | |
| `LLAMBLE_WEB_DIR` | `/app/web` in Docker | also serves the web client at `/` |
| `LLAMBLE_BOOTSTRAP_INVITE` | random | fixed first admin invite code |

**Backups:** everything lives in the `llamble-data` volume (`llamble.db` is SQLite in WAL mode), which sits inside the apps pool's `ix-apps` dataset. Snapshot that dataset.

## Tests

```sh
cd server && cargo test                                       # unit tests
LLAMBLE_DATA=/tmp/p LLAMBLE_BIND=127.0.0.1:8099 ./target/release/llamble-server &
python3 tests/smoke.py http://127.0.0.1:8099 $(cat /tmp/p/ADMIN_INVITE.txt)   # full API flow
python3 tests/mock_llama.py & ; (restart server with LLAMBLE_LLAMA_URL=http://127.0.0.1:8098)
python3 tests/bot_test.py http://127.0.0.1:8099 <invite>      # bot: server backend, GPU worker, failover, DMs
```

## Not done yet / next ideas

- Per-channel permission overrides (only server-wide roles today)
- Message pins, threads, custom server emoji, link to a specific message
- Push notifications for phones (an Android app would reuse the web UI)
- Bot in voice channels (whisper.cpp in, TTS out)
- E2E encryption for DMs
