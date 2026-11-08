import { useEffect, useState } from "react";

type Row = { label: string; what: string; pid: number; mb: number | null; cpu: number | null };

/** Settings → Performance (Windows app): where the app's memory and CPU go, live. */
export function PerformanceSettings() {
  const metrics = window.llambleNative?.metrics;
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    if (!metrics) return;
    let alive = true;
    const tick = () => metrics().then((r) => alive && setRows(r)).catch(() => {});
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!metrics) return <p className="muted">This needs the Windows app. In a browser, the browser's own task manager (Shift+Esc in Chrome) shows the same thing.</p>;
  if (!rows) return <p className="muted">Measuring…</p>;

  // group same-label processes (e.g. several helpers) into one line
  const groups = new Map<string, { what: string; mb: number; cpu: number; n: number; unknown: boolean }>();
  for (const r of rows) {
    const g = groups.get(r.label) || { what: r.what, mb: 0, cpu: 0, n: 0, unknown: false };
    g.mb += r.mb ?? 0;
    g.cpu += r.cpu ?? 0;
    g.unknown ||= r.mb === null;
    g.n++;
    groups.set(r.label, g);
  }
  const list = [...groups.entries()].sort((a, b) => b[1].mb - a[1].mb);
  const total = list.reduce((s, [, g]) => s + g.mb, 0);
  const max = Math.max(1, ...list.map(([, g]) => g.mb));

  return (
    <div>
      <h2>Performance</h2>
      <p className="muted small">
        What this app is using right now, updated every 2 seconds. Memory is each part's working set (close to Task Manager's numbers; parts share some
        memory, so the total can read a little high).
      </p>
      <div className="perf-total">
        <b>{total.toLocaleString()} MB</b> total
      </div>
      <div className="perf-list">
        {list.map(([label, g]) => (
          <div key={label} className="perf-row">
            <div className="perf-head">
              <span className="bold">
                {label}
                {g.n > 1 && <span className="muted small"> ×{g.n}</span>}
              </span>
              <span>
                {g.unknown && g.mb === 0 ? "—" : `${g.mb.toLocaleString()} MB`}
                <span className="muted small"> · {g.cpu.toFixed(1)}% CPU</span>
              </span>
            </div>
            <div className="perf-bar">
              <div style={{ width: `${(g.mb / max) * 100}%` }} />
            </div>
            {g.what && <div className="muted small">{g.what}</div>}
          </div>
        ))}
      </div>
      <p className="muted small" style={{ marginTop: 12 }}>
        Tips: "Graphics & video" and "Interface & calls" grow with every video you're watching. Hiding cameras or streams you don't need (the eye button on
        a tile) frees that memory right away.
      </p>
    </div>
  );
}
