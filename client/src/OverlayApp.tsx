// Entry for the Windows app's transparent overlay window (index.html#overlay).
import { useEffect, useState } from "react";
import { ScreenOverlay } from "./components/Overlay";
import { AlarmCard, type AlarmView } from "./components/Alarms";
import type { OverlaySnapshot } from "./overlay";

type AlarmPayload = AlarmView & { kind: "alarm" | "reminder"; only?: boolean };

export function OverlayApp() {
  const [snap, setSnap] = useState<OverlaySnapshot | null>(null);
  const [edit, setEdit] = useState(false);
  const [alarm, setAlarm] = useState<AlarmPayload | null>(null);
  const [reminder, setReminder] = useState<AlarmPayload | null>(null);
  useEffect(() => {
    document.body.classList.add("overlay-window");
    const n = window.llambleNative!.overlay!;
    const a = n.onSnapshot(setSnap);
    const b = n.onEdit(setEdit);
    let rt = 0;
    const c = n.onAlarm?.((p: AlarmPayload | null) => {
      if (p && p.kind === "reminder") {
        setReminder(p);
        clearTimeout(rt);
        rt = window.setTimeout(() => setReminder(null), 8000);
        return;
      }
      setAlarm(p);
      if (!p) n.interactive?.(false);
    });
    const key = (e: KeyboardEvent) => e.key === "Escape" && n.edit(false);
    window.addEventListener("keydown", key);
    return () => {
      a();
      b();
      c?.();
      clearTimeout(rt);
      window.removeEventListener("keydown", key);
    };
  }, []);
  const n = window.llambleNative!.overlay!;
  const act = (action: "snooze" | "dismiss", minutes?: number) => {
    if (!alarm) return;
    n.alarmAction?.({ id: alarm.alarm.id, action, minutes });
    n.interactive?.(false);
  };
  return (
    <>
      {!(alarm?.only && !edit) && <ScreenOverlay snap={snap} edit={edit} onDone={() => n.edit(false)} />}
      {alarm && (
        <div className="al-ov-wrap" onMouseEnter={() => n.interactive?.(true)} onMouseLeave={() => n.interactive?.(false)}>
          <AlarmCard r={alarm} onSnooze={(m) => act("snooze", m)} onDismiss={() => act("dismiss")} />
        </div>
      )}
      {reminder && (
        <div className="al-ov-toast" role="status">
          🔔 {reminder.alarm.label || "Reminder"}
        </div>
      )}
    </>
  );
}
