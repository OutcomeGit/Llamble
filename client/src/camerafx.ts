// Camera effects: background blur/replace, color looks, and face stickers that follow
// your face (Snapchat-style). Runs on your own device with Google's MediaPipe models,
// which ship inside Llamble: nothing is sent anywhere but the finished video.
import type { FaceLandmarker, ImageSegmenter, NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { Track, TrackProcessor, ProcessorOptions } from "livekit-client";
import { create } from "zustand";

export type Bg = "none" | "blur" | "sunset" | "ocean" | "space" | "forest" | "custom";
export type Look = "none" | "bw" | "retro" | "comic" | "night" | "warm" | "cool";
export type Face = "none" | "sunglasses" | "crown" | "dog" | "cat" | "clown" | "mustache" | "party" | "halo" | "devil" | "hearteyes";

export interface FxPrefs {
  bg: Bg;
  look: Look;
  face: Face;
}

export const BGS: { id: Bg; label: string }[] = [
  { id: "none", label: "None" },
  { id: "blur", label: "Blur" },
  { id: "sunset", label: "Sunset" },
  { id: "ocean", label: "Ocean" },
  { id: "space", label: "Space" },
  { id: "forest", label: "Forest" },
  { id: "custom", label: "My picture" },
];
export const LOOKS: { id: Look; label: string; css: string }[] = [
  { id: "none", label: "Normal", css: "none" },
  { id: "bw", label: "Black & white", css: "grayscale(1) contrast(1.1)" },
  { id: "retro", label: "Retro", css: "sepia(0.75) contrast(1.05) saturate(1.2)" },
  { id: "comic", label: "Comic", css: "saturate(2.2) contrast(1.7) brightness(1.05)" },
  { id: "night", label: "Night vision", css: "grayscale(1) brightness(1.4) sepia(1) hue-rotate(65deg) saturate(4)" },
  { id: "warm", label: "Warm", css: "sepia(0.25) saturate(1.3) brightness(1.05)" },
  { id: "cool", label: "Cool", css: "hue-rotate(-12deg) saturate(1.15) brightness(1.03)" },
];
export const FACES: { id: Face; label: string; icon: string }[] = [
  { id: "none", label: "None", icon: "🚫" },
  { id: "sunglasses", label: "Shades", icon: "🕶️" },
  { id: "crown", label: "Crown", icon: "👑" },
  { id: "dog", label: "Puppy", icon: "🐶" },
  { id: "cat", label: "Kitty", icon: "🐱" },
  { id: "clown", label: "Clown nose", icon: "🔴" },
  { id: "mustache", label: "Mustache", icon: "🥸" },
  { id: "party", label: "Party hat", icon: "🥳" },
  { id: "halo", label: "Halo", icon: "😇" },
  { id: "devil", label: "Horns", icon: "😈" },
  { id: "hearteyes", label: "Heart eyes", icon: "😍" },
];

const KEY = "llamble.camerafx";
function load(): FxPrefs {
  try {
    return { bg: "none", look: "none", face: "none", ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { bg: "none", look: "none", face: "none" };
  }
}
export const useFx = create<FxPrefs>(load);
export function setFx(p: Partial<FxPrefs>) {
  const next = { ...useFx.getState(), ...p };
  useFx.setState(next, true);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
}
export function fxActive(p: FxPrefs = useFx.getState()) {
  return p.bg !== "none" || p.look !== "none" || p.face !== "none";
}

/** Save a picture as "My picture" background (shrunk so it fits in local storage). */
export async function setCustomBackground(file: File) {
  const img = await createImageBitmap(file);
  const c = document.createElement("canvas");
  const s = Math.min(1, 1280 / img.width, 720 / img.height);
  c.width = Math.round(img.width * s);
  c.height = Math.round(img.height * s);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  localStorage.setItem("llamble.camerafx.custom", c.toDataURL("image/jpeg", 0.85));
  customImg = null;
  setFx({ bg: "custom" });
}

// ---------------------------------------------------------------- models (loaded once, on demand)

const BASE = new URL("./mediapipe/", document.baseURI).href;
let faceP: Promise<FaceLandmarker> | null = null;
let segP: Promise<ImageSegmenter> | null = null;

/** The Windows app reads bundled files over IPC (Chromium won't fetch file:// URLs). */
async function asset(name: string): Promise<Uint8Array | null> {
  const n = window.llambleNative;
  return n?.readAsset ? new Uint8Array(await n.readAsset(name)) : null;
}

let visionP: Promise<{ mp: typeof import("@mediapipe/tasks-vision"); files: any }> | null = null;
function vision() {
  visionP ??= (async () => {
    const mp = await import("@mediapipe/tasks-vision");
    const wasm = await asset("wasm/vision_wasm_internal.wasm");
    const files = wasm
      ? { wasmLoaderPath: BASE + "wasm/vision_wasm_internal.js", wasmBinaryPath: URL.createObjectURL(new Blob([wasm as BlobPart], { type: "application/wasm" })) }
      : await mp.FilesetResolver.forVisionTasks(BASE + "wasm");
    return { mp, files };
  })();
  return visionP;
}
async function modelOpts(file: string) {
  const buf = await asset(file);
  return buf ? { modelAssetBuffer: buf } : { modelAssetPath: BASE + file };
}
function faceModel() {
  faceP ??= vision().then(async ({ mp, files }) =>
    mp.FaceLandmarker.createFromOptions(files, {
      baseOptions: { ...(await modelOpts("face_landmarker.task")), delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 3,
      outputFaceBlendshapes: true,
    }),
  );
  return faceP;
}
function segModel() {
  segP ??= vision().then(async ({ mp, files }) =>
    mp.ImageSegmenter.createFromOptions(files, {
      baseOptions: { ...(await modelOpts("selfie_segmenter.tflite")), delegate: "GPU" },
      runningMode: "VIDEO",
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    }),
  );
  return segP;
}

// ---------------------------------------------------------------- the effect renderer

let customImg: HTMLImageElement | null = null;

/** Draws one frame with the current effects. Used by the call processor and the preview. */
export class FxRenderer {
  out = document.createElement("canvas");
  private ctx = this.out.getContext("2d")!;
  private tmp = document.createElement("canvas");
  private tctx = this.tmp.getContext("2d")!;
  private mask = document.createElement("canvas");
  private mctx = this.mask.getContext("2d")!;
  private face: FaceLandmarker | null = null;
  private seg: ImageSegmenter | null = null;
  private lastTs = 0;
  private faces: { lm: NormalizedLandmark[]; jaw: number }[] = [];
  private stars: [number, number, number][] = Array.from({ length: 140 }, () => [Math.random(), Math.random(), Math.random()]);

  async ready(p: FxPrefs) {
    if (p.face !== "none" && !this.face) this.face = await faceModel();
    if (p.bg !== "none" && !this.seg) this.seg = await segModel();
  }

  draw(video: HTMLVideoElement, p: FxPrefs) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    if (this.out.width !== w || this.out.height !== h) {
      this.out.width = this.tmp.width = w;
      this.out.height = this.tmp.height = h;
    }
    let ts = performance.now();
    if (ts <= this.lastTs) ts = this.lastTs + 1;
    this.lastTs = ts;
    const ctx = this.ctx;
    const look = LOOKS.find((l) => l.id === p.look)?.css ?? "none";

    if (p.bg !== "none" && this.seg) {
      // 1. background: blurred camera, or a picture
      ctx.filter = p.bg === "blur" ? "blur(14px)" : "none";
      if (p.bg === "blur") ctx.drawImage(video, 0, 0, w, h);
      else this.drawBackground(p.bg, w, h);
      ctx.filter = "none";
      // 2. you, cut out with the segmentation mask
      let have = false;
      this.seg.segmentForVideo(video, ts, (r) => {
        const m = r.confidenceMasks?.[0];
        if (!m) return;
        const mw = m.width;
        const mh = m.height;
        const data = m.getAsFloat32Array();
        if (this.mask.width !== mw || this.mask.height !== mh) {
          this.mask.width = mw;
          this.mask.height = mh;
        }
        const img = this.mctx.createImageData(mw, mh);
        for (let i = 0; i < data.length; i++) {
          // selfie model: 1 = person; soften the edge a little
          const a = Math.min(1, Math.max(0, (data[i] - 0.25) * 2));
          img.data[i * 4 + 3] = a * 255;
        }
        this.mctx.putImageData(img, 0, 0);
        have = true;
      });
      this.tctx.globalCompositeOperation = "copy";
      this.tctx.drawImage(video, 0, 0, w, h);
      if (have) {
        this.tctx.globalCompositeOperation = "destination-in";
        this.tctx.imageSmoothingEnabled = true;
        this.tctx.filter = "blur(2px)";
        this.tctx.drawImage(this.mask, 0, 0, w, h);
        this.tctx.filter = "none";
      }
      this.tctx.globalCompositeOperation = "source-over";
      ctx.drawImage(this.tmp, 0, 0);
      if (look !== "none") this.applyLook(look);
    } else {
      ctx.filter = look;
      ctx.drawImage(video, 0, 0, w, h);
      ctx.filter = "none";
    }

    if (p.face !== "none" && this.face) {
      const r = this.face.detectForVideo(video, ts);
      this.faces = (r.faceLandmarks || []).map((lm, i) => ({
        lm,
        jaw: r.faceBlendshapes?.[i]?.categories.find((c) => c.categoryName === "jawOpen")?.score ?? 0,
      }));
      for (const f of this.faces) drawSticker(ctx, p.face, f.lm, f.jaw, w, h);
    }
  }

  private applyLook(css: string) {
    this.tctx.globalCompositeOperation = "copy";
    this.tctx.filter = css;
    this.tctx.drawImage(this.out, 0, 0);
    this.tctx.filter = "none";
    this.tctx.globalCompositeOperation = "source-over";
    this.ctx.drawImage(this.tmp, 0, 0);
  }

  private drawBackground(bg: Bg, w: number, h: number) {
    const ctx = this.ctx;
    if (bg === "custom") {
      if (!customImg) {
        customImg = new Image();
        customImg.src = localStorage.getItem("llamble.camerafx.custom") || "";
      }
      if (customImg.complete && customImg.naturalWidth) {
        const s = Math.max(w / customImg.naturalWidth, h / customImg.naturalHeight);
        const iw = customImg.naturalWidth * s;
        const ih = customImg.naturalHeight * s;
        ctx.drawImage(customImg, (w - iw) / 2, (h - ih) / 2, iw, ih);
        return;
      }
    }
    const g = ctx.createLinearGradient(0, 0, 0, h);
    const stops: Record<string, string[]> = {
      sunset: ["#2d1b4e", "#b33f62", "#f9a03f", "#ffd27d"],
      ocean: ["#0b3d5c", "#1677a8", "#3fb6d9", "#a7e3f0"],
      space: ["#04040f", "#0b0b2a", "#1a1040", "#2b1650"],
      forest: ["#0f2a1a", "#1f4d2c", "#3d7a45", "#9cc58b"],
      custom: ["#333", "#555", "#777", "#999"],
    };
    (stops[bg] || stops.custom).forEach((c, i, a) => g.addColorStop(i / (a.length - 1), c));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    if (bg === "space") {
      for (const [x, y, s] of this.stars) {
        ctx.fillStyle = `rgba(255,255,255,${0.4 + s * 0.6})`;
        ctx.beginPath();
        ctx.arc(x * w, y * h, 0.6 + s * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (bg === "sunset") {
      ctx.fillStyle = "rgba(255,236,170,0.85)";
      ctx.beginPath();
      ctx.arc(w * 0.72, h * 0.72, h * 0.16, 0, Math.PI * 2);
      ctx.fill();
    } else if (bg === "forest") {
      ctx.fillStyle = "#14361f";
      for (let i = 0; i < 9; i++) {
        const x = (i / 8) * w;
        ctx.beginPath();
        ctx.moveTo(x - w * 0.07, h);
        ctx.lineTo(x, h * (0.35 + (i % 3) * 0.08));
        ctx.lineTo(x + w * 0.07, h);
        ctx.fill();
      }
    }
  }
}

// ---------------------------------------------------------------- stickers

function P(lm: NormalizedLandmark[], i: number, w: number, h: number) {
  return { x: lm[i].x * w, y: lm[i].y * h };
}

function drawSticker(ctx: CanvasRenderingContext2D, face: Face, lm: NormalizedLandmark[], jaw: number, w: number, h: number) {
  const le = P(lm, 33, w, h); // eye corners
  const re = P(lm, 263, w, h);
  const nose = P(lm, 1, w, h);
  const top = P(lm, 10, w, h); // forehead
  const chin = P(lm, 152, w, h);
  const lc = P(lm, 234, w, h); // face sides
  const rc = P(lm, 454, w, h);
  const upperLip = P(lm, 13, w, h);
  const ang = Math.atan2(re.y - le.y, re.x - le.x);
  const fw = Math.hypot(rc.x - lc.x, rc.y - lc.y); // face width
  const fh = Math.hypot(chin.x - top.x, chin.y - top.y);
  const eyeMid = { x: (le.x + re.x) / 2, y: (le.y + re.y) / 2 };
  const up = { x: Math.sin(ang), y: -Math.cos(ang) }; // "up" for the face

  const at = (x: number, y: number, fn: () => void) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    fn();
    ctx.restore();
  };
  const emoji = (ch: string, x: number, y: number, size: number) =>
    at(x, y, () => {
      ctx.font = `${size}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(ch, 0, 0);
    });

  switch (face) {
    case "sunglasses":
      return at(eyeMid.x, eyeMid.y, () => {
        const ew = fw * 0.36;
        const eh = fw * 0.2;
        ctx.fillStyle = "rgba(10,10,14,0.94)";
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.roundRect(s * fw * 0.22 - ew / 2, -eh / 2, ew, eh, eh * 0.35);
          ctx.fill();
        }
        ctx.fillRect(-fw * 0.06, -eh * 0.35, fw * 0.12, eh * 0.16);
        ctx.fillRect(-fw * 0.5, -eh * 0.35, fw * 0.12, eh * 0.14);
        ctx.fillRect(fw * 0.38, -eh * 0.35, fw * 0.12, eh * 0.14);
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        for (const s of [-1, 1]) ctx.fillRect(s * fw * 0.22 - ew * 0.35, -eh * 0.3, ew * 0.18, eh * 0.12);
      });
    case "hearteyes":
      emoji("❤️", le.x, le.y, fw * 0.3);
      return emoji("❤️", re.x, re.y, fw * 0.3);
    case "crown":
      return emoji("👑", top.x + up.x * fh * 0.22, top.y + up.y * fh * 0.22, fw * 0.75);
    case "party":
      return at(top.x + up.x * fh * 0.05, top.y + up.y * fh * 0.05, () => {
        const hw = fw * 0.32;
        const hh = fh * 0.75;
        ctx.save();
        ctx.translate(fw * 0.12, 0);
        ctx.rotate(0.25);
        ctx.beginPath();
        ctx.moveTo(-hw, 0);
        ctx.lineTo(0, -hh);
        ctx.lineTo(hw, 0);
        ctx.closePath();
        ctx.fillStyle = "#5865f2";
        ctx.fill();
        ctx.clip();
        ctx.strokeStyle = "#fee75c";
        ctx.lineWidth = hw * 0.18;
        for (let i = 1; i < 6; i++) {
          ctx.beginPath();
          ctx.moveTo(-hw, -hh * i * 0.2 + hw);
          ctx.lineTo(hw, -hh * i * 0.2 - hw * 0.4);
          ctx.stroke();
        }
        ctx.restore();
        ctx.save();
        ctx.translate(fw * 0.12, 0);
        ctx.rotate(0.25);
        ctx.fillStyle = "#eb459e";
        ctx.beginPath();
        ctx.arc(0, -hh, hw * 0.28, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
    case "halo":
      return at(top.x + up.x * fh * 0.25, top.y + up.y * fh * 0.25, () => {
        ctx.strokeStyle = "rgba(255,222,90,0.95)";
        ctx.shadowColor = "#ffe066";
        ctx.shadowBlur = fw * 0.12;
        ctx.lineWidth = fw * 0.07;
        ctx.beginPath();
        ctx.ellipse(0, 0, fw * 0.38, fw * 0.1, 0, 0, Math.PI * 2);
        ctx.stroke();
      });
    case "devil":
      return at(top.x, top.y, () => {
        ctx.fillStyle = "#d4202a";
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * fw * 0.18, fh * 0.02);
          ctx.quadraticCurveTo(s * fw * 0.42, -fh * 0.18, s * fw * 0.36, -fh * 0.42);
          ctx.quadraticCurveTo(s * fw * 0.28, -fh * 0.2, s * fw * 0.06, -fh * 0.02);
          ctx.closePath();
          ctx.fill();
        }
      });
    case "clown":
      ctx.save();
      ctx.fillStyle = "#e3202b";
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = fw * 0.04;
      ctx.beginPath();
      ctx.arc(nose.x, nose.y, fw * 0.11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.beginPath();
      ctx.arc(nose.x - fw * 0.035, nose.y - fw * 0.04, fw * 0.025, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    case "mustache":
      return at((nose.x + upperLip.x) / 2, (nose.y + upperLip.y) / 2 + fh * 0.01, () => {
        ctx.fillStyle = "#2b1a10";
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(0, -fw * 0.02);
          ctx.bezierCurveTo(s * fw * 0.12, -fw * 0.1, s * fw * 0.24, -fw * 0.02, s * fw * 0.3, -fw * 0.08);
          ctx.bezierCurveTo(s * fw * 0.28, fw * 0.04, s * fw * 0.12, fw * 0.06, 0, fw * 0.03);
          ctx.fill();
        }
      });
    case "dog":
    case "cat": {
      const dog = face === "dog";
      at(top.x, top.y, () => {
        for (const s of [-1, 1]) {
          ctx.beginPath();
          if (dog) {
            ctx.fillStyle = "#7a4a26";
            ctx.ellipse(s * fw * 0.45, fh * 0.08, fw * 0.14, fh * 0.3, s * -0.35, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#a8714a";
            ctx.beginPath();
            ctx.ellipse(s * fw * 0.45, fh * 0.1, fw * 0.08, fh * 0.2, s * -0.35, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillStyle = "#3a3a3a";
            ctx.moveTo(s * fw * 0.12, -fh * 0.02);
            ctx.lineTo(s * fw * 0.36, -fh * 0.36);
            ctx.lineTo(s * fw * 0.44, fh * 0.04);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = "#f2a5b8";
            ctx.beginPath();
            ctx.moveTo(s * fw * 0.2, -fh * 0.02);
            ctx.lineTo(s * fw * 0.35, -fh * 0.26);
            ctx.lineTo(s * fw * 0.39, -fh * 0.0);
            ctx.closePath();
            ctx.fill();
          }
        }
      });
      at(nose.x, nose.y, () => {
        ctx.fillStyle = dog ? "#1b1b1b" : "#f08aa6";
        ctx.beginPath();
        ctx.ellipse(0, 0, fw * (dog ? 0.11 : 0.06), fw * (dog ? 0.07 : 0.04), 0, 0, Math.PI * 2);
        ctx.fill();
        if (!dog) {
          ctx.strokeStyle = "rgba(30,30,30,0.85)";
          ctx.lineWidth = fw * 0.008;
          for (const s of [-1, 1])
            for (const k of [-1, 0, 1]) {
              ctx.beginPath();
              ctx.moveTo(s * fw * 0.1, fw * 0.04);
              ctx.lineTo(s * fw * 0.42, fw * (0.02 + k * 0.06));
              ctx.stroke();
            }
        }
      });
      if (dog && jaw > 0.35) {
        const lip = P(lm, 14, w, h); // lower lip
        at(lip.x, lip.y, () => {
          ctx.fillStyle = "#ef6f8a";
          ctx.beginPath();
          ctx.ellipse(0, fh * 0.1 * jaw, fw * 0.1, fh * 0.16 * jaw, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#c94d68";
          ctx.lineWidth = fw * 0.01;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(0, fh * 0.2 * jaw);
          ctx.stroke();
        });
      }
      return;
    }
  }
}

// ---------------------------------------------------------------- LiveKit camera processor

export class CameraFxProcessor implements TrackProcessor<Track.Kind.Video> {
  name = "llamble-camerafx";
  processedTrack?: MediaStreamTrack;
  private video = document.createElement("video");
  private r = new FxRenderer();
  private running = false;
  private unsub?: () => void;

  async init(opts: ProcessorOptions<Track.Kind.Video>) {
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = new MediaStream([opts.track]);
    await this.video.play().catch(() => {});
    await this.r.ready(useFx.getState()).catch((e) => console.warn("camera effects unavailable", e));
    this.unsub = useFx.subscribe((p) => void this.r.ready(p).catch(() => {}));
    const settings = opts.track.getSettings();
    const fps = Math.min(30, settings.frameRate || 30);
    this.processedTrack = (this.r.out as any).captureStream(fps).getVideoTracks()[0];
    this.running = true;
    this.loop();
  }

  private loop = () => {
    if (!this.running) return;
    try {
      this.r.draw(this.video, useFx.getState());
    } catch (e) {
      console.warn("camera effect frame failed", e);
    }
    // requestVideoFrameCallback keeps pace with the camera; setTimeout keeps going in background tabs
    const v = this.video as any;
    if (v.requestVideoFrameCallback && document.visibilityState === "visible") v.requestVideoFrameCallback(() => this.loop());
    else setTimeout(this.loop, 33);
  };

  async restart(opts: ProcessorOptions<Track.Kind.Video>) {
    await this.destroy();
    await this.init(opts);
  }

  async destroy() {
    this.running = false;
    this.unsub?.();
    this.processedTrack?.stop();
    this.video.srcObject = null;
  }
}
