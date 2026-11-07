import {
  AudioPresets, ConnectionState, LocalParticipant, Participant, RemoteParticipant, RemoteTrack,
  Room, RoomEvent, ScreenSharePresets, Track, VideoPresets,
} from "livekit-client";
import { create } from "zustand";
import { api } from "./api";
import { sounds } from "./sounds";

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

function audioCapture() {
  const dev = prefs.get("audioInput");
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
  vset({ channelId, status: "connecting", error: null, camera: false, screen: false, speaking: [] });
  let info: { url: string; token: string; can_speak: boolean; can_video: boolean };
  try {
    info = await api(`/api/channels/${channelId}/voice`, { method: "POST" });
  } catch (e: any) {
    vset({ channelId: null, status: "idle", error: e.message });
    return;
  }
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
    .on(RoomEvent.Disconnected, () => {
      if (room === r) {
        room = null;
        audioBox.innerHTML = "";
        vset({ channelId: null, status: "idle", camera: false, screen: false, speaking: [] });
        bump();
      }
    })
    .on(RoomEvent.MediaDevicesError, (e: Error) => vset({ error: "Microphone/camera error: " + e.message }));

  try {
    await r.connect(info.url, info.token, { autoSubscribe: true });
  } catch (e: any) {
    room = null;
    vset({ channelId: null, status: "idle", error: "Couldn't connect to voice: " + (e?.message || e) });
    api("/api/voice/leave", { method: "POST" }).catch(() => {});
    return;
  }
  vset({ status: "connected", canSpeak: info.can_speak, canVideo: info.can_video });
  sounds.join();
  if (info.can_speak) {
    try {
      await r.localParticipant.setMicrophoneEnabled(!vget().muted && !vget().deafened, audioCapture());
    } catch (e: any) {
      vset({ error: "Microphone unavailable: " + e.message });
    }
  }
  syncServerState();
  bump();
}

export async function leaveVoice(notify = true) {
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
  if (room && s.canSpeak) await room.localParticipant.setMicrophoneEnabled(!muted, audioCapture()).catch(() => {});
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
  if (room && s.canSpeak) await room.localParticipant.setMicrophoneEnabled(!deafened && !s.muted, audioCapture()).catch(() => {});
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
      { screenShareEncoding: preset.encoding, videoCodec: "vp9", backupCodec: true },
    );
    vset({ screen: true, pickerOpen: false });
  } catch (e: any) {
    vset({ error: "Screen share failed: " + e.message, pickerOpen: false });
  }
  syncServerState();
  bump();
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
