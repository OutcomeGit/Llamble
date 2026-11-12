# Llamble Games: SDK, packages and sessions

Status: proposed design, Nov 9. It covers how games are packaged, how they run inside Llamble, how players in a session talk to each other, and how this ties into kid accounts, seats and the store (see ROADMAP → "Store and purchases").

The first title will be **Page Terrace Shuffleboard**, a Three.js browser game. It already runs its whole game room inside the host's browser, so it needs no game code on the Llamble server.

---

## 1. Principles

1. **Games run on the players' devices, never on the instance.** The instance stores the game files, starts sessions and relays messages. It runs no game code, so a NAS can host any number of games.
2. **One SDK for every engine.** Web games, Godot web exports and (later) native Windows games all use the same messages.
3. **Walled off by default.** A game sees only what it declares in its manifest and what the person allows. It never gets session tokens, emails, other servers, or real user IDs.
4. **The app does the trusted work, not the game.** Seat check-ins, kid rules, permissions and result posts are all done by the Llamble client. A game can't fake them.
5. **Nothing points at llamble.com.** An instance with no store link can still install and play free games from a package file.

## 2. Three tiers of games

| Tier | Example | How it runs | Notes |
|---|---|---|---|
| **Web** | Page Terrace, trivia, chess, drawing | Sandboxed frame inside the app/webapp | Small and instant. Works on phones and Chromebooks. |
| **Godot web export** | mid-size Godot titles | Same sandboxed frame | Compatibility renderer only (WebGL 2). Must be a **single-threaded** export (no SharedArrayBuffer in the sandbox). GDScript only (no C#). The engine download is roughly 25–40 MB. |
| **Native** (later) | FLASH Rising, the RTX-fork games, **Unreal / Unity / custom-engine titles** | The Windows app launches the game's `.exe` | Full renderer, any engine. Three integration levels (§12). Windows app only. |

## 3. Package format

A game is a zip with the extension `.llgame`:

```
llamble-game.json      manifest (required)
icon.png               256×256
cover.png              optional, 1280×720
index.html             entry (web tiers)
...                    the game's files
llamble-game.sig       store signature (optional; free/unsigned packages are allowed if the instance admin allows them)
```

`llamble-game.json`:

```json
{
  "id": "com.llamble.page-terrace",
  "name": "Page Terrace Shuffleboard",
  "version": "1.2.0",
  "sdk": 1,
  "tier": "web",
  "entry": "index.html",
  "players": { "min": 1, "max": 4, "spectators": true },
  "kidSafe": true,
  "permissions": ["results.post", "presence"],
  "size": 1048576,
  "files": { "index.html": "sha256-…", "app.js": "sha256-…" },
  "native": null
}
```

- `id` is reverse-DNS and never changes. `version` is semver.
- `permissions` are the **only** extras the game can use (§5.6). Anything not listed is refused.
- `files` holds a hash for each file. The instance checks it on install, and the client checks it when it loads the game.
- `llamble-game.sig` is an Ed25519 signature over the canonical manifest, using the same pattern as signed news. It proves the store published the package. The instance checks it against a built-in store public key (or keys the instance admin adds for their own studio).
- For native games, `native` would hold `{ "exe": "game.exe", "args": [] }`, with a hash for each file as above.

## 4. Hosting and isolation

### Serving files
- The instance unpacks to its data volume: `games/<id>/<version>/…`.
- It serves the files at `GET /g/<id>/<version>/<path>` with:
  - `Access-Control-Allow-Origin: *`, because sandboxed frames have an opaque origin and module scripts need CORS.
  - `Content-Security-Policy: default-src 'self' blob: data:; connect-src 'none'; frame-ancestors <app origin>`. **No network access.** All networking goes through the SDK.
  - `Cache-Control: public, max-age=31536000, immutable`, which is safe because paths include the version.
- A game shown in a server's Games list but **not hosted** by the instance downloads from the store's file host instead (see ROADMAP "hosting"). The client checks the same file hashes either way.

### The frame
```html
<iframe src="https://instance/g/com.llamble.page-terrace/1.2.0/index.html"
        sandbox="allow-scripts allow-pointer-lock"
        allow="fullscreen; gamepad; autoplay"></iframe>
```
- **No `allow-same-origin`**, so the game can't read the app's cookies, storage or tokens, can't call the REST API, and can't open popups or navigate the app.
- The Electron app uses the same iframe inside the renderer, which is already `sandbox: true` and `contextIsolation: true`. The webapp and Android app are identical. One code path everywhere.
- Fullscreen is the app's job. The game asks with `ll.ui.fullscreen()` and the app enlarges the frame.

## 5. The SDK (version 1)

### 5.1 Transport
Messages travel by `postMessage` between the frame and the app. Every message has this envelope:

```json
{ "llamble": 1, "id": 17, "type": "send", "data": { } }
```

- Requests carry an `id`. The reply echoes it with `type: "ok"` or `type: "error"`.
- Events from the app carry no `id`.
- The app only accepts messages from its own game frame's `contentWindow`, and only sends to it.

The SDK is a single file, `llamble-games.js` (no dependencies, ~4 KB). Games bundle it. The repo also ships a GDScript wrapper.

### 5.2 Startup
```js
import { connect } from './llamble-games.js';

const ll = await connect();   // resolves on "ready"; rejects after 5 s if not running in Llamble
ll.me        // { id, name, avatar, kid, locale, color }
ll.session   // { id, gameId, hostId, players: [...], spectators: [...], role: 'player'|'spectator', launch: {...} }
```

- `me.id` is a **per-game pseudonymous id**: `base64url(HMAC(instance_secret, user_id + game_id))[0..16]`. It is stable for that person in that game, but different in every game, and it is never the real user id.
- `avatar` is a `data:` URL (64×64) or empty, so the game never fetches from the instance.
- `kid: true` tells the game to show its kid-safe options. The app enforces the rules regardless (§7).
- `launch` carries whatever the starter picked in the app's launch sheet (for example a room code to rejoin). Usually empty.

A game opened outside Llamble (for example the standalone LAN build) gets a rejection from `connect()` and falls back to its own networking.

### 5.3 Session events
```js
ll.on('join',  p => {})       // { id, name, avatar, kid, role }
ll.on('leave', p => {})
ll.on('host',  ({ hostId, previousHostId }) => {})   // host handoff (§6.3)
ll.on('role',  p => {})       // spectator ↔ player
ll.on('pause', ({ reason }) => {})   // e.g. 'quiet-hours', 'seat-lost', 'app-hidden'
ll.on('end',   ({ reason }) => {})   // the session is closing; save now
```

### 5.4 Messaging
```js
ll.send(data, { to: 'all' | 'host' | playerId, reliable: true })
ll.on('message', ({ from, data }) => {})
```

- `data` is any JSON value, at most **16 KB** per message.
- Rate limit: **30 messages/s per member**, burst 60. The app drops anything over the limit and fires `error` with `rate_limited`.
- Messages are delivered in order and reliably over the gateway WebSocket. Version 1 has no unreliable or UDP channel. A later version can add a WebRTC data channel for action games.
- Players and spectators can both send. A game that doesn't want spectators to talk simply ignores their messages.

### 5.5 Storage
```js
await ll.save.get('settings')          // per person, per game, kept on the instance
await ll.save.set('settings', { ... }) // at most 64 KB per key, 1 MB per person per game
await ll.save.list()
```
Session-wide state is the game's own business, kept by the host (§6).

### 5.6 Permissioned extras
These only work if they're declared in the manifest **and** allowed. Each one has an on/off for its server, the instance and each guardian.

| Permission | API | What it does |
|---|---|---|
| `presence` | `ll.presence.set("Frame 3 · 21–14")` | Feeds the existing "Playing …" activity (§8), at most once every 15 s |
| `results.post` | `ll.results.post({ winners:[id], scores:{id:n}, summary })` | The app posts a result card in the channel the game was started from, with the person's OK on the first time |
| `invite` | `ll.ui.invite()` | Opens the app's own invite picker. The game never sees the friend list. |
| `ai.chat` | `ll.ai.chat(messages, { maxTokens })` | Goes through the Llamble bot with the instance's limits and the kid-safe prompt for kids. Meant for trivia and narrators. |
| `voice.state` | `ll.on('speaking', …)` | Who is talking in the linked voice channel (for avatars). There is no audio access. |

Always available, with no permission: `ll.ui.fullscreen()`, `ll.ui.toast(text)`, `ll.exit()`, `ll.on('visibility', …)`.

## 6. Multiplayer model

### 6.1 Host-authoritative in the host's client
- The person who starts the game is the **host**. The host's copy runs the real game (rules, physics, AI) and sends results to everyone else.
- Every other copy sends inputs to the host (`to: 'host'`) and renders what the host sends back.
- This is exactly how Page Terrace already works. Its `GameRoom` class runs inside the browser for solo play, and in Llamble it simply runs inside the host's frame. Its `LocalTransport` becomes a `LlambleTransport` (~80 lines).

### 6.2 Server side: relay only
The instance keeps no game state. It only tracks who is in which session and passes messages along.

### 6.3 Host handoff
- If the host leaves or drops for **10 s**, the instance makes the longest-connected player the new host and fires `host` to everyone.
- To survive this, games should have the host send a compact snapshot every few seconds (or at turn boundaries). The new host restores from the last snapshot.
- The SDK helps: `ll.snapshot.set(obj)` (host only; the app keeps the latest copy, max 64 KB, in memory on the instance) and `await ll.snapshot.get()`.

### 6.4 Lockstep games
Deterministic lockstep games (same inputs give the same results on every machine) work too: the host relays inputs plus tick numbers. Page Terrace already does a hybrid: everyone replays each shot with the same deterministic physics, then snaps to the host's final positions.

## 7. Kids and guardians

The app enforces all of this. Games can't get around it.

- **Launching or joining:** a kid account can start or join a game only if the guardian has allowed that game. `kidSafe: true` games can be set to "allowed unless blocked" on the kid's options page. Games that aren't kid-safe need a per-game OK from a guardian.
- **Who they play with:** kids can only be in a session with people they're allowed to message (the same rule as DMs) plus that server's members, if the guardian allows server play. Joining a session with anyone else is refused.
- **Quiet hours:** fire `pause` with reason `quiet-hours`, then `end` after 2 minutes.
- **Guardian view:** guardians can see the kid's game history (game, when, who with, results) next to their chat logs. Game messages are not logged; they're game data, not chat.
- **AI:** `ai.chat` for a kid always uses the kid-safe bot settings. Guardians can turn it off per kid.
- **Purchases:** kids have no store accounts (ROADMAP). Getting a game needs a parent to buy or gift it.

## 8. Seats and licenses (the store tie-in)

All of this is done by the **client app and the instance**. The game itself never sees licenses.

- **When someone starts or joins as a player**, the client checks, in order:
  1. a personal copy (types A/B), meaning a signed license tied to the person's linked store account, or
  2. a free game (`price: 0` in the catalog, or any unsigned package the instance admin allowed), or
  3. a **seat** from that server's seat pack (type C).
- **Seat lease:** the instance gives out a seat lease of **5 minutes**. The client renews it every **2 minutes** (`game_heartbeat`). A crashed app or a lost connection frees the seat within 5 minutes.
- **No seat free:** the person sees a "waiting for a seat" message and gets pinged when one frees up (ROADMAP).
- **Spectating** never needs a seat.

## 9. Server changes (Rust)

### 9.1 Database
```
games(id, version, manifest_json, signed, source, installed_at, hosted)
game_listing(guild_id, game_id, listed, added_by)
game_sessions(id, game_id, version, guild_id, channel_id, host_user, started_at, ended_at)
game_members(session_id, user_id, role, joined_at, left_at)
game_saves(game_id, user_id, key, value_json, updated_at)        -- user_id is the real id; the game sees only the pseudonym
game_results(session_id, posted_message_id, summary_json)
seat_packs(id, license_json, guild_id, seats)                     -- from the store, signed
seat_leases(pack_id, user_id, session_id, expires_at)
```

### 9.2 REST
- `GET /api/games?guild=…`: games listed for this server, filtered for kid accounts.
- `POST /api/games/install`: instance admin only. Takes a `.llgame` upload or a store URL. Checks the signature and file hashes.
- `DELETE /api/games/{id}`, `PATCH /api/games/{id}` (hosted, enabled).
- `PUT /api/guilds/{id}/games/{game}`: server admin listing on/off.
- `GET /g/{id}/{version}/{*path}`: static files with the headers from §4.

### 9.3 Gateway (same style as now: `{op}` in, `{t, d}` out)

| Client → server `op` | Server → client `t` |
|---|---|
| `game_start {game_id, channel_id, launch}` | `GAME_SESSION {session…}` to members; `GAME_INVITE` to people who can see the channel |
| `game_join {session_id, role}` / `game_leave` | `GAME_MEMBER {session_id, member, joined}` |
| `game_send {session_id, to, data}` | `GAME_MSG {session_id, from, data}` |
| `game_snapshot {session_id, data}` (host) | — (kept in memory) |
| `game_heartbeat {session_id}` | `GAME_SEAT {session_id, ok, waiting}` |
| — | `GAME_HOST {session_id, host}`, `GAME_END {session_id, reason}` |

- Gateway limits: `game_send` is capped at 16 KB and the per-member rate from §5.4.
- Routing uses the existing in-memory connection map, so the instance never stores game messages.
- Sessions in a voice channel show up in its member list (a "Playing Page Terrace" chip, with a Join button).

## 10. Client changes (React/Electron)

1. **Games home** (ROADMAP Home → 🎮 Games): your games, what's listed in this server, who's playing right now, and Start.
2. **Launch sheet:** pick the channel, invite people or a party, play or spectate.
3. **Game frame:** opens docked over the channel or fullscreen. The voice channel stays live underneath. It holds the `postMessage` bridge, enforces permissions and rate limits, and checks file hashes.
4. **Join chips:** shown on channels and in member lists.
5. **Guardian settings:** game allow list, AI in games, game history.

## 11. Godot

A web export runs in the frame as is. A small autoload wraps the SDK:

```gdscript
# addons/llamble/llamble.gd (autoload "Llamble")
extends Node
signal message(from, data)
signal joined(player)
signal left(player)
signal host_changed(host_id)
var me := {}
var session := {}
var _cb   # JS callback must stay referenced or Godot frees it

func _ready() -> void:
    if not OS.has_feature("web"): return
    var win = JavaScriptBridge.get_interface("window")
    _cb = JavaScriptBridge.create_callback(_on_event)
    win.LlambleGodot.init(_cb)   # tiny JS shim in the export template wraps llamble-games.js

func send(data, to := "all") -> void:
    JavaScriptBridge.eval("LlambleGodot.send(%s, %s)" % [JSON.stringify(data), JSON.stringify(to)])

func _on_event(args) -> void:
    var ev = JSON.parse_string(args[0])
    match ev.type:
        "ready": me = ev.me; session = ev.session
        "message": message.emit(ev.from, ev.data)
        "join": joined.emit(ev.player)
        "leave": left.emit(ev.player)
        "host": host_changed.emit(ev.hostId)
```

Export settings: Compatibility renderer, **Thread support off**, and a custom HTML shell that includes `llamble-games.js` and the shim.

**Native Godot (later):** this uses the native path described in §12, Level 3.

## 12. Native games from any engine (Unreal, Unity, Godot, custom)

Any game that ships a Windows build can live in Llamble. Developers pick how deeply to integrate.

### Level 1: Launch only (no code changes)
- Manifest: `"tier": "native"`, `"native": { "exe": "Game.exe", "args": [], "integration": 1 }`.
- Llamble installs it, checks file hashes, launches it, and shows "Playing X" using the existing game detection (`llamble-helper.exe`). It handles personal licenses and seat packs on the launcher side: a seat is held while the process runs, plus the 2-minute heartbeat from the app.
- The game keeps its own multiplayer, its own servers and everything else. This is how existing games come to Llamble unchanged.

### Level 2: Join and invite hooks (a few lines of code)
- **Joining:** when someone clicks **Join** on a friend, Llamble launches the game with
  `--llamble-join=<connect string>`, where the connect string is whatever the host game published (an `ip:port`, a lobby code, a session id).
- **Hosting:** the game publishes its connect string by writing one line to its standard output, with no SDK needed:
  `LLAMBLE {"hosting":{"connect":"203.0.113.5:7777","players":2,"max":8}}`.
  Alternatively it can call the Level 3 SDK.
- Llamble shows a Join button in the voice channel, the member list and invites. The connect string goes only to people who are allowed to join (same channel, friends, kid rules).
- **Unreal:** read the argument with `FParse::Value(FCommandLine::Get(), TEXT("llamble-join="), Out)` and call `ClientTravel` (listen or dedicated server). **Unity:** use `System.Environment.GetCommandLineArgs()`.
- **Networking stays the game's own.** Unreal replication, Unity Netcode, Steam networking and so on never go through the Llamble gateway; it is too fast and too heavy for a chat connection. Hosting from home still needs an open port or the game's own relay. A Llamble UDP relay for native games could come later.

### Level 3: Full SDK
- The app starts a localhost WebSocket for that one game and launches it with `--llamble-port=<p> --llamble-token=<one-time token>`. The token is good for that launch only and has no meaning to the instance. The app holds the real connection.
- The game connects to `ws://127.0.0.1:<p>` and speaks the **same envelope and the same messages as §5**: identity, session events, `send`/`message` relay, saves, snapshots, presence, results, invites, `ai.chat`. The same permissions and the same kid rules apply.
- **Libraries we ship:**
  - `llamble-sdk-c`: a single-header C/C++ library with no dependencies beyond a WebSocket client. It is the base for everything else.
  - **Unreal plugin:** a `ULlambleSubsystem` (GameInstance subsystem) with Blueprint-exposed events and functions. It wraps the C library.
  - **Unity package:** `com.llamble.sdk`, C#, using `System.Net.WebSockets`.
  - **Godot addon:** the same autoload as §11. It switches to WebSocket mode when it finds `--llamble-port`.
- Using the relay (`send`) is fine for turn-based or low-rate state in native games. Real-time action should use the engine's own networking (Level 2) together with the SDK for everything else.

### Web exports from other engines
- **Unity web builds** run in the sandboxed web tier like Godot web exports. They talk to the SDK through a small `.jslib` bridge, and they must be single-threaded builds.
- **Unreal** has no official web export, so Unreal titles are native only.

### Trust rules for native games
A native `.exe` can't be sandboxed the way a web game is: it has the same reach as any program on that PC. So:
- **Store titles from other developers:**
  - verified publisher accounts;
  - Authenticode-signed executables, with the signature checked by the app at install and launch;
  - an automated malware scan plus review before listing;
  - updates re-scanned before they ship.
- **Install screen:** a clear "This is a full program for Windows. It can access your computer like any app you install." notice, separate from the web-game permission list.
- **Kid accounts:** native games always need a guardian's explicit OK, even when marked kid-safe.
- **Instance admins** can turn native installs off entirely (the default for new instances: **off**, web games only).
- **Unsigned or sideloaded native packages** are allowed only on the instance admin's own instance and only after an extra confirmation.

### Size and delivery
- Native games can be many GB. The package format adds per-chunk hashes (4 MB chunks) so downloads resume and updates only fetch changed chunks.
- **Instance hosting is a big win here:** the NAS downloads once, then everyone on the LAN installs at local speed. Admins choose which games to host (ROADMAP "hosting").
- Store listings show the platform ("Windows app only") so web and Android users aren't surprised.

### Licensing
- Native titles check their license through the app: the SDK gives `ll.license()` → `{ owned, seat }`, and Level 1 is enforced by the launcher. As with anything on a player's PC, a determined person can crack it (ROADMAP: the value is the content and the convenience).
- Engine royalties (for example Unreal's) are between the developer and the engine maker. Llamble is just a store.

## 13. Developer kit

`tools/game-devkit/`, a local page you open in a browser:
- It loads a game folder in **2–4 side-by-side frames**, each pretending to be a different player.
- It acts as the app's side of the bridge: fake identities, a kid toggle, and a "drop host" button to test handoff.
- It has a message inspector with rate-limit warnings, and a manifest check.
- `npm run pack` turns a game folder into a `.llgame` with hashes. Signing stays in the store's publishing tool, like the news key.

This kit is also how Page Terrace gets tested without a full instance.

## 14. Build order

1. **SDK + devkit**, then port **Page Terrace** to the SDK. Its standalone LAN server keeps working, and the game picks whichever is available.
2. **Instance side:** install packages from file, serve `/g/...`, gateway session ops, relay.
3. **Client side:** Games home, launch sheet, frame bridge and join chips. Free games only.
4. **Kids:** allow lists, quiet hours, history.
5. **Built-in titles** from the roadmap (AI trivia, drawing, chess, watch together) using the same SDK.
6. **Store hookup:** signed packages, personal licenses, seat packs and leases.
7. **Godot web shim + template**.
8. **Native tier:** Level 1 (launch + seats), then Level 2 (join/hosting line), then Level 3 (localhost SDK + C, Unreal, Unity and Godot libraries). Native installs stay off by default per instance.

## 15. Naming
Call these **Games** in the app (the Home section already uses that name). Use "Start a game" and "Join game", and avoid other products' terms for in-chat games.

---

## Review notes (Nov 11, before building)

Adopted as the plan, with these changes:

1. **Game files must be able to load themselves.** `connect-src 'none'` would stop Godot and Unity web exports from fetching their own `.pck`/`.wasm`/data files. Use `connect-src https://<instance>/g/<id>/<version>/` (a path-limited source), so a game reaches only its own files. Calling the API from there gets nothing anyway: the frame has an opaque origin and Llamble uses bearer tokens, not cookies.
2. **WebAssembly:** add `script-src 'self' 'wasm-unsafe-eval'` for Godot/Unity exports.
3. **`frame-ancestors`:** must list every place the app runs from: the instance itself, the Android app's `https://appassets.androidplatform.net`, and the Windows app (it loads from `file://`, which `frame-ancestors` can't name; the Windows app should load games through its `llamble-asset://` protocol or the instance URL).
4. **Faster game messages when the players are in a voice channel:** route `ll.send` over LiveKit data messages (already running for voice; reliable and lossy modes, UDP, forwarded by the voice server) instead of the chat gateway. The gateway stays as the fallback for games started outside a voice channel. This gives action games a low-latency path in v1 without new servers.
5. **Native Level 3 localhost socket:** bind to 127.0.0.1 only, one-time token per launch (as written), and close it when the game process exits.
6. **Build order:** after friends and parties (Bran, Nov 11).
