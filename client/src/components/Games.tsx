import { useEffect, useState } from "react";
import { setShowPlaying, showPlaying, useGames } from "../games";
import { Toggle } from "./common";

type Custom = { games: Record<string, string>; ignored: Record<string, boolean> };

/** Settings → Games (Windows app): "Playing X", and fixing what counts as a game. */
export function GamesSettings() {
  const n = window.llambleNative?.games;
  const list = useGames((g) => g.list);
  const [on, setOn] = useState(showPlaying());
  const [custom, setCustom] = useState<Custom>({ games: {}, ignored: {} });
  const [running, setRunning] = useState<{ exe: string; title: string; game: string | null }[] | null>(null);
  const [pick, setPick] = useState("");
  const [name, setName] = useState("");
  useEffect(() => {
    n?.custom().then(setCustom);
  }, []);
  if (!n) return <p className="muted">Game detection needs the Windows app.</p>;

  const openList = async () => setRunning(await n.running());
  const add = async () => {
    if (!pick) return;
    setCustom(await n.mark(pick, name.trim() || running?.find((r) => r.exe === pick)?.title || pick));
    setPick("");
    setName("");
    setRunning(null);
  };

  return (
    <div>
      <h2>Games</h2>
      <p className="muted small">
        Llamble notices games you have open (Steam, Epic, GOG, Xbox, EA, Ubisoft, Riot, Roblox, Minecraft and more). That lets you stream a game in one
        click from a call, and it's picked first when you share your screen or record a show. It checks every 15 seconds and nothing leaves this PC
        unless the setting below is on.
      </p>
      <div className="perm-row">
        <div>
          <div className="bold">Show what I'm playing</div>
          <div className="muted small">People in your servers see "Playing Roblox" under your name. Hidden while you're set to Invisible.</div>
        </div>
        <Toggle
          on={on}
          onChange={(v) => {
            setOn(v);
            setShowPlaying(v);
          }}
        />
      </div>

      <div className="profile-section">Open right now</div>
      {list.length ? (
        list.map((g) => (
          <div key={g.exe} className="perm-row">
            <div>
              <div className="bold">🎮 {g.name}</div>
              <div className="muted small">{g.exe}.exe</div>
            </div>
            <button className="btn small" onClick={async () => setCustom(await n.mark(g.exe, null))} title="Stop treating this as a game">
              Not a game
            </button>
          </div>
        ))
      ) : (
        <p className="muted small">No games open.</p>
      )}

      <div className="profile-section">Add a game Llamble missed</div>
      {running === null ? (
        <button className="btn" onClick={openList}>
          Pick from open windows…
        </button>
      ) : (
        <div className="row gap center-v" style={{ flexWrap: "wrap" }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: 2, minWidth: 220 }}>
            <option value="">Choose a window…</option>
            {running
              .filter((r) => !r.game)
              .map((r) => (
                <option key={r.exe} value={r.exe}>
                  {r.title} ({r.exe}.exe)
                </option>
              ))}
          </select>
          <input placeholder="Game name (optional)" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <button className="btn primary" disabled={!pick} onClick={add}>
            Add
          </button>
          <button className="btn" onClick={() => setRunning(null)}>
            Cancel
          </button>
        </div>
      )}

      {(Object.keys(custom.games).length > 0 || Object.keys(custom.ignored).length > 0) && (
        <>
          <div className="profile-section">Your changes</div>
          {Object.entries(custom.games).map(([exe, nm]) => (
            <div key={exe} className="perm-row">
              <div>
                <div className="bold">{nm}</div>
                <div className="muted small">{exe}.exe · added as a game</div>
              </div>
              <button className="btn small" onClick={async () => setCustom(await n.reset(exe))}>
                Remove
              </button>
            </div>
          ))}
          {Object.keys(custom.ignored).map((exe) => (
            <div key={exe} className="perm-row">
              <div>
                <div className="bold">{exe}.exe</div>
                <div className="muted small">marked "not a game"</div>
              </div>
              <button className="btn small" onClick={async () => setCustom(await n.reset(exe))}>
                Undo
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
