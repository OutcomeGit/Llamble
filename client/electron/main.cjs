// Llamble desktop shell (Electron main process)
const {
  app, BrowserWindow, Tray, Menu, ipcMain, desktopCapturer, session,
  shell, globalShortcut, nativeImage, Notification, protocol,
} = require("electron");
const path = require("path");
const llm = require("./llm.cjs");

// The app's own audio-processing files (noise suppression, noise gate) are served from
// llamble-asset://audio/... : browsers won't load audio modules straight from disk (file://).
protocol.registerSchemesAsPrivileged([
  { scheme: "llamble-asset", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);
const ASSET_TYPES = { ".js": "text/javascript", ".wasm": "application/wasm" };
function serveAssets() {
  const base = path.join(__dirname, "..", "dist", "audio");
  protocol.handle("llamble-asset", async (req) => {
    const u = new URL(req.url);
    if (u.host === "recordings") return serveRecording(req, u);
    const full = path.normalize(path.join(base, decodeURIComponent(u.pathname)));
    if (u.host !== "audio" || !full.startsWith(base + path.sep)) return new Response("not found", { status: 404 });
    try {
      const body = await require("fs").promises.readFile(full);
      return new Response(body, {
        headers: { "content-type": ASSET_TYPES[path.extname(full)] || "application/octet-stream", "access-control-allow-origin": "*" },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

// ---- recordings kept on this PC (Library → Recordings) ----
// Shows recorded on this app are written to Videos\Llamble as they record. Nothing is sent
// to the server unless the person shares one from the Library.
const fsp = require("fs").promises;
const REC_ID = /^[A-Za-z0-9_-]{1,64}$/;
const recDir = () => path.join(app.getPath("videos"), "Llamble");
// shows record to .webm; recordings made by the native recorder are .mp4
const recFile = (id) => {
  const mp4 = path.join(recDir(), id + ".mp4");
  return require("fs").existsSync(mp4) ? mp4 : path.join(recDir(), id + ".webm");
};
const recMeta = (id) => path.join(recDir(), id + ".json");
function checkId(id) {
  if (typeof id !== "string" || !REC_ID.test(id)) throw new Error("bad recording id");
  return id;
}
ipcMain.handle("rec-begin", async (_e, id, meta) => {
  checkId(id);
  await fsp.mkdir(recDir(), { recursive: true });
  await fsp.writeFile(recFile(id), Buffer.alloc(0));
  await fsp.writeFile(recMeta(id), JSON.stringify(meta || {}));
  return true;
});
ipcMain.handle("rec-append", async (_e, id, data) => {
  checkId(id);
  await fsp.appendFile(recFile(id), Buffer.from(data));
  return (await fsp.stat(recFile(id))).size;
});
ipcMain.handle("rec-meta", async (_e, id, meta) => {
  checkId(id);
  let cur = {};
  try { cur = JSON.parse(await fsp.readFile(recMeta(id), "utf8")); } catch {}
  await fsp.writeFile(recMeta(id), JSON.stringify({ ...cur, ...(meta || {}) }));
  return true;
});
ipcMain.handle("rec-list", async () => {
  let names = [];
  try { names = await fsp.readdir(recDir()); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".webm") && !n.endsWith(".mp4")) continue;
    const id = n.replace(/\.(webm|mp4)$/, "");
    if (!REC_ID.test(id)) continue;
    let meta = { id, title: "", started_at: 0, mime: n.endsWith(".mp4") ? "video/mp4" : "video/webm" };
    try { meta = { ...meta, ...JSON.parse(await fsp.readFile(recMeta(id), "utf8")) }; } catch {}
    try { out.push({ id, size: (await fsp.stat(recFile(id))).size, meta }); } catch {}
  }
  return out.sort((a, b) => (b.meta.started_at || 0) - (a.meta.started_at || 0));
});
ipcMain.handle("rec-read", async (_e, id, offset, length) => {
  checkId(id);
  const fh = await fsp.open(recFile(id), "r");
  try {
    const buf = Buffer.alloc(Math.max(0, Math.min(length | 0, 16 * 1024 * 1024)));
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
});
ipcMain.handle("rec-remove", async (_e, id) => {
  checkId(id);
  await fsp.rm(recFile(id), { force: true });
  await fsp.rm(recMeta(id), { force: true });
  return true;
});
ipcMain.handle("rec-reveal", async (_e, id) => {
  checkId(id);
  shell.showItemInFolder(recFile(id));
  return true;
});
ipcMain.handle("rec-folder", () => recDir());
// ---- native recording: llamble-helper.exe records a window or screen on the graphics card ----
// (Windows Graphics Capture → the card's own encoder → MP4, like dedicated recording apps).
// It writes into Videos\Llamble next to the show recordings; the Library lists both.
let nativeRec = null; // { p, id, file, done }
function nativeRecStart(o) {
  if (nativeRec) return Promise.resolve({ error: "already recording" });
  if (process.platform !== "win32") return Promise.resolve({ error: "only in the Windows app" });
  const exe = require("./helper.cjs").exePath();
  if (!exe) return Promise.resolve({ error: "the recorder helper is missing" });
  const id = checkId(String(o.id));
  const file = path.join(recDir(), id + ".mp4");
  const fps = o.fps === 30 ? 30 : 60;
  const bpp = Math.max(0.03, Math.min(1, Number(o.bpp) || 0.2)); // bits per pixel per frame
  return (async () => {
    await fsp.mkdir(recDir(), { recursive: true });
    const args = ["record", file, "--fps", String(fps), "--bpp", String(bpp), "--codec", o.codec === "h264" ? "h264" : "auto"];
    const win32 = /^window:(\d+):/.exec(String(o.sourceId || ""));
    if (win32) {
      args.push("--window", win32[1]);
    } else {
      // a whole screen: find it by a point in its middle, in real pixels
      const { screen } = require("electron"); // only usable once the app is ready
      const srcs = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
      const src = findSource(srcs, o.sourceId) || srcs[0];
      const disp = screen.getAllDisplays().find((d) => String(d.id) === String(src && src.display_id)) || screen.getPrimaryDisplay();
      const pt = screen.dipToScreenPoint({ x: Math.round(disp.bounds.x + disp.bounds.width / 2), y: Math.round(disp.bounds.y + disp.bounds.height / 2) });
      args.push("--point", `${Math.round(pt.x)},${Math.round(pt.y)}`);
    }
    let what = "none";
    if (o.sound === "all") {
      args.push("--audio", "except", String(process.pid));
      what = "all-but-llamble";
    } else if (o.sound !== "off") {
      if (win32) {
        args.push("--audio", "window", win32[1]);
        what = "app";
      } else {
        const game = (require("./games.cjs").current() || []).find((g) => g.pid);
        args.push("--audio", game ? "app" : "except", String(game ? game.pid : process.pid));
        what = game ? "game:" + game.name : "all-but-llamble";
      }
    }
    const started_at = Date.now();
    await fsp.writeFile(recMeta(id), JSON.stringify({ id, title: o.title || "", channel_id: "", started_at, kind: "clip", mime: "video/mp4", sound: what }));
    const p = require("child_process").spawn(exe, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let resolveDone;
    nativeRec = { p, id, file, done: new Promise((r) => (resolveDone = r)) };
    const send = (ch, v) => win && !win.isDestroyed() && win.webContents.send(ch, v);
    return await new Promise((resolve) => {
      let buf = "";
      let started = false;
      p.stdout.setEncoding("utf8");
      p.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          const [kind, ...rest] = line.split(" ");
          if (kind === "started") {
            started = true;
            const [codec, where, w, h, rate] = rest;
            resolve({ id, codec, gpu: where === "gpu", width: Number(w), height: Number(h), bitrate: Number(rate) || 0, sound: what });
          } else if (kind === "stat") send("native-rec-stat", { id, fps: Number(rest[0]), dropped: Number(rest[1]), bytes: Number(rest[2]) });
          else if (kind === "error") {
            const why = rest.join(" ");
            console.warn("[llamble] recorder:", why);
            if (!started) resolve({ error: why });
            else send("native-rec-stat", { id, error: why });
          }
        }
      });
      p.stderr.on("data", (d) => console.warn("[llamble] recorder:", String(d).trim()));
      p.on("exit", async (code) => {
        if (nativeRec && nativeRec.p === p) nativeRec = null;
        try {
          const cur = JSON.parse(await fsp.readFile(recMeta(id), "utf8"));
          await fsp.writeFile(recMeta(id), JSON.stringify({ ...cur, ended_at: Date.now() }));
        } catch {}
        if (!started) resolve({ error: "the recorder stopped (code " + code + ")" });
        send("native-rec-done", { id, ok: code === 0 });
        resolveDone();
      });
      setTimeout(() => !started && resolve({ error: "the recorder didn't start" }), 15000);
    });
  })();
}
async function nativeRecStop() {
  const r = nativeRec;
  if (!r) return false;
  try { r.p.stdin.write("stop\n"); } catch {}
  // finishing the file can take a moment; don't wait forever
  await Promise.race([r.done, new Promise((res) => setTimeout(res, 20000))]);
  try { r.p.kill(); } catch {}
  return true;
}
ipcMain.handle("native-rec-start", (_e, o) => nativeRecStart(o || {}));
ipcMain.handle("native-rec-stop", () => nativeRecStop());

// play a recording in the app (with seeking: Range requests)
async function serveRecording(req, u) {
  const id = decodeURIComponent(u.pathname.replace(/^\//, "").replace(/\.(webm|mp4)$/, ""));
  if (!REC_ID.test(id)) return new Response("not found", { status: 404 });
  let size;
  try { size = (await fsp.stat(recFile(id))).size; } catch { return new Response("not found", { status: 404 }); }
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
  let start = 0, end = size - 1, status = 200;
  if (m) {
    start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    status = 206;
  }
  if (size === 0 || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  const { Readable } = require("stream");
  const body = Readable.toWeb(require("fs").createReadStream(recFile(id), { start, end }));
  const headers = { "content-type": recFile(id).endsWith(".mp4") ? "video/mp4" : "video/webm", "accept-ranges": "bytes", "content-length": String(end - start + 1) };
  if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status, headers });
}

// ---- push-to-talk: llamble-helper.exe watches the one chosen key, even while a game has focus ----
let ptt = null;
function pttStart(vk) {
  pttStop();
  const helper = require("./helper.cjs");
  const exe = helper.exePath && helper.exePath();
  if (!exe || !(vk > 0 && vk < 255)) return false;
  const p = require("child_process").spawn(exe, ["ptt", String(vk | 0)], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  ptt = p;
  let buf = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if ((line === "down" || line === "up") && win && !win.isDestroyed()) win.webContents.send("ptt-state", line === "down");
    }
  });
  p.on("exit", () => { if (ptt === p) ptt = null; });
  return true;
}
function pttStop() {
  if (!ptt) return;
  try { ptt.stdin.end(); } catch {}
  const p = ptt;
  setTimeout(() => { try { p.kill(); } catch {} }, 500);
  ptt = null;
}
ipcMain.handle("ptt-start", (_e, vk) => pttStart(Number(vk)));

// ---- screen-share sound: just the shared app's sound (or a game's), via llamble-helper.exe ----
// Windows 10 2004+ can capture one program's sound. Sharing a window → that program only.
// Sharing a whole screen → the game you're playing if one is running, else everything
// except Llamble itself. Other call apps, music and notifications stay out.
// Several can run at once, by name: "share" (the screen share's sound), "rec" (a show
// recording taking in the whole PC's sound).
const appAudio = new Map();
function appAudioStop(key = "share") {
  const p = appAudio.get(key);
  if (!p) return;
  appAudio.delete(key);
  try { p.stdin.end(); } catch {}
  setTimeout(() => { try { p.kill(); } catch {} }, 500);
}
function appAudioStopAll() { for (const k of [...appAudio.keys()]) appAudioStop(k); }
function appAudioStart(key, sourceId, mode) {
  appAudioStop(key);
  if (process.platform !== "win32") return Promise.resolve(null);
  const exe = require("./helper.cjs").exePath();
  if (!exe) return Promise.resolve(null);
  const m = /^window:(\d+):/.exec(String(sourceId || ""));
  let args, what;
  if (mode === "all") {
    // everything playing on the PC — minus Llamble itself, so the call never echoes back
    args = ["audio", "except", String(process.pid)];
    what = "all-but-llamble";
  } else if (m) {
    args = ["audio", "window", m[1]];
    what = "app";
  } else {
    const game = (require("./games.cjs").current() || []).find((g) => g.pid);
    args = game ? ["audio", "app", String(game.pid)] : ["audio", "except", String(process.pid)];
    what = game ? "game:" + game.name : "all-but-llamble";
  }
  const p = require("child_process").spawn(exe, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  appAudio.set(key, p);
  // a direct line to the page's sound thread: the samples skip the page's busy main thread
  const { MessageChannelMain } = require("electron");
  const { port1, port2 } = new MessageChannelMain();
  if (win && !win.isDestroyed()) win.webContents.postMessage("app-audio-port", key, [port2]);
  let rest = Buffer.alloc(0);
  p.stdout.on("data", (d) => {
    // whole stereo float frames only (8 bytes each), copied so the page gets aligned samples
    const all = rest.length ? Buffer.concat([rest, d]) : d;
    const n = all.length - (all.length % 8);
    rest = Buffer.from(all.subarray(n));
    if (n) port1.postMessage(new Float32Array(new Uint8Array(all.subarray(0, n)).buffer));
  });
  p.on("exit", () => { try { port1.close(); } catch {} if (appAudio.get(key) === p) appAudio.delete(key); });
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let err = "";
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (d) => {
      err += d;
      if (/^ok/m.test(err)) finish(what);
      else if (/error|usage/.test(err)) { console.warn("[llamble] app sound:", err.trim()); finish(null); }
    });
    p.on("exit", () => finish(null));
    setTimeout(() => finish(null), 4000);
  }).then((v) => { if (!v && appAudio.get(key) === p) appAudioStop(key); return v; });
}
ipcMain.handle("app-audio-start", (_e, key, sourceId, mode) => appAudioStart(String(key), sourceId, mode));
ipcMain.handle("app-audio-stop", (_e, key) => appAudioStop(String(key)));

ipcMain.handle("ptt-stop", () => pttStop());

// ---- auto-update from GitHub Releases ----
let updateReady = false;
function setupAutoUpdate() {
  if (DEV) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info) => {
    updateReady = info.version || true;
    if (win && !win.isDestroyed()) win.webContents.send("update-ready", info.version);
  });
  const send = (ch, v) => win && !win.isDestroyed() && win.webContents.send(ch, v);
  autoUpdater.on("download-progress", (p) => send("update-status", { state: "downloading", percent: Math.round(p.percent || 0) }));
  autoUpdater.on("error", (e) => {
    console.warn("updater:", e && e.message);
    send("update-status", { state: "error", message: (e && e.message) || "update failed" });
  });
  // the server says a newer app exists: look now instead of waiting for the next timer
  ipcMain.on("check-update", () => {
    if (updateReady) return send("update-ready", typeof updateReady === "string" ? updateReady : "");
    send("update-status", { state: "checking" });
    autoUpdater.checkForUpdates().catch((e) => send("update-status", { state: "error", message: e.message }));
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 10_000);
  setInterval(check, 4 * 60 * 60 * 1000);
  ipcMain.on("install-update", () => {
    if (!updateReady) return;
    quitting = true;
    autoUpdater.quitAndInstall(false, true);
  });
}

const DEV = !!process.env.LLAMBLE_DEV;
let win = null;
let tray = null;
let quitting = false;
let pendingInvite = null;
let chosenScreen = null; // { id, audio }
// "window:<hwnd>:<n>" — the trailing number differs between our game list and Electron's, so match on the window itself
const sourceKey = (id) => String(id || "").split(":").slice(0, 2).join(":");
const sameSource = (a, b) => a === b || sourceKey(a) === sourceKey(b);
const findSource = (sources, id) => sources.find((s) => s.id === id) || sources.find((s) => sameSource(s.id, id));

if (process.defaultApp) {
  app.setAsDefaultProtocolClient("llamble", process.execPath, [path.resolve(process.argv[1] || ".")]);
} else {
  app.setAsDefaultProtocolClient("llamble");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const link = argv.find((a) => a.startsWith("llamble://"));
    if (link) handleLink(link);
    showWindow();
  });
}

app.setAppUserModelId("chat.llamble.desktop");

function handleLink(link) {
  // llamble://invite/<code>  or  llamble://invite/<code>@<server>
  const m = /^llamble:\/\/invite\/([^/?#]+)/i.exec(link);
  if (!m) return;
  const value = decodeURIComponent(m[1]);
  if (win && !win.webContents.isLoading()) win.webContents.send("invite", value);
  else pendingInvite = value;
}

function iconPath() {
  return path.join(__dirname, "..", "build", "icon.png");
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1340,
    height: 840,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: "#313338",
    title: "Llamble",
    icon: iconPath(),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#1e1f22", symbolColor: "#b5bac1", height: 30 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false, // keep voice + gateway healthy when minimized
    },
  });

  win.once("ready-to-show", () => win.show());

  if (DEV) win.loadURL("http://localhost:5173");
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));

  win.webContents.on("did-finish-load", () => {
    if (pendingInvite) {
      win.webContents.send("invite", pendingInvite);
      pendingInvite = null;
    }
  });

  // External links open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // pop-out video: a frameless, always-on-top window the app draws into itself
    if (url === "about:blank" && frameName.startsWith("llamble-pop")) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          frame: false,
          alwaysOnTop: true,
          backgroundColor: "#000000",
          minWidth: 200,
          minHeight: 120,
          icon: iconPath(),
          webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
        },
      };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-create-window", (child) => {
    child.setAlwaysOnTop(true, "screen-saver");
    child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    child.webContents.on("will-navigate", (e) => e.preventDefault());
  });
  win.webContents.on("will-navigate", (e, url) => {
    const allowed = DEV ? url.startsWith("http://localhost:5173") : url.startsWith("file://");
    if (!allowed) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // Spellcheck suggestions + copy/paste menu
  win.webContents.on("context-menu", (_e, p) => {
    const items = [];
    for (const s of p.dictionarySuggestions || []) {
      items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
    }
    if (p.misspelledWord) items.push({ type: "separator" });
    if (p.isEditable) items.push({ role: "cut" }, { role: "copy" }, { role: "paste" });
    else if (p.selectionText) items.push({ role: "copy" });
    if (p.linkURL && /^https?:/.test(p.linkURL)) {
      items.push({ label: "Copy Link", click: () => require("electron").clipboard.writeText(p.linkURL) });
    }
    if (p.mediaType === "image" && p.srcURL) {
      items.push({ label: "Copy Image", click: () => win.webContents.copyImageAt(p.x, p.y) });
      items.push({ label: "Save Image As…", click: () => win.webContents.downloadURL(p.srcURL) });
    }
    if (items.length) Menu.buildFromTemplate(items).popup();
  });

  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("focus", () => win.flashFrame(false));
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip("Llamble");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Llamble", click: showWindow },
      { type: "separator" },
      { label: "Toggle Mute", click: () => win && win.webContents.send("hotkey", "mute") },
      { label: "Toggle Deafen", click: () => win && win.webContents.send("hotkey", "deafen") },
      { type: "separator" },
      { label: "Quit Llamble", click: () => { quitting = true; app.quit(); } },
    ])
  );
  tray.on("click", showWindow);
}

app.whenReady().then(() => {
  serveAssets();
  const ses = session.defaultSession;
  const allowed = new Set(["media", "notifications", "clipboard-read", "clipboard-sanitized-write", "display-capture", "fullscreen", "speaker-selection"]);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  // Screen share: renderer picks a source first (our own picker UI), then calls getDisplayMedia.
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
      const pick = (chosenScreen && findSource(sources, chosenScreen.id)) || sources[0];
      if (chosenScreen && pick && !sameSource(pick.id, chosenScreen.id)) console.warn("[llamble] picked source not found, sharing", pick.id, "instead of", chosenScreen.id);
      if (!pick) return cb({});
      const wantAudio = chosenScreen ? chosenScreen.audio : false;
      cb(wantAudio && process.platform === "win32" ? { video: pick, audio: "loopback" } : { video: pick });
    } catch (e) {
      console.error(e);
      cb({});
    }
  });

  createWindow();
  createTray();
  llm.init((channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); });
  games.init(app, (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); });
  require("./images.cjs").init((channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); });

  setupAutoUpdate();
  globalShortcut.register("CommandOrControl+Shift+M", () => win && win.webContents.send("hotkey", "mute"));
  globalShortcut.register("CommandOrControl+Shift+D", () => win && win.webContents.send("hotkey", "deafen"));
  globalShortcut.register("CommandOrControl+Shift+O", () => setOverlayEdit(!overlayEditing));

  const link = process.argv.find((a) => a.startsWith("llamble://"));
  if (link) handleLink(link);
});

app.on("open-url", (e, url) => { e.preventDefault(); handleLink(url); });
app.on("before-quit", () => { quitting = true; llm.stop(); games.stop(); pttStop(); appAudioStopAll(); nativeRecStop(); require("./helper.cjs").stop(); });
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

// ---- IPC ----
ipcMain.handle("screen-sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 352, height: 198 },
    fetchWindowIcons: true,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith("screen") ? "screen" : "window",
    thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
    icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
  }));
});
ipcMain.handle("set-screen-source", (_e, choice) => { chosenScreen = choice; return true; });
ipcMain.on("flash", () => { if (win && !win.isFocused()) win.flashFrame(true); });
ipcMain.on("unread", (_e, count) => {
  if (!win) return;
  win.setTitle(count > 0 ? `(${count}) Llamble` : "Llamble");
  if (process.platform !== "win32") app.setBadgeCount(count);
  if (tray) tray.setToolTip(count > 0 ? `Llamble — ${count} unread` : "Llamble");
});
ipcMain.on("focus", showWindow);
ipcMain.handle("is-focused", () => !!(win && win.isFocused() && win.isVisible()));
ipcMain.handle("app-version", () => app.getVersion());
ipcMain.on("quit", () => { quitting = true; app.quit(); });
ipcMain.on("set-autostart", (_e, on) => app.setLoginItemSettings({ openAtLogin: !!on, args: ["--hidden"] }));

// ---- memory breakdown (Settings → About) ----
ipcMain.handle("app-metrics", async () => {
  const helper = require("./helper.cjs");
  const pidOf = (w) => { try { return w && !w.isDestroyed() ? w.webContents.getOSProcessId() : -1; } catch { return -1; } };
  const mainPid = pidOf(win);
  const overlayPid = pidOf(overlay);
  const rows = app.getAppMetrics().map((m) => {
    const svc = String(m.serviceName || m.name || "").toLowerCase();
    let label = "Other";
    let what = "";
    if (m.type === "Browser") { label = "App core"; what = "Electron/Node: windows, hotkeys, updates, downloads"; }
    else if (m.type === "Tab" && m.pid === mainPid) { label = "Interface & calls"; what = "the Llamble window: chat, React, LiveKit, decoding audio"; }
    else if (m.type === "Tab" && m.pid === overlayPid) { label = "Overlay"; what = "the in-game overlay window"; }
    else if (m.type === "Tab") { label = "Other windows"; what = "pop-outs and hidden pages"; }
    else if (m.type === "GPU") { label = "Graphics & video"; what = "drawing the window, video decode/encode on the graphics card"; }
    else if (svc.includes("audio")) { label = "Sound"; what = "mic capture and playback"; }
    else if (svc.includes("network")) { label = "Network"; what = "connections to your server"; }
    else if (svc.includes("video_capture") || svc.includes("capture")) { label = "Camera & screen capture"; what = ""; }
    else if (svc.includes("storage")) { label = "Storage"; what = "saved settings and cache"; }
    else { label = m.type === "Utility" ? "Other helpers" : m.type; what = m.serviceName || m.name || ""; }
    // private memory (what Task Manager shows). Working set would count memory the processes
    // share (Chromium's libraries, graphics buffers) once per process and add up to far too much.
    const kb = m.memory.privateBytes ?? m.memory.workingSetSize ?? 0;
    return { label, what, pid: m.pid, mb: Math.round(kb / 1024), cpu: Math.round((m.cpu.percentCPUUsage || 0) * 10) / 10 };
  });
  // our own extra programs (not part of Electron's list)
  const extra = [
    [helper.pid(), "Windows helper", "game detection, graphics card info"],
    [llm.pid(), "Local AI (llama.cpp)", "the AI model you lend to the server"],
    [require("./images.cjs").pid(), "Picture engine", "drawing a picture right now"],
  ].filter(([pid]) => pid);
  if (extra.length) {
    const mem = (await helper.ask("mem " + extra.map(([p]) => p).join(" "))) || [];
    for (const [pid, label, what] of extra) {
      const m = mem.find((x) => x.pid === pid);
      rows.push({ label, what, pid, mb: m ? m.mb : null, cpu: null });
    }
  }
  return rows;
});

// ---- game detection ----
const games = require("./games.cjs");
ipcMain.handle("games-current", () => games.poll());
ipcMain.handle("games-running", () => games.running());
ipcMain.handle("games-custom", () => games.custom());
ipcMain.handle("games-mark", (_e, exe, name) => games.mark(exe, name));
ipcMain.handle("games-enable", (_e, on) => games.setEnabled(on));
ipcMain.handle("games-reset", (_e, exe) => games.reset(exe));

// ---- local AI (llama.cpp) ----
ipcMain.handle("llm-gpus", () => llm.detectGpus(app));
const pictures = require("./images.cjs");
ipcMain.handle("img-status", () => pictures.status());
ipcMain.handle("img-prepare", (_e, cfg) => pictures.prepare(cfg));
ipcMain.handle("img-generate", (_e, job, gpu) => pictures.generate(job, gpu));
// idle + GPU-busy signals for "only lend when I'm away / not gaming"
ipcMain.handle("sys-state", async (_e, gpuIndex) => {
  const { powerMonitor } = require("electron");
  return {
    idleSeconds: powerMonitor.getSystemIdleTime(),
    locked: powerMonitor.getSystemIdleState(1) === "locked",
    gpuUtil: await llm.gpuUtil(gpuIndex),
  };
});
ipcMain.handle("llm-start", (_e, cfg) => llm.start(cfg));
ipcMain.handle("llm-stop", () => llm.stop());
ipcMain.handle("llm-status", () => ({ status: llm.status(), log: llm.log() }));
ipcMain.on("llm-chat", (_e, job) => llm.chat(job));
ipcMain.handle("pick-file", async (_e, opts) => {
  const { dialog } = require("electron");
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: opts?.filters || [], title: opts?.title });
  return r.canceled ? null : r.filePaths[0];
});

// ---------------------------------------------------------------- overlay
// A transparent, click-through window over the whole screen that shows who's
// talking, chat and alerts on top of games. The main window sends it snapshots.
const { screen: displays } = require("electron");
let overlay = null;
let overlayWanted = false;
let overlayHideWhenFocused = true;
let overlayEditing = false;
let lastSnap = null;
let overlayAlarm = null; // a ringing alarm shows on the overlay even when the overlay is off
let overlayInteractive = false;

function makeOverlay() {
  const d = displays.getPrimaryDisplay();
  overlay = new BrowserWindow({
    ...d.bounds,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  if (DEV) overlay.loadURL("http://localhost:5173/#overlay");
  else overlay.loadFile(path.join(__dirname, "..", "dist", "index.html"), { hash: "overlay" });
  overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  overlay.webContents.on("will-navigate", (e) => e.preventDefault());
  overlay.webContents.on("did-finish-load", () => {
    if (lastSnap) overlay.webContents.send("overlay-snapshot", lastSnap);
    if (overlayAlarm) overlay.webContents.send("overlay-alarm", { ...overlayAlarm, only: !overlayWanted });
    // a window made just for "Move widgets" loads after we asked: tell it now
    if (overlayEditing) overlay.webContents.send("overlay-edit", true);
  });
  overlay.on("closed", () => { overlay = null; overlayEditing = false; overlayInteractive = false; });
}

function syncOverlay() {
  const mainInFront = win && win.isFocused() && win.isVisible();
  const show = overlayEditing || (!!overlayAlarm && !mainInFront) || (overlayWanted && !(overlayHideWhenFocused && mainInFront));
  if (show && !overlay) makeOverlay();
  if (!overlay) return;
  if (show) {
    const d = displays.getPrimaryDisplay();
    overlay.setBounds(d.bounds);
    if (!overlay.isVisible()) overlay.showInactive();
    overlay.setAlwaysOnTop(true, "screen-saver");
  } else if (overlay.isVisible()) overlay.hide();
}

// While moving widgets the overlay takes the mouse for the whole screen. If its page never
// shows the "Done" bar (didn't load, crashed), that would lock the screen: so it must say
// it's showing the bar within a few seconds, and Esc always gets you out.
let editAckTimer = null;
function setOverlayEdit(on) {
  overlayEditing = !!on;
  clearTimeout(editAckTimer);
  if (overlayEditing) {
    editAckTimer = setTimeout(() => { if (overlayEditing) setOverlayEdit(false); }, 5000);
    try { globalShortcut.register("Escape", () => setOverlayEdit(false)); } catch {}
  } else {
    try { globalShortcut.unregister("Escape"); } catch {}
  }
  if (overlayEditing && !overlay) makeOverlay();
  if (overlay) {
    overlay.setIgnoreMouseEvents(!(overlayEditing || overlayInteractive), { forward: true });
    overlay.setFocusable(overlayEditing);
    overlay.webContents.send("overlay-edit", overlayEditing);
    if (overlayEditing) { overlay.showInactive(); overlay.focus(); }
  }
  syncOverlay();
}

ipcMain.on("overlay-set", (_e, o) => {
  overlayWanted = !!o.show;
  overlayHideWhenFocused = o.hideWhenFocused !== false;
  syncOverlay();
});
ipcMain.on("overlay-update", (_e, snap) => {
  lastSnap = snap;
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay-snapshot", snap);
});
ipcMain.on("overlay-edit", (_e, on) => setOverlayEdit(on));
ipcMain.on("overlay-edit-shown", () => clearTimeout(editAckTimer));

// Alarms: the main window sends the alarm to show over games (or null when none should).
// It shows whatever the overlay settings say: the alarm's level decides, not the overlay.
ipcMain.on("overlay-alarm", (_e, p) => {
  overlayAlarm = p || null;
  if (overlayAlarm && !overlay) makeOverlay();
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay-alarm", overlayAlarm && { ...overlayAlarm, only: !overlayWanted });
  if (!overlayAlarm && overlayInteractive) {
    overlayInteractive = false;
    if (overlay && !overlayEditing) overlay.setIgnoreMouseEvents(true, { forward: true });
  }
  try { if (win && !win.isDestroyed()) win.flashFrame(!!overlayAlarm && !win.isFocused()); } catch {}
  syncOverlay();
});
// the overlay turns click-through off only while the pointer is over the alarm card
ipcMain.on("overlay-interactive", (_e, on) => {
  overlayInteractive = !!on && !!overlayAlarm;
  if (overlay && !overlay.isDestroyed() && !overlayEditing) {
    overlay.setIgnoreMouseEvents(!overlayInteractive, { forward: true });
  }
});
ipcMain.on("overlay-alarm-action", (_e, a) => {
  if (win && !win.isDestroyed()) win.webContents.send("alarm-action", a);
});

// Camera-effect models + runtime ship in dist/mediapipe. Chromium can't fetch() file://
// URLs, so the app reads them here (only from that folder) and hands over the bytes.
ipcMain.handle("read-asset", async (_e, name) => {
  const base = path.join(__dirname, "..", "dist", "mediapipe");
  const full = path.normalize(path.join(base, String(name)));
  if (!full.startsWith(base + path.sep)) throw new Error("not allowed");
  return require("fs").promises.readFile(full);
});
app.on("browser-window-focus", syncOverlay);
app.on("browser-window-blur", () => setTimeout(syncOverlay, 50));
