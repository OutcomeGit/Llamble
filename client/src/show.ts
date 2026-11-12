// Show: record a call like a produced show.
// The recorder's app mixes the picture (auto-switching to whoever is talking unless the
// director holds a shot) and the sound of everyone who said yes, and records it:
//  - normally onto the recorder's own device (Library → Recordings), a few seconds at a time
//    so a crash keeps everything; nothing reaches the server until they share it
//  - or, if the show was set to save to the server (an instance option, off by default),
//    streamed up to the server a few seconds at a time instead.
import { CanvasRecorder } from "./webmrec";
import { startNativeSound, type NativeSound } from "./appsound";
import { builtinUrl } from "./soundboard";
import { media } from "./api";
import { create } from "zustand";
import { Track, type Participant } from "livekit-client";
import { api, session } from "./api";
import { memberName, onEvent, useStore } from "./store";
import { needVideo, participants, useVoice } from "./voice";
import * as localrec from "./localrec";

export interface Streams {
  voice: boolean;
  camera: boolean;
  screen: boolean;
}
export interface ShowPerson {
  user_id: string;
  wanted: Streams;
  consent: Streams | null;
}
export interface ShowState {
  focus?: string | null; // user id (or "screen:<uid>") on the main shot
  hold?: boolean; // director holds the shot (no auto-switch)
  layout?: "auto" | "speaker" | "grid" | "screen";
  title?: string | null;
  lower_third?: { text: string; sub?: string } | null;
  card?: string | null;
  /** the director's sound mix for the recording: source key → on/off and volume (0–2) */
  mix?: Record<string, MixEntry>;
}

export interface MixEntry {
  on?: boolean;
  vol?: number;
}

/** Name of the audio track the director's music player sends into the call. */
export const SHOW_MUSIC = "show-music";

/** How loud one sound source goes into the recording (0 when it's off). The whole-PC sound starts off. */
export function mixGain(st: ShowState | undefined, key: string): number {
  const m = st?.mix?.[key];
  const on = m?.on ?? (key !== "pc");
  return on ? Math.max(0, Math.min(2, m?.vol ?? 1)) : 0;
}

export interface MixSource {
  key: string; // "mic:<uid>", "screen:<uid>", "music:<uid>", "soundboard", "pc", "master"
  uid?: string;
  kind: "mic" | "screen" | "music" | "soundboard" | "pc" | "master";
  track: MediaStreamTrack | null;
}

/** Every sound a show can take in right now: voices and shared-app sound of the people who said yes, music, soundboard, PC sound. */
export function mixSources(s: Show): MixSource[] {
  const out: MixSource[] = [];
  const ps = participants();
  for (const person of s.people) {
    const p = ps.find((x) => x.identity === person.user_id);
    if (person.consent?.voice) out.push({ key: "mic:" + person.user_id, uid: person.user_id, kind: "mic", track: p ? trackOf(p, Track.Source.Microphone) : null });
    if (person.consent?.screen) out.push({ key: "screen:" + person.user_id, uid: person.user_id, kind: "screen", track: p ? trackOf(p, Track.Source.ScreenShareAudio) : null });
  }
  for (const p of ps) {
    const pub = [...p.trackPublications.values()].find((x) => x.trackName === SHOW_MUSIC && x.track && !x.isMuted);
    if (pub && s.people.some((x) => x.user_id === p.identity)) out.push({ key: "music:" + p.identity, uid: p.identity, kind: "music", track: pub.track!.mediaStreamTrack });
  }
  out.push({ key: "soundboard", kind: "soundboard", track: null }, { key: "pc", kind: "pc", track: null });
  return out;
}
export interface Show {
  id: string;
  channel_id: string;
  title: string;
  initiator_id: string;
  recorder_id: string;
  director_id: string;
  recorder_ok: boolean;
  director_ok: boolean;
  status: "setup" | "recording" | "ended" | "cancelled";
  state: ShowState;
  started_at: number | null;
  ended_at: number | null;
  size: number;
  people: ShowPerson[];
  video_url: string | null;
  /** "member": kept on the recorder's device; "server": saved on the server as it records */
  record_on?: "member" | "server";
  /** the video is on the server (saved there, or shared from the device) */
  on_server?: boolean;
}

/** live shows by channel; `status` only for channels you aren't part of */
export const useShows = create<{ live: Record<string, Show>; status: Record<string, string> }>(() => ({ live: {}, status: {} }));

onEvent((t, d) => {
  if (t === "READY") {
    const live: Record<string, Show> = {};
    const status: Record<string, string> = {};
    for (const s of (d.shows || []) as Show[]) {
      live[s.channel_id] = s;
      status[s.channel_id] = s.status;
    }
    useShows.setState({ live, status });
    setTimeout(syncRecorder, 0);
  } else if (t === "SHOW_UPDATE") {
    const s = d as Show;
    useShows.setState((st) => {
      const live = { ...st.live };
      if (s.status === "setup" || s.status === "recording") live[s.channel_id] = s;
      else if (live[s.channel_id]?.id === s.id) delete live[s.channel_id];
      return { live, status: { ...st.status, [s.channel_id]: s.status } };
    });
    syncRecorder();
  } else if (t === "SHOW_STATUS") {
    useShows.setState((st) => ({ status: { ...st.status, [d.channel_id]: d.status } }));
  }
});

export function myShow(): Show | undefined {
  const ch = useVoice.getState().channelId;
  return ch ? useShows.getState().live[ch] : undefined;
}

export const isRecording = (channelId: string) => useShows.getState().status[channelId] === "recording";

// ---------------------------------------------------------------- compositor

export type RecRes = "1080p" | "1440p" | "2160p";
const RES: Record<RecRes, [number, number, number]> = {
  "1080p": [1920, 1080, 8_000_000],
  "1440p": [2560, 1440, 14_000_000],
  "2160p": [3840, 2160, 28_000_000],
};

interface Source {
  key: string; // "<uid>" camera / "screen:<uid>"
  uid: string;
  kind: "camera" | "screen";
  el: HTMLVideoElement;
  track: Track;
  missingSince?: number;
}

/**
 * Draws the show. The director's preview and the recorder use the same code, so what
 * the director sees is what gets recorded.
 */
export class Compositor {
  canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private sources = new Map<string, Source>();
  /** people whose video we asked the call to send us even if this person isn't watching it */
  private needs = new Set<string>();
  private box: HTMLDivElement;
  /** who's on the main shot in auto mode, and since when */
  private auto: { uid: string; since: number } | null = null;
  private candidate: { uid: string; since: number } | null = null;

  constructor(
    private show: () => Show | undefined,
    w = 1920,
    h = 1080,
  ) {
    this.canvas.width = w;
    this.canvas.height = h;
    // the videos must stay "visible" so the call keeps sending full quality to us
    this.box = document.createElement("div");
    this.box.className = "show-sources";
    // sized like the recording so the call sends us full detail (up to 4K)
    this.box.style.width = w + "px";
    this.box.style.height = h + "px";
    document.body.appendChild(this.box);
  }

  destroy() {
    for (const s of this.sources.values()) s.track.detach(s.el);
    for (const k of this.needs) needVideo(k.split("|")[0], k.split("|")[1] as "camera" | "screen", false);
    this.needs.clear();
    this.box.remove();
  }

  /** Keep a <video> for every consented camera/screen. */
  private refreshSources(s: Show) {
    const want = new Map<string, { uid: string; kind: "camera" | "screen"; track: Track }>();
    const ps = participants();
    const needNow = new Set<string>();
    for (const person of s.people) {
      const c = person.consent;
      if (c?.camera) needNow.add(person.user_id + "|camera");
      if (c?.screen) needNow.add(person.user_id + "|screen");
    }
    for (const k of needNow) if (!this.needs.has(k)) needVideo(k.split("|")[0], k.split("|")[1] as "camera" | "screen", true);
    for (const k of this.needs) if (!needNow.has(k)) needVideo(k.split("|")[0], k.split("|")[1] as "camera" | "screen", false);
    this.needs = needNow;
    for (const person of s.people) {
      const c = person.consent;
      if (!c) continue;
      const p = ps.find((x) => x.identity === person.user_id);
      if (!p) continue;
      const cam = c.camera && lkTrack(p, Track.Source.Camera);
      // a shared window that briefly sends no picture (game lost focus, changed mode, skipped
      // frames) reads as "muted" for a moment: keep showing it rather than flipping away
      const scr = c.screen && lkTrack(p, Track.Source.ScreenShare, true);
      if (cam) want.set(person.user_id, { uid: person.user_id, kind: "camera", track: cam });
      if (scr) want.set("screen:" + person.user_id, { uid: person.user_id, kind: "screen", track: scr });
    }
    const now = Date.now();
    for (const [k, src] of this.sources) {
      const w = want.get(k);
      // gone for a moment: hold the last picture for a few seconds before switching shots
      if (!w && src.track.mediaStreamTrack?.readyState !== "ended") {
        src.missingSince ??= now;
        if (now - src.missingSince < 4000) continue;
      }
      if (w && src.track === w.track) {
        src.missingSince = undefined;
        continue;
      }
      if (!w || src.track !== w.track) {
        src.track.detach(src.el);
        src.el.remove();
        this.sources.delete(k);
      }
    }
    for (const [k, w] of want) {
      if (this.sources.has(k)) continue;
      const el = document.createElement("video");
      el.muted = true;
      el.playsInline = true;
      // attached through LiveKit so it keeps sending us full quality
      w.track.attach(el);
      el.play().catch(() => {});
      el.style.width = this.canvas.width + "px";
      el.style.height = this.canvas.height + "px";
      this.box.appendChild(el);
      this.sources.set(k, { key: k, uid: w.uid, kind: w.kind, el, track: w.track });
    }
  }

  draw() {
    const s = this.show();
    if (!s) return;
    this.refreshSources(s);
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const st = s.state || {};
    ctx.fillStyle = "#101114";
    ctx.fillRect(0, 0, W, H);

    if (st.card) {
      this.card(st.card, W, H);
      return;
    }

    const srcs = [...this.sources.values()];
    const cams = srcs.filter((x) => x.kind === "camera");
    const screens = srcs.filter((x) => x.kind === "screen");
    const voiceOnly = s.people.filter((p) => p.consent?.voice && !cams.some((c) => c.uid === p.user_id)).map((p) => p.user_id);
    const main = this.mainShot(s, srcs);
    const layout = st.layout && st.layout !== "auto" ? st.layout : screens.length ? "screen" : "speaker";

    if (layout === "grid" || (!main && srcs.length)) {
      this.grid(srcs, W, H);
    } else if (main) {
      this.fit(main.el, 0, 0, W, H, main.kind === "screen");
      if (main.kind === "camera") this.nameTag(main.uid, 24, H - 70);
      // everyone else in a strip
      const others = (layout === "screen" ? cams : srcs.filter((x) => x !== main)).filter((x) => x !== main).slice(0, 5);
      const tw = Math.round(W * 0.16);
      const th = Math.round((tw * 9) / 16);
      others.forEach((o, i) => {
        const x = W - tw - 24;
        const y = 24 + i * (th + 12);
        this.fit(o.el, x, y, tw, th, false, 10);
        this.nameTag(o.uid, x + 8, y + th - 34, 0.6);
      });
    } else {
      this.voiceBoard(voiceOnly.length ? voiceOnly : s.people.map((p) => p.user_id), W, H);
    }

    if (st.lower_third?.text) this.lowerThird(st.lower_third.text, st.lower_third.sub, W, H);
    if (st.title) this.titleBar(st.title, W);
  }

  /** Main shot: the director's pick when held, else whoever's talking (with a little patience). */
  private mainShot(s: Show, srcs: Source[]): Source | undefined {
    const st = s.state || {};
    const byKey = (k: string | null | undefined) => (k ? srcs.find((x) => x.key === k || x.uid === k) : undefined);
    if (st.hold && st.focus) {
      const f = byKey(st.focus);
      if (f) return f;
    }
    const screens = srcs.filter((x) => x.kind === "screen");
    if ((st.layout === "screen" || (!st.layout || st.layout === "auto")) && screens.length) {
      if (st.focus?.startsWith("screen:")) return byKey(st.focus) ?? screens[0];
      return screens[0];
    }
    const now = Date.now();
    const talking = useVoice.getState().speaking.find((uid) => srcs.some((x) => x.uid === uid && x.kind === "camera"));
    if (talking && talking !== this.auto?.uid) {
      if (this.candidate?.uid !== talking) this.candidate = { uid: talking, since: now };
      // switch after they've talked for 1.2 s, and keep each shot at least 3 s
      if (now - this.candidate.since > 1200 && (!this.auto || now - this.auto.since > 3000)) this.auto = { uid: talking, since: now };
    }
    const cur = this.auto && srcs.find((x) => x.uid === this.auto!.uid && x.kind === "camera");
    return cur || srcs.find((x) => x.kind === "camera");
  }

  private fit(el: HTMLVideoElement, x: number, y: number, w: number, h: number, contain: boolean, radius = 0) {
    const vw = el.videoWidth;
    const vh = el.videoHeight;
    const ctx = this.ctx;
    ctx.save();
    if (radius) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.clip();
      ctx.fillStyle = "#000";
      ctx.fillRect(x, y, w, h);
    }
    if (vw && vh) {
      const s = contain ? Math.min(w / vw, h / vh) : Math.max(w / vw, h / vh);
      const dw = vw * s;
      const dh = vh * s;
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    }
    ctx.restore();
  }

  private grid(srcs: Source[], W: number, H: number) {
    const n = Math.max(1, srcs.length);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const gw = W / cols;
    const gh = H / rows;
    srcs.forEach((s, i) => {
      const x = (i % cols) * gw;
      const y = Math.floor(i / cols) * gh;
      this.fit(s.el, x + 4, y + 4, gw - 8, gh - 8, s.kind === "screen", 12);
      this.nameTag(s.uid, x + 16, y + gh - 56, 0.75);
    });
  }

  private voiceBoard(uids: string[], W: number, H: number) {
    const ctx = this.ctx;
    const speaking = useVoice.getState().speaking;
    const n = Math.max(1, uids.length);
    const r = Math.min(110, W / (n * 3));
    uids.forEach((uid, i) => {
      const cx = (W / (n + 1)) * (i + 1);
      const cy = H / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = "#5865f2";
      ctx.fill();
      if (speaking.includes(uid)) {
        ctx.lineWidth = 8;
        ctx.strokeStyle = "#23a55a";
        ctx.stroke();
      }
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${r * 0.7}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(name(uid).slice(0, 2).toUpperCase(), cx, cy);
      ctx.font = `600 ${Math.max(20, r * 0.28)}px sans-serif`;
      ctx.fillText(name(uid), cx, cy + r + 36);
    });
  }

  private nameTag(uid: string, x: number, y: number, scale = 1) {
    const ctx = this.ctx;
    const t = name(uid);
    ctx.font = `600 ${Math.round(26 * scale * (this.canvas.width / 1920))}px sans-serif`;
    const w = ctx.measureText(t).width + 24 * scale;
    const h = 40 * scale * (this.canvas.width / 1920);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(t, x + 12 * scale, y + h / 2);
  }

  private lowerThird(text: string, sub: string | undefined, W: number, H: number) {
    const ctx = this.ctx;
    const k = W / 1920;
    const x = 80 * k;
    const y = H - 210 * k;
    ctx.font = `700 ${46 * k}px sans-serif`;
    const w = Math.max(ctx.measureText(text).width, sub ? (ctx.font = `500 ${30 * k}px sans-serif`, ctx.measureText(sub).width) : 0) + 60 * k;
    ctx.fillStyle = "#5865f2";
    ctx.fillRect(x, y, 10 * k, sub ? 120 * k : 76 * k);
    ctx.fillStyle = "rgba(16,17,20,0.85)";
    ctx.fillRect(x + 10 * k, y, w, sub ? 120 * k : 76 * k);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `700 ${46 * k}px sans-serif`;
    ctx.fillText(text, x + 34 * k, y + 14 * k);
    if (sub) {
      ctx.fillStyle = "#c9cdfb";
      ctx.font = `500 ${30 * k}px sans-serif`;
      ctx.fillText(sub, x + 34 * k, y + 72 * k);
    }
  }

  private titleBar(text: string, W: number) {
    const ctx = this.ctx;
    const k = W / 1920;
    ctx.font = `800 ${40 * k}px sans-serif`;
    const w = ctx.measureText(text).width + 60 * k;
    ctx.fillStyle = "rgba(16,17,20,0.8)";
    ctx.beginPath();
    ctx.roundRect((W - w) / 2, 28 * k, w, 70 * k, 14 * k);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, W / 2, 63 * k);
  }

  private card(text: string, W: number, H: number) {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#2b2f8f");
    g.addColorStop(1, "#7a2b8f");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `800 ${Math.round(W / 22)}px sans-serif`;
    const lines = text.split("\n").slice(0, 4);
    lines.forEach((l, i) => ctx.fillText(l, W / 2, H / 2 + (i - (lines.length - 1) / 2) * (W / 17)));
  }
}

function lkTrack(p: Participant, source: Track.Source, evenIfPaused = false): Track | null {
  const pub = p.getTrackPublication(source);
  return pub && (evenIfPaused || !pub.isMuted) && pub.track && pub.track.mediaStreamTrack?.readyState !== "ended" ? pub.track : null;
}

function trackOf(p: Participant, source: Track.Source): MediaStreamTrack | null {
  const pub = p.getTrackPublication(source);
  if (!pub || pub.isMuted || !pub.track) return null;
  return pub.track.mediaStreamTrack;
}

function name(uid: string) {
  const s = useStore.getState();
  const ch = useVoice.getState().channelId;
  const gid = ch ? s.channels[ch]?.guild_id ?? null : null;
  return memberName(gid, s.users[uid]);
}

// ---------------------------------------------------------------- recorder

export const useRecorder = create<{ showId: string | null; uploaded: number; pending: number; error: string | null; soundBlocked?: boolean; where?: "device" | "server"; encoder?: string; fps?: number; fpsNow?: number }>(() => ({
  showId: null,
  uploaded: 0,
  pending: 0,
  error: null,
}));

class Recorder {
  comp: Compositor;
  private rec: MediaRecorder | null = null;
  private audio = new AudioContext({ sampleRate: 48000 });
  private cr: CanvasRecorder | null = null;
  private dest = this.audio.createMediaStreamDestination();
  private mixed = new Map<string, { node: MediaStreamAudioSourceNode; gain: GainNode; track: MediaStreamTrack }>();
  private bus = this.audio.createGain();
  private sbGain = this.audio.createGain();
  private sbCache = new Map<string, Promise<AudioBuffer>>();
  private offSoundboard: () => void = () => {};
  private pc: NativeSound | null = null;
  private pcGain: GainNode | null = null;
  private pcStarting = false;
  private timer = 0;
  private seq = 0;
  private queue: Blob[] = [];
  private sending = false;
  stopped = false;
  private toServer: boolean;
  private local: Promise<void> = Promise.resolve();
  private localSize = 0;

  constructor(public showId: string, res: RecRes) {
    const show = Object.values(useShows.getState().live).find((s) => s.id === showId);
    this.toServer = show?.record_on === "server";
    if (!this.toServer) {
      const st = useStore.getState();
      const ch = show ? st.channels[show.channel_id] : undefined;
      this.local = localrec
        .begin({
          id: showId,
          title: show?.title || "",
          channel_id: show?.channel_id || "",
          channel_name: ch?.name,
          server_name: ch?.guild_id ? st.guilds[ch.guild_id]?.name : undefined,
          started_at: show?.started_at || Date.now(),
        })
        .catch((e) => useRecorder.setState({ error: "Couldn't save on this device: " + (e?.message || e) }));
    }
    this.bus.connect(this.dest);
    this.sbGain.connect(this.bus);
    // soundboard clips played in the show's call go into the recording too
    this.offSoundboard = onEvent((t, d) => {
      if (t !== "SOUNDBOARD_PLAY" || this.stopped) return;
      const sh = this.show();
      if (!sh || d.channel_id !== sh.channel_id) return;
      const url = d.sound.builtin ? builtinUrl(d.sound.builtin) : media(`/api/files/${d.sound.file_id}`);
      let buf = this.sbCache.get(url);
      if (!buf) {
        buf = fetch(url)
          .then((r) => r.arrayBuffer())
          .then((a) => this.audio.decodeAudioData(a));
        this.sbCache.set(url, buf);
      }
      buf
        .then((b) => {
          const src = this.audio.createBufferSource();
          const g = this.audio.createGain();
          g.gain.value = d.sound.volume ?? 1;
          src.buffer = b;
          src.connect(g).connect(this.sbGain);
          src.start();
        })
        .catch(() => this.sbCache.delete(url));
    });
    const [w, h] = RES[res];
    this.comp = new Compositor(() => Object.values(useShows.getState().live).find((s) => s.id === this.showId), w, h);
    this.start(res, w, h);
  }

  /** Pick the encoder, then start recording (the graphics card when it can, at 60 fps). */
  private async start(res: RecRes, w: number, h: number) {
    const [, , baseRate] = RES[res];
    const audioTrack = this.dest.stream.getAudioTracks()[0];
    this.unblockSound();
    const cr = await CanvasRecorder.start(this.comp.canvas, audioTrack, 60, Math.round(baseRate * 1.5), (b) => this.piece(b), (e) => useRecorder.setState({ error: "Recording trouble: " + e })).catch((e) => {
      console.warn("[llamble] recorder unavailable", e);
      return null;
    });
    if (this.stopped) {
      cr?.stop();
      return;
    }
    let fps = 30;
    if (cr) {
      this.cr = cr;
      fps = cr.info!.fps;
      console.info(`[llamble] recording ${w}x${h} at ${fps} fps with ${cr.info!.codec} on the ${cr.info!.hardware ? "graphics card" : "processor"}`);
      useRecorder.setState({ encoder: `${cr.info!.codec} · ${cr.info!.hardware ? "graphics card" : "processor"}`, fps });
    } else {
      // older engines: the browser's own recorder (VP9/VP8 on the processor)
      const stream = (this.comp.canvas as any).captureStream(30) as MediaStream;
      stream.addTrack(audioTrack);
      const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
      this.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: baseRate, audioBitsPerSecond: 160_000 });
      this.rec.ondataavailable = (e) => e.data.size && this.piece(e.data);
      this.rec.start(4000);
      useRecorder.setState({ encoder: "VP9 · processor", fps });
    }
    // draw on a timer, not animation frames, so it keeps going while the app is in the background
    this.timer = window.setInterval(
      () => {
        this.comp.draw();
        this.cr?.frame();
        this.mixAudio();
        if (this.cr && useRecorder.getState().fpsNow !== this.cr.fpsNow) useRecorder.setState({ fpsNow: this.cr.fpsNow });
      },
      Math.floor(1000 / fps),
    );
    useRecorder.setState({ showId: this.showId, uploaded: 0, pending: 0, error: null, where: this.toServer ? "server" : "device" });
  }

  /** A finished piece of the video file: onto this device in order, or up to the server. */
  private piece(data: Blob) {
    if (this.toServer) {
      this.queue.push(data);
      useRecorder.setState({ pending: this.queue.length });
      this.pump();
      return;
    }
    this.local = this.local.then(() =>
      localrec
        .append(this.showId, data)
        .then((size) => {
          this.localSize = size;
          useRecorder.setState({ uploaded: size, error: null });
        })
        .catch((err) => useRecorder.setState({ error: "Couldn't save on this device: " + (err?.message || err) })),
    );
  }

  /**
   * Phones (and some browsers) keep audio paused until the person taps something; the
   * recorder starts on its own, so it would record silence. Resume on the next tap/key
   * and tell the person until it's running.
   */
  private unblockSound() {
    const tryResume = () => {
      if (this.stopped) return done();
      this.audio
        .resume()
        .then(() => {
          if (this.audio.state === "running") done();
        })
        .catch(() => {});
    };
    const done = () => {
      useRecorder.setState({ soundBlocked: false });
      for (const ev of ["pointerdown", "keydown", "touchstart"]) window.removeEventListener(ev, tryResume, true);
    };
    tryResume();
    if (this.audio.state !== "running") {
      useRecorder.setState({ soundBlocked: true });
      for (const ev of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(ev, tryResume, true);
    }
    this.audio.onstatechange = () => useRecorder.setState({ soundBlocked: this.audio.state !== "running" && !this.stopped });
  }

  private show() {
    return Object.values(useShows.getState().live).find((x) => x.id === this.showId);
  }

  /** Mix every sound source at the director's levels (voices only from people who said yes). */
  private mixAudio() {
    const s = this.show();
    if (!s) return;
    const st = s.state || {};
    const now = this.audio.currentTime;
    const want = new Map<string, MediaStreamTrack>();
    for (const src of mixSources(s)) if (src.track) want.set(src.key, src.track);
    for (const [k, m] of this.mixed) {
      if (want.get(k) !== m.track) {
        m.node.disconnect();
        m.gain.disconnect();
        this.mixed.delete(k);
      }
    }
    for (const [k, t] of want) {
      let m = this.mixed.get(k);
      if (!m) {
        const node = this.audio.createMediaStreamSource(new MediaStream([t]));
        const gain = this.audio.createGain();
        node.connect(gain).connect(this.bus);
        m = { node, gain, track: t };
        this.mixed.set(k, m);
      }
      m.gain.gain.setTargetAtTime(mixGain(st, k), now, 0.05);
    }
    this.sbGain.gain.setTargetAtTime(mixGain(st, "soundboard"), now, 0.05);
    this.bus.gain.setTargetAtTime(mixGain(st, "master"), now, 0.05);
    // the recording PC's own sound (everything but Llamble), when the director turns it on
    const pcVol = mixGain(st, "pc");
    if (pcVol > 0 && !this.pc && !this.pcStarting) {
      this.pcStarting = true;
      startNativeSound("rec", "", "all").then((n) => {
        this.pcStarting = false;
        if (!n) return;
        if (this.stopped) return n.stop();
        this.pc = n;
        this.pcGain = this.audio.createGain();
        this.audio.createMediaStreamSource(new MediaStream([n.track])).connect(this.pcGain).connect(this.bus);
      });
    } else if (pcVol === 0 && this.pc) {
      this.pc.stop();
      this.pc = null;
      this.pcGain?.disconnect();
      this.pcGain = null;
    }
    this.pcGain?.gain.setTargetAtTime(pcVol, now, 0.05);
  }

  private async pump() {
    if (this.sending) return;
    this.sending = true;
    let wait = 1000;
    while (this.queue.length) {
      const blob = this.queue[0];
      try {
        const r = await fetch(`${session.server}/api/shows/${this.showId}/chunk`, {
          method: "POST",
          headers: { Authorization: "Bearer " + session.token, "x-seq": String(this.seq), "content-type": "application/octet-stream" },
          body: blob,
        });
        if (r.status === 409) {
          // the server is ahead/behind: follow what it expects
          const m = /expected piece (\d+)/.exec(await r.text());
          if (m) this.seq = Number(m[1]);
          else throw new Error("upload out of order");
          continue;
        }
        if (!r.ok) throw new Error(await r.text());
        this.queue.shift();
        this.seq++;
        wait = 1000;
        useRecorder.setState((s) => ({ uploaded: s.uploaded + blob.size, pending: this.queue.length, error: null }));
      } catch (e: any) {
        useRecorder.setState({ error: "Upload trouble, retrying… (" + (e?.message || e) + ")" });
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(15000, wait * 2);
        if (this.stopped && wait >= 15000 && this.queue.length > 50) break;
      }
    }
    this.sending = false;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    if (this.cr) {
      const last = await this.cr.stop();
      if (last) this.piece(last);
      this.cr = null;
    }
    if (this.rec && this.rec.state !== "inactive") {
      await new Promise<void>((res) => {
        this.rec!.onstop = () => res();
        this.rec!.stop();
      });
    }
    this.comp.destroy();
    this.offSoundboard();
    this.pc?.stop();
    this.audio.close().catch(() => {});
    if (!this.toServer) {
      await this.local;
      const s = useShows.getState();
      const show = Object.values(s.live).find((x) => x.id === this.showId);
      await localrec.updateMeta({ id: this.showId, ended_at: Date.now(), title: show?.title || "" } as localrec.RecMeta).catch(() => {});
      // tell the others in it how big it is (they see "on <recorder>'s device")
      await api(`/api/shows/${this.showId}/local-size`, { body: { size: this.localSize } }).catch(() => {});
      useRecorder.setState({ showId: null });
      return;
    }
    // let every last piece reach the server (up to ~2 minutes of retries)
    this.pump();
    const until = Date.now() + 120_000;
    while ((this.queue.length || this.sending) && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    useRecorder.setState({ showId: null });
  }
}

let recorder: Recorder | null = null;

/** Start/stop recording on this app when the show says so. */
export function syncRecorder() {
  const me = useStore.getState().me?.id;
  const shows = Object.values(useShows.getState().live);
  const mine = shows.find((s) => s.recorder_id === me && s.status === "recording");
  if (mine && (!recorder || recorder.showId !== mine.id)) {
    recorder?.stop();
    const res = (localStorage.getItem("llamble.showRes") as RecRes) || "1080p";
    recorder = new Recorder(mine.id, res);
  } else if (!mine && recorder) {
    const r = recorder;
    recorder = null;
    r.stop();
  }
}
// if our app leaves the call while recording, finish the recording properly
useVoice.subscribe((v, prev) => {
  if (prev.channelId && !v.channelId && recorder) {
    const id = recorder.showId;
    api(`/api/shows/${id}/stop`, { method: "POST" }).catch(() => {});
  }
});

export const showApi = {
  create: (channelId: string, body: unknown) => api(`/api/channels/${channelId}/shows`, { body }),
  consent: (id: string, s: Streams) => api(`/api/shows/${id}/consent`, { body: s }),
  role: (id: string, accept: boolean) => api(`/api/shows/${id}/role`, { body: { accept } }),
  start: (id: string) => api(`/api/shows/${id}/start`, { method: "POST" }),
  stop: (id: string) => api(`/api/shows/${id}/stop`, { method: "POST" }),
  state: (id: string, st: Partial<ShowState>) => api(`/api/shows/${id}/state`, { body: st }),
  director: (id: string, uid: string) => api(`/api/shows/${id}/director`, { body: { director_id: uid } }),
};
