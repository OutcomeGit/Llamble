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
  const what = await native.start(key, sourceId, mode).catch(() => null);
  if (!what) return null;
  try {
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule("./pcmPlayerWorklet.js");
    const player = new AudioWorkletNode(ctx, "pcm-player", { outputChannelCount: [2], processorOptions: { cushion: 0.15 } });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    player.connect(dest);
    await ctx.resume().catch(() => {});
    const off = native.on((k, pcm) => {
      if (k !== key) return;
      const f = new Float32Array(pcm.byteLength / 4);
      new Uint8Array(f.buffer).set(pcm);
      player.port.postMessage(f, [f.buffer]);
    });
    return {
      track: dest.stream.getAudioTracks()[0],
      what,
      stop: () => {
        off();
        native.stop(key);
        ctx.close().catch(() => {});
      },
    };
  } catch (e) {
    console.warn("[llamble] program sound unavailable", e);
    native.stop(key);
    return null;
  }
}
