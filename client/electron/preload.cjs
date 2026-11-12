const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("llambleNative", {
  platform: process.platform,
  getScreenSources: () => ipcRenderer.invoke("screen-sources"),
  setScreenSource: (choice) => ipcRenderer.invoke("set-screen-source", choice),
  appAudio: {
    start: (key, sourceId, mode) => ipcRenderer.invoke("app-audio-start", key, sourceId, mode),
    stop: (key) => ipcRenderer.invoke("app-audio-stop", key),
    on: (cb) => {
      const h = (_e, key, buf) => cb(key, buf);
      ipcRenderer.on("app-audio", h);
      return () => ipcRenderer.removeListener("app-audio", h);
    },
  },
  flash: () => ipcRenderer.send("flash"),
  setUnread: (n) => ipcRenderer.send("unread", n),
  focus: () => ipcRenderer.send("focus"),
  isFocused: () => ipcRenderer.invoke("is-focused"),
  version: () => ipcRenderer.invoke("app-version"),
  setAutostart: (on) => ipcRenderer.send("set-autostart", on),
  quit: () => ipcRenderer.send("quit"),
  onHotkey: (cb) => {
    const h = (_e, k) => cb(k);
    ipcRenderer.on("hotkey", h);
    return () => ipcRenderer.removeListener("hotkey", h);
  },
  metrics: () => ipcRenderer.invoke("app-metrics"),
  recordings: {
    begin: (id, meta) => ipcRenderer.invoke("rec-begin", id, meta),
    append: (id, data) => ipcRenderer.invoke("rec-append", id, data),
    meta: (id, meta) => ipcRenderer.invoke("rec-meta", id, meta),
    list: () => ipcRenderer.invoke("rec-list"),
    read: (id, offset, length) => ipcRenderer.invoke("rec-read", id, offset, length),
    remove: (id) => ipcRenderer.invoke("rec-remove", id),
    reveal: (id) => ipcRenderer.invoke("rec-reveal", id),
    folder: () => ipcRenderer.invoke("rec-folder"),
  },
  ptt: {
    start: (vk) => ipcRenderer.invoke("ptt-start", vk),
    stop: () => ipcRenderer.invoke("ptt-stop"),
    on: (cb) => {
      const h = (_e, down) => cb(down);
      ipcRenderer.on("ptt-state", h);
      return () => ipcRenderer.removeListener("ptt-state", h);
    },
  },
  games: {
    current: () => ipcRenderer.invoke("games-current"),
    running: () => ipcRenderer.invoke("games-running"),
    custom: () => ipcRenderer.invoke("games-custom"),
    mark: (exe, name) => ipcRenderer.invoke("games-mark", exe, name),
    reset: (exe) => ipcRenderer.invoke("games-reset", exe),
    enable: (on) => ipcRenderer.invoke("games-enable", on),
    on: (cb) => {
      const h = (_e, g) => cb(g);
      ipcRenderer.on("games-update", h);
      return () => ipcRenderer.removeListener("games-update", h);
    },
  },
  llm: {
    gpus: () => ipcRenderer.invoke("llm-gpus"),
    start: (cfg) => ipcRenderer.invoke("llm-start", cfg),
    stop: () => ipcRenderer.invoke("llm-stop"),
    status: () => ipcRenderer.invoke("llm-status"),
    chat: (job) => ipcRenderer.send("llm-chat", job),
    sysState: (gpuIndex) => ipcRenderer.invoke("sys-state", gpuIndex),
    on: (cb) => {
      const a = (_e, d) => cb("status", d);
      const b = (_e, d) => cb("log", d);
      const c = (_e, d) => cb("job", d);
      ipcRenderer.on("llm-status", a);
      ipcRenderer.on("llm-log", b);
      ipcRenderer.on("llm-job", c);
      return () => {
        ipcRenderer.removeListener("llm-status", a);
        ipcRenderer.removeListener("llm-log", b);
        ipcRenderer.removeListener("llm-job", c);
      };
    },
  },
  onUpdateReady: (cb) => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on("update-ready", h);
    return () => ipcRenderer.removeListener("update-ready", h);
  },
  installUpdate: () => ipcRenderer.send("install-update"),
  checkUpdate: () => ipcRenderer.send("check-update"),
  onUpdateStatus: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on("update-status", h);
    return () => ipcRenderer.removeListener("update-status", h);
  },
  overlay: {
    set: (o) => ipcRenderer.send("overlay-set", o),
    update: (snap) => ipcRenderer.send("overlay-update", snap),
    edit: (on) => ipcRenderer.send("overlay-edit", on),
    editShown: () => ipcRenderer.send("overlay-edit-shown"),
    onSnapshot: (cb) => {
      const h = (_e, s) => cb(s);
      ipcRenderer.on("overlay-snapshot", h);
      return () => ipcRenderer.removeListener("overlay-snapshot", h);
    },
    onEdit: (cb) => {
      const h = (_e, on) => cb(on);
      ipcRenderer.on("overlay-edit", h);
      return () => ipcRenderer.removeListener("overlay-edit", h);
    },
    alarm: (p) => ipcRenderer.send("overlay-alarm", p),
    alarmAction: (a) => ipcRenderer.send("overlay-alarm-action", a),
    interactive: (on) => ipcRenderer.send("overlay-interactive", !!on),
    onAlarm: (cb) => {
      const h = (_e, p) => cb(p);
      ipcRenderer.on("overlay-alarm", h);
      return () => ipcRenderer.removeListener("overlay-alarm", h);
    },
    onAlarmAction: (cb) => {
      const h = (_e, a) => cb(a);
      ipcRenderer.on("alarm-action", h);
      return () => ipcRenderer.removeListener("alarm-action", h);
    },
  },
  images: {
    status: () => ipcRenderer.invoke("img-status"),
    prepare: (cfg) => ipcRenderer.invoke("img-prepare", cfg),
    generate: (job, gpu) => ipcRenderer.invoke("img-generate", job, gpu),
    on: (cb) => {
      const h = (_e, s) => cb(s);
      ipcRenderer.on("img-status", h);
      return () => ipcRenderer.removeListener("img-status", h);
    },
  },
  readAsset: (name) => ipcRenderer.invoke("read-asset", name),
  pickFile: (opts) => ipcRenderer.invoke("pick-file", opts),
  onInvite: (cb) => {
    const h = (_e, code) => cb(code);
    ipcRenderer.on("invite", h);
    return () => ipcRenderer.removeListener("invite", h);
  },
});
