// Tiny synthesized UI sounds (no audio assets needed).
let ctx: AudioContext | null = null;
function ac() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function tone(freqs: number[], dur = 0.09, gap = 0.07, vol = 0.12, type: OscillatorType = "sine") {
  if (localStorage.getItem("parley.sounds") === "off") return;
  try {
    const c = ac();
    freqs.forEach((f, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.value = f;
      const t0 = c.currentTime + i * gap;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(c.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    });
  } catch {}
}

export const sounds = {
  message: () => tone([880, 1320], 0.12, 0.06, 0.08, "triangle"),
  join: () => tone([523, 784], 0.14, 0.09, 0.1),
  leave: () => tone([784, 523], 0.14, 0.09, 0.1),
  mute: () => tone([440], 0.07, 0, 0.08, "square"),
  unmute: () => tone([660], 0.07, 0, 0.08, "square"),
  ring: () => tone([660, 880, 660, 880], 0.18, 0.2, 0.1),
};
