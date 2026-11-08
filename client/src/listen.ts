// "Hey Llamble": where a server has it turned on, your app sends the stretches of audio
// where you spoke (never silence) from your own microphone to your Llamble server, which
// turns them into text there and answers out loud when you call it by name.
// Everyone in the call hears the answer; the app shows "Llamble is listening".
import { create } from "zustand";
import { Track } from "livekit-client";
import { media, session } from "./api";
import { onEvent, useStore } from "./store";
import { getRoom, prefs, useVoice } from "./voice";

export interface VoiceAiConfig {
  available: boolean;
  notice: string;
  guilds: string[];
}

export const useBotVoice = create<{ thinking: { channel: string; question: string; at: number } | null; caption: { text: string; at: number; asked_by: string } | null }>(() => ({ thinking: null, caption: null }));

/** Is Llamble listening in this voice channel? */
export function listeningIn(channelId: string | null): boolean {
  if (!channelId) return false;
  const s = useStore.getState();
  const ch = s.channels[channelId];
  const cfg = (s.config as any).voice_ai as VoiceAiConfig | undefined;
  return !!(ch?.guild_id && cfg?.available && cfg.guilds.includes(ch.guild_id));
}

// ---------------------------------------------------------------- capture

const RATE = 16000;
let ctx: AudioContext | null = null;
let node: ScriptProcessorNode | null = null;
let src: MediaStreamAudioSourceNode | null = null;
let micTrack: MediaStreamTrack | null = null;
let channel: string | null = null;

// simple voice activity detection
let floor = 0.004;
let speaking = false;
let quietMs = 0;
let chunks: Float32Array[] = [];
let preroll: Float32Array[] = [];
let spokenMs = 0;

function stop() {
  node?.disconnect();
  src?.disconnect();
  ctx?.close().catch(() => {});
  ctx = null;
  node = null;
  src = null;
  micTrack = null;
  speaking = false;
  chunks = [];
}

function start(track: MediaStreamTrack, cid: string) {
  stop();
  channel = cid;
  micTrack = track;
  ctx = new AudioContext({ sampleRate: RATE });
  src = ctx.createMediaStreamSource(new MediaStream([track]));
  node = ctx.createScriptProcessor(2048, 1, 1);
  const frameMs = (2048 / RATE) * 1000;
  node.onaudioprocess = (e) => {
    const x = new Float32Array(e.inputBuffer.getChannelData(0));
    let sum = 0;
    for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
    const rms = Math.sqrt(sum / x.length);
    const loud = rms > Math.max(0.012, floor * 3.5);
    if (!loud) floor = floor * 0.995 + rms * 0.005; // learn the room's background noise
    if (loud) {
      if (!speaking) {
        speaking = true;
        chunks = [...preroll];
        spokenMs = 0;
      }
      quietMs = 0;
    } else if (speaking) {
      quietMs += frameMs;
    }
    if (speaking) {
      chunks.push(x);
      spokenMs += frameMs;
      // a pause of ~0.8 s ends the sentence; very long talking is cut into pieces
      if (quietMs > 800 || spokenMs > 20000) {
        send(chunks);
        speaking = false;
        chunks = [];
      }
    } else {
      preroll.push(x);
      if (preroll.length > 3) preroll.shift(); // ~0.4 s before the speech started
    }
  };
  src.connect(node);
  node.connect(ctx.destination); // (silent: we never write to the output)
  ctx.resume().catch(() => {});
}

function send(parts: Float32Array[]) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  if (n < RATE * 0.35 || !channel) return;
  const pcm = new Int16Array(n);
  let o = 0;
  for (const p of parts) for (let i = 0; i < p.length; i++) pcm[o++] = Math.max(-32768, Math.min(32767, p[i] * 32767));
  fetch(`${session.server}/api/channels/${channel}/listen`, {
    method: "POST",
    headers: { Authorization: "Bearer " + session.token, "content-type": "application/octet-stream" },
    body: pcm.buffer,
  }).catch(() => {});
}

/** Keep capture in step with: in a call where Llamble listens, mic on. */
function sync() {
  const v = useVoice.getState();
  const want = v.status === "connected" && !v.muted && !v.deafened && listeningIn(v.channelId);
  const track = want ? (getRoom()?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack ?? null) : null;
  if (!want || !track) {
    if (ctx) stop();
    return;
  }
  if (track !== micTrack || channel !== v.channelId) start(track, v.channelId!);
}
useVoice.subscribe(sync);
useStore.subscribe((s, p) => s.config !== p.config && sync());
setInterval(sync, 3000); // mic restarts swap the track underneath us

// ---------------------------------------------------------------- answers

onEvent((t, d) => {
  if (t === "BOT_THINKING") {
    if (d.channel_id === useVoice.getState().channelId) useBotVoice.setState({ thinking: { channel: d.channel_id, question: d.question, at: Date.now() } });
  } else if (t === "BOT_SPEAK") {
    if (d.channel_id !== useVoice.getState().channelId) return;
    useBotVoice.setState({ thinking: null, caption: { text: d.text, at: Date.now(), asked_by: d.asked_by } });
    if (d.audio_url && !useVoice.getState().deafened) {
      const a = new Audio(media(d.audio_url));
      a.volume = Math.min(1, Number(prefs.get("botVolume", "1")));
      const out = prefs.get("audioOutput");
      if (out && "setSinkId" in a) (a as any).setSinkId(out).catch(() => {});
      a.play().catch(() => {});
      a.onended = () => setTimeout(() => clearCaption(d.text), 2500);
    } else setTimeout(() => clearCaption(d.text), Math.max(4000, d.text.length * 70));
  }
});

function clearCaption(text: string) {
  if (useBotVoice.getState().caption?.text === text) useBotVoice.setState({ caption: null });
}
