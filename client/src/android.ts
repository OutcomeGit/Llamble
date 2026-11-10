import { useSyncExternalStore } from "react";

// Inside the Android app (android/): the page side of its private message channel.
// The app hands the top page one end of a MessageChannel after each load; frames never get it.
// We use it for: notifications, keeping a call alive with the screen off, saving files to
// Downloads, the back button, and updates. In a browser none of this runs.

export const isAndroidApp = /LlambleAndroid\//.test(navigator.userAgent);

type Msg = { event: string; [k: string]: unknown };
let port: MessagePort | null = null;
const queue: object[] = [];
const handlers: ((m: Msg) => void)[] = [];

export function androidSend(cmd: string, data: Record<string, unknown> = {}) {
  if (!isAndroidApp) return;
  const m = { cmd, ...data };
  if (port) port.postMessage(JSON.stringify(m));
  else queue.push(m);
}

export function onAndroid(f: (m: Msg) => void) {
  handlers.push(f);
}

if (isAndroidApp) {
  window.addEventListener("message", (e) => {
    // only the app's own hand-off: first one, not from another site's frame
    if (port || e.data !== "llamble-android" || !e.ports[0]) return;
    if (e.origin && e.origin !== "null" && e.origin !== location.origin) return;
    port = e.ports[0];
    port.onmessage = (ev) => {
      let m: Msg;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      for (const h of handlers) h(m);
    };
    for (const m of queue.splice(0)) port.postMessage(JSON.stringify(m));
  });

  // WebView has no Notification API: this one shows real Android notifications
  const clicks = new Map<string, () => void>();
  let n = 0;
  class AppNotification {
    static permission: NotificationPermission = "granted";
    static requestPermission() {
      return Promise.resolve("granted" as NotificationPermission);
    }
    onclick: (() => void) | null = null;
    private tag: string;
    constructor(title: string, opts: NotificationOptions = {}) {
      this.tag = opts.tag || `n${++n}`;
      clicks.set(this.tag, () => this.onclick?.());
      if (clicks.size > 50) clicks.delete(clicks.keys().next().value!);
      androidSend("notify", { tag: this.tag, title, body: opts.body || "" });
    }
    close() {
      androidSend("notify-close", { tag: this.tag });
    }
  }
  (window as any).Notification = AppNotification;
  onAndroid((m) => {
    if (m.event === "notification-click") clicks.get(String(m.tag))?.();
  });
}

/** Save a Blob into the phone's Downloads (the WebView can't download blob: links). */
export async function androidSave(blob: Blob, name: string) {
  androidSend("save-begin", { name, mime: blob.type || "application/octet-stream" });
  const step = 768 * 1024;
  try {
    for (let off = 0; off < blob.size; off += step) {
      const buf = new Uint8Array(await blob.slice(off, off + step).arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      androidSend("save-chunk", { b64: btoa(s) });
    }
    androidSend("save-end", { ok: true });
  } catch {
    androidSend("save-end", { ok: false });
  }
}

/** the phone's back button: close what's open; false = nothing to close (the app goes to the background) */
export function installBack(close: () => boolean) {
  (window as any).llambleBack = close;
}

// an Android update the app found on GitHub (the pill shows only then)
let update: string | null = null;
const updateSubs = new Set<() => void>();
onAndroid((m) => {
  if (m.event === "update-available") {
    update = String(m.version);
    updateSubs.forEach((f) => f());
  }
});
export function useAndroidUpdate(): string | null {
  return useSyncExternalStore(
    (f) => {
      updateSubs.add(f);
      return () => updateSubs.delete(f);
    },
    () => update,
  );
}
