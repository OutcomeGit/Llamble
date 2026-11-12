import { useMemo, useState } from "react";
import { api } from "../api";
import { homeOf, selectChannel, useStore } from "../store";
import type { Message } from "../types";
import { closeModal, toast } from "../ui";
import { Icon } from "./common";

type Dest = { id: string; label: string; group: string; guildId: string | null };

/** "Share to…": send a message (text, links, pictures, files) to another channel or DM. */
export function ShareModal({ msg }: { msg: Message }) {
  const me = useStore((s) => s.me);
  // raw store objects in, list built with useMemo: building new objects inside a store
  // selector makes React re-render forever (error #185)
  const guildOrder = useStore((s) => s.guildOrder);
  const guilds = useStore((s) => s.guilds);
  const channels = useStore((s) => s.channels);
  const dests = useMemo(() => {
    const out: Dest[] = [];
    for (const gid of guildOrder) {
      const g = guilds[gid];
      if (!g) continue;
      Object.values(channels)
        .filter((c) => c.guild_id === gid && c.kind === "text")
        .sort((a, b) => a.position - b.position)
        .forEach((c) => out.push({ id: c.id, label: "#" + c.name, group: g.name, guildId: gid }));
    }
    Object.values(channels)
      .filter((c) => !c.guild_id && c.recipients?.length)
      .forEach((c) => {
        const others = (c.recipients || []).filter((r) => r.id !== me?.id);
        out.push({ id: c.id, label: "@" + (others.map((r) => r.display_name).join(", ") || "Notes to self"), group: "Direct messages", guildId: null });
      });
    return out;
  }, [guildOrder, guilds, channels, me?.id]);
  const [q, setQ] = useState("");
  const [to, setTo] = useState<Dest | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return dests.filter((d) => d.id !== msg.channel_id && (!t || d.label.toLowerCase().includes(t) || d.group.toLowerCase().includes(t)));
  }, [dests, q]);

  const send = async (dest: Dest | null = to): Promise<boolean> => {
    if (!dest) return false;
    setBusy(true);
    try {
      await api(`/api/messages/${msg.id}/share`, { body: { channel_id: dest.id, comment } });
      closeModal();
      toast(`Shared to ${dest.label}`);
      return true;
    } catch (e: any) {
      toast(e.message, "error");
      setBusy(false);
      return false;
    }
  };

  const preview = msg.content.trim() || (msg.attachments.length ? `${msg.attachments.length} attachment${msg.attachments.length > 1 ? "s" : ""}` : "");
  let lastGroup = "";
  return (
    <div className="modal share-modal">
      <h2>Share to…</h2>
      <div className="share-preview muted small">
        <Icon name="share" size={14} /> {msg.author.display_name}: {preview.slice(0, 140)}
        {preview.length > 140 ? "…" : ""}
      </div>
      <input autoFocus placeholder="Search channels and people" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="share-list">
        {list.length === 0 && <div className="muted pad">Nothing matches.</div>}
        {list.map((d) => {
          const head = d.group !== lastGroup ? (lastGroup = d.group) : null;
          return (
            <div key={d.id}>
              {head && <div className="share-group">{head}</div>}
              <button className={"share-dest" + (to?.id === d.id ? " on" : "")} onClick={() => setTo(d)} onDoubleClick={() => send(d)}>
                {d.label}
              </button>
            </div>
          );
        })}
      </div>
      <input placeholder="Add a comment (optional)" value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
      <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 10 }}>
        <button className="btn" onClick={closeModal}>
          Cancel
        </button>
        {to && (
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              if (await send()) selectChannel(to.guildId ?? homeOf(useStore.getState().channels[to.id]), to.id);
            }}
          >
            Share & go there
          </button>
        )}
        <button className="btn primary" disabled={!to || busy} onClick={() => send()}>
          {to ? `Share to ${to.label}` : "Pick where to share"}
        </button>
      </div>
      {me && <div className="muted small" style={{ marginTop: 6 }}>It's posted by you, credited to {msg.author.display_name}, with pictures and files included.</div>}
    </div>
  );
}
