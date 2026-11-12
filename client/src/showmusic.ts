// The show's music & sound files: the director loads mp3/wav/ogg/flac files from their own
// computer, and plays them into the call as a track of its own ("show-music"). Everyone in
// the call hears it and the recorder mixes it in like any other source (Director → Sound).
// Each file can loop, has its own volume, and can duck: drop under people's voices.
// Files stay on the director's computer; nothing is uploaded.
import { create } from "zustand";
import { LocalAudioTrack, Track } from "livekit-client";
import { SHOW_MUSIC, useShows } from "./show";
import { localParticipant, participants, useVoice } from "./voice";

export interface MusicItem {
  id: string;
  name: string;
  duration: number;
  playing: boolean;
  loop: boolean;
  duck: boolean;
  vol: number; // 0–1.5
  pos: number; // seconds, updated while playing
}

export const useShowMusic = create<{ items: MusicItem[]; live: boolean }>(() => ({ items: [], live: false }));

let ctx: AudioContext | null = null;
let out: MediaStreamAudioDestinationNode | null = null;
let track: LocalAudioTrack | null = null;
let duckTimer = 0;
const buffers = new Map<string, AudioBuffer>();
const voices = new Map<string, { src: AudioBufferSourceNode; gain: GainNode; duck: GainNode; startedAt: number; offset: number }>();

function engine() {
  if (!ctx) {
    ctx = new AudioContext({ sampleRate: 48000 });
    out = ctx.createMediaStreamDestination();
    out.channelCount = 2;
  }
  return { ctx, out: out! };
}

function patch(id: string, p: Partial<MusicItem>) {
  useShowMusic.setState((s) => ({ items: s.items.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
}
const item = (id: string) => useShowMusic.getState().items.find((x) => x.id === id);

/** Load files the director picked. */
export async function addMusic(files: FileList | File[]) {
  const { ctx } = engine();
  for (const f of Array.from(files).slice(0, 20)) {
    try {
      const buf = await ctx.decodeAudioData(await f.arrayBuffer());
      const id = Math.random().toString(36).slice(2);
      buffers.set(id, buf);
      useShowMusic.setState((s) => ({ items: [...s.items, { id, name: f.name.replace(/\.[^.]+$/, ""), duration: buf.duration, playing: false, loop: false, duck: true, vol: 0.8, pos: 0 }] }));
    } catch {
      throw new Error(`Couldn't read ${f.name} as sound`);
    }
  }
}

/** Send the music into the call (once, when the first file plays). */
async function goLive() {
  if (track) return;
  const lp = localParticipant();
  if (!lp) return;
  const { out } = engine();
  track = new LocalAudioTrack(out.stream.getAudioTracks()[0], undefined, false);
  try {
    await lp.publishTrack(track, { name: SHOW_MUSIC, source: Track.Source.Unknown, forceStereo: true, dtx: false, red: false, audioPreset: { maxBitrate: 160_000 } });
  } catch (e: any) {
    track = null;
    throw new Error(/permission/i.test(e?.message || "") ? "Playing music into the call needs permission to talk and use video in this channel." : "Couldn't play into the call: " + (e?.message || e));
  }
  useShowMusic.setState({ live: true });
  // duck: dip ducking files to a quarter while anyone talks
  duckTimer = window.setInterval(() => {
    const talking = someoneTalking();
    const now = ctx!.currentTime;
    for (const [id, v] of voices) {
      const it = item(id);
      v.duck.gain.setTargetAtTime(it?.duck && talking ? 0.25 : 1, now, talking ? 0.08 : 0.4);
      if (it) patch(id, { pos: Math.min(it.duration, v.offset + (now - v.startedAt)) });
    }
  }, 150);
}

// Who's talking, from the microphones themselves (the call's "speaking" list can count the
// music track as talking, which would make the music duck under itself).
const meters = new Map<MediaStreamTrack, AnalyserNode>();
const meterBuf = new Float32Array(1024);
let lastTalk = 0;
function someoneTalking(): boolean {
  const { ctx } = engine();
  const live = new Set<MediaStreamTrack>();
  let loud = false;
  for (const p of participants()) {
    const pub = p.getTrackPublication(Track.Source.Microphone);
    const t = pub && !pub.isMuted ? pub.track?.mediaStreamTrack : undefined;
    if (!t || t.readyState !== "live") continue;
    live.add(t);
    let a = meters.get(t);
    if (!a) {
      a = ctx.createAnalyser();
      a.fftSize = 1024;
      ctx.createMediaStreamSource(new MediaStream([t])).connect(a);
      meters.set(t, a);
    }
    a.getFloatTimeDomainData(meterBuf);
    let sum = 0;
    for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
    if (Math.sqrt(sum / meterBuf.length) > 0.02) loud = true;
  }
  for (const [t, a] of meters) if (!live.has(t)) (a.disconnect(), meters.delete(t));
  const now = performance.now();
  if (loud) lastTalk = now;
  return now - lastTalk < 600; // hold a moment so it doesn't pump between words
}

export async function playMusic(id: string) {
  const it = item(id);
  const buf = buffers.get(id);
  if (!it || !buf) return;
  const { ctx, out } = engine();
  await ctx.resume().catch(() => {});
  stopVoice(id);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = it.loop;
  const gain = ctx.createGain();
  gain.gain.value = it.vol;
  const duck = ctx.createGain();
  src.connect(gain).connect(duck);
  duck.connect(out); // into the call
  duck.connect(ctx.destination); // and so the director hears it too
  const offset = it.pos >= it.duration - 0.05 ? 0 : it.pos;
  src.start(0, offset);
  voices.set(id, { src, gain, duck, startedAt: ctx.currentTime, offset });
  src.onended = () => {
    if (voices.get(id)?.src !== src) return;
    voices.delete(id);
    patch(id, { playing: false, pos: 0 });
  };
  patch(id, { playing: true });
  try {
    await goLive();
  } catch (e) {
    stopVoice(id);
    patch(id, { playing: false });
    throw e;
  }
}

function stopVoice(id: string) {
  const v = voices.get(id);
  if (!v) return;
  voices.delete(id);
  try {
    v.src.stop();
  } catch {}
  v.duck.disconnect();
}

export function pauseMusic(id: string) {
  const v = voices.get(id);
  const it = item(id);
  if (v && it && ctx) patch(id, { pos: (v.offset + (ctx.currentTime - v.startedAt)) % it.duration });
  stopVoice(id);
  patch(id, { playing: false });
}

export function setMusic(id: string, p: Partial<Pick<MusicItem, "loop" | "duck" | "vol">>) {
  patch(id, p);
  const v = voices.get(id);
  if (!v || !ctx) return;
  if (p.vol !== undefined) v.gain.gain.setTargetAtTime(p.vol, ctx.currentTime, 0.05);
  if (p.loop !== undefined) v.src.loop = p.loop;
}

export function removeMusic(id: string) {
  stopVoice(id);
  buffers.delete(id);
  useShowMusic.setState((s) => ({ items: s.items.filter((x) => x.id !== id) }));
}

/** The show ended (or you left the call): stop everything and take the track out of the call. */
export async function endShowMusic() {
  for (const id of [...voices.keys()]) stopVoice(id);
  clearInterval(duckTimer);
  if (track) {
    const t = track;
    track = null;
    await localParticipant()
      ?.unpublishTrack(t, false)
      .catch(() => {});
  }
  useShowMusic.setState((s) => ({ live: false, items: s.items.map((x) => ({ ...x, playing: false })) }));
}

useVoice.subscribe((v, prev) => {
  if (prev.channelId && !v.channelId) endShowMusic();
});

// the show ended: the music stops with it
useShows.subscribe((s) => {
  if (!useShowMusic.getState().live) return;
  const ch = useVoice.getState().channelId;
  if (!ch || !s.live[ch]) endShowMusic();
});
