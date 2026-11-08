// Llamble desktop shell (Electron main process)
const {
  app, BrowserWindow, Tray, Menu, ipcMain, desktopCapturer, session,
  shell, globalShortcut, nativeImage, Notification,
} = require("electron");
const path = require("path");
const llm = require("./llm.cjs");

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
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
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
  const ses = session.defaultSession;
  const allowed = new Set(["media", "notifications", "clipboard-read", "clipboard-sanitized-write", "display-capture", "fullscreen", "speaker-selection"]);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  // Screen share: renderer picks a source first (our own picker UI), then calls getDisplayMedia.
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
      const pick = (chosenScreen && sources.find((s) => s.id === chosenScreen.id)) || sources[0];
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

  setupAutoUpdate();
  globalShortcut.register("CommandOrControl+Shift+M", () => win && win.webContents.send("hotkey", "mute"));
  globalShortcut.register("CommandOrControl+Shift+D", () => win && win.webContents.send("hotkey", "deafen"));
  globalShortcut.register("CommandOrControl+Shift+O", () => setOverlayEdit(!overlayEditing));

  const link = process.argv.find((a) => a.startsWith("llamble://"));
  if (link) handleLink(link);
});

app.on("open-url", (e, url) => { e.preventDefault(); handleLink(url); });
app.on("before-quit", () => { quitting = true; llm.stop(); });
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

// ---- local AI (llama.cpp) ----
ipcMain.handle("llm-gpus", () => llm.detectGpus(app));
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
  overlay.webContents.on("did-finish-load", () => lastSnap && overlay.webContents.send("overlay-snapshot", lastSnap));
  overlay.on("closed", () => { overlay = null; overlayEditing = false; });
}

function syncOverlay() {
  const mainInFront = win && win.isFocused() && win.isVisible();
  const show = overlayEditing || (overlayWanted && !(overlayHideWhenFocused && mainInFront));
  if (show && !overlay) makeOverlay();
  if (!overlay) return;
  if (show) {
    const d = displays.getPrimaryDisplay();
    overlay.setBounds(d.bounds);
    if (!overlay.isVisible()) overlay.showInactive();
    overlay.setAlwaysOnTop(true, "screen-saver");
  } else if (overlay.isVisible()) overlay.hide();
}

function setOverlayEdit(on) {
  overlayEditing = !!on;
  if (overlayEditing && !overlay) makeOverlay();
  if (overlay) {
    overlay.setIgnoreMouseEvents(!overlayEditing, { forward: true });
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
app.on("browser-window-focus", syncOverlay);
app.on("browser-window-blur", () => setTimeout(syncOverlay, 50));
