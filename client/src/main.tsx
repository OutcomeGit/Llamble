import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { getRoom, joinVoice, leaveVoice, micSound, setMicSound, setWatching, toggleCamera, useVoice } from "./voice";
import { PRESETS } from "./micsound";
import { openGuildView, openHome } from "./store";
import { useRecorder } from "./show";

// handle for automated tests and troubleshooting from the dev console
(window as any).llambleDebug = { joinVoice, leaveVoice, getRoom, voice: () => useVoice.getState(), useVoice, toggleCamera, setWatching, recorder: () => useRecorder.getState(), micSound, setMicSound, PRESETS, openHome, openGuildView };

import { OverlayApp } from "./OverlayApp";

const isOverlay = location.hash === "#overlay" && !!window.llambleNative?.overlay;
/** Last line of defence: show what broke instead of an empty window. */
class Crash extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ padding: 40, color: "#ddd", fontFamily: "sans-serif" }}>
        <h2>Something went wrong</h2>
        <p style={{ color: "#aaa" }}>{this.state.err.message}</p>
        <button className="btn primary" onClick={() => location.reload()}>
          Reload Llamble
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(isOverlay ? <OverlayApp /> : <Crash><App /></Crash>);

// installable web app (only in browsers served over http(s), not inside Electron)
if (!isOverlay && !window.llambleNative && "serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
