import { useEffect, useState } from "react";
import { api, normalizeServer, session, setSession } from "../api";
import { Setup } from "./Setup";

export function Login({ onDone }: { onDone: (token: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [server, setServer] = useState(session.server || "");
  const [invite, setInvite] = useState("");
  const [username, setUsername] = useState("");
  const [display, setDisplay] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [needsSetup, setNeedsSetup] = useState<string | null>(null);
  const [inSetup, setInSetup] = useState(false);

  // detect a brand-new server that still needs first-run setup
  useEffect(() => {
    setNeedsSetup(null);
    const srv = normalizeServer(server);
    if (!srv || srv.length < 10) return;
    const t = setTimeout(() => {
      api("/api/info", { server: srv, token: null })
        .then((i) => {
          if (i.setup_required) {
            setNeedsSetup(srv);
            if (srv === session.server || location.origin === srv) setInSetup(true);
          }
        })
        .catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [server]);

  // accept a pasted full invite link: llamble://invite/CODE@server or https://server/invite/CODE
  useEffect(() => {
    const m = /invite\/([^@/?#\s]+)(?:@([^\s]+))?/i.exec(invite);
    if (m) {
      setInvite(m[1]);
      if (m[2]) setServer(m[2]);
    }
  }, [invite]);

  useEffect(() => {
    return window.llambleNative?.onInvite((v) => {
      const [code, srv] = v.split("@");
      setMode("register");
      setInvite(code);
      if (srv) setServer(srv);
    });
  }, []);

  useEffect(() => {
    setPreview(null);
    if (mode !== "register" || invite.length < 6 || !server) return;
    const t = setTimeout(() => {
      api(`/api/invites/${encodeURIComponent(invite)}`, { server: normalizeServer(server), token: null })
        .then(setPreview)
        .catch(() => setPreview(false));
    }, 400);
    return () => clearTimeout(t);
  }, [invite, server, mode]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const srv = normalizeServer(server);
    if (!srv) return setError("Enter your server address");
    setBusy(true);
    try {
      await api("/api/info", { server: srv, token: null });
      const device = window.llambleNative ? `Llamble Desktop (${window.llambleNative.platform})` : "Browser";
      const res =
        mode === "login"
          ? await api("/api/auth/login", { server: srv, token: null, body: { username, password, device_name: device } })
          : await api("/api/auth/register", { server: srv, token: null, body: { invite, username, password, display_name: display || undefined, device_name: device } });
      setSession(srv, res.token);
      onDone(res.token);
    } catch (err: any) {
      setError(err.status === 0 ? `Can't reach ${srv}. Check the address and that the server is running.` : err.message);
    } finally {
      setBusy(false);
    }
  };

  if (inSetup && needsSetup) {
    return <Setup server={needsSetup} onDone={onDone} onCancel={() => setInSetup(false)} />;
  }

  return (
    <div className="login-bg">
      <div className="titlebar-drag" />
      <form className="login-card" onSubmit={submit}>
        <h1>{mode === "login" ? "Welcome back!" : "Create your account"}</h1>
        <p className="muted">{mode === "login" ? "Sign in to your Llamble server." : "You'll need an invite from the server owner."}</p>
        <label>
          Server address
          <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="chat.example.com or 192.168.1.20:8080" autoFocus={!server} />
        </label>
        {needsSetup && (
          <div className="invite-preview setup-banner">
            This server is brand new and hasn't been set up yet.
            <button type="button" className="btn primary small" onClick={() => setInSetup(true)}>
              Set it up
            </button>
          </div>
        )}
        {mode === "register" && (
          <>
            <label>
              Invite code or link
              <input value={invite} onChange={(e) => setInvite(e.target.value.trim())} placeholder="e.g. Xk3pQ9aB2z" />
            </label>
            {preview && (
              <div className="invite-preview">
                {preview.guild ? (
                  <>
                    You're invited to <b>{preview.guild.name}</b> · {preview.guild.member_count} members
                  </>
                ) : (
                  <>Valid account invite ✓</>
                )}
              </div>
            )}
            {preview === false && <div className="form-error">That invite is invalid or expired.</div>}
          </>
        )}
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus={!!server} />
        </label>
        {mode === "register" && (
          <label>
            Display name <span className="muted">(optional)</span>
            <input value={display} onChange={(e) => setDisplay(e.target.value)} />
          </label>
        )}
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="btn primary wide" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Log In" : "Create Account"}
        </button>
        <p className="muted small">
          {mode === "login" ? (
            <>
              Have an invite?{" "}
              <a href="#" onClick={(e) => (e.preventDefault(), setMode("register"))}>
                Register
              </a>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <a href="#" onClick={(e) => (e.preventDefault(), setMode("login"))}>
                Log in
              </a>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
