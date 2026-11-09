// Alarms and reminders. Alarms always ring (no notification or overlay setting can silence
// them, like a phone alarm) until snoozed or dismissed; reminders are ordinary notices.
// The server fires them (ALARM_FIRE); this app also keeps local timers so an alarm still
// rings if the connection drops for a moment (deduped per alarm + occurrence).
import { create } from "zustand";
import { api } from "./api";
import { onEvent } from "./store";
import type { User } from "./types";
import { toast } from "./ui";

export type AlarmKind = "alarm" | "reminder";
export interface Alarm {
  id: string;
  label: string;
  kind: AlarmKind;
  at: number | null;
  time: string | null;
  days: number[] | null;
  tz: string;
  sound: string;
  snooze_min: number;
  enabled: boolean;
  set_by: User | null;
  locked: boolean;
  next_at: number | null;
  snoozed_until: number | null;
  created_at: number;
}
export interface Ringing {
  alarm: Alarm;
  occurrence_at: number;
}
export interface Suggestion {
  event: { title: string; start: number };
  alarm_at: number;
  message: string;
}
export interface Schedule {
  calendar: { set: boolean; error: string | null; fetched_at: number | null };
  manual: { days: number[]; start: string; end: string | null; title: string } | null;
  sleep_hours: number;
  ready_minutes: number;
  suggest: boolean;
}
export interface UpcomingEvent {
  title: string;
  start: number;
  end: number | null;
  all_day: boolean;
  source: string;
}

export const SOUNDS: [string, string][] = [
  ["classic", "Classic beep-beep"],
  ["chime", "Chime"],
  ["gentle", "Gentle rise"],
  ["rooster", "Rooster (silly)"],
];

export const useAlarms = create<{ list: Record<string, Alarm>; ringing: Ringing[]; suggestion: Suggestion | null }>(() => ({
  list: {},
  ringing: [],
  suggestion: null,
}));
const set = useAlarms.setState;
const get = useAlarms.getState;

// ---------------------------------------------------------------- sound (synthesized)
let ctx: AudioContext | null = null;
let loop: { stop: () => void } | null = null;

function audio(): AudioContext {
  if (!ctx || ctx.state === "closed") ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

/** Schedule one "round" of a sound starting at t into gain node g; returns its length in seconds. */
function playRound(c: AudioContext, g: GainNode, sound: string, t: number): number {
  const tone = (freq: number, start: number, dur: number, type: OscillatorType = "square", vol = 0.5, slideTo?: number) => {
    const o = c.createOscillator();
    const e = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    if (slideTo) o.frequency.linearRampToValueAtTime(slideTo, start + dur);
    e.gain.setValueAtTime(0, start);
    e.gain.linearRampToValueAtTime(vol, start + 0.01);
    e.gain.setValueAtTime(vol, start + dur - 0.03);
    e.gain.linearRampToValueAtTime(0, start + dur);
    o.connect(e).connect(g);
    o.start(start);
    o.stop(start + dur + 0.02);
  };
  switch (sound) {
    case "chime":
      [784, 988, 1175].forEach((f, i) => tone(f, t + i * 0.28, 0.9, "sine", 0.45));
      return 2.2;
    case "gentle":
      tone(330, t, 1.6, "triangle", 0.4, 660);
      tone(495, t + 0.4, 1.4, "sine", 0.25, 880);
      return 2.6;
    case "rooster":
      tone(500, t, 0.18, "sawtooth", 0.3, 900);
      tone(900, t + 0.2, 0.15, "sawtooth", 0.3, 700);
      tone(700, t + 0.38, 0.55, "sawtooth", 0.3, 1100);
      tone(1100, t + 0.95, 0.4, "sawtooth", 0.25, 600);
      return 2.0;
    default: // classic beep-beep
      for (let i = 0; i < 4; i++) tone(880, t + i * 0.22, 0.12, "square", 0.35);
      return 1.4;
  }
}

/** Loop a sound until stopped; volume rises over 20 s (like a phone alarm). */
export function startSound(sound: string, ramp = true) {
  stopSound();
  const c = audio();
  const g = c.createGain();
  g.gain.setValueAtTime(ramp ? 0.15 : 0.8, c.currentTime);
  if (ramp) g.gain.linearRampToValueAtTime(1, c.currentTime + 20);
  g.connect(c.destination);
  let stopped = false;
  let next = c.currentTime + 0.05;
  const tick = () => {
    if (stopped) return;
    while (next < c.currentTime + 1.5) next += playRound(c, g, sound, next) + 0.6;
  };
  tick();
  const t = window.setInterval(tick, 500);
  loop = {
    stop: () => {
      stopped = true;
      clearInterval(t);
      try {
        g.gain.cancelScheduledValues(c.currentTime);
        g.gain.setValueAtTime(0, c.currentTime);
        g.disconnect();
      } catch {}
    },
  };
}

export function stopSound() {
  loop?.stop();
  loop = null;
}

/** ▶ preview in settings: one round, no looping. */
export function previewSound(sound: string) {
  const c = audio();
  const g = c.createGain();
  g.gain.value = 0.8;
  g.connect(c.destination);
  const len = playRound(c, g, sound, c.currentTime + 0.05);
  window.setTimeout(() => g.disconnect(), (len + 0.5) * 1000);
}

// ---------------------------------------------------------------- ringing
const rung = new Set<string>();
const key = (id: string, occ: number) => `${id}:${occ}`;

function overlayPayload() {
  const r = get().ringing[0];
  return r ? { kind: r.alarm.kind, alarm: r.alarm, occurrence_at: r.occurrence_at } : null;
}

function syncOutside() {
  const r = get().ringing[0];
  window.llambleNative?.overlay?.alarm?.(overlayPayload());
  if (r) startSound(r.alarm.sound);
  else stopSound();
}

function ring(alarm: Alarm, occurrence_at: number) {
  const k = key(alarm.id, occurrence_at);
  if (rung.has(k)) return;
  rung.add(k);
  if (alarm.kind === "reminder") {
    // reminders follow the notification settings (alarms never do)
    if (localStorage.getItem("llamble.status") === "dnd") return;
    toast(`🔔 ${alarm.label || "Reminder"}`);
    try {
      if (localStorage.getItem("llamble.notifications") !== "off" && "Notification" in window && Notification.permission === "granted")
        new Notification("Reminder", { body: alarm.label, silent: false });
    } catch {}
    // the overlay only shows reminders when overlay notifications are on (the app decides)
    window.llambleNative?.overlay?.alarm?.({ kind: "reminder", alarm, occurrence_at });
    return;
  }
  if (get().ringing.some((x) => x.alarm.id === alarm.id)) return;
  set({ ringing: [...get().ringing, { alarm, occurrence_at }] });
  syncOutside();
}

function stopRinging(id: string) {
  const before = get().ringing.length;
  set({ ringing: get().ringing.filter((x) => x.alarm.id !== id) });
  if (get().ringing.length !== before) syncOutside();
}

export async function snooze(id: string, minutes?: number) {
  stopRinging(id);
  try {
    const a = await api<Alarm>(`/api/alarms/${id}/snooze`, { body: minutes ? { minutes } : {} });
    if (a && a.id) merge([a]);
  } catch (e: any) {
    toast(e.message, "error");
    // couldn't snooze (e.g. "No more snoozes" on a parent's alarm): keep ringing
    const a = get().list[id];
    if (a) {
      set({ ringing: [...get().ringing, { alarm: a, occurrence_at: Date.now() }] });
      syncOutside();
    }
  }
}

export async function dismiss(id: string) {
  stopRinging(id);
  try {
    const a = await api<Alarm>(`/api/alarms/${id}/dismiss`, { body: {} });
    if (a && a.id) merge([a]);
  } catch (e: any) {
    toast(e.message, "error");
  }
}

// actions from the in-game overlay's buttons
window.llambleNative?.overlay?.onAlarmAction?.((a: { id: string; action: "snooze" | "dismiss"; minutes?: number }) => {
  if (a.action === "dismiss") dismiss(a.id);
  else snooze(a.id, a.minutes);
});

// ---------------------------------------------------------------- local timers
const timers = new Map<string, number>();
function schedule() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  const now = Date.now();
  for (const a of Object.values(get().list)) {
    const at = a.snoozed_until && a.snoozed_until > now ? a.snoozed_until : a.next_at;
    if (!a.enabled || !at) continue;
    const wait = at - now;
    if (wait < -60_000 || wait > 24 * 3600_000) continue;
    // the server normally fires first; this is the backup (a little later, deduped)
    timers.set(a.id, window.setTimeout(() => ring(a, at), Math.max(0, wait) + 4000));
  }
}

function merge(list: Alarm[]) {
  const all = { ...get().list };
  for (const a of list) all[a.id] = a;
  set({ list: all });
  schedule();
}

export async function loadAlarms() {
  try {
    const list = await api<Alarm[]>("/api/alarms");
    set({ list: Object.fromEntries(list.map((a) => [a.id, a])) });
    schedule();
  } catch {
    // older server without alarms
  }
}

// ---------------------------------------------------------------- CRUD
export type AlarmDraft = Partial<Pick<Alarm, "label" | "kind" | "at" | "time" | "days" | "sound" | "snooze_min" | "enabled" | "locked">> & { tz?: string };
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export async function createAlarm(d: AlarmDraft, kidId?: string) {
  const a = await api<Alarm>(kidId ? `/api/kids/${kidId}/alarms` : "/api/alarms", { body: { tz: tz(), ...d } });
  if (!kidId) merge([a]);
  return a;
}
export async function updateAlarm(id: string, d: AlarmDraft) {
  const a = await api<Alarm>(`/api/alarms/${id}`, { method: "PATCH", body: { tz: tz(), ...d } });
  merge([a]);
  return a;
}
export async function deleteAlarm(id: string) {
  await api(`/api/alarms/${id}`, { method: "DELETE" });
  const all = { ...get().list };
  delete all[id];
  set({ list: all });
  schedule();
}

// ---------------------------------------------------------------- schedule + suggestion
export const getSchedule = () => api<Schedule>("/api/schedule");
export const putSchedule = (b: Partial<Omit<Schedule, "calendar">> & { calendar_url?: string | null }) => api<Schedule>("/api/schedule", { method: "PUT", body: b });
export const upcoming = (days = 2) => api<UpcomingEvent[]>(`/api/schedule/upcoming?days=${days}`);

let suggestedDay = "";
export async function checkSuggestion() {
  const day = new Date().toDateString();
  if (suggestedDay === day) return;
  suggestedDay = day;
  try {
    const s = await api<Suggestion | null>("/api/schedule/suggestion");
    set({ suggestion: s && s.alarm_at ? s : null });
  } catch {
    set({ suggestion: null });
  }
}

export async function acceptSuggestion(at: number) {
  const s = get().suggestion;
  if (!s) return;
  const when = new Date(s.event.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  set({ suggestion: null });
  try {
    await createAlarm({ label: `Time to get off — ${s.event.title} at ${when}`, kind: "alarm", at });
    toast("Alarm set");
  } catch (e: any) {
    toast(e.message, "error");
  }
}

export async function declineSuggestion() {
  set({ suggestion: null });
  await api("/api/schedule/suggestion/decline", { body: {} }).catch(() => {});
}

// ---------------------------------------------------------------- formatting
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DAY_NAMES = DAY;
export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
export function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 864e5);
  const day = d.toDateString() === today.toDateString() ? "Today" : d.toDateString() === tomorrow.toDateString() ? "Tomorrow" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `${day} ${fmtTime(ms)}`;
}
export function repeatText(a: Pick<Alarm, "days" | "time" | "at">): string {
  if (a.time && a.days?.length) {
    const days = [...a.days].sort();
    const s = days.join(",");
    const label = s === "0,1,2,3,4,5,6" ? "Every day" : s === "1,2,3,4,5" ? "Weekdays" : s === "0,6" ? "Weekends" : days.map((d) => DAY[d]).join(" ");
    return label;
  }
  return "Once";
}

/** The soonest enabled alarm within the next `hours`. */
export function nextAlarm(list: Record<string, Alarm>, hours = 12): Alarm | null {
  const now = Date.now();
  let best: Alarm | null = null;
  for (const a of Object.values(list)) {
    const at = a.snoozed_until && a.snoozed_until > now ? a.snoozed_until : a.next_at;
    if (!a.enabled || a.kind !== "alarm" || !at || at < now || at - now > hours * 3600_000) continue;
    if (!best || at < (best.next_at ?? Infinity)) best = { ...a, next_at: at };
  }
  return best;
}

// ---------------------------------------------------------------- gateway
onEvent((t, d) => {
  switch (t) {
    case "READY":
      setTimeout(() => {
        loadAlarms();
        checkSuggestion();
      }, 500);
      break;
    case "ALARM_FIRE":
      if (d?.alarm) {
        merge([d.alarm]);
        ring(d.alarm, d.occurrence_at ?? d.alarm.next_at ?? Date.now());
      }
      break;
    case "ALARM_STOP":
      stopRinging(d?.alarm_id);
      break;
    case "ALARM_CREATE":
    case "ALARM_UPDATE":
      if (d?.id) merge([d]);
      break;
    case "ALARM_DELETE": {
      const all = { ...get().list };
      delete all[d?.id];
      set({ list: all });
      stopRinging(d?.id);
      schedule();
      break;
    }
  }
});

// a new day: maybe a new get-off suggestion (checked hourly)
window.setInterval(() => {
  if (new Date().toDateString() !== suggestedDay && suggestedDay) checkSuggestion();
}, 3600_000);
