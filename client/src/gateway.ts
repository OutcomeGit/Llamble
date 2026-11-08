import { api, session } from "./api";
import { handleEvent, useStore } from "./store";

let ws: WebSocket | null = null;
let stopped = false;
let attempt = 0;
let pingTimer: number | undefined;
let retryTimer: number | undefined;

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
    useStore.setState({ conn: "open" });
    clearInterval(pingTimer);
    pingTimer = window.setInterval(() => sendGateway("ping"), 30000);
    const status = localStorage.getItem("llamble.status");
    if (status && status !== "online") sendGateway("presence", { status });
    window.dispatchEvent(new Event("llamble:gateway-open"));
  };
  sock.onmessage = (e) => {
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
