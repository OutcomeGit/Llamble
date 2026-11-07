import { useEffect, useState } from "react";
import { api, formatBytes } from "../api";
import { Icon } from "./common";

interface Opts {
  server?: string;
  token?: string;
}

interface AiState {
  status: { state: string; repo: string | null; quant: string | null; ctx: number; total_bytes: number; downloaded_bytes: number; error: string | null };
  catalog: { repo: string; quant: string; name: string; size_gb: number; note: string }[];
  system: { cpus: number; ram_gb: number | null; disk_free_gb: number | null; llama_bundled: boolean };
  external_url: string | null;
  log: string[];
}

const STATE_LABEL: Record<string, string> = {
  none: "No built-in model",
  resolving: "Looking up model…",
  downloading: "Downloading…",
  starting: "Loading model into memory…",
  ready: "Ready",
  error: "Error",
  external: "Using an external llama server",
};

/** Pick / download / switch the server's built-in AI model. Used by setup and admin settings. */
export function ModelPicker({ opts = {}, compact }: { opts?: Opts; compact?: boolean }) {
  const [ai, setAi] = useState<AiState | null>(null);
  const [error, setError] = useState("");
  const [custom, setCustom] = useState("");
  const [quants, setQuants] = useState<{ quant: string; size: number }[] | null>(null);
  const [customQuant, setCustomQuant] = useState("");
  const [ctx, setCtx] = useState(8192);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const load = () =>
    api<AiState>("/api/admin/ai", opts)
      .then((a) => {
        setAi(a);
        if (a.status.ctx) setCtx(a.status.ctx);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
    // the "Models on this server" list can switch models too
    const h = () => load();
    window.addEventListener("llamble:ai-changed", h);
    return () => window.removeEventListener("llamble:ai-changed", h);
  }, []);
  // poll while something is in progress
  useEffect(() => {
    if (!ai || ["none", "ready", "external"].includes(ai.status.state)) return;
    const t = setTimeout(load, 1000);
    return () => clearTimeout(t);
  }, [ai]);

  const choose = async (repo: string, quant: string) => {
    setBusy(true);
    setError("");
    try {
      await api("/api/admin/ai", { ...opts, body: { repo, quant, ctx } });
      await load();
      window.dispatchEvent(new Event("llamble:models-changed"));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const lookup = async () => {
    setQuants(null);
    setError("");
    try {
      const r = await api(`/api/admin/ai/quants?repo=${encodeURIComponent(custom.trim())}`, opts);
      setQuants(r.quants);
      const pref = r.quants.find((q: any) => q.quant === "Q4_K_M") || r.quants[Math.floor(r.quants.length / 2)];
      setCustomQuant(pref?.quant || "");
      setCustom(r.repo);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const disable = async () => {
    await api("/api/admin/ai", { ...opts, method: "DELETE" });
    load();
  };

  if (!ai) return <div className="muted">{error || "Loading…"}</div>;
  const st = ai.status;
  const ram = ai.system.ram_gb ?? 0;
  const pct = st.total_bytes ? Math.min(100, (st.downloaded_bytes / st.total_bytes) * 100) : 0;

  if (st.state === "external") {
    return <div className="backend ok">Using an external llama server at {ai.external_url}. Remove LLAMBLE_LLAMA_URL from the app's YAML to manage models here.</div>;
  }

  return (
    <div className="model-picker">
      <div className="sysline muted small">
        This server: {ai.system.cpus} CPU threads{ram ? ` · ${ram} GB RAM` : ""}
        {ai.system.disk_free_gb != null ? ` · ${ai.system.disk_free_gb} GB free disk` : ""}
        {!ai.system.llama_bundled && " · ⚠ llama-server not found in this image"}
      </div>

      {st.state !== "none" && (
        <div className={"model-status " + st.state}>
          <div className="row center-v gap">
            <b className="grow">
              {STATE_LABEL[st.state] ?? st.state}
              {st.repo ? ` — ${st.repo.split("/")[1]} ${st.quant ?? ""}` : ""}
            </b>
            <button className="btn small" onClick={disable}>
              Turn off
            </button>
          </div>
          {(st.state === "downloading" || st.state === "resolving") && (
            <>
              <div className="meter big">
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className="muted small">
                {formatBytes(st.downloaded_bytes)} of {st.total_bytes ? formatBytes(st.total_bytes) : "…"} · keeps downloading if you close this
              </div>
            </>
          )}
          {st.state === "starting" && <div className="muted small">Loading into memory, usually under a minute.</div>}
          {st.state === "ready" && <div className="muted small">The bot replies with this model whenever no GPU is lent. Context {st.ctx.toLocaleString()} tokens.</div>}
          {st.error && <div className="form-error">{st.error}</div>}
          {!compact && (
            <button className="btn link small" onClick={() => setShowLog(!showLog)}>
              {showLog ? "Hide" : "Show"} llama-server log
            </button>
          )}
          {showLog && <pre className="llm-log">{ai.log.join("\n") || "(no output yet)"}</pre>}
        </div>
      )}

      <div className="profile-section">{st.state === "none" ? "Choose a model" : "Switch model"}</div>
      <div className="model-grid">
        {ai.catalog.map((m) => {
          const need = m.size_gb * 1.3 + 1;
          const tight = ram > 0 && need > ram;
          const active = st.repo === m.repo && st.quant === m.quant;
          return (
            <button key={m.repo} className={"model-card" + (active ? " on" : "")} disabled={busy || active} onClick={() => choose(m.repo, m.quant)}>
              <div className="row center-v">
                <b className="grow">{m.name}</b>
                <span className="muted small">{m.size_gb.toFixed(1)} GB</span>
              </div>
              <div className="muted small">{m.note}</div>
              {tight && <div className="form-error small">Needs ~{Math.ceil(need)} GB RAM</div>}
              {active && <div className="green small">Current</div>}
            </button>
          );
        })}
      </div>

      <div className="profile-section">Any model from Hugging Face</div>
      <div className="copy-row">
        <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="owner/Model-GGUF  or paste the huggingface.co link" onKeyDown={(e) => e.key === "Enter" && lookup()} />
        <button className="btn" onClick={lookup} disabled={!custom.trim()}>
          Look up
        </button>
      </div>
      {quants && (
        <div className="row gap center-v" style={{ marginTop: 8 }}>
          <select value={customQuant} onChange={(e) => setCustomQuant(e.target.value)} style={{ maxWidth: 260 }}>
            {quants.map((q) => (
              <option key={q.quant} value={q.quant}>
                {q.quant} — {formatBytes(q.size)}
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={busy || !customQuant} onClick={() => choose(custom.trim(), customQuant)}>
            <Icon name="download" size={14} /> Use this
          </button>
        </div>
      )}

      <label>
        Context size (memory the model can "see")
        <select value={ctx} onChange={(e) => setCtx(Number(e.target.value))} style={{ maxWidth: 260 }}>
          {[4096, 8192, 16384, 32768].map((n) => (
            <option key={n} value={n}>
              {n.toLocaleString()} tokens
            </option>
          ))}
        </select>
      </label>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}
