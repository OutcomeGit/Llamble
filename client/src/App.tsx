import { initReplay } from "./replay";
import { useEffect, useState } from "react";
import { EmailResetLanding } from "./components/Recovery";
import { api, session, setSession } from "./api";
import { initAiWorker } from "./aiWorker";
import { startGameDetection } from "./games";
import "./notes"; // loads Home (notes + highlights) after connecting
import "./alarms"; // alarms (ringing, local backup timers)
import { AlarmRinging, AlarmSuggestion } from "./components/Alarms";
import { connectGateway, disconnectGateway } from "./gateway";
import { Login } from "./components/Login";
import { Shell } from "./components/Shell";
import { currentChannelId, homeOf, memberName, mentionsMe, onEvent, selectChannel, totalUnreadBadge, useStore } from "./store";
import { openModal } from "./ui";
import { toggleDeafen, toggleMute } from "./voice";
import { sounds } from "./sounds";
import { autoEffect, playEffect } from "./effects";
import { pushOverlayAlert, startOverlayFeed } from "./overlay";
import { avatarUrl } from "./api";
import type { Message } from "./types";

// a shared invite link (https://server/invite/CODE) opened in a browser
const webInvite = (() => {
  if (window.llambleNative) return null;
  const code = new URLSearchParams(location.search).get("invite");
  if (!code) return null;
  history.replaceState(null, "", location.pathname);
  sessionStorage.setItem("llamble.invite", code);
  return code;
})();

// an emailed password-reset link: ?reset=ID.SECRET
const emailReset = (() => {
  const v = new URLSearchParams(location.search).get("reset");
  if (!v || !v.includes(".")) return null;
  history.replaceState(null, "", location.pathname);
  const [id, secret] = v.split(".", 2);
  return { id, secret };
})();

export default function App() {
  const [token, setToken] = useState(session.token);
  const [resetDone, setResetDone] = useState(false);

  // already signed in: offer to join right away
  useEffect(() => {
    if (webInvite && token) {
      sessionStorage.removeItem("llamble.invite");
      openModal({ kind: "joinInvite", code: webInvite });
    }
  }, []);

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
    startGameDetection();
    return () => disconnectGateway();
  }, [token]);

  // desktop integration: hotkeys, invite links
  useEffect(() => {
    const n = window.llambleNative;
    if (!n) return;
    initReplay();
    const a = n.onHotkey((k) => (k === "mute" ? toggleMute() : k === "deafen" ? toggleDeafen() : null));
    const b = n.onInvite((code) => openModal({ kind: "joinInvite", code }));
    return () => {
      a();
      b();
    };
  }, []);

  // feed the overlay (Windows overlay window / browser pop-out)
  useEffect(() => startOverlayFeed(), []);

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
        const msg = d as Message & { effect?: string };
        if (!s.me || msg.author.id === s.me.id) return;
        const ch = s.channels[msg.channel_id];
        if (!ch) return;
        const focused = window.llambleNative ? await window.llambleNative.isFocused() : document.hasFocus();
        const viewing = focused && currentChannelId() === ch.id;
        if (currentChannelId() === ch.id && document.visibilityState === "visible") {
          const fx = msg.effect || autoEffect(msg.content);
          if (fx) playEffect(fx);
        }
        const important = ch.kind === "dm" || mentionsMe(msg.content, s.me);
        if (viewing || !important) return;
        pushOverlayAlert(
          {
            id: msg.id,
            author: memberName(ch.guild_id, msg.author),
            avatar: avatarUrl(msg.author.avatar_file_id),
            text: (msg.content || (msg.attachments.length ? "📎 " + msg.attachments[0].filename : "")).slice(0, 160),
            where: ch.kind === "dm" ? "Direct message" : "#" + ch.name,
            ts: Date.now(),
          },
          true,
        );
        if (localStorage.getItem("llamble.status") === "dnd") return;
        sounds.message();
        window.llambleNative?.flash();
        if (localStorage.getItem("llamble.notifications") !== "off" && "Notification" in window) {
          const where = ch.kind === "dm" ? "" : ` (#${ch.name}, ${s.guilds[ch.guild_id!]?.name ?? ""})`;
          const body = msg.content || (msg.attachments.length ? `📎 ${msg.attachments[0].filename}` : "");
          const notif = new Notification(memberName(ch.guild_id, msg.author) + where, { body: body.slice(0, 180), silent: true, tag: "m:" + msg.id });
          notif.onclick = () => {
            window.llambleNative?.focus();
            selectChannel(homeOf(ch), ch.id);
          };
        }
      }),
    [],
  );

  if (emailReset && !resetDone) return <EmailResetLanding server={location.origin} id={emailReset.id} secret={emailReset.secret} onDone={(t) => (setResetDone(true), setToken(t))} />;
  if (!token || !session.server) return <Login onDone={(t) => setToken(t)} />;
  return (
    <>
      <Shell />
      <AlarmSuggestion />
      <AlarmRinging />
    </>
  );
}

export async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {}
  window.dispatchEvent(new Event("llamble:unauthorized"));
}
