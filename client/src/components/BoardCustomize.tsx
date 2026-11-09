// "Customize": what each server puts on my boards. Notes off also means nobody there can leave me notes.
import { useState } from "react";
import { setGuildPrefs, setLlambleNewsPref } from "../notes";
import { useStore } from "../store";
import type { GuildBoardPrefs, HighlightType } from "../types";
import { toast } from "../ui";
import { Toggle } from "./common";

export const HIGHLIGHT_TYPES: [HighlightType, string][] = [
  ["shows", "Shows"],
  ["pictures", "Pictures"],
  ["videos", "Videos"],
  ["recordings", "Recordings"],
  ["links", "Links"],
  ["posts", "Posts"],
];

export function BoardCustomize({ onClose }: { onClose: () => void }) {
  const order = useStore((s) => s.guildOrder);
  const guilds = useStore((s) => s.guilds);
  const prefs = useStore((s) => s.boardPrefs);
  const llamble = useStore((s) => s.llambleNews);
  const [busy, setBusy] = useState(false);
  const save = async (gid: string, patch: Partial<GuildBoardPrefs>) => {
    setBusy(true);
    try {
      await setGuildPrefs(gid, patch);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="hb-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="hb-modal hb-customize">
        <h2>Customize your board</h2>
        <p className="muted small">Choose what each server puts on your Home board.</p>
        {order
          .filter((g) => guilds[g])
          .map((g) => {
            const p: GuildBoardPrefs = prefs.guilds[g] ?? { notes: true, highlights: true, news: true, highlight_types: "all" };
            const types = p.highlight_types === "all" ? HIGHLIGHT_TYPES.map(([t]) => t) : p.highlight_types;
            return (
              <div key={g} className="hb-cust-row">
                <div className="bold">{guilds[g].name}</div>
                <div className="hb-cust-toggles">
                  <label>
                    <Toggle on={p.notes} onChange={(v) => save(g, { notes: v })} /> Notes
                  </label>
                  <label>
                    <Toggle on={p.highlights} onChange={(v) => save(g, { highlights: v })} /> Highlights
                  </label>
                  <label>
                    <Toggle on={p.news} onChange={(v) => save(g, { news: v })} /> News
                  </label>
                </div>
                {!p.notes && <div className="muted small">Off: people in this server can't leave you notes, and notes to everyone there won't show up for you.</div>}
                {p.highlights && (
                  <div className="hb-cust-types">
                    <span className="muted small">Highlight types:</span>
                    {HIGHLIGHT_TYPES.map(([t, label]) => {
                      const on = types.includes(t);
                      return (
                        <button
                          key={t}
                          disabled={busy}
                          className={"hb-chip" + (on ? " on" : "")}
                          onClick={() => {
                            const next = on ? types.filter((x) => x !== t) : [...types, t];
                            save(g, { highlight_types: next.length === HIGHLIGHT_TYPES.length ? "all" : next });
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        <div className="hb-cust-row">
          <div className="bold">Llamble news</div>
          <label className="hb-cust-toggles">
            <Toggle
              on={prefs.llamble_news}
              onChange={(v) => setLlambleNewsPref(v).catch((e) => toast(e.message, "error"))}
            />{" "}
            What's new in Llamble, from the Llamble project
          </label>
          {llamble && !llamble.enabled && <div className="muted small">This instance's admin has Llamble news turned off.</div>}
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
