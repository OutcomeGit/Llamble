const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("llambleNative", {
  platform: process.platform,
  getScreenSources: () => ipcRenderer.invoke("screen-sources"),
  setScreenSource: (choice) => ipcRenderer.invoke("set-screen-source", choice),
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
  llm: {
    gpus: () => ipcRenderer.invoke("llm-gpus"),
    start: (cfg) => ipcRenderer.invoke("llm-start", cfg),
    stop: () => ipcRenderer.invoke("llm-stop"),
    status: () => ipcRenderer.invoke("llm-status"),
    chat: (job) => ipcRenderer.send("llm-chat", job),
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
  pickFile: (opts) => ipcRenderer.invoke("pick-file", opts),
  onInvite: (cb) => {
    const h = (_e, code) => cb(code);
    ipcRenderer.on("invite", h);
    return () => ipcRenderer.removeListener("invite", h);
  },
});
