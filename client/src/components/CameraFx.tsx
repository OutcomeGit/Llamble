import { useEffect, useRef, useState } from "react";
import { BGS, FACES, FxRenderer, LOOKS, removeCustomBackground, setCustomBackground, setFx, useFx } from "../camerafx";
import { prefs } from "../voice";
import { toast } from "../ui";

/** Pick background / look / face sticker. With `preview`, shows your camera live with the effects. */
export function CameraFxPicker({ preview }: { preview?: boolean }) {
  const fx = useFx();
  const file = useRef<HTMLInputElement>(null);
  const [hasCustom, setHasCustom] = useState(() => !!localStorage.getItem("llamble.camerafx.custom"));
  return (
    <div className="camfx">
      {preview && <FxPreview />}
      <div className="camfx-group">
        <div className="camfx-title">Face</div>
        <div className="camfx-row">
          {FACES.map((f) => (
            <button key={f.id} className={"camfx-chip" + (fx.face === f.id ? " on" : "")} onClick={() => setFx({ face: f.id })} title={f.label}>
              <span className="camfx-icon">{f.icon}</span>
              <span>{f.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="camfx-group">
        <div className="camfx-title">Background</div>
        <div className="camfx-row">
          {BGS.map((b) => (
            <button
              key={b.id}
              className={"camfx-chip bg-" + b.id + (fx.bg === b.id ? " on" : "")}
              onClick={() => (b.id === "custom" && !localStorage.getItem("llamble.camerafx.custom") ? file.current?.click() : setFx({ bg: b.id }))}
            >
              {b.label}
            </button>
          ))}
          <button className="camfx-chip" onClick={() => file.current?.click()}>
            Upload picture…
          </button>
          {hasCustom && (
            <button
              className="camfx-chip danger"
              title="Delete your uploaded picture from this device"
              onClick={() => {
                removeCustomBackground();
                setHasCustom(false);
              }}
            >
              Remove my picture
            </button>
          )}
          <input
            ref={file}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setCustomBackground(f).then(() => setHasCustom(true)).catch((er) => toast(er.message, "error"));
              e.target.value = "";
            }}
          />
        </div>
      </div>
      <div className="camfx-group">
        <div className="camfx-title">Look</div>
        <div className="camfx-row">
          {LOOKS.map((l) => (
            <button key={l.id} className={"camfx-chip" + (fx.look === l.id ? " on" : "")} onClick={() => setFx({ look: l.id })}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <p className="muted small">Effects run on this device. Face tracking uses Google's open-source MediaPipe, built into Llamble, so nothing leaves your computer except your video.</p>
    </div>
  );
}

function FxPreview() {
  const box = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    let unsub = () => {};
    const r = new FxRenderer();
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    r.out.className = "camfx-canvas";
    box.current?.appendChild(r.out);
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: prefs.get("videoInput") || undefined, width: 640, height: 360 } });
        video.srcObject = stream;
        await video.play();
        const prepare = async () => {
          setLoading(true);
          await r.ready(useFx.getState()).catch((e) => setErr("Effects couldn't load: " + e.message));
          setLoading(false);
        };
        unsub = useFx.subscribe(prepare);
        await prepare();
        const tick = () => {
          if (stop) return;
          try {
            r.draw(video, useFx.getState());
          } catch {}
          requestAnimationFrame(tick);
        };
        tick();
      } catch (e: any) {
        setErr("Camera unavailable: " + e.message);
      }
    })();
    return () => {
      stop = true;
      unsub();
      stream?.getTracks().forEach((t) => t.stop());
      r.out.remove();
    };
  }, []);
  return (
    <div className="camfx-preview" ref={box}>
      {err && <div className="camfx-err">{err}</div>}
      {loading && !err && <div className="camfx-loading">Loading effects…</div>}
    </div>
  );
}
