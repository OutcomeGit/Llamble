import { useEffect, useRef, useState } from "react";
import { api, session } from "../api";
import { useStore } from "../store";
import { toast } from "../ui";
import { Toggle } from "./common";
import { testHearing } from "../listen";

/** Master Admin: talking with Llamble in voice calls (speech models, voice, notice). */
/** Master Admin: what the bot may look up (chat and voice). */
export function BotToolsAdmin() {
  const [t, setT] = useState<any>(null);
  useEffect(() => {
    api("/api/admin/bot-tools").then(setT).catch(() => {});
  }, []);
  if (!t) return null;
  const save = (patch: any) =>
    api("/api/admin/bot-tools", { method: "PUT", body: { ...t, ...patch } })
      .then(setT)
      .catch((e) => toast(e.message, "error"));
  return (
    <div>
      <div className="profile-section">What the AI can look up</div>
      <div className="perm-row">
        <div>
          <div className="bold">Time and calculator</div>
          <div className="muted small">Knows today's date and time (in each person's own time zone) and does exact maths instead of guessing.</div>
        </div>
        <Toggle on={t.basic} onChange={(v) => save({ basic: v })} />
      </div>
      <div className="perm-row">
        <div>
          <div className="bold">Internet: web search, reading web pages, weather</div>
          <div className="muted small">Searches go to DuckDuckGo (or your own SearXNG below); weather comes from Open-Meteo. Only the search words or place name are sent, never your chats. Kids get strict safe search.</div>
        </div>
        <Toggle on={t.web} onChange={(v) => save({ web: v })} />
      </div>
      {t.web && (
        <label>
          Your own SearXNG search (optional)
          <input placeholder="http://192.168.1.20:8888" defaultValue={t.searxng_url} onBlur={(e) => e.target.value !== t.searxng_url && save({ searxng_url: e.target.value })} />
        </label>
      )}
      <p className="muted small">Works with models that support tool calls (Qwen3, Llama 3.1+, Mistral, and most recent ones). Lent GPUs need the latest Windows app.</p>
    </div>
  );
}

export function VoiceAiAdmin() {
  const [d, setD] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const notice = useRef<HTMLTextAreaElement>(null);
  const load = () => api("/api/admin/voice-ai").then(setD).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);
  if (!d) return null;
  const s = d.settings;
  const st = d.status;
  const save = (patch: any) =>
    api("/api/admin/voice-ai", { method: "PUT", body: patch })
      .then(setD)
      .catch((e) => toast(e.message, "error"));
  const hear = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${session.server}/api/admin/voice-ai/preview`, {
        method: "POST",
        headers: { Authorization: "Bearer " + session.token, "content-type": "application/json" },
        body: JSON.stringify({ voice: s.voice, speed: s.speed }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "couldn't make speech");
      const a = new Audio(URL.createObjectURL(await r.blob()));
      a.play();
    } catch (e: any) {
      toast(e.message, "error");
    }
    setBusy(false);
  };
  const pct = st.total_bytes ? Math.round((st.done_bytes / st.total_bytes) * 100) : 0;
  return (
    <div>
      <div className="profile-section">Talking with Llamble in voice calls</div>
      <p className="muted small">
        People say "Hey Llamble" in a voice call and it answers out loud for everyone. Speech is turned into text here on the NAS (Whisper) and answers are spoken with Kokoro, a natural-sounding voice that runs on the CPU. Nothing is
        sent anywhere else. Each server's owner decides whether Llamble listens in their server (Server Settings → AI Bot).
      </p>
      {!d.installed && <p className="error-text">This server build doesn't include the speech tools. Update the Llamble image.</p>}
      <div className="perm-row">
        <div>
          <div className="bold">Allow voice conversations on this Llamble server</div>
        </div>
        <Toggle on={s.enabled} onChange={(v) => save({ enabled: v })} />
      </div>
      {s.enabled && (
        <>
          <div className={"rs " + (st.stt === "ready" && st.tts === "ready" ? "ok" : st.error ? "err" : "off")}>
            <b>Speech models</b>{" "}
            {st.downloading
              ? `downloading ${st.downloading}… ${pct}%`
              : st.error
                ? st.error
                : st.stt === "ready" && st.tts === "ready"
                  ? "ready"
                  : "waiting to download"}
          </div>
          <label>
            Speech recognition
            <select value={s.stt} onChange={(e) => save({ stt: e.target.value })}>
              {d.stt_models.map((m: any) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.note}
                </option>
              ))}
            </select>
          </label>
          <div className="row gap" style={{ alignItems: "flex-end" }}>
            <label style={{ flex: 1 }}>
              Llamble's voice
              <select value={s.voice} onChange={(e) => save({ voice: Number(e.target.value) })}>
                {d.voices.map((v: any) => (
                  <option key={v.sid} value={v.sid}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Speed
              <select value={s.speed} onChange={(e) => save({ speed: Number(e.target.value) })}>
                {[0.8, 0.9, 1, 1.1, 1.2, 1.35].map((x) => (
                  <option key={x} value={x}>
                    {x}×
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" disabled={busy || st.tts !== "ready"} onClick={hear}>
              {busy ? "Speaking…" : "▶ Hear it"}
            </button>
          </div>
          <ListeningWhere />
          <label>
            Wake phrases (one per line; {"{name}"} is the bot's name)
            <textarea
              rows={4}
              defaultValue={(s.wake_phrases || []).join("\n")}
              placeholder={"hey {name}\nharo {name}"}
              onBlur={(e) => {
                const list = e.target.value.split("\n").map((x) => x.trim()).filter(Boolean);
                if (list.join("\n") !== (s.wake_phrases || []).join("\n")) save({ wake_phrases: list });
              }}
            />
          </label>
          <p className="muted small">Anything works, like "haro {"{name}"}" or a phrase without the name at all. Close spellings count too, since speech recognition isn't perfect. Use "{"{name}"}" alone to wake it by just its name at the start of a sentence.</p>
          <label>
            Keep listening after an answer (conversation mode)
            <select value={s.follow_up_secs ?? 20} onChange={(e) => save({ follow_up_secs: Number(e.target.value) })}>
              <option value={0}>Off: say the wake phrase every time</option>
              <option value={10}>10 seconds</option>
              <option value={20}>20 seconds</option>
              <option value={30}>30 seconds</option>
              <option value={60}>1 minute</option>
            </select>
          </label>
          <p className="muted small">After answering, it keeps listening to the person who asked, so they can just keep talking. Everyone else still needs the wake phrase. Saying "thanks" or "that's all" ends it early.</p>
          <MicTest />
          <div className="muted small">
            Since the server started: {d.activity.received} bits of speech received, {d.activity.recognized} understood, {d.activity.wakes} times called by name, {d.activity.answers} answers.
            {d.activity.last_error ? ` Last problem: ${d.activity.last_error}` : ""}
          </div>
          <label>
            Notice people see the first time they join a call where Llamble listens
            <textarea ref={notice} rows={4} defaultValue={s.notice} onBlur={(e) => e.target.value !== s.notice && save({ notice: e.target.value })} />
          </label>
          <p className="muted small">
            Kept in memory only: the last ~10 back-and-forths of each call, erased as it goes and when the call ends. Calls with a kid in them are saved as text for that kid's parents (Settings → Family).
          </p>
        </>
      )}
    </div>
  );
}

/** Server owners: let Llamble listen in this server's voice channels. */
export function GuildVoiceListen({ guildId, botEnabled, value, onChange }: { guildId: string; botEnabled: boolean; value: boolean; onChange: (v: boolean) => void }) {
  const available = useStore((s) => (s.config as any).voice_ai?.available as boolean | undefined);
  const me = useStore((s) => s.me);
  return (
    <div className="perm-row">
      <div>
        <div className="bold">Listen in voice channels ("Hey Llamble")</div>
        <div className="muted small">
          {!available
            ? me?.instance_role === "master"
              ? "Turn on voice conversations first: Settings → AI Model → Talking with Llamble."
              : "The Llamble server's owner hasn't turned on voice conversations yet."
            : !botEnabled
              ? "Enable the AI bot above first."
              : "People in calls can say \"Hey Llamble\" and get a spoken answer. Everyone sees that it's listening."}
        </div>
      </div>
      <Toggle
        on={value}
        disabled={!available || !botEnabled}
        onChange={(v) =>
          api(`/api/guilds/${guildId}/voice-listen`, { method: "PUT", body: { voice_listen: v } })
            .then(() => onChange(v))
            .catch((e) => toast(e.message, "error"))
        }
      />
    </div>
  );
}

/** Say "Hey Llamble, …" and see exactly what it understood. */
export function MicTest() {
  const [state, setState] = useState<"idle" | "listening" | "thinking">("idle");
  const [res, setRes] = useState<{ text: string; wake: boolean; question: string | null; seconds: number } | null>(null);
  const bot = useStore((s) => s.config.bot?.name || "Llamble");
  const go = async () => {
    setRes(null);
    setState("listening");
    try {
      const p = testHearing(5);
      setTimeout(() => setState("thinking"), 5000);
      setRes(await p);
    } catch (e: any) {
      toast(e.message, "error");
    }
    setState("idle");
  };
  return (
    <div className="mic-test">
      <button className="btn" disabled={state !== "idle"} onClick={go}>
        {state === "listening" ? `🎙 Listening… say "Hey ${bot}, what time is it?"` : state === "thinking" ? "Working it out…" : "🎙 Test: what does it hear?"}
      </button>
      {res && (
        <div className="small" style={{ marginTop: 6 }}>
          Heard: <b>“{res.text || "(nothing)"}”</b> in {res.seconds.toFixed(1)}s ·{" "}
          {res.wake ? <span style={{ color: "#57f287" }}>✓ heard its name — question: “{res.question}”</span> : <span style={{ color: "#f0b232" }}>didn't hear its name</span>}
        </div>
      )}
    </div>
  );
}

function ListeningWhere() {
  const cfg = useStore((s) => (s.config as any).voice_ai);
  const guilds = useStore((s) => s.guilds);
  if (!cfg) return <p className="error-text small">This app doesn't see the voice settings yet — reload the app.</p>;
  const names = (cfg.guilds as string[]).map((g) => guilds[g]?.name || "a server you're not in");
  return (
    <p className="small">
      {cfg.available ? (names.length ? <>Listening in: <b>{names.join(", ")}</b></> : "Not listening in any server yet: turn it on in Server Settings → AI Bot.") : "Not available yet (models still getting ready)."}
    </p>
  );
}
