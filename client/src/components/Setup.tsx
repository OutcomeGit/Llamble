import { useState } from "react";
import { api, setSession } from "../api";
import { useStore } from "../store";
import { ModelPicker } from "./ModelPicker";

/** First-run wizard: shown when the server has no accounts yet. */
export function Setup({ server, onDone, onCancel }: { server: string; onDone: (token: string) => void; onCancel?: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [username, setUsername] = useState("");
  const [display, setDisplay] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [serverName, setServerName] = useState("");
  const [token, setToken] = useState("");
  const [guildId, setGuildId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    try {
      const device = window.llambleNative ? `Llamble Desktop (${window.llambleNative.platform})` : "Browser";
      const r = await api("/api/setup", {
        server,
        token: null,
        body: { username, password, display_name: display || undefined, server_name: serverName || undefined, device_name: device },
      });
      setToken(r.token);
      setGuildId(r.guild_id);
      setStep(2);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    if (guildId) {
      // open the new server first
      localStorage.setItem("llamble.lastGuild", guildId);
      useStore.setState({ selectedGuild: guildId });
    }
    setSession(server, token);
    onDone(token);
  };

  return (
    <div className="login-bg">
      <div className="titlebar-drag" />
      {step === 1 ? (
        <form className="login-card" onSubmit={create}>
          <div className="setup-steps">
            <span className="on">1. Admin account</span>
            <span>2. AI model</span>
          </div>
          <h1>Set up your Llamble server</h1>
          <p className="muted">
            This server has no accounts yet. The account you create here is the <b>owner/admin</b>.
          </p>
          <div className="muted small center">{server}</div>
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
          </label>
          <label>
            Display name <span className="muted">(optional)</span>
            <input value={display} onChange={(e) => setDisplay(e.target.value)} />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <label>
            Confirm password
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </label>
          <label>
            Name your first server <span className="muted">(optional — e.g. your company name)</span>
            <input value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="My Clients" />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="btn primary wide" disabled={busy || !username || password.length < 8}>
            {busy ? "Creating…" : "Create admin account"}
          </button>
          {onCancel && (
            <p className="small center">
              <a href="#" onClick={(e) => (e.preventDefault(), onCancel())}>
                Back
              </a>
            </p>
          )}
        </form>
      ) : (
        <div className="login-card wide-card">
          <div className="setup-steps">
            <span>1. Admin account ✓</span>
            <span className="on">2. AI model</span>
          </div>
          <h1>Pick the AI model</h1>
          <p className="muted">
            The bot runs this model on the server whenever nobody is lending a GPU. You can change it any time in Settings → Instance Admin → AI Model.
          </p>
          <ModelPicker opts={{ server, token }} compact />
          <div className="row gap" style={{ marginTop: 20 }}>
            <button className="btn" onClick={finish}>
              Skip for now
            </button>
            <div className="grow" />
            <button className="btn primary" onClick={finish}>
              Finish setup
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
