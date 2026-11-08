import { useEffect, useRef, useState } from "react";
import { buildChain, micContext, type Chain } from "../micfx";
import {
  BITRATES,
  HELPERS_ABOUT,
  LEVELS,
  PRESETS,
  RAW_ABOUT,
  keyLabel,
  presetFor,
  presetLabel,
  virtualKey,
  type MicSound,
  type NoiseMode,
  type PushToTalk,
} from "../micsound";
import { followsServerDefault, micLimits, micSound, prefs, pushToTalk, setMicSound, setPushToTalk, useServerDefault } from "../voice";
import { useStore } from "../store";
import { Toggle } from "./common";

const NOISE: [NoiseMode, string, string][] = [
  ["rnnoise", "AI: RNNoise (recommended)", "Open-source AI from Xiph. Removes fans, keyboards and hum while keeping your voice natural. Light on the CPU."],
  ["gtcrn", "AI: GTCRN (newer, stronger)", "A newer open-source AI model. Removes more noise, a bit more CPU. Try it if RNNoise lets something through."],
  ["browser", "Browser's built-in", "The basic suppressor built into Chrome/Edge. Lightest, but can make voices sound watery."],
  ["off", "Off", "Nothing removed."],
];

/** Settings → Voice & Video → Mic sound: presets on the left, every setting on the right. */
export function MicSoundPanel() {
  const [m, setM] = useState<MicSound>(micSound());
  const [following, setFollowing] = useState(followsServerDefault());
  const media = useStore((s) => s.config.media);
  const limits = micLimits(media);
  // while following, show the server's current default (it can change while this is open)
  useEffect(() => {
    if (following) setM(micSound());
  }, [media?.mic_default_kbps, media?.mic_max_kbps]);
  const preset = following ? undefined : presetFor(m);
  const apply = (next: MicSound) => {
    setM(next);
    setFollowing(false);
    setMicSound(next);
  };
  const kbps = (b: number) => Math.round(b / 1000);
  const title = following ? `Server default · with helpers (${kbps(limits.def)} kbps)` : presetLabel(m);
  const set = <K extends keyof MicSound>(k: K, v: MicSound[K]) => apply({ ...m, [k]: v });
  const sw = (k: "stereo" | "echoCancellation" | "autoGainControl" | "trimSilence" | "repairPackets" | "lowCut" | "compressor", label: string, desc: string) => (
    <div className="perm-row">
      <div>
        <div className="bold">{label}</div>
        <div className="muted small">{desc}</div>
      </div>
      <Toggle on={m[k]} onChange={(v) => set(k, v)} />
    </div>
  );
  const slider = (k: "gainDb" | "bassDb" | "midDb" | "trebleDb", label: string, min: number, max: number) => (
    <label className="mic-slider">
      <span>
        {label} <b>{m[k] > 0 ? "+" : ""}{m[k]} dB</b>
      </span>
      <input type="range" min={min} max={max} step={1} value={m[k]} onChange={(e) => set(k, Number(e.target.value))} onDoubleClick={() => set(k, 0)} />
    </label>
  );

  return (
    <div className="mic-panel">
      <div className="profile-section">Mic sound</div>
      <div className="mic-grid">
        <div className="mic-presets">
          <div className={"mic-level" + (following ? " on" : "")}>
            <div className="mic-level-head">
              <span className="bold">Server default</span>
              <span className="muted small">{kbps(limits.def)} kbps</span>
            </div>
            <div className="muted small">With helpers, at the bitrate this server's admin chose. Follows it if they change it.</div>
            <div className="mic-level-btns">
              <button
                className={"btn small" + (following ? " primary" : "")}
                onClick={() => {
                  useServerDefault();
                  setFollowing(true);
                  setM(micSound());
                }}
              >
                Use server default
              </button>
            </div>
          </div>
          <div className="muted small">Lowest to highest fidelity · this server allows up to {kbps(limits.max)} kbps</div>
          {LEVELS.map((l) => (
            <div key={l.id} className={"mic-level" + (preset?.level.id === l.id ? " on" : "")}>
              <div className="mic-level-head">
                <span className="bold">{l.label}</span>
                <span className="muted small">{Math.round(l.bitrate / 1000)} kbps</span>
              </div>
              <div className="muted small">{l.about}</div>
              <div className="mic-level-btns">
                {PRESETS.filter((p) => p.level.id === l.id).map((p) => (
                  <button
                    key={p.id}
                    className={"btn small" + (preset?.id === p.id ? " primary" : "")}
                    disabled={l.bitrate > limits.max}
                    title={l.bitrate > limits.max ? `Above this server's limit (${kbps(limits.max)} kbps)` : undefined}
                    onClick={() => apply({ ...p.sound })}
                  >
                    {p.raw ? "Raw" : "With helpers"}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <p className="muted small">{HELPERS_ABOUT}</p>
          <p className="muted small">{RAW_ABOUT}</p>
        </div>

        <div className="mic-settings">
          <div className="mic-current">{title}</div>
          {m.bitrate > limits.max && (
            <div className="mic-warn">This server's limit is {kbps(limits.max)} kbps, so you're sent at {kbps(limits.max)} kbps for now.</div>
          )}
          <p className="muted small">Change anything here and it becomes Custom. Changes apply right away, even mid-call.</p>
          <label>
            Bitrate
            <select value={m.bitrate} onChange={(e) => set("bitrate", Number(e.target.value))}>
              {BITRATES.map((b) => (
                <option key={b} value={b} disabled={b > limits.max}>
                  {b / 1000} kbps
                  {b === limits.def ? " (server default)" : ""}
                  {b === 64000 ? " (Discord's normal)" : b === 384000 ? " (Discord's maximum)" : b === 510000 ? " (Opus maximum)" : ""}
                  {b > limits.max ? " (above server limit)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Noise suppression
            <select value={m.noise} onChange={(e) => set("noise", e.target.value as NoiseMode)}>
              {NOISE.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <span className="muted small">{NOISE.find(([v]) => v === m.noise)?.[2]}</span>
          </label>
          {sw("echoCancellation", "Echo cancellation", "Stops others hearing themselves through your speakers. Not needed with headphones.")}
          {!m.echoCancellation && (
            <div className="mic-warn">
              Echo cancellation is off: if you listen on speakers (not headphones), everyone will hear their own voice repeated back. Two devices in the same
              room cause the same echo even with it on.
            </div>
          )}
          {sw("autoGainControl", "Auto volume", "Evens out loud and quiet. Off: your volume follows how close you are to the mic.")}
          {sw("trimSilence", "Trim silence", "Sends almost nothing while you're quiet. Saves data; the very start of a word can come through slightly soft.")}
          {sw("repairPackets", "Repair packets", "Each packet carries a backup of the previous one so a lost packet gets rebuilt. Smoother on Wi-Fi; doubles the data.")}
          {sw("stereo", "Stereo", "Sends both channels if your mic is stereo. No difference for normal headset mics.")}

          <div className="profile-section">Shaping</div>
          {slider("gainDb", "Mic volume", -20, 20)}
          <div className="perm-row">
            <div>
              <div className="bold">Noise gate</div>
              <div className="muted small">Only sends sound louder than the threshold, so breathing and background stay out between words.</div>
            </div>
            <Toggle on={m.gateDb !== null} onChange={(v) => set("gateDb", v ? -50 : null)} />
          </div>
          {m.gateDb !== null && (
            <label className="mic-slider">
              <span>
                Gate threshold <b>{m.gateDb} dB</b> <span className="muted small">(lower lets quieter sounds through)</span>
              </span>
              <input type="range" min={-80} max={-20} step={1} value={m.gateDb} onChange={(e) => set("gateDb", Number(e.target.value))} />
            </label>
          )}
          {sw("lowCut", "Low-cut filter", "Removes rumble below 80 Hz: desk bumps, traffic, AC hum. Barely touches voices.")}
          {sw("compressor", "Compressor", "Tames sudden loud moments (laughs, shouts) so you stay at a steady level.")}
          {slider("bassDb", "Bass", -12, 12)}
          {slider("midDb", "Mids", -12, 12)}
          {slider("trebleDb", "Treble", -12, 12)}
          <p className="muted small">Double-click a slider to reset it.</p>

          <HearMyself sound={m} />
        </div>
      </div>
      <PushToTalkSettings />
    </div>
  );
}

/** Play your processed mic back to you (use headphones) with a level meter. */
function HearMyself({ sound }: { sound: MicSound }) {
  const [on, setOn] = useState(false);
  const [level, setLevel] = useState(0);
  const key = JSON.stringify(sound);
  useEffect(() => {
    if (!on) return;
    let stop = false;
    let stream: MediaStream | null = null;
    let chain: Chain | null = null;
    let monitor: GainNode | null = null;
    const ctx = micContext();
    const dev = prefs.get("audioInput");
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          deviceId: dev || undefined,
          echoCancellation: sound.echoCancellation,
          noiseSuppression: sound.noise === "browser",
          autoGainControl: sound.autoGainControl,
          channelCount: sound.stereo ? 2 : 1,
          sampleRate: 48000,
        },
      })
      .then(async (s) => {
        stream = s;
        if (stop) return s.getTracks().forEach((t) => t.stop());
        chain = await buildChain(ctx, s.getAudioTracks()[0], sound);
        if (stop) return chain.destroy();
        monitor = ctx.createGain();
        chain.tail.connect(monitor);
        monitor.connect(ctx.destination);
        const an = ctx.createAnalyser();
        chain.tail.connect(an);
        const buf = new Float32Array(an.fftSize);
        const tick = () => {
          if (stop) return;
          an.getFloatTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v));
          setLevel(peak);
          requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => setOn(false));
    return () => {
      stop = true;
      try {
        monitor?.disconnect();
      } catch {}
      chain?.destroy();
      (stream as MediaStream | null)?.getTracks().forEach((t) => t.stop());
      setLevel(0);
    };
  }, [on, key]);
  return (
    <div className="hear-myself">
      <button className={"btn" + (on ? " primary" : "")} onClick={() => setOn(!on)}>
        {on ? "Stop listening" : "Hear myself"}
      </button>
      <div className="meter">
        <div style={{ width: `${Math.min(100, level * 100)}%`, background: level > 0.95 ? "var(--red, #e5484d)" : undefined }} />
      </div>
      <div className="muted small">Plays your mic back exactly as others will hear it, with every setting above. Use headphones.</div>
    </div>
  );
}

function PushToTalkSettings() {
  const [p, setP] = useState<PushToTalk>(pushToTalk());
  const [capturing, setCapturing] = useState(false);
  const save = (next: PushToTalk) => {
    setP(next);
    setPushToTalk(next);
  };
  const ref = useRef(save);
  ref.current = save;
  useEffect(() => {
    if (!capturing) return;
    const take = (code: string, e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      setCapturing(false);
      if (code === "Escape") return;
      ref.current({ ...pushToTalk(), key: code });
    };
    const kd = (e: KeyboardEvent) => take(e.code, e);
    const md = (e: MouseEvent) => {
      const c = e.button === 1 ? "Mouse3" : e.button === 3 ? "Mouse4" : e.button === 4 ? "Mouse5" : "";
      if (c) take(c, e);
    };
    window.addEventListener("keydown", kd, true);
    window.addEventListener("mousedown", md, true);
    return () => {
      window.removeEventListener("keydown", kd, true);
      window.removeEventListener("mousedown", md, true);
    };
  }, [capturing]);
  const native = !!window.llambleNative?.ptt;
  return (
    <>
      <div className="profile-section">Push to talk</div>
      <div className="perm-row">
        <div>
          <div className="bold">Push to talk</div>
          <div className="muted small">
            Your mic only sends while you hold the key.{" "}
            {native ? "Works while a game or any other app has focus." : "In a browser it only works while this tab has focus; the Windows app works everywhere."}
          </div>
        </div>
        <Toggle on={p.on} onChange={(v) => save({ ...p, on: v })} />
      </div>
      {p.on && (
        <>
          <div className="row gap center-v">
            <span>Key:</span>
            <button className={"btn" + (capturing ? " primary" : "")} onClick={() => setCapturing(true)}>
              {capturing ? "Press a key or mouse button… (Esc cancels)" : keyLabel(p.key)}
            </button>
            {native && !virtualKey(p.key) && <span className="muted small">This key can't be watched outside the app; pick another.</span>}
          </div>
          <label className="mic-slider">
            <span>
              Release delay <b>{p.releaseMs} ms</b> <span className="muted small">(keeps the mic open briefly after you let go, so word endings aren't cut)</span>
            </span>
            <input type="range" min={0} max={1000} step={50} value={p.releaseMs} onChange={(e) => save({ ...p, releaseMs: Number(e.target.value) })} />
          </label>
        </>
      )}
    </>
  );
}
