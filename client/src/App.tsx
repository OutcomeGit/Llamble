import { useEffect, useState } from "react";
import { api, session, setSession } from "./api";
import { initAiWorker } from "./aiWorker";
import { connectGateway, disconnectGateway } from "./gateway";
import { Login } from "./components/Login";
import { Shell } from "./components/Shell";
import { currentChannelId, memberName, mentionsMe, onEvent, selectChannel, totalUnreadBadge, useStore } from "./store";
import { openModal } from "./ui";
import { toggleDeafen, toggleMute } from "./voice";
import { sounds } from "./sounds";
import type { Message } from "./types";

export default function App() {
  const [token, setToken] = useState(session.token);

  useEffect(() => {
    const out = () => {
      disconnectGateway();
      setSession(session.server, "");
      setToken("");
      useStore.setState({ ready: false, me: null });
    };
    window.addEventListener("llamble:unauthorized", out);
    return () => window.removeEventListener("llamble:unauthorized", out);
  }, []);

  useEffect(() => {
    if (!token) return;
    connectGateway();
    initAiWorker();
    return () => disconnectGateway();
  }, [token]);

  // desktop integration: hotkeys, invite links
  useEffect(() => {
    const n = window.llambleNative;
    if (!n) return;
    const a = n.onHotkey((k) => (k === "mute" ? toggleMute() : k === "deafen" ? toggleDeafen() : null));
    const b = n.onInvite((code) => openModal({ kind: "joinInvite", code }));
    return () => {
      a();
      b();
    };
  }, []);

  // unread badge
  useEffect(() => useStore.subscribe((s) => window.llambleNative?.setUnread(totalUnreadBadge(s))), []);

  // notifications for mentions + DMs
  useEffect(
    () =>
      onEvent(async (t, d) => {
        if (t === "CALL_RING") {
          sounds.ring();
          window.llambleNative?.flash();
          return;
        }
        if (t !== "MESSAGE_CREATE") return;
        const s = useStore.getState();
        const msg = d as Message;
        if (!s.me || msg.author.id === s.me.id) return;
        const ch = s.channels[msg.channel_id];
        if (!ch) return;
        const focused = window.llambleNative ? await window.llambleNative.isFocused() : document.hasFocus();
        const viewing = focused && currentChannelId() === ch.id;
        const important = ch.kind === "dm" || mentionsMe(msg.content, s.me);
        if (viewing || !important) return;
        if (localStorage.getItem("llamble.status") === "dnd") return;
        sounds.message();
        window.llambleNative?.flash();
        if (localStorage.getItem("llamble.notifications") !== "off" && "Notification" in window) {
          const where = ch.kind === "dm" ? "" : ` (#${ch.name}, ${s.guilds[ch.guild_id!]?.name ?? ""})`;
          const body = msg.content || (msg.attachments.length ? `📎 ${msg.attachments[0].filename}` : "");
          const notif = new Notification(memberName(ch.guild_id, msg.author) + where, { body: body.slice(0, 180), silent: true });
          notif.onclick = () => {
            window.llambleNative?.focus();
            selectChannel(ch.guild_id || "@me", ch.id);
          };
        }
      }),
    [],
  );

  if (!token || !session.server) return <Login onDone={(t) => setToken(t)} />;
  return <Shell />;
}

export async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {}
  window.dispatchEvent(new Event("llamble:unauthorized"));
}
