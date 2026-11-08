// Soundboard: everyone in the voice channel hears the clip. Each person plays it on
// their own device, so their soundboard volume / mute applies.
import { create } from "zustand";
import { api, media } from "./api";
import { onEvent } from "./store";
import { prefs, useVoice } from "./voice";

export interface Sound {
  id: string;
  name: string;
  emoji: string;
  file_id: string;
  volume: number;
  created_by: string;
}

export const BUILTIN: { name: string; emoji: string; label: string }[] = [
  { name: "airhorn", emoji: "📯", label: "Airhorn" },
  { name: "rimshot", emoji: "🥁", label: "Ba-dum-tss" },
  { name: "crickets", emoji: "🦗", label: "Crickets" },
  { name: "sad-trombone", emoji: "🎺", label: "Sad trombone" },
  { name: "boing", emoji: "🌀", label: "Boing" },
  { name: "drumroll", emoji: "🪘", label: "Drumroll" },
  { name: "applause", emoji: "👏", label: "Applause" },
  { name: "tada", emoji: "🎉", label: "Ta-da" },
  { name: "whoosh", emoji: "💨", label: "Whoosh" },
  { name: "bonk", emoji: "🔨", label: "Bonk" },
];

interface SB {
  sounds: Record<string, Sound[]>; // by guild
  last: { who: string; name: string; at: number } | null;
}
export const useSoundboard = create<SB>(() => ({ sounds: {}, last: null }));

export async function loadSounds(guildId: string) {
  try {
    const r = await api(`/api/guilds/${guildId}/sounds`);
    useSoundboard.setState((s) => ({ sounds: { ...s.sounds, [guildId]: r.sounds } }));
  } catch {}
}

export function soundboardVolume(): number {
  return Number(prefs.get("soundboardVolume", "0.6"));
}

const cache = new Map<string, HTMLAudioElement>();

function play(url: string, volume: number) {
  const v = useVoice.getState();
  if (v.deafened || prefs.get("soundboardMuted") === "1") return;
  let base = cache.get(url);
  if (!base) {
    base = new Audio(url);
    base.preload = "auto";
    cache.set(url, base);
  }
  const a = base.cloneNode(true) as HTMLAudioElement;
  a.volume = Math.max(0, Math.min(1, volume * soundboardVolume()));
  const out = prefs.get("audioOutput");
  if (out && "setSinkId" in a) (a as any).setSinkId(out).catch(() => {});
  a.play().catch(() => {});
}

export function builtinUrl(name: string) {
  return `./sounds/${name}.mp3`;
}

/** Preview a sound just for yourself. */
export function preview(s: { builtin?: string; file_id?: string; volume?: number }) {
  const url = s.builtin ? builtinUrl(s.builtin) : media(`/api/files/${s.file_id}`);
  const a = new Audio(url);
  a.volume = Math.min(1, (s.volume ?? 1) * soundboardVolume());
  a.play().catch(() => {});
}

/** Play a sound for everyone in your voice channel. */
export async function playForAll(sound: string) {
  const ch = useVoice.getState().channelId;
  if (!ch) return;
  await api(`/api/channels/${ch}/soundboard`, { body: { sound } });
}

onEvent((t, d) => {
  if (t === "SOUNDS_UPDATE") {
    useSoundboard.setState((s) => ({ sounds: { ...s.sounds, [d.guild_id]: d.sounds } }));
  } else if (t === "SOUNDBOARD_PLAY") {
    if (d.channel_id !== useVoice.getState().channelId) return;
    const s = d.sound;
    const label = s.builtin ? BUILTIN.find((b) => b.name === s.builtin)?.label ?? s.builtin : s.name;
    useSoundboard.setState({ last: { who: d.user_id, name: label, at: Date.now() } });
    play(s.builtin ? builtinUrl(s.builtin) : media(`/api/files/${s.file_id}`), s.volume ?? 1);
  }
});
