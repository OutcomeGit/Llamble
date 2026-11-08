import { useEffect, useRef, useState } from "react";
import { api, session } from "../api";
import { useStore } from "../store";
import { toast } from "../ui";
import { Toggle } from "./common";

/** Master Admin: talking with Llamble in voice calls (speech models, voice, notice). */
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
