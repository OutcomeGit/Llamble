// Home → Library: your things. For now: Recordings (post history and files come later).
//
// A show recorded on your app lives on your device. It only goes to the server when you do
// something with it here: Add to Highlights, Publish as a Show, or Post the video.
import { useEffect, useMemo, useState } from "react";
import { api, media } from "../api";
import * as localrec from "../localrec";
import { addHighlight } from "../notes";
import type { Show } from "../show";
import { can, memberName, useStore } from "../store";
import { P } from "../types";
import { toast } from "../ui";
import { Player } from "./Show";

type ServerRec = Show & { channel_name?: string };
type Row = { id: string; local?: localrec.LocalRec; server?: ServerRec };

export function Library() {
  return (
    <div className="library">
      <h1 className="library-title">📚 Library</h1>
      <Recordings />
    </div>
  );
}

export function Recordings() {
  const [server, setServer] = useState<ServerRec[] | null>(null);
  const [local, setLocal] = useState<localrec.LocalRec[] | null>(null);
  const [where, setWhere] = useState("");
  const load = () => {
    api("/api/shows")
      .then(setServer)
      .catch(() => setServer([]));
    localrec.list().then(setLocal);
  };
  useEffect(() => {
    load();
    localrec.whereKept().then(setWhere);
  }, []);
  const rows = useMemo(() => {
    const m = new Map<string, Row>();
    for (const l of local || []) m.set(l.id, { id: l.id, local: l });
    for (const s of server || []) m.set(s.id, { ...(m.get(s.id) || { id: s.id }), server: s });
    const when = (r: Row) => r.server?.started_at || r.local?.meta.started_at || 0;
    return [...m.values()].sort((a, b) => when(b) - when(a));
  }, [server, local]);
  if (!server || !local) return <p className="muted">Loading…</p>;
  return (
    <div>
      <h2>Recordings</h2>
      <p className="muted small">
        Shows you were in, crewed, or that your kids were in. A show recorded on your app stays on your device ({where}) and only goes to the server when you share it: add it to
        Highlights, publish it as a Show, or post the video.
      </p>
      {!rows.length && <p className="muted">No recordings yet. Start one with the 🎬 button in a voice call.</p>}
      {rows.map((r) => (
        <RecordingRow key={r.id} r={r} reload={load} />
      ))}
    </div>
  );
}

function RecordingRow({ r, reload }: { r: Row; reload: () => void }) {
  const me = useStore((s) => s.me);
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const s = r.server;
  const meta = r.local?.meta;
  const onServer = !!s?.on_server;
  const title = s?.title || meta?.title || "Show";
  const started = s?.started_at || meta?.started_at || 0;
  const ended = s?.ended_at || meta?.ended_at || 0;
  const size = r.local?.size ?? s?.size ?? 0;
  const guildId = s ? channels[s.channel_id]?.guild_id ?? null : null;
  const crew = !!s && !!me && ([s.initiator_id, s.recorder_id, s.director_id].includes(me.id) || !!me.is_admin);
  const canDelete = !s || (!!me && (s.initiator_id === me.id || s.recorder_id === me.id || !!me.is_admin));
  const name = (uid: string) => memberName(null, users[uid]);
  const [busy, setBusy] = useState<string | null>(null);
  const [panel, setPanel] = useState<null | "show" | "video">(null);
  const [src, setSrc] = useState<string | null>(null);
  const shareable = !!s && (onServer || !!r.local) && crew;

  // play from this device if it's here, else from the server
  useEffect(() => {
    let url: string | null = null;
    let gone = false;
    if (r.local) {
      localrec.playUrl(r.id).then((u) => {
        if (gone) return URL.revokeObjectURL(u);
        url = u;
        setSrc(u);
      });
    } else if (onServer) setSrc(media(`/api/shows/${r.id}/video`));
    return () => {
      gone = true;
      if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
    };
  }, [r.id, !!r.local, onServer]);

  /** Make sure the server has it (uploads from this device the first time). */
  const ensureOnServer = async () => {
    if (onServer) return;
    if (!r.local) throw new Error("The video is on the recorder's device. They need to share it.");
    setBusy("Uploading 0%");
    await localrec.uploadToServer(r.id, (f) => setBusy(`Uploading ${Math.round(f * 100)}%`));
  };
  const act = async (label: string, f: () => Promise<unknown>, done: string) => {
    try {
      setBusy(label);
      await f();
      toast(done);
      reload();
    } catch (e: any) {
      toast(e.message || String(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const highlight = () =>
    act(
      "Uploading…",
      async () => {
        await ensureOnServer();
        await addHighlight(guildId!, { show_id: r.id });
      },
      "Added to Highlights",
    );
  const removeHere = () => act("Deleting…", () => localrec.remove(r.id), "Deleted from this device");
  const removeAll = () => {
    if (!confirm(`Delete "${title}" everywhere? ${onServer ? "Posts and highlights that play it go too." : ""}`)) return;
    act(
      "Deleting…",
      async () => {
        if (r.local) await localrec.remove(r.id);
        if (s) await api(`/api/shows/${r.id}`, { method: "DELETE" });
      },
      "Deleted",
    );
  };

  return (
    <div className="recording">
      <div className="row gap" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
        <div>
          <b>{title}</b>{" "}
          <span className="muted small">
            {s?.channel_name || meta?.channel_name ? "🔊 " + (s?.channel_name || meta?.channel_name) + " · " : ""}
            {started ? new Date(started).toLocaleString() : ""}
            {started && ended ? ` · ${Math.max(1, Math.round((ended - started) / 60000))} min` : ""}
            {size ? ` · ${(size / 1e6).toFixed(0)} MB` : ""}
          </span>
          <div className="muted small">
            {r.local ? "💾 On this device" : ""}
            {r.local && onServer ? " · " : ""}
            {onServer ? "☁️ On the server" : ""}
            {!r.local && !onServer && s ? `💾 On ${s.recorder_id === me?.id ? "another device of yours" : name(s.recorder_id) + "'s device"}` : ""}
            {s && (
              <>
                {" · With "}
                {s.people
                  .filter((p) => p.consent && (p.consent.voice || p.consent.camera || p.consent.screen))
                  .map((p) => name(p.user_id))
                  .join(", ")}
              </>
            )}
          </div>
        </div>
        {busy ? (
          <span className="muted small">{busy}</span>
        ) : (
          <span className="row gap" style={{ flexWrap: "wrap" }}>
            {shareable && guildId && can(guildId, P.ADD_HIGHLIGHTS) && (
              <button className="btn small" title="Add it to its server's Highlights (uploads it if it's only on this device)" onClick={highlight}>
                ✨ Add to Highlights
              </button>
            )}
            {shareable && (
              <button className={"btn small" + (panel === "show" ? " primary" : "")} title="Post it as a Show" onClick={() => setPanel(panel === "show" ? null : "show")}>
                🎬 Publish as a Show
              </button>
            )}
            {shareable && (
              <button className={"btn small" + (panel === "video" ? " primary" : "")} title="Post just the video in a channel" onClick={() => setPanel(panel === "video" ? null : "video")}>
                Post the video
              </button>
            )}
            {r.local ? (
              <button className="btn small" onClick={() => localrec.download(r.id, title)}>
                {window.llambleNative ? "Show in folder" : "Download"}
              </button>
            ) : onServer ? (
              <a className="btn small" href={media(`/api/shows/${r.id}/video`)} download>
                Download
              </a>
            ) : null}
            {r.local && (onServer || !s) && (
              <button className="btn small" title="Keep it on the server, remove it from this device" onClick={removeHere}>
                Delete from this device
              </button>
            )}
            {canDelete && (
              <button className="btn small red" onClick={removeAll}>
                {r.local && onServer ? "Delete everywhere" : "Delete"}
              </button>
            )}
          </span>
        )}
      </div>
      {panel && s && (
        <PublishPanel
          style={panel}
          defaultGuild={guildId}
          onCancel={() => setPanel(null)}
          onPublish={(channelId, comment) =>
            act(
              "Uploading…",
              async () => {
                await ensureOnServer();
                await api(`/api/shows/${r.id}/publish`, { body: { channel_id: channelId, style: panel, comment } });
                setPanel(null);
              },
              panel === "show" ? "Published as a Show" : "Posted",
            )
          }
        />
      )}
      {src && <Player src={src} />}
    </div>
  );
}

function PublishPanel({ style, defaultGuild, onCancel, onPublish }: { style: "show" | "video"; defaultGuild: string | null; onCancel: () => void; onPublish: (channelId: string, comment: string) => void }) {
  const guildOrder = useStore((s) => s.guildOrder);
  const guilds = useStore((s) => s.guilds);
  const channels = useStore((s) => s.channels);
  // raw store objects in, list built here (building it inside a selector loops React)
  const groups = useMemo(() => {
    const ids = defaultGuild ? [defaultGuild, ...guildOrder.filter((g) => g !== defaultGuild)] : guildOrder;
    return ids
      .filter((g) => guilds[g])
      .map((g) => ({
        name: guilds[g].name,
        chans: Object.values(channels)
          .filter((c) => c.guild_id === g && c.kind === "text" && can(g, P.SEND))
          .sort((a, b) => a.position - b.position),
      }))
      .filter((g) => g.chans.length);
  }, [guildOrder, guilds, channels, defaultGuild]);
  const [to, setTo] = useState(groups[0]?.chans[0]?.id || "");
  const [comment, setComment] = useState("");
  return (
    <div className="publish-panel">
      <div className="row gap" style={{ flexWrap: "wrap", alignItems: "center" }}>
        <label>
          {style === "show" ? "Publish in" : "Post in"}{" "}
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {groups.map((g) => (
              <optgroup key={g.name} label={g.name}>
                {g.chans.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <input placeholder={style === "show" ? "Say something about it (optional)" : "Message (optional)"} value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <button className="btn small primary" disabled={!to} onClick={() => onPublish(to, comment)}>
          {style === "show" ? "Publish" : "Post"}
        </button>
        <button className="btn small" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="muted small">Everyone who can see that channel will be able to watch it.{style === "show" ? " It's posted as a Show, with its title and who's in it." : ""}</p>
    </div>
  );
}
