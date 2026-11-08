import {
  AudioPresets, ConnectionState, DisconnectReason, LocalParticipant, Participant, RemoteParticipant, RemoteTrack,
  Room, RoomEvent, ScreenSharePresets, Track, VideoPreset, VideoPresets, type LocalVideoTrack, type RemoteTrackPublication, type VideoCodec,
} from "livekit-client";
import { create } from "zustand";
import { api } from "./api";
import { sounds } from "./sounds";
import { needsBackup, pickCodec, useEncoder, verifyEncoder, type VideoKind } from "./encoder";
import { onEvent, useStore } from "./store";

export interface VoiceUI {
  channelId: string | null;
  status: "idle" | "connecting" | "connected" | "reconnecting";
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  screen: boolean;
  speaking: string[];
  canSpeak: boolean;
  canVideo: boolean;
  error: string | null;
  version: number;
  pickerOpen: boolean;
  /** the browser is blocking call audio until the user clicks */
  audioBlocked?: boolean;
}

export const useVoice = create<VoiceUI>(() => ({
  channelId: null,
  status: "idle",
  muted: localStorage.getItem("llamble.muted") === "1",
  deafened: localStorage.getItem("llamble.deafened") === "1",
  camera: false,
  screen: false,
  speaking: [],
  canSpeak: true,
  canVideo: true,
  error: null,
  version: 0,
  pickerOpen: false,
}));
const vset = useVoice.setState;
const vget = useVoice.getState;
const bump = () => vset((s) => ({ version: s.version + 1 }));

let room: Room | null = null;
// the channel the user means to be in; survives dropped connections so we can rejoin
let wanted: string | null = null;
let rejoinTimer: number | undefined;
let rejoinStarted = 0;
const audioBox = (() => {
  const d = document.createElement("div");
  d.style.display = "none";
  document.body.appendChild(d);
  return d;
})();

export function getRoom() {
  return room;
}

export const prefs = {
  get(k: string, d = ""): string {
    return localStorage.getItem("llamble." + k) ?? d;
  },
  set(k: string, v: string) {
    localStorage.setItem("llamble." + k, v);
  },
  bool(k: string, d = true): boolean {
    const v = localStorage.getItem("llamble." + k);
    return v === null ? d : v === "1";
  },
};

// devices seen on this machine (refreshed on device changes); a saved device that's
// been unplugged falls back to the system default instead of failing
let knownInputs: string[] | null = null;
async function refreshDevices() {
  try {
    knownInputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput").map((d) => d.deviceId);
  } catch {
    knownInputs = null;
  }
}

/** Studio mic: your mic exactly as it sounds — no processing, stereo if the mic is, no voice-call tricks. Needs headphones. */
export function studioMic(): boolean {
  return prefs.bool("studioMic", false);
}

function audioCapture() {
  let dev = prefs.get("audioInput");
  if (dev && knownInputs && !knownInputs.includes(dev)) dev = "";
  const studio = studioMic();
  return {
    deviceId: dev || undefined,
    echoCancellation: !studio && prefs.bool("echoCancellation"),
    noiseSuppression: !studio && prefs.bool("noiseSuppression"),
    autoGainControl: !studio && prefs.bool("autoGainControl"),
    channelCount: studio ? 2 : 1,
    sampleRate: 48000,
  };
}

/** How the mic is sent: studio mode drops DTX (cuts quiet parts) and RED (duplicate packets), and keeps stereo. */
function micPublish() {
  return studioMic() ? { forceStereo: true, dtx: false, red: false } : {};
}

function userVolume(uid: string): number {
  return Number(prefs.get("vol." + uid, "1")) || 1;
}

export function setUserVolume(uid: string, v: number) {
  prefs.set("vol." + uid, String(v));
  const p = room?.remoteParticipants.get(uid);
  p?.setVolume(v);
  p?.setVolume(v, Track.Source.ScreenShareAudio);
}

function syncServerState() {
  const s = vget();
  api("/api/voice/state", { method: "PATCH", body: { muted: s.muted || !s.canSpeak, deafened: s.deafened, video: s.camera, screen: s.screen } }).catch(() => {});
}

function applyDeafen() {
  const deaf = vget().deafened;
  audioBox.querySelectorAll("audio").forEach((a) => ((a as HTMLAudioElement).muted = deaf));
}

function attachAudio(track: RemoteTrack, p: RemoteParticipant) {
  if (track.kind !== Track.Kind.Audio) return;
  const el = track.attach() as HTMLAudioElement;
  el.dataset.uid = p.identity;
  el.muted = vget().deafened;
  const out = prefs.get("audioOutput");
  if (out && "setSinkId" in el) (el as any).setSinkId(out).catch(() => {});
  audioBox.appendChild(el);
  p.setVolume(userVolume(p.identity));
}

export async function joinVoice(channelId: string) {
  if (vget().channelId === channelId && room) return;
  if (room) await leaveVoice(false);
  if (!window.isSecureContext) {
    vset({ error: "Voice and video need a secure (https://) connection in a browser. Use the desktop app, or open Llamble through its HTTPS address." });
    return;
  }
  clearTimeout(rejoinTimer);
  rejoinStarted = 0;
  wanted = channelId;
  await connect(channelId, false);
}

function scheduleRejoin(channelId: string) {
  if (wanted !== channelId) return;
  if (!rejoinStarted) rejoinStarted = Date.now();
  if (Date.now() - rejoinStarted > 3 * 60_000) {
    wanted = null;
    rejoinStarted = 0;
    vset({ channelId: null, status: "idle", error: "Lost the voice connection to the server. Click the voice channel to rejoin." });
    bump();
    return;
  }
  const tries = Math.round((Date.now() - rejoinStarted) / 1000);
  vset({ channelId, status: "reconnecting", speaking: [] });
  clearTimeout(rejoinTimer);
  rejoinTimer = window.setTimeout(() => connect(channelId, true), Math.min(15_000, 1000 + tries * 500));
}

async function connect(channelId: string, rejoining: boolean) {
  if (wanted !== channelId) return;
  vset({ channelId, status: rejoining ? "reconnecting" : "connecting", error: null, camera: false, screen: false, speaking: [] });
  await refreshDevices();
  let info: { url: string; token: string; can_speak: boolean; can_video: boolean };
  try {
    info = await api(`/api/channels/${channelId}/voice`, { method: "POST" });
  } catch (e: any) {
    // server unreachable (restarting, network blip): keep trying; a real refusal stops
    if (rejoining && (e?.status === undefined || e.status >= 500)) return scheduleRejoin(channelId);
    wanted = null;
    vset({ channelId: null, status: "idle", error: e.message });
    return;
  }
  if (wanted !== channelId) return;
  const r = new Room({
    // the desktop app keeps full video while minimized (a show may be recording)
    adaptiveStream: { pauseVideoInBackground: !window.llambleNative },
    dynacast: true,
    audioCaptureDefaults: audioCapture(),
    videoCaptureDefaults: { deviceId: prefs.get("videoInput") || undefined, resolution: cameraResolution() },
    publishDefaults: {
      audioPreset: { maxBitrate: Number(prefs.get("audioBitrate", "96000")) },
      dtx: true,
      red: true,
      videoCodec: "vp9",
      backupCodec: true,
      videoSimulcastLayers: cameraLayers(),
      screenShareEncoding: ScreenSharePresets.h1080fps30.encoding,
    },
    audioOutput: prefs.get("audioOutput") ? { deviceId: prefs.get("audioOutput") } : undefined,
  });
  room = r;
  r.on(RoomEvent.TrackSubscribed, (track, pub, p) => {
    // someone's video/stream you haven't chosen to watch: don't download it
    if (!wantTrack(p.identity, pub.source)) {
      (pub as RemoteTrackPublication).setSubscribed(false);
      bump();
      return;
    }
    attachAudio(track, p);
    bump();
  })
    .on(RoomEvent.TrackPublished, (pub, p) => {
      if (!wantTrack(p.identity, pub.source)) pub.setSubscribed(false);
      bump();
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
      bump();
    })
    .on(RoomEvent.ParticipantConnected, () => {
      sounds.join();
      bump();
    })
    .on(RoomEvent.ParticipantDisconnected, (p) => {
      sounds.leave();
      audioBox.querySelectorAll(`audio[data-uid="${p.identity}"]`).forEach((e) => e.remove());
      bump();
    })
    .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => vset({ speaking: speakers.map((s) => s.identity) }))
    .on(RoomEvent.TrackMuted, bump)
    .on(RoomEvent.TrackUnmuted, bump)
    .on(RoomEvent.LocalTrackPublished, bump)
    .on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub.source === Track.Source.ScreenShare) {
        vset({ screen: false });
        syncServerState();
      }
      bump();
    })
    .on(RoomEvent.ConnectionStateChanged, (st) => {
      if (st === ConnectionState.Reconnecting) vset({ status: "reconnecting" });
      else if (st === ConnectionState.Connected) vset({ status: "connected" });
    })
    .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (room !== r) return;
      room = null;
      audioBox.innerHTML = "";
      bump();
      // dropped by the network or a server restart: rejoin by ourselves
      if (wanted === channelId && reason !== DisconnectReason.CLIENT_INITIATED && reason !== DisconnectReason.DUPLICATE_IDENTITY && reason !== DisconnectReason.PARTICIPANT_REMOVED) {
        console.warn("voice dropped, rejoining", reason);
        scheduleRejoin(channelId);
        return;
      }
      wanted = null;
      const why = reason === DisconnectReason.DUPLICATE_IDENTITY ? "You joined voice from another device." : reason === DisconnectReason.PARTICIPANT_REMOVED ? "You were removed from the voice channel." : null;
      vset({ channelId: null, status: "idle", camera: false, screen: false, speaking: [], error: why });
    })
    .on(RoomEvent.MediaDevicesChanged, () => {
      refreshDevices().then(recoverMic);
    })
    .on(RoomEvent.MediaDevicesError, (e: Error) => vset({ error: "Microphone/camera error: " + e.message }))
    // browsers can refuse to play sound until the page is clicked
    .on(RoomEvent.AudioPlaybackStatusChanged, () => vset({ audioBlocked: !r.canPlaybackAudio }));

  try {
    await r.connect(info.url, info.token, { autoSubscribe: true });
  } catch (e: any) {
    if (room === r) room = null;
    if (rejoining) return scheduleRejoin(channelId);
    wanted = null;
    vset({ channelId: null, status: "idle", error: "Couldn't connect to voice: " + (e?.message || e) });
    api("/api/voice/leave", { method: "POST" }).catch(() => {});
    return;
  }
  if (room !== r) return;
  rejoinStarted = 0;
  vset({ status: "connected", canSpeak: info.can_speak, canVideo: info.can_video, audioBlocked: !r.canPlaybackAudio });
  if (!r.canPlaybackAudio) r.startAudio().then(() => vset({ audioBlocked: !r.canPlaybackAudio })).catch(() => {});
  if (!rejoining) sounds.join();
  if (info.can_speak) {
    try {
      await r.localParticipant.setMicrophoneEnabled(!vget().muted && !vget().deafened, audioCapture(), micPublish());
    } catch (e: any) {
      micError(e);
    }
  }
  syncServerState();
  bump();
}

export async function leaveVoice(notify = true) {
  wanted = null;
  clearTimeout(rejoinTimer);
  rejoinStarted = 0;
  const r = room;
  room = null;
  audioBox.innerHTML = "";
  vset({ channelId: null, status: "idle", camera: false, screen: false, speaking: [] });
  if (r) {
    await r.disconnect();
    sounds.leave();
  }
  if (notify) api("/api/voice/leave", { method: "POST" }).catch(() => {});
  bump();
}

export async function toggleMute() {
  const s = vget();
  let muted = !s.muted;
  let deafened = s.deafened;
  if (!muted && deafened) deafened = false; // unmuting also undeafens, like Discord
  vset({ muted, deafened });
  localStorage.setItem("llamble.muted", muted ? "1" : "0");
  localStorage.setItem("llamble.deafened", deafened ? "1" : "0");
  applyDeafen();
  muted ? sounds.mute() : sounds.unmute();
  if (room && s.canSpeak) await room.localParticipant.setMicrophoneEnabled(!muted, audioCapture(), micPublish()).then(() => !muted && vset({ error: null })).catch(micError);
  if (room) syncServerState();
  bump();
}

export async function toggleDeafen() {
  const s = vget();
  const deafened = !s.deafened;
  vset({ deafened });
  localStorage.setItem("llamble.deafened", deafened ? "1" : "0");
  applyDeafen();
  deafened ? sounds.mute() : sounds.unmute();
  if (room && s.canSpeak) await room.localParticipant.setMicrophoneEnabled(!deafened && !s.muted, audioCapture(), micPublish()).catch(micError);
  if (room) syncServerState();
  bump();
}

export async function toggleCamera() {
  if (!room) return;
  const on = !vget().camera;
  try {
    const codec = on ? await pickCodec("camera") : "vp8";
    await room.localParticipant.setCameraEnabled(
      on,
      { deviceId: prefs.get("videoInput") || undefined, resolution: cameraResolution() },
      { videoSimulcastLayers: cameraLayers(), videoCodec: codec, backupCodec: needsBackup(codec) },
    );
    vset({ camera: on });
    if (on) {
      syncCameraFx();
      watchEncoder("camera", codec);
    } else useEncoder.setState({ camera: undefined });
  } catch (e: any) {
    vset({ error: "Camera unavailable: " + e.message });
  }
  syncServerState();
  bump();
}

export type ShareQuality = "720p30" | "1080p30" | "1080p60" | "1440p30" | "1440p60" | "2160p30" | "2160p60" | "native";

export const SHARE_ORDER: ShareQuality[] = ["720p30", "1080p30", "1080p60", "1440p30", "1440p60", "2160p30", "2160p60", "native"];
export const SHARE_LABELS: Record<ShareQuality, string> = {
  "720p30": "720p · 30 fps",
  "1080p30": "1080p · 30 fps (text & code)",
  "1080p60": "1080p · 60 fps (games & video)",
  "1440p30": "1440p · 30 fps",
  "1440p60": "1440p · 60 fps",
  "2160p30": "4K · 30 fps",
  "2160p60": "4K · 60 fps",
  native: "Match my screen (up to 4K · 60 fps)",
};
const CAMERA_ORDER = ["360p", "720p", "1080p", "2160p"];

/** Is this screen-share quality within the server's limit? */
/** Your default from Settings → Voice & Video, lowered to the server's limit if needed. */
export function defaultShareQuality(): ShareQuality {
  const saved = (localStorage.getItem("llamble.shareQuality") as ShareQuality) || "1080p30";
  if (SHARE_ORDER.includes(saved) && shareAllowed(saved)) return saved;
  const ok = SHARE_ORDER.filter((q) => q !== "native" && shareAllowed(q));
  return ok[ok.length - 1] || "720p30";
}

export function setDefaultShareQuality(q: ShareQuality) {
  localStorage.setItem("llamble.shareQuality", q);
}

export function shareAllowed(q: ShareQuality): boolean {
  const max = (useStore.getState().config.media?.max_share || "native") as ShareQuality;
  return SHARE_ORDER.indexOf(q) <= SHARE_ORDER.indexOf(max);
}

export function cameraAllowed(q: string): boolean {
  const max = useStore.getState().config.media?.max_camera || "2160p";
  return CAMERA_ORDER.indexOf(q) <= CAMERA_ORDER.indexOf(max);
}

/** The camera resolution to use: your choice, capped by the server. */
function cameraResolution() {
  let q = prefs.get("cameraQuality", "720p");
  while (!cameraAllowed(q) && CAMERA_ORDER.indexOf(q) > 0) q = CAMERA_ORDER[CAMERA_ORDER.indexOf(q) - 1];
  return (q === "2160p" ? VideoPresets.h2160 : q === "1080p" ? VideoPresets.h1080 : q === "360p" ? VideoPresets.h360 : VideoPresets.h720).resolution;
}

/** Smaller copies sent alongside a big camera picture, so people on slow links still get video. */
function cameraLayers() {
  const h = cameraResolution().height;
  return h >= 2160 ? [VideoPresets.h360, VideoPresets.h1080] : h >= 1080 ? [VideoPresets.h360, VideoPresets.h720] : [VideoPresets.h180, VideoPresets.h360];
}

/** Resolution, frame rate and bitrate for a screen-share choice. */
function sharePreset(q: ShareQuality): { width: number; height: number; fps: number; bitrate: number } {
  if (q === "native") {
    const dpr = window.devicePixelRatio || 1;
    let w = Math.round(screen.width * dpr);
    let h = Math.round(screen.height * dpr);
    const k = Math.min(1, 3840 / w, 2160 / h);
    w = Math.round(w * k);
    h = Math.round(h * k);
    // about 0.04 bits per pixel per frame: 4K60 ~ 20 Mbps, 1440p60 ~ 9 Mbps, 1080p60 ~ 5 Mbps
    return { width: w, height: h, fps: 60, bitrate: Math.round(Math.max(3_000_000, Math.min(22_000_000, w * h * 60 * 0.04))) };
  }
  const [res, fps] = q.split("p").map(Number) as [number, number];
  const dims: Record<number, [number, number]> = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] };
  const [width, height] = dims[res];
  const rate: Record<string, number> = { "720p30": 2_000_000, "1080p30": 3_000_000, "1080p60": 6_000_000, "1440p30": 8_000_000, "1440p60": 12_000_000, "2160p30": 14_000_000, "2160p60": 20_000_000 };
  return { width, height, fps, bitrate: rate[q] };
}

export async function startScreenShare(sourceId: string, audio: boolean, quality: ShareQuality) {
  if (!room) return;
  while (!shareAllowed(quality) && SHARE_ORDER.indexOf(quality) > 0) quality = SHARE_ORDER[SHARE_ORDER.indexOf(quality) - 1];
  await window.llambleNative?.setScreenSource({ id: sourceId, audio });
  const p = sharePreset(quality);
  // People with smaller screens or slower connections get a lighter copy: VP9 sends
  // layers inside one stream; H.264 (Chromebooks) sends separate smaller copies.
  const codec = await pickCodec("screen");
  const layers =
    p.height > 1080
      ? [new VideoPreset(1280, 720, 1_500_000, 15), new VideoPreset(1920, 1080, 4_000_000, Math.min(30, p.fps))]
      : [new VideoPreset(1280, 720, 1_200_000, 15)];
  screenOpts = { screenShareEncoding: { maxBitrate: p.bitrate, maxFramerate: p.fps }, screenShareSimulcastLayers: layers };
  try {
    await room.localParticipant.setScreenShareEnabled(
      true,
      {
        // game/app sound: stereo, untouched (voice processing would mangle music and effects)
        audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } : false,
        resolution: { width: p.width, height: p.height, frameRate: p.fps },
        contentHint: p.fps >= 60 ? "motion" : "detail",
        selfBrowserSurface: "exclude",
        systemAudio: audio ? "include" : "exclude",
      },
      // AV1/H.264 on the graphics card when it can, else VP9 (see encoder.ts)
      // shared sound goes out as stereo Opus at music quality, without the voice-call
      // tricks (DTX cuts "silence", RED doubles packets) that suit speech, not game audio
      { ...screenOpts, videoCodec: codec, backupCodec: needsBackup(codec), forceStereo: true, dtx: false, red: false, audioPreset: { maxBitrate: 160_000 } },
    );
    watchEncoder("screen", codec);
    vset({ screen: true, pickerOpen: false });
    const t = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
    if (t) watchForBlack(t);
  } catch (e: any) {
    vset({ error: "Screen share failed: " + e.message, pickerOpen: false });
  }
  syncServerState();
  bump();
}

let screenOpts: Record<string, unknown> = {};

/**
 * A few seconds after publishing, look at what's really encoding the video. If an
 * automatically chosen hardware codec ended up on the CPU, send the same video again
 * with the next codec (viewers see a short blip, nothing to click).
 */
async function watchEncoder(kind: VideoKind, codec: VideoCodec) {
  const r = room;
  const source = kind === "camera" ? Track.Source.Camera : Track.Source.ScreenShare;
  const track = r?.localParticipant.getTrackPublication(source)?.track as LocalVideoTrack | undefined;
  if (!r || !track) return;
  const next = await verifyEncoder(kind, track, codec);
  if (!next || room !== r || r.localParticipant.getTrackPublication(source)?.track !== track) return;
  console.info(`[llamble] ${codec} was encoding on the CPU; switching ${kind} to ${next}`);
  try {
    await r.localParticipant.unpublishTrack(track, false);
    await r.localParticipant.publishTrack(track, {
      source,
      ...(kind === "camera" ? { videoSimulcastLayers: cameraLayers() } : screenOpts),
      videoCodec: next,
      backupCodec: needsBackup(next),
    });
    watchEncoder(kind, next);
  } catch (e) {
    console.warn("codec switch failed", e);
  }
}

function isChromeOS(): boolean {
  return /\bCrOS\b/.test(navigator.userAgent);
}

/** A shared screen that only ever sends black (Android apps on ChromeOS, protected video). */
function watchForBlack(track: MediaStreamTrack) {
  const v = document.createElement("video");
  v.muted = true;
  v.srcObject = new MediaStream([track]);
  v.play().catch(() => {});
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 18;
  const g = c.getContext("2d", { willReadFrequently: true });
  let black = 0;
  const t = setInterval(() => {
    if (track.readyState !== "live" || !g) return clearInterval(t);
    if (v.readyState < 2) return;
    g.drawImage(v, 0, 0, 32, 18);
    const d = g.getImageData(0, 0, 32, 18).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    black = sum / (d.length / 4) < 6 ? black + 1 : 0;
    if (black === 4) {
      vset({
        error: isChromeOS()
          ? "Your shared screen is coming through black. ChromeOS usually can't capture Android apps (like Roblox from the Play Store), even with Entire screen. Chrome tabs and windows share fine. To share Roblox, play it on a PC with the Windows app."
          : "Your shared screen is coming through black. Some apps and protected videos block screen capture. Try sharing a different window, or your whole screen.",
      });
      clearInterval(t);
    }
  }, 1000);
  setTimeout(() => clearInterval(t), 20000);
}

export async function stopScreenShare() {
  if (!room) return;
  await room.localParticipant.setScreenShareEnabled(false).catch(() => {});
  vset({ screen: false });
  useEncoder.setState({ screen: undefined });
  syncServerState();
  bump();
}

export async function applyDevicePrefs() {
  if (!room) return;
  const ai = prefs.get("audioInput");
  const ao = prefs.get("audioOutput");
  const vi = prefs.get("videoInput");
  if (ai) await room.switchActiveDevice("audioinput", ai).catch(() => {});
  if (vi) await room.switchActiveDevice("videoinput", vi).catch(() => {});
  if (ao) {
    await room.switchActiveDevice("audiooutput", ao).catch(() => {});
    audioBox.querySelectorAll("audio").forEach((a: any) => a.setSinkId?.(ao).catch(() => {}));
  }
}

export function participants(): Participant[] {
  if (!room) return [];
  return [room.localParticipant as LocalParticipant, ...Array.from(room.remoteParticipants.values())];
}

export function connectionQuality(): string {
  return room?.localParticipant.connectionQuality ?? "unknown";
}

/** Bring the microphone back if its device went away (unplugged headset, Windows switching the default, driver reset). */
async function recoverMic() {
  const r = room;
  const s = vget();
  if (!r || s.status !== "connected" || !s.canSpeak || s.muted || s.deafened) return;
  const pub = r.localParticipant.getTrackPublication(Track.Source.Microphone);
  const live = pub?.track?.mediaStreamTrack?.readyState === "live";
  if (live) return;
  try {
    await r.localParticipant.setMicrophoneEnabled(false);
    await r.localParticipant.setMicrophoneEnabled(true, audioCapture(), micPublish());
    console.warn("microphone restarted");
  } catch (e: any) {
    vset({ error: "Microphone unavailable: " + e.message });
  }
}
// cheap watchdog: a mic track can end without any device event
window.setInterval(recoverMic, 5000);

// After the chat connection comes back (or the server restarted), make sure the server
// still lists us in the call we're in, so others don't see us drop out.
onEvent((t, d) => {
  if (t !== "READY" || !room || !wanted || vget().status !== "connected") return;
  const me = d?.user?.id;
  if (me && !(d.voice_states || []).some((v: any) => v.user_id === me && v.channel_id === wanted)) {
    api(`/api/channels/${wanted}/voice`, { method: "POST" })
      .then(() => syncServerState())
      .catch(() => {});
  }
});

/** Explain why the microphone didn't start, in words people can act on. */
function micError(e: any) {
  const name = e?.name || "";
  const msg =
    name === "NotAllowedError" || /permission/i.test(e?.message || "")
      ? "Your browser blocked the microphone. Click the lock/settings icon next to the address, allow Microphone, then mute and unmute."
      : name === "NotFoundError"
        ? "No microphone found. Plug one in or pick one in Settings → Voice & Video."
        : name === "NotReadableError"
          ? "The microphone is busy or failed to start (another app may be using it)."
          : "Microphone unavailable: " + (e?.message || e);
  vset({ error: msg });
}

/** Turn call audio on after the browser blocked it (must run from a click). */
export async function enableAudio() {
  if (!room) return;
  try {
    await room.startAudio();
  } catch {}
  vset({ audioBlocked: !room.canPlaybackAudio });
}

// After the gateway reconnects (server restart/update), make sure the server still
// lists us in our voice channel; if it forgot, announce ourselves again so everyone
// sees us in the channel list.
onEvent((t, d) => {
  if (t !== "READY") return;
  const s = vget();
  if (!room || s.status !== "connected" || !s.channelId) return;
  const meId = d?.user?.id;
  const listed = (d?.voice_states || []).some((v: any) => v.user_id === meId && v.channel_id === s.channelId);
  if (!listed) {
    api(`/api/channels/${s.channelId}/voice`, { method: "POST" })
      .then(() => syncServerState())
      .catch(() => {});
  }
});

// ---------------------------------------------------------------- camera effects
// Effects run only while one is picked; switching everything off drops the processor.
let fxBusy = false;
async function syncCameraFx() {
  if (fxBusy || !room) return;
  const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined;
  if (!track) return;
  fxBusy = true;
  try {
    const fx = await import("./camerafx");
    const want = fx.fxActive();
    const has = track.getProcessor()?.name === "llamble-camerafx";
    if (want && !has) await track.setProcessor(new fx.CameraFxProcessor());
    else if (!want && has) await track.stopProcessor();
  } catch (e: any) {
    vset({ error: "Camera effects failed to start: " + (e?.message || e) });
  } finally {
    fxBusy = false;
  }
}
import("./camerafx").then((fx) => fx.useFx.subscribe(() => syncCameraFx()));

// ---------------------------------------------------------------- choosing what to watch
// Like Discord: screen shares aren't downloaded until you click "Watch"; cameras show
// unless you hide them. Your choices last for the call (per person and per kind).

/** your choice per person+kind for this call: true = watch, false = hide */
export const useWatch = create<Record<string, boolean>>(() => ({}));
const wkey = (identity: string, kind: "screen" | "camera") => identity + "|" + kind;
const kindOf = (src: Track.Source) => (src === Track.Source.ScreenShare || src === Track.Source.ScreenShareAudio ? "screen" : src === Track.Source.Camera ? "camera" : null);

/** Something outside the call view needs this person's video (a recording, a pop-out). */
const needed = new Set<string>();
export function needVideo(identity: string, kind: "screen" | "camera", on: boolean) {
  const k = wkey(identity, kind);
  if (on) needed.add(k);
  else needed.delete(k);
  applyWatch(identity, kind);
}

export function watching(identity: string, kind: "screen" | "camera"): boolean {
  const k = wkey(identity, kind);
  const choice = useWatch.getState()[k];
  if (choice !== undefined) return choice;
  return kind === "camera" ? prefs.bool("autoWatchCameras", true) : prefs.bool("autoWatchStreams", false);
}

function wantTrack(identity: string, src: Track.Source): boolean {
  const kind = kindOf(src);
  if (!kind) return true; // microphones: always
  return watching(identity, kind) || needed.has(wkey(identity, kind));
}

function applyWatch(identity: string, kind: "screen" | "camera") {
  const p = room?.remoteParticipants.get(identity);
  if (!p) return;
  const sources = kind === "screen" ? [Track.Source.ScreenShare, Track.Source.ScreenShareAudio] : [Track.Source.Camera];
  for (const src of sources) {
    const pub = p.getTrackPublication(src) as RemoteTrackPublication | undefined;
    if (pub) pub.setSubscribed(wantTrack(identity, src));
  }
  bump();
}

/** Watch / stop watching someone's screen share or camera. */
export function setWatching(identity: string, kind: "screen" | "camera", on: boolean) {
  useWatch.setState({ [wkey(identity, kind)]: on });
  applyWatch(identity, kind);
}

// a new call starts with the defaults again
useVoice.subscribe((v, prev) => {
  if (v.channelId !== prev.channelId) useWatch.setState({}, true);
});
