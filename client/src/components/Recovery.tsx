// Password recovery: recovery codes, "ask an admin/parent" requests, and the code shown at sign-up.
import { useEffect, useRef, useState } from "react";
import { api, setSession } from "../api";
import { useStore } from "../store";
import { closeModal, copy, openModal, toast } from "../ui";

/** Shown once after an account is created (or a new code is made). */
export function RecoveryCodeNotice({ code }: { code: string }) {
  return (
    <div className="modal">
      <h2>Save your recovery code</h2>
      <p>If you ever forget your password, this code lets you set a new one yourself. It works once, then you get a new one.</p>
      <div className="recovery-code" onClick={() => copy(code, "Code copied")}>
        {code}
      </div>
      <p className="muted small">Write it down or keep it in a password manager. Nobody can show it to you again, not even an admin.</p>
      <div className="modal-foot">
        <button className="btn" onClick={() => copy(code, "Code copied")}>
          Copy
        </button>
        <button className="btn primary" onClick={closeModal}>
          I saved it
        </button>
      </div>
    </div>
  );
}

/** Settings → My Account: make a fresh recovery code. */
export function RecoveryCodeSection() {
  const me = useStore((s) => s.me)!;
  if (me.is_kid) {
    return (
      <>
        <div className="profile-section">Forgot your password?</div>
        <p className="muted small">A parent can set a new password for you in their Family settings.</p>
      </>
    );
  }
  return (
    <>
      <EmailField />
      <div className="profile-section">Recovery code</div>
      <p className="muted small">A recovery code lets you reset your password yourself if you forget it. Making a new one cancels the old one.</p>
      <button
        className="btn"
        onClick={() =>
          openModal({
            kind: "prompt",
            title: "New recovery code",
            label: "Your current password",
            password: true,
            confirmLabel: "Make code",
            onSubmit: async (pw: string) => {
              const r = await api("/api/me/recovery-code", { body: { password: pw } });
              setTimeout(() => openModal({ kind: "recoveryCode", code: r.recovery_code }), 0);
            },
          })
        }
      >
        Make a new recovery code
      </button>
    </>
  );
}

/**
 * Sign-in screen: "Forgot password?". Two ways back in:
 * - type the recovery code and a new password
 * - ask: admins (or a kid's parents) get a notice; once one approves, this same screen
 *   lets you set the new password. Nothing has to be read out or passed along.
 */
export function ForgotPassword({ server, initialUser, onDone, onCancel }: { server: string; initialUser: string; onDone: (token: string) => void; onCancel: () => void }) {
  const [mode, setMode] = useState<"choose" | "code" | "ask" | "waiting" | "approved" | "emailed">("choose");
  const [canEmail, setCanEmail] = useState(false);
  useEffect(() => {
    fetch(server.replace(/\/+$/, "") + "/api/info")
      .then((r) => r.json())
      .then((i) => setCanEmail(!!i.email_reset))
      .catch(() => {});
  }, [server]);
  const [username, setUsername] = useState(initialUser);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const req = useRef<{ id: string; secret: string } | null>(null);
  const base = server.replace(/\/+$/, "");
  const post = async (path: string, body: any) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `error ${r.status}`);
    return j;
  };
  // waiting: check back every few seconds
  useEffect(() => {
    if (mode !== "waiting") return;
    const t = setInterval(async () => {
      if (!req.current) return;
      try {
        const r = await post(`/api/auth/reset-request/${req.current.id}`, { secret: req.current.secret });
        if (r.status === "approved") setMode("approved");
        if (r.status === "denied") {
          setErr("Your request was turned down. Ask an admin or a parent directly.");
          setMode("choose");
        }
        if (r.status === "expired") {
          setErr("The request expired. Ask again.");
          setMode("choose");
        }
      } catch {}
    }, 4000);
    return () => clearInterval(t);
  }, [mode]);

  const finish = (token: string, newCode?: string) => {
    setSession(base, token);
    onDone(token);
    if (newCode) setTimeout(() => openModal({ kind: "recoveryCode", code: newCode }), 500);
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-card">
      <img className="login-logo" src="./logo-banner.jpg" alt="Llamble" />
      <h1>Forgot your password?</h1>
      {mode === "choose" && (
        <>
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </label>
          <button className="btn primary wide" disabled={!username.trim()} onClick={() => setMode("code")}>
            I have my recovery code
          </button>
          <button
            className="btn wide"
            disabled={!username.trim() || busy}
            onClick={() =>
              run(async () => {
                req.current = await post("/api/auth/reset-request", { username: username.trim() });
                setMode("waiting");
              })
            }
          >
            Ask an admin (or my parent) to let me reset it
          </button>
          {canEmail && (
            <button
              className="btn wide"
              disabled={!username.trim() || busy}
              onClick={() =>
                run(async () => {
                  await post("/api/auth/reset-email", { username: username.trim() });
                  setMode("emailed");
                })
              }
            >
              Email me a reset link
            </button>
          )}
        </>
      )}
      {mode === "code" && (
        <>
          <label>
            Recovery code
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-EFGH-JKLM-NPQR" autoFocus />
          </label>
          <label>
            New password
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </label>
          <button
            className="btn primary wide"
            disabled={busy || pw.length < 8 || code.length < 16}
            onClick={() =>
              run(async () => {
                const r = await post("/api/auth/recover", { username: username.trim(), code, new_password: pw });
                finish(r.token, r.recovery_code);
              })
            }
          >
            Set new password
          </button>
        </>
      )}
      {mode === "emailed" && <p>If that account has an email address saved, a reset link is on its way. It works for an hour. Check your spam folder too.</p>}
      {mode === "waiting" && (
        <div className="waiting">
          <div className="spinner" />
          <p>
            Asked! An admin, or a parent for kid accounts, will see your request in Llamble. <b>Keep this screen open</b>: as soon as they approve, you can set your new password here.
          </p>
        </div>
      )}
      {mode === "approved" && (
        <>
          <p className="green">Approved! Choose your new password.</p>
          <label>
            New password
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          </label>
          <button
            className="btn primary wide"
            disabled={busy || pw.length < 8}
            onClick={() =>
              run(async () => {
                const r = await post(`/api/auth/reset-request/${req.current!.id}`, { secret: req.current!.secret, new_password: pw });
                if (r.status !== "done") throw new Error("That didn't work; ask again.");
                finish(r.token);
              })
            }
          >
            Set new password
          </button>
        </>
      )}
      {err && <div className="form-error">{err}</div>}
      <div className="login-switch">
        <a onClick={onCancel}>Back to sign in</a>
      </div>
    </div>
  );
}

export function notifyResetRequest(d: any) {
  toast(`${d.user?.display_name || "Someone"} forgot their password and asked for a reset. See Settings → Instance Admin (or Family).`);
}

function EmailField() {
  const [d, setD] = useState<{ email: string | null; server_can_email: boolean } | null>(null);
  const [v, setV] = useState("");
  useEffect(() => {
    api("/api/me/email")
      .then((x) => {
        setD(x);
        setV(x.email || "");
      })
      .catch(() => {});
  }, []);
  if (!d) return null;
  return (
    <>
      <div className="profile-section">Email for password resets</div>
      <p className="muted small">
        {d.server_can_email ? "If you forget your password, a reset link can be sent here. It's never shown to anyone else." : "Your server admin hasn't set up email yet, but you can add your address now for later."}
      </p>
      <div className="row gap">
        <input className="grow" value={v} onChange={(e) => setV(e.target.value)} placeholder="you@example.com" />
        <button
          className="btn"
          disabled={v === (d.email || "")}
          onClick={() =>
            api("/api/users/@me", { method: "PATCH", body: { email: v } })
              .then(() => {
                setD({ ...d, email: v });
                toast(v ? "Email saved" : "Email removed");
              })
              .catch((e) => toast(e.message, "error"))
          }
        >
          Save
        </button>
      </div>
    </>
  );
}

/** Opened from the emailed link: ?reset=ID.SECRET */
export function EmailResetLanding({ server, id, secret, onDone }: { server: string; id: string; secret: string; onDone: (token: string) => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(server + `/api/auth/reset-request/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret, new_password: pw }) }).then((x) => x.json());
      if (r.status !== "done") throw new Error(r.status === "expired" ? "This link has expired. Ask for a new one from the sign-in screen." : "This link has already been used or isn't valid.");
      setSession(server, r.token);
      onDone(r.token);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-bg">
      <div className="login-card">
        <img className="login-logo" src="./logo-banner.jpg" alt="Llamble" />
        <h1>Choose a new password</h1>
        <label>
          New password
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </label>
        <button className="btn primary wide" disabled={busy || pw.length < 8} onClick={submit}>
          Set new password
        </button>
        {err && <div className="form-error">{err}</div>}
      </div>
    </div>
  );
}
