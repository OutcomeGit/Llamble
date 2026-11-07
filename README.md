# Parley

A self-hosted Discord-style chat server for your clients. Rust server on TrueNAS, Windows desktop app (Electron), voice/video/screen share through a self-hosted LiveKit SFU, and an AI bot powered by llama.cpp.

```
parley/
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
- **Desktop**: tray, minimize to tray, notifications plus taskbar flash for DMs and mentions, unread count in the title, `parley://invite/CODE@host` links, spellcheck menu, autostart option
- **AI bot** (see below)
- **Admin**: one-time admin invite on first boot, account invites, password resets, user deletion, device list. A janitor cleans orphaned uploads, stale cache and expired invites.

## The AI bot

Each server can turn the bot on under **Server Settings → AI Bot**, and give it a personality prompt there. It replies when:

- someone **@mentions** it (`@Parley …`, which autocompletes in the composer)
- someone **replies** to one of its messages
- a message **starts with its name**: `parley, …`, `hey parley …`
- it's a **DM** with the bot (Home → "Chat with Parley")
- the channel is marked **always-on** (it then answers every message)

It reads the last ~40 messages for context, shows a typing indicator, streams its reply live into the message, and hides `<think>` reasoning from models like Qwen3.

**Where it runs:**

1. **A lent GPU (preferred).** In the desktop app: **User Settings → AI & GPU**. It's off until you accept a consent screen. Parley detects GPUs with `nvidia-smi` (it falls back to WMI), picks the card with the most VRAM, and launches `llama-server` pinned to it with `CUDA_VISIBLE_DEVICES`. You can also point it at a llama-server you already run. The server sends bot jobs to that PC over the existing connection and streams tokens back.
2. **llama.cpp on the NAS (fallback).** The `llama` service in the compose file.

If several GPUs are lent, the least busy / largest one is used. If one disconnects mid-job, the bot fails over to the next GPU, then to the NAS.

**Privacy rule (built in):** a lent GPU only receives conversations from channels its owner can already read. By default only **instance admins** can lend a GPU (`PARLEY_BOT_WORKERS=admins`), so clients' chats run on your machine, not on another client's. Set it to `members` to let anyone lend.

Recommended for your 4090: a Qwen3-14B or Gemma-3-27B class instruct GGUF at Q4_K_M with 16k context. Use the **CUDA** build of llama.cpp for Windows (from the llama.cpp GitHub releases). The NAS CPU fallback should use a small 3–4B Q4 model.

## Deploy on TrueNAS SCALE (nothing to copy to the NAS)

GitHub Actions builds the server image (`ghcr.io/<you>/parley:latest`) and the Windows installer on every push. TrueNAS just pulls the image.

1. **Push this folder to a GitHub repo.** The `build` workflow runs automatically (Actions tab, ~6 minutes).
   - **Public repo:** the image is pullable as-is. Make the package public too: GitHub → your profile → Packages → parley → Package settings → Change visibility → Public.
   - **Private repo:** keep the package private, and in TrueNAS add a registry login (**Apps → Configuration → Manage Container Image Registries**). Use `ghcr.io`, your GitHub username, and a token with `read:packages`.
2. **Create one dataset:** Datasets → Add Dataset under your apps dataset, named `parley`, preset **Apps**.
3. **Edit `deploy/truenas-compose.yaml`:**
   - `OWNER` = your GitHub username, lowercase
   - your NAS IP (3 places)
   - one long random secret, in both places
   - your pool name
4. **Apps → Discover → ⋮ → Install via YAML**, then paste the file. LiveKit's config is inline, and llama.cpp downloads its model (Qwen3-4B Q4_K_M, ~2.5 GB) from Hugging Face on first start. Change the `-hf` line for a different model.
5. Open the **parley** container logs for the **one-time admin invite code**.
6. Install the desktop app. Download `Parley-Setup` from the Actions run (or from Releases, after you push a `v0.1.0` tag). Then register with server `http://NAS-IP:8090` and that code.

**Updating:** push to GitHub, wait for the build, then in TrueNAS click **Update** (or stop and start) on the app. `pull_policy: always` fetches the new image.

### Access from outside your house

- **Chat/API:** put Parley behind HTTPS (Nginx Proxy Manager or Caddy on TrueNAS) at e.g. `https://chat.example.com` → `NAS:8090`. WebSockets must be allowed.
- **Voice:** forward **7881/tcp** and **50000–50100/udp** to the NAS, and set `node_ip` (in the compose file's LIVEKIT_CONFIG) to your public IP. Expose the 7880 signaling port as `wss://voice.example.com` through the same reverse proxy, and set `LIVEKIT_URL` to that.
- Cloudflare Tunnel works for chat but **not** for voice media (no UDP).

## Desktop app (Windows)

```sh
cd client
npm install
npm run dev        # dev mode (Vite + Electron)
npm run dist       # builds release/Parley Setup x.y.z.exe
```

The installer registers the `parley://` protocol, so invite links open the app.

## Server configuration (env)

| Var | Default | |
|---|---|---|
| `PARLEY_DATA` | `./data` | SQLite DB, files, thumbnails, proxy cache, secret key |
| `PARLEY_BIND` | `0.0.0.0:8080` | |
| `PARLEY_PUBLIC_URL` | — | informational |
| `PARLEY_MAX_UPLOAD_MB` | `500` | per file |
| `PARLEY_GUILD_CREATE` | `admin` | `all` = anyone can create servers |
| `PARLEY_UNFURL` | `1` | link previews on/off |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | — | voice off if unset |
| `PARLEY_LLAMA_URL` | — | NAS llama.cpp fallback (OpenAI-compatible) |
| `PARLEY_BOT_NAME` | `Parley` | |
| `PARLEY_BOT_WORKERS` | `admins` | who may lend a GPU: `admins` / `members` |
| `PARLEY_BOT_MAX_TOKENS` | `1024` | |
| `PARLEY_WEB_DIR` | `/app/web` in Docker | also serves the web client at `/` |
| `PARLEY_BOOTSTRAP_INVITE` | random | fixed first admin invite code |

**Backups:** snapshot the `data` dataset. Everything lives there (`parley.db` is SQLite in WAL mode).

## Tests

```sh
cd server && cargo test                                       # unit tests
PARLEY_DATA=/tmp/p PARLEY_BIND=127.0.0.1:8099 ./target/release/parley-server &
python3 tests/smoke.py http://127.0.0.1:8099 $(cat /tmp/p/ADMIN_INVITE.txt)   # full API flow
python3 tests/mock_llama.py & ; (restart server with PARLEY_LLAMA_URL=http://127.0.0.1:8098)
python3 tests/bot_test.py http://127.0.0.1:8099 <invite>      # bot: server backend, GPU worker, failover, DMs
```

## Not done yet / next ideas

- Per-channel permission overrides (only server-wide roles today)
- Message pins, threads, custom server emoji, link to a specific message
- Push notifications for phones (an Android app would reuse the web UI)
- Bot in voice channels (whisper.cpp in, TTS out)
- E2E encryption for DMs
