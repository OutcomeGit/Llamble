import { useEffect, useState } from "react";
import { api } from "../api";
import {
  DAY_NAMES,
  SOUNDS,
  acceptSuggestion,
  createAlarm,
  declineSuggestion,
  deleteAlarm,
  dismiss,
  fmtTime,
  fmtWhen,
  getSchedule,
  previewSound,
  putSchedule,
  repeatText,
  snooze,
  upcoming,
  updateAlarm,
  useAlarms,
  type Alarm,
  type AlarmDraft,
  type AlarmLevel,
  DEFAULT_LEVEL,
  LEVELS,
  levelOf,
  type Schedule,
  type UpcomingEvent,
} from "../alarms";
import { toast } from "../ui";
import { Toggle } from "./common";

// ---------------------------------------------------------------- the ringing card
export interface AlarmView {
  alarm: Alarm;
  occurrence_at: number;
}

/** The big card shown while an alarm rings (in the app, and on the in-game overlay). */
export function AlarmCard({ r, onSnooze, onDismiss }: { r: AlarmView; onSnooze: (min?: number) => void; onDismiss: () => void }) {
  const a = r.alarm;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const extra = [10, 30].filter((m) => m !== a.snooze_min);
  return (
    <div className="al-card" role="alertdialog" aria-label={`Alarm: ${a.label}`}>
      <div className="al-bell">⏰</div>
      <div className="al-time">{fmtTime(now)}</div>
      <div className="al-label">{a.label || "Alarm"}</div>
      {a.set_by && <div className="al-by">Set by {a.set_by.display_name}{a.locked ? " 🔒" : ""}</div>}
      <div className="al-actions">
        <button className="al-btn al-snooze" onClick={() => onSnooze(a.snooze_min)}>
          Snooze {a.snooze_min} min
        </button>
        {extra.map((m) => (
          <button key={m} className="al-btn al-snooze-sm" onClick={() => onSnooze(m)}>
            {m} min
          </button>
        ))}
        <button className="al-btn al-dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** In the main app: covers the window until snoozed or dismissed (no other way to close it). */
export function AlarmRinging() {
  const ringing = useAlarms((s) => s.ringing);
  const r = ringing[0];
  if (!r) return null;
  return (
    <div className="al-backdrop">
      <AlarmCard r={r} onSnooze={(m) => snooze(r.alarm.id, m)} onDismiss={() => dismiss(r.alarm.id)} />
    </div>
  );
}

/** "It seems you have something early tomorrow" — shown after signing in, only set if accepted. */
export function AlarmSuggestion() {
  const s = useAlarms((x) => x.suggestion);
  const [time, setTime] = useState("");
  useEffect(() => {
    if (!s) return;
    const d = new Date(s.alarm_at);
    setTime(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
  }, [s?.alarm_at]);
  if (!s) return null;
  const pickedAt = () => {
    const d = new Date(s.alarm_at);
    const [h, m] = time.split(":").map(Number);
    const out = new Date(d);
    out.setHours(h || 0, m || 0, 0, 0);
    // a time after the event's start wouldn't make sense: assume they meant the day before
    if (out.getTime() >= s.event.start) out.setDate(out.getDate() - 1);
    return out.getTime();
  };
  return (
    <div className="al-suggest" role="dialog" aria-label="Alarm suggestion">
      <div className="al-suggest-head">🌙 Bedtime check</div>
      <div className="al-suggest-msg">{s.message}</div>
      <label className="al-suggest-time">
        Get-off alarm at <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      </label>
      <div className="al-suggest-actions">
        <button className="btn" onClick={() => declineSuggestion()}>
          Not tonight
        </button>
        <button className="btn primary" onClick={() => acceptSuggestion(pickedAt())}>
          Set alarm
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- settings
function AlarmRow({ a, onEdit, onDelete, onToggle }: { a: Alarm; onEdit: () => void; onDelete: () => void; onToggle: (v: boolean) => void }) {
  const when = a.snoozed_until && a.snoozed_until > Date.now() ? `Snoozed until ${fmtTime(a.snoozed_until)}` : a.next_at ? fmtWhen(a.next_at) : "Not scheduled";
  return (
    <div className={"al-row" + (a.enabled ? "" : " off")}>
      <div className="al-row-main">
        <div className="al-row-time">{a.time ? formatHM(a.time) : a.at ? fmtTime(a.at) : "—"}</div>
        <div>
          <div className="bold">
            {a.label || "Alarm"} <span className={"al-kind al-kind-l" + levelOf(a)} title={LEVELS[levelOf(a)].annoy}>{LEVELS[levelOf(a)].name}</span>
          </div>
          <div className="muted small">
            {repeatText(a)} · next: {when}
            {a.set_by && ` · set by ${a.set_by.display_name}${a.locked ? " 🔒" : ""}`}
          </div>
        </div>
      </div>
      <div className="row gap center-v">
        <Toggle on={a.enabled} disabled={a.locked} onChange={onToggle} />
        <button className="btn small" disabled={a.locked} onClick={onEdit}>
          Edit
        </button>
        <button className="btn small danger" disabled={a.locked} onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

function formatHM(hm: string): string {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return fmtTime(d.getTime());
}

/** The how-annoying slider: Chime … Siren, with what each step does underneath. */
function LevelSlider({ level, onChange }: { level: AlarmLevel; onChange: (l: AlarmLevel) => void }) {
  const L = LEVELS[level];
  return (
    <div className="al-level">
      <div className="row center-v" style={{ justifyContent: "space-between" }}>
        <span className="bold">
          {L.name} <span className="muted">({L.annoy})</span>
        </span>
        {level === DEFAULT_LEVEL && <span className="muted small">default</span>}
      </div>
      <input type="range" min={1} max={5} step={1} value={level} aria-label="How annoying" onChange={(e) => onChange(Number(e.target.value) as AlarmLevel)} />
      <div className="al-level-ends muted small">
        {([1, 2, 3, 4, 5] as AlarmLevel[]).map((l) => (
          <span key={l} className={l === level ? "on" : ""} onClick={() => onChange(l)}>
            {LEVELS[l].name}
          </span>
        ))}
      </div>
      <div className="al-flags">
        <span className={"al-flag" + (L.sound === "none" ? " off" : "")}>🔊 {L.sound === "loop" ? "Rings until you stop it" : L.sound === "once" ? "One chime" : "No sound"}</span>
        <span className={"al-flag" + (L.overlay ? "" : " off")}>🖥 {L.overlay ? "Pops up over games until dismissed" : level === 5 ? "Nothing on screen: tab out and stop it in Llamble" : "Waits in Llamble, not over games"}</span>
      </div>
      <div className="muted small">Do Not Disturb and notification settings never turn an alarm down: it always does what you pick here.</div>
    </div>
  );
}

/** Add/edit an alarm. */
export function AlarmEditor({ initial, onSave, onClose, lockedOption }: { initial?: Alarm; onSave: (d: AlarmDraft) => Promise<unknown>; onClose: () => void; lockedOption?: boolean }) {
  const now = new Date(Date.now() + 3600_000);
  const [label, setLabel] = useState(initial?.label ?? "");
  const [level, setLevel] = useState<AlarmLevel>(initial ? levelOf(initial) : DEFAULT_LEVEL);
  const [repeat, setRepeat] = useState(!!initial?.days?.length);
  const [date, setDate] = useState(() => {
    const d = initial?.at ? new Date(initial.at) : now;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [time, setTime] = useState(() => {
    if (initial?.time) return initial.time;
    const d = initial?.at ? new Date(initial.at) : now;
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  });
  const [days, setDays] = useState<number[]>(initial?.days ?? [1, 2, 3, 4, 5]);
  const [sound, setSound] = useState(initial?.sound ?? "classic");
  const [snoozeMin, setSnoozeMin] = useState(initial?.snooze_min ?? 10);
  const [locked, setLocked] = useState(initial?.locked ?? !!lockedOption);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const d: AlarmDraft = { label: label.trim(), level, sound, snooze_min: snoozeMin, enabled: true };
    if (repeat) {
      if (!days.length) return toast("Pick at least one day", "error");
      Object.assign(d, { time, days, at: null });
    } else {
      const at = new Date(`${date}T${time}`).getTime();
      if (!(at > Date.now())) return toast("Pick a time in the future", "error");
      Object.assign(d, { at, time: null, days: null });
    }
    if (lockedOption) d.locked = locked;
    setBusy(true);
    try {
      await onSave(d);
      onClose();
    } catch (e: any) {
      toast(e.message, "error");
      setBusy(false);
    }
  };
  return (
    <div className="al-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal al-editor">
        <h2>{initial ? "Edit" : "New"} alarm</h2>
        <label>
          Label
          <input value={label} maxLength={100} placeholder="Time to get off" onChange={(e) => setLabel(e.target.value)} />
        </label>
        <LevelSlider level={level} onChange={setLevel} />
        <div className="al-seg">
          <button className={"al-seg-btn" + (!repeat ? " on" : "")} onClick={() => setRepeat(false)}>
            Once
          </button>
          <button className={"al-seg-btn" + (repeat ? " on" : "")} onClick={() => setRepeat(true)}>
            Repeat
          </button>
        </div>
        <div className="row gap">
          {!repeat && (
            <label style={{ flex: 1 }}>
              Date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          )}
          <label style={{ flex: 1 }}>
            Time
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
        {repeat && (
          <div className="al-days">
            {DAY_NAMES.map((n, i) => (
              <button key={n} className={"al-day" + (days.includes(i) ? " on" : "")} onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort())}>
                {n}
              </button>
            ))}
          </div>
        )}
        {LEVELS[level].sound !== "none" && (
          <>
            <label>
              Sound
              <div className="row gap center-v">
                <select value={sound} onChange={(e) => setSound(e.target.value)} style={{ flex: 1 }}>
                  {SOUNDS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
                <button className="btn small" title="Play once" onClick={() => previewSound(sound)}>
                  ▶
                </button>
              </div>
            </label>
          </>
        )}
        <>
            <label>
              Snooze length
              <select value={snoozeMin} onChange={(e) => setSnoozeMin(Number(e.target.value))}>
                {[5, 10, 15, 20, 30].map((m) => (
                  <option key={m} value={m}>
                    {m} minutes
                  </option>
                ))}
              </select>
            </label>
          </>
        {lockedOption && (
          <div className="perm-row">
            <div>
              <div className="bold">Locked</div>
              <div className="muted small">Your kid can't turn it off, change or delete it.</div>
            </div>
            <Toggle on={locked} onChange={setLocked} />
          </div>
        )}
        <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

const CAL_HELP: [string, string][] = [
  ["Google Calendar", "Settings → pick your calendar → “Secret address in iCal format”"],
  ["Apple iCloud", "Calendar → share the calendar → turn on Public Calendar → copy the link"],
  ["Outlook", "Settings → Calendar → Shared calendars → Publish a calendar → ICS link"],
];

/** Settings → Schedule & alarms */
export function ScheduleSettings() {
  const list = useAlarms((s) => s.list);
  const [editing, setEditing] = useState<Alarm | "new" | null>(null);
  const alarms = Object.values(list).sort((a, b) => (a.next_at ?? Infinity) - (b.next_at ?? Infinity));
  return (
    <div>
      <h2>Schedule &amp; alarms</h2>
      <div className="profile-section">Alarms</div>
      {alarms.length === 0 && <p className="muted small">No alarms yet.</p>}
      {alarms.map((a) => (
        <AlarmRow
          key={a.id}
          a={a}
          onEdit={() => setEditing(a)}
          onDelete={() => deleteAlarm(a.id).catch((e) => toast(e.message, "error"))}
          onToggle={(v) => updateAlarm(a.id, { enabled: v }).catch((e) => toast(e.message, "error"))}
        />
      ))}
      <button className="btn primary" onClick={() => setEditing("new")}>
        + New alarm
      </button>
      {editing && (
        <AlarmEditor
          initial={editing === "new" ? undefined : editing}
          onSave={(d) => (editing === "new" ? createAlarm(d) : updateAlarm(editing.id, d))}
          onClose={() => setEditing(null)}
        />
      )}
      <YourSchedule />
    </div>
  );
}

function YourSchedule() {
  const [s, setS] = useState<Schedule | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<UpcomingEvent[] | null>(null);
  const load = () => {
    getSchedule()
      .then((x) => {
        setS(x);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
    upcoming(2).then(setEvents).catch(() => setEvents([]));
  };
  useEffect(load, []);
  const save = async (b: Parameters<typeof putSchedule>[0]) => {
    try {
      setS(await putSchedule(b));
      upcoming(2).then(setEvents).catch(() => {});
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  if (err) return <p className="muted small">Schedules need a newer Llamble server ({err}).</p>;
  if (!s) return <p className="muted small">Loading your schedule…</p>;
  const manual = s.manual ?? { days: [1, 2, 3, 4, 5], start: "05:00", end: null, title: "Work" };
  return (
    <>
      <div className="profile-section">Your schedule</div>
      <p className="muted small">
        Llamble can suggest a "time to get off" alarm when you have something early the next day. It only reads your schedule; nothing is set unless you
        say yes.
      </p>
      <div className="bold">Calendar subscription link</div>
      {s.calendar.set ? (
        <div className="row gap center-v al-cal">
          <span>
            {s.calendar.error ? (
              <span className="al-err">Couldn't read it: {s.calendar.error}</span>
            ) : (
              <>Linked ✓{s.calendar.fetched_at ? ` (updated ${Math.max(1, Math.round((Date.now() - s.calendar.fetched_at) / 60000))} min ago)` : ""}</>
            )}
          </span>
          <button className="btn small" onClick={() => save({ calendar_url: null })}>
            Remove link
          </button>
        </div>
      ) : (
        <div className="row gap al-cal">
          <input placeholder="https://… .ics" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
          <button className="btn primary" disabled={!url.trim()} onClick={() => save({ calendar_url: url.trim() }).then(() => setUrl(""))}>
            Link
          </button>
        </div>
      )}
      <details className="al-help">
        <summary>Where do I find this link?</summary>
        {CAL_HELP.map(([n, how]) => (
          <div key={n} className="small">
            <b>{n}:</b> {how}
          </div>
        ))}
        <div className="small muted">Work schedulers: if your scheduling app can add shifts to your phone's calendar, link that calendar here.</div>
      </details>

      <div className="perm-row">
        <div>
          <div className="bold">Or enter your work schedule</div>
          <div className="muted small">If your shifts aren't in a calendar.</div>
        </div>
        <Toggle on={!!s.manual} onChange={(v) => save({ manual: v ? manual : null })} />
      </div>
      {s.manual && (
        <div className="al-manual">
          <div className="al-days">
            {DAY_NAMES.map((n, i) => (
              <button
                key={n}
                className={"al-day" + (manual.days.includes(i) ? " on" : "")}
                onClick={() => save({ manual: { ...manual, days: manual.days.includes(i) ? manual.days.filter((x) => x !== i) : [...manual.days, i].sort() } })}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="row gap">
            <label style={{ flex: 1 }}>
              Starts
              <input type="time" value={manual.start} onChange={(e) => save({ manual: { ...manual, start: e.target.value } })} />
            </label>
            <label style={{ flex: 1 }}>
              Ends (optional)
              <input type="time" value={manual.end ?? ""} onChange={(e) => save({ manual: { ...manual, end: e.target.value || null } })} />
            </label>
            <label style={{ flex: 2 }}>
              Called
              <input value={manual.title} maxLength={60} onChange={(e) => setS({ ...s, manual: { ...manual, title: e.target.value } })} onBlur={() => save({ manual })} />
            </label>
          </div>
        </div>
      )}

      <label className="mic-slider">
        <span>
          Sleep I need <b>{s.sleep_hours} h</b>
        </span>
        <input type="range" min={4} max={12} step={0.5} value={s.sleep_hours} onChange={(e) => setS({ ...s, sleep_hours: Number(e.target.value) })} onMouseUp={() => save({ sleep_hours: s.sleep_hours })} onTouchEnd={() => save({ sleep_hours: s.sleep_hours })} onKeyUp={() => save({ sleep_hours: s.sleep_hours })} />
      </label>
      <label className="mic-slider">
        <span>
          Getting ready takes <b>{s.ready_minutes} min</b>
        </span>
        <input type="range" min={0} max={180} step={5} value={s.ready_minutes} onChange={(e) => setS({ ...s, ready_minutes: Number(e.target.value) })} onMouseUp={() => save({ ready_minutes: s.ready_minutes })} onTouchEnd={() => save({ ready_minutes: s.ready_minutes })} onKeyUp={() => save({ ready_minutes: s.ready_minutes })} />
      </label>
      <div className="perm-row">
        <div>
          <div className="bold">Suggest a get-off alarm</div>
          <div className="muted small">When I have something early tomorrow, ask me (after I sign in) whether to set one.</div>
        </div>
        <Toggle on={s.suggest} onChange={(v) => save({ suggest: v })} />
      </div>

      <div className="profile-section">Coming up (next 2 days)</div>
      {events === null ? (
        <p className="muted small">Loading…</p>
      ) : events.length === 0 ? (
        <p className="muted small">Nothing scheduled.</p>
      ) : (
        events.map((e, i) => (
          <div key={i} className="al-event">
            <span className="al-event-time">{e.all_day ? "All day" : fmtWhen(e.start)}</span>
            <span>{e.title}</span>
            <span className="muted small">{e.source === "manual" ? "work schedule" : "calendar"}</span>
          </div>
        ))
      )}
    </>
  );
}

// ---------------------------------------------------------------- kids (Family page)
export function KidAlarms({ kidId, name }: { kidId: string; name: string }) {
  const [list, setList] = useState<Alarm[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () =>
    api<Alarm[]>(`/api/kids/${kidId}/alarms`)
      .then(setList)
      .catch(() => setList([]));
  useEffect(() => {
    load();
  }, [kidId]);
  return (
    <>
      <div className="profile-section">Alarms</div>
      <p className="muted small">Bedtime or homework alarms for {name}. Locked ones can't be turned off, changed or deleted by {name}.</p>
      {list?.length === 0 && <p className="muted small">None yet.</p>}
      {list?.map((a) => (
        <div key={a.id} className="al-row">
          <div className="al-row-main">
            <div className="al-row-time">{a.time ? formatHM(a.time) : a.at ? fmtTime(a.at) : "—"}</div>
            <div>
              <div className="bold">
                {a.label || "Alarm"} {a.locked && "🔒"}
              </div>
              <div className="muted small">
                {repeatText(a)}
                {a.next_at ? ` · next: ${fmtWhen(a.next_at)}` : ""}
              </div>
            </div>
          </div>
          <button
            className="btn small danger"
            onClick={() =>
              api(`/api/alarms/${a.id}`, { method: "DELETE" })
                .then(load)
                .catch((e) => toast(e.message, "error"))
            }
          >
            Delete
          </button>
        </div>
      ))}
      <button className="btn small" onClick={() => setAdding(true)}>
        + Add an alarm for {name}
      </button>
      {adding && (
        <AlarmEditor
          lockedOption
          onSave={async (d) => {
            await createAlarm(d, kidId);
            load();
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}
