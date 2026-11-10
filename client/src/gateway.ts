import { api, session } from "./api";
import { handleEvent, useStore } from "./store";

let ws: WebSocket | null = null;
let stopped = false;
let attempt = 0;
let pingTimer: number | undefined;
let retryTimer: number | undefined;
// when we last heard anything from the server (a dead connection can look open for a long
// time, e.g. after a phone froze the app in the background)
let lastHeard = 0;

export function connectGateway() {
  stopped = false;
  open();
}

export function disconnectGateway() {
  stopped = true;
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  ws?.close();
  ws = null;
}

export function sendGateway(op: string, data: Record<string, unknown> = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, ...data }));
}

function open() {
  clearTimeout(retryTimer);
  const url = session.server.replace(/^http/, "ws") + "/api/gateway?access_token=" + encodeURIComponent(session.token);
  useStore.setState({ conn: "connecting" });
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    attempt = 0;
    lastHeard = Date.now();
    useStore.setState({ conn: "open" });
    clearInterval(pingTimer);
    pingTimer = window.setInterval(() => {
      const sent = Date.now();
      sendGateway("ping");
      // no answer at all within 10s: the connection is dead even if it looks open
      window.setTimeout(() => {
        if (ws === sock && lastHeard < sent) restart();
      }, 10000);
    }, 30000);
    const status = localStorage.getItem("llamble.status");
    if (status && status !== "online") sendGateway("presence", { status });
    window.dispatchEvent(new Event("llamble:gateway-open"));
  };
  sock.onmessage = (e) => {
    lastHeard = Date.now();
    try {
      const { t, d } = JSON.parse(e.data);
      if (t && t !== "PONG") handleEvent(t, d);
    } catch (err) {
      console.error("gateway parse", err);
    }
  };
  sock.onclose = (e) => {
    clearInterval(pingTimer);
    if (ws !== sock) return;
    ws = null;
    useStore.setState({ conn: "closed" });
    if (stopped) return;
    if (e.code === 1008 || e.code === 4001) {
      window.dispatchEvent(new Event("llamble:unauthorized"));
      return;
    }
    if (attempt >= 2) api("/api/users/@me").catch(() => {}); // 401 here signs the user out
    const delay = Math.min(30000, 1000 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
    attempt++;
    retryTimer = window.setTimeout(open, delay);
  };
}

// reconnect fast when the network comes back / machine wakes
window.addEventListener("online", () => {
  if (!stopped && !ws) {
    attempt = 0;
    open();
  }
});

/** Throw away the current connection and open a new one right away. */
function restart() {
  if (stopped) return;
  const old = ws;
  ws = null;
  clearInterval(pingTimer);
  try {
    old?.close();
  } catch {}
  attempt = 0;
  open();
}

/**
 * Coming back to the app (tab shown, window focused, phone app resumed): make sure the
 * connection is really alive, and if not, replace it now instead of waiting it out.
 */
export function checkGateway() {
  if (stopped || !session.token) return;
  if (!ws) {
    clearTimeout(retryTimer);
    attempt = 0;
    open();
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) return; // already connecting
  if (Date.now() - lastHeard < 15000) return; // heard from it just now
  const sent = Date.now();
  const sock = ws;
  sendGateway("ping");
  window.setTimeout(() => {
    if (ws === sock && lastHeard < sent) restart();
  }, 4000);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkGateway();
});
window.addEventListener("focus", checkGateway);
window.addEventListener("pageshow", checkGateway);
document.addEventListener("resume", checkGateway);
