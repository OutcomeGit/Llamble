// One program's sound (or the whole PC's), captured by the Windows app's helper and turned
// into an audio track here. Used by screen sharing ("share") and show recordings ("rec").
export interface NativeSound {
  track: MediaStreamTrack;
  what: string; // "app", "game:<name>", "all-but-llamble"
  stop: () => void;
}

/** null when not on the Windows app or Windows is too old (before 10 2004). */
export async function startNativeSound(key: string, sourceId: string, mode: "app" | "all"): Promise<NativeSound | null> {
  const native = window.llambleNative?.appAudio;
  if (!native) return null;
  // the Windows app sends a message port for this capture; it goes straight to the sound thread
  let port: MessagePort | null = null;
  let gotPort: (p: MessagePort) => void = () => {};
  const portReady = new Promise<MessagePort>((res) => (gotPort = res));
  const onMsg = (e: MessageEvent) => {
    if (e.source === window && e.data?.llambleAppAudioPort === key && e.ports[0]) {
      port = e.ports[0];
      gotPort(port);
    }
  };
  window.addEventListener("message", onMsg);
  const what = await native.start(key, sourceId, mode).catch(() => null);
  if (!what) {
    window.removeEventListener("message", onMsg);
    return null;
  }
  try {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    await ctx.audioWorklet.addModule("./pcmPlayerWorklet.js");
    const player = new AudioWorkletNode(ctx, "pcm-player", { outputChannelCount: [2], processorOptions: { cushion: 0.04 } });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    player.connect(dest);
    await ctx.resume().catch(() => {});
    const p = port ?? (await Promise.race([portReady, new Promise<null>((r) => setTimeout(() => r(null), 3000))]));
    window.removeEventListener("message", onMsg);
    if (!p) throw new Error("no sound line from the app");
    player.port.postMessage({ feed: p }, [p]);
    return {
      track: dest.stream.getAudioTracks()[0],
      what,
      stop: () => {
        native.stop(key);
        ctx.close().catch(() => {});
      },
    };
  } catch (e) {
    window.removeEventListener("message", onMsg);
    console.warn("[llamble] program sound unavailable", e);
    native.stop(key);
    return null;
  }
}
