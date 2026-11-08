import {
  AudioPresets, ConnectionState, DisconnectReason, LocalParticipant, Participant, RemoteParticipant, RemoteTrack,
  Room, RoomEvent, ScreenSharePresets, Track, VideoPresets,
} from "livekit-client";
import { create } from "zustand";
import { api } from "./api";
import { sounds } from "./sounds";
import { onEvent } from "./store";

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

function audioCapture() {
  let dev = prefs.get("audioInput");
  if (dev && knownInputs && !knownInputs.includes(dev)) dev = "";
  return {
    deviceId: dev || undefined,
    echoCancellation: prefs.bool("echoCancellation"),
    noiseSuppression: prefs.bool("noiseSuppression"),
    autoGainControl: prefs.bool("autoGainControl"),
    channelCount: 1,
  };
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
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: audioCapture(),
    videoCaptureDefaults: { deviceId: prefs.get("videoInput") || undefined, resolution: VideoPresets.h720.resolution },
    publishDefaults: {
      audioPreset: { maxBitrate: Number(prefs.get("audioBitrate", "96000")) },
      dtx: true,
      red: true,
      videoCodec: "vp9",
      backupCodec: true,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      screenShareEncoding: ScreenSharePresets.h1080fps30.encoding,
    },
    audioOutput: prefs.get("audioOutput") ? { deviceId: prefs.get("audioOutput") } : undefined,
  });
  room = r;
  r.on(RoomEvent.TrackSubscribed, (track, _pub, p) => {
    attachAudio(track, p);
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
      await r.localParticipant.setMicrophoneEnabled(!vget().muted && !vget().deafened, audioCapture());
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
  if (room && s.canSpeak) await room.localParticipant.setMicrophoneEnabled(!muted, audioCapture()).then(() => !muted && vset({ error: null })).catch(micError);
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
  if (room && s.canSpeak) await room.localParticipant.setMicrophoneEnabled(!deafened && !s.muted, audioCapture()).catch(micError);
  if (room) syncServerState();
  bump();
}

export async function toggleCamera() {
  if (!room) return;
  const on = !vget().camera;
  try {
    await room.localParticipant.setCameraEnabled(on, { deviceId: prefs.get("videoInput") || undefined, resolution: VideoPresets.h720.resolution });
    vset({ camera: on });
  } catch (e: any) {
    vset({ error: "Camera unavailable: " + e.message });
  }
  syncServerState();
  bump();
}

export type ShareQuality = "720p30" | "1080p30" | "1080p60" | "1440p30";

export async function startScreenShare(sourceId: string, audio: boolean, quality: ShareQuality) {
  if (!room) return;
  await window.llambleNative?.setScreenSource({ id: sourceId, audio });
  const preset = {
    "720p30": ScreenSharePresets.h720fps30,
    "1080p30": ScreenSharePresets.h1080fps30,
    "1080p60": { encoding: { maxBitrate: 6_000_000, maxFramerate: 60 }, width: 1920, height: 1080 },
    "1440p30": { encoding: { maxBitrate: 8_000_000, maxFramerate: 30 }, width: 2560, height: 1440 },
  }[quality] as any;
  try {
    await room.localParticipant.setScreenShareEnabled(
      true,
      {
        audio,
        resolution: { width: preset.width ?? preset.resolution?.width, height: preset.height ?? preset.resolution?.height, frameRate: preset.encoding.maxFramerate },
        contentHint: quality.endsWith("60") ? "motion" : "detail",
        selfBrowserSurface: "exclude",
        systemAudio: audio ? "include" : "exclude",
      },
      // Chromebooks encode H.264 in hardware; their VP9 encoder can send black frames
      { screenShareEncoding: preset.encoding, videoCodec: isChromeOS() ? "h264" : "vp9", backupCodec: true },
    );
    vset({ screen: true, pickerOpen: false });
    const t = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
    if (t) watchForBlack(t);
  } catch (e: any) {
    vset({ error: "Screen share failed: " + e.message, pickerOpen: false });
  }
  syncServerState();
  bump();
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
    await r.localParticipant.setMicrophoneEnabled(true, audioCapture());
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
