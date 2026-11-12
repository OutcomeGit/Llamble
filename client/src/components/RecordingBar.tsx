// The bar at the top while this PC records your screen (nativerec.ts): how long, what's
// encoding it, how smoothly it's keeping up, the file size, and Stop.
import { useEffect, useState } from "react";
import { stopRecording, useNativeRec } from "../nativerec";

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s % 60).padStart(2, "0");
};

export function RecordingBar() {
  const r = useNativeRec();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!r.active) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [r.active]);
  if (!r.active) return null;
  const a = r.active;
  const sound = a.sound === "none" ? "no sound" : a.sound === "app" ? "app sound" : a.sound.startsWith("game:") ? a.sound.slice(5) + " sound" : "PC sound";
  return (
    <div className="rec-bar">
      <span className="rec-dot" /> <b>{clock(Date.now() - a.startedAt)}</b>
      <span className="muted small">
        {a.width}×{a.height} · {a.codec} on the {a.gpu ? "graphics card" : "processor"} · {r.fps} fps{r.dropped ? ` (${r.dropped} skipped)` : ""} · {sound} · {(r.bytes / 1e6).toFixed(0)} MB
      </span>
      {r.error && <span className="rec-err small">{r.error}</span>}
      <button className="btn small danger" disabled={r.stopping} onClick={stopRecording}>
        {r.stopping ? "Saving…" : "■ Stop"}
      </button>
    </div>
  );
}
