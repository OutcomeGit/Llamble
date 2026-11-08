import { useEffect, useRef, useState } from "react";
import { upload } from "../api";
import { api } from "../api";
import { can, memberName, useStore } from "../store";
import { P } from "../types";
import { toast } from "../ui";
import { prefs } from "../voice";
import { BUILTIN, loadSounds, playForAll, preview, useSoundboard } from "../soundboard";

/** The soundboard pop-up in a voice call. */
export function SoundboardPanel({ guildId, onClose }: { guildId: string | null; onClose: () => void }) {
  const sounds = useSoundboard((s) => (guildId ? s.sounds[guildId] : undefined)) || [];
  const manage = guildId ? can(guildId, P.MANAGE_GUILD) : false;
  const [vol, setVol] = useState(Number(prefs.get("soundboardVolume", "0.6")));
  const [muted, setMuted] = useState(prefs.get("soundboardMuted") === "1");
  const [adding, setAdding] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (guildId) loadSounds(guildId);
  }, [guildId]);
  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && onClose();
    const t = setTimeout(() => document.addEventListener("mousedown", close), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", close);
    };
  }, []);

  const fire = (id: string) => playForAll(id).catch((e) => toast(e.message, "error"));

  return (
    <div className="soundboard" ref={box}>
      <div className="sb-head">
        <b>Soundboard</b>
        <span className="muted small">Click to play for everyone · right-click to preview</span>
      </div>
      <div className="sb-grid">
        {BUILTIN.map((b) => (
          <button key={b.name} className="sb-btn" onClick={() => fire("builtin:" + b.name)} onContextMenu={(e) => (e.preventDefault(), preview({ builtin: b.name }))}>
            <span className="sb-emoji">{b.emoji}</span>
            {b.label}
          </button>
        ))}
        {sounds.map((s) => (
          <button key={s.id} className="sb-btn mine" onClick={() => fire(s.id)} onContextMenu={(e) => (e.preventDefault(), preview(s))}>
            <span className="sb-emoji">{s.emoji || "🔊"}</span>
            {s.name}
            {manage && (
              <span
                className="sb-del"
                title="Delete this sound"
                onClick={(e) => {
                  e.stopPropagation();
                  api(`/api/guilds/${guildId}/sounds/${s.id}`, { method: "DELETE" }).catch((er) => toast(er.message, "error"));
                }}
              >
                ×
              </span>
            )}
          </button>
        ))}
        {manage && !adding && (
          <button className="sb-btn add" onClick={() => setAdding(true)}>
            <span className="sb-emoji">＋</span>Add sound
          </button>
        )}
      </div>
      {adding && guildId && <AddSound guildId={guildId} onDone={() => setAdding(false)} />}
      <div className="sb-foot">
        <label className="check">
          <input
            type="checkbox"
            checked={muted}
            onChange={(e) => {
              setMuted(e.target.checked);
              prefs.set("soundboardMuted", e.target.checked ? "1" : "0");
            }}
          />{" "}
          Mute soundboard for me
        </label>
        <span className="row gap" style={{ alignItems: "center" }}>
          🔈
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={vol}
            onChange={(e) => {
              setVol(+e.target.value);
              prefs.set("soundboardVolume", e.target.value);
            }}
          />
        </span>
      </div>
    </div>
  );
}

function AddSound({ guildId, onDone }: { guildId: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!file) return;
    if (file.size > 1024 * 1024) return toast("Sound files can be up to 1 MB (about 5 seconds).", "error");
    setBusy(true);
    try {
      const f = await upload(file, file.name);
      await api(`/api/guilds/${guildId}/sounds`, { body: { name: name || file.name.replace(/\.\w+$/, ""), emoji, file_id: f.id } });
      onDone();
    } catch (e: any) {
      toast(e.message, "error");
    }
    setBusy(false);
  };
  return (
    <div className="sb-add">
      <input type="file" accept="audio/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <input placeholder="Name" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="Emoji" maxLength={4} value={emoji} onChange={(e) => setEmoji(e.target.value)} style={{ width: 70 }} />
      <button className="btn primary small" disabled={!file || busy} onClick={save}>
        {busy ? "Uploading…" : "Add"}
      </button>
      <button className="btn small" onClick={onDone}>
        Cancel
      </button>
      <div className="muted small" style={{ width: "100%" }}>
        mp3, ogg, wav or m4a, up to about 5 seconds. Free sounds: kenney.nl (all public domain) or freesound.org (filter by CC0).
      </div>
    </div>
  );
}

/** "🔊 Mom played Airhorn" for a couple of seconds. */
export function SoundboardTicker({ guildId }: { guildId: string | null }) {
  const last = useSoundboard((s) => s.last);
  const user = useStore((s) => (last ? s.users[last.who] : undefined));
  const [, tick] = useState(0);
  useEffect(() => {
    if (!last) return;
    const t = setTimeout(() => tick((n) => n + 1), 2600);
    return () => clearTimeout(t);
  }, [last]);
  if (!last || Date.now() - last.at > 2500) return null;
  return (
    <div className="sb-ticker">
      🔊 {memberName(guildId, user)} played <b>{last.name}</b>
    </div>
  );
}
