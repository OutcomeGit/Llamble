// Entry for the Windows app's transparent overlay window (index.html#overlay).
import { useEffect, useState } from "react";
import { ScreenOverlay } from "./components/Overlay";
import type { OverlaySnapshot } from "./overlay";

export function OverlayApp() {
  const [snap, setSnap] = useState<OverlaySnapshot | null>(null);
  const [edit, setEdit] = useState(false);
  useEffect(() => {
    document.body.classList.add("overlay-window");
    const n = window.llambleNative!.overlay!;
    const a = n.onSnapshot(setSnap);
    const b = n.onEdit(setEdit);
    const key = (e: KeyboardEvent) => e.key === "Escape" && n.edit(false);
    window.addEventListener("keydown", key);
    return () => {
      a();
      b();
      window.removeEventListener("keydown", key);
    };
  }, []);
  return <ScreenOverlay snap={snap} edit={edit} onDone={() => window.llambleNative!.overlay!.edit(false)} />;
}
