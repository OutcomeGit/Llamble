// What a show looks like at this moment, as plain data (a "scene"), and the one function
// that paints a scene. The main thread decides the scene (who's on, layout, titles) and
// both the recorder's background thread and the director's preview paint it with
// drawScene, so the preview is exactly what gets recorded.
//
// Everything is laid out on a 1920×1080 stage and scaled to the real size when painted.

export const STAGE_W = 1920;
export const STAGE_H = 1080;

export interface SceneItem {
  key: string; // which source: "<uid>" camera or "screen:<uid>"
  x: number;
  y: number;
  w: number;
  h: number;
  /** fit the whole picture in (screens) or fill and crop (cameras) */
  contain: boolean;
  radius: number;
  tag?: { text: string; x: number; y: number; scale: number };
  /** someone without video: the Llamble logo and their name, painted instead of a picture */
  persona?: { name: string };
  /** a green ring while this person talks */
  ring?: boolean;
}

export interface Scene {
  card?: string;
  items: SceneItem[];
  /** nobody has video: circles with initials, ringed while they talk */
  board?: { name: string; speaking: boolean }[];
  lower?: { text: string; sub?: string };
  title?: string;
}

/** A picture to paint: a <video> on the main thread, a VideoFrame in the recorder's thread. */
export interface Frame {
  img: CanvasImageSource;
  w: number;
  h: number;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The single full-screen picture with nothing on top, when that's all the scene is (it can skip painting). */
export function soloItem(sc: Scene): SceneItem | null {
  if (sc.card || sc.board || sc.lower || sc.title || sc.items.length !== 1) return null;
  const it = sc.items[0];
  return it.x === 0 && it.y === 0 && it.w === STAGE_W && it.h === STAGE_H && !it.tag ? it : null;
}

export function drawScene(ctx: Ctx, W: number, H: number, sc: Scene, frame: (key: string) => Frame | null) {
  ctx.setTransform(W / STAGE_W, 0, 0, H / STAGE_H, 0, 0);
  ctx.fillStyle = "#101114";
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  if (sc.card) {
    card(ctx, sc.card);
    return;
  }
  for (const it of sc.items) {
    if (it.persona) persona(ctx, it, it.persona.name);
    else fit(ctx, frame(it.key), it);
    if (it.tag) nameTag(ctx, it.tag.text, it.tag.x, it.tag.y, it.tag.scale);
    if (it.ring) ring(ctx, it);
  }
  if (sc.board) board(ctx, sc.board);
  if (sc.lower) lowerThird(ctx, sc.lower.text, sc.lower.sub);
  if (sc.title) titleBar(ctx, sc.title);
}

function fit(ctx: Ctx, f: Frame | null, it: SceneItem) {
  const { x, y, w, h } = it;
  ctx.save();
  ctx.beginPath();
  if (it.radius) ctx.roundRect(x, y, w, h, it.radius);
  else ctx.rect(x, y, w, h);
  ctx.clip();
  if (it.radius) {
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y, w, h);
  }
  if (f && f.w && f.h) {
    const s = it.contain ? Math.min(w / f.w, h / f.h) : Math.max(w / f.w, h / f.h);
    const dw = f.w * s;
    const dh = f.h * s;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(f.img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }
  ctx.restore();
}

/** A tile for someone with no video: the llama logo and their name, readable even when small. */
function persona(ctx: Ctx, it: SceneItem, name: string) {
  const { x, y, w, h } = it;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, it.radius || 0);
  ctx.clip();
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, "#2b2f8f");
  g.addColorStop(1, "#5a2b8f");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.round(h * 0.4)}px sans-serif`;
  ctx.fillText("🦙", x + w / 2, y + h * 0.4);
  ctx.fillStyle = "#fff";
  let size = Math.max(22, Math.round(h * 0.16));
  ctx.font = `700 ${size}px sans-serif`;
  while (size > 16 && ctx.measureText(name).width > w * 0.9) {
    size -= 2;
    ctx.font = `700 ${size}px sans-serif`;
  }
  ctx.fillText(name, x + w / 2, y + h * 0.8);
  ctx.restore();
}

function ring(ctx: Ctx, it: SceneItem) {
  ctx.save();
  ctx.lineWidth = Math.max(4, Math.round(it.h * 0.025));
  ctx.strokeStyle = "#23a55a";
  ctx.beginPath();
  ctx.roundRect(it.x, it.y, it.w, it.h, it.radius || 0);
  ctx.stroke();
  ctx.restore();
}

function board(ctx: Ctx, people: { name: string; speaking: boolean }[]) {
  const n = Math.max(1, people.length);
  const r = Math.min(110, STAGE_W / (n * 3));
  people.forEach((p, i) => {
    const cx = (STAGE_W / (n + 1)) * (i + 1);
    const cy = STAGE_H / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#5865f2";
    ctx.fill();
    if (p.speaking) {
      ctx.lineWidth = 8;
      ctx.strokeStyle = "#23a55a";
      ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    ctx.font = `700 ${r * 0.7}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(p.name.slice(0, 2).toUpperCase(), cx, cy);
    ctx.font = `600 ${Math.max(20, r * 0.28)}px sans-serif`;
    ctx.fillText(p.name, cx, cy + r + 36);
  });
}

function nameTag(ctx: Ctx, t: string, x: number, y: number, scale: number) {
  ctx.font = `600 ${Math.round(26 * scale)}px sans-serif`;
  const w = ctx.measureText(t).width + 24 * scale;
  const h = 40 * scale;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 8);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(t, x + 12 * scale, y + h / 2);
}

function lowerThird(ctx: Ctx, text: string, sub?: string) {
  const x = 80;
  const y = STAGE_H - 210;
  ctx.font = "700 46px sans-serif";
  let w = ctx.measureText(text).width;
  if (sub) {
    ctx.font = "500 30px sans-serif";
    w = Math.max(w, ctx.measureText(sub).width);
  }
  w += 60;
  const h = sub ? 120 : 76;
  ctx.fillStyle = "#5865f2";
  ctx.fillRect(x, y, 10, h);
  ctx.fillStyle = "rgba(16,17,20,0.85)";
  ctx.fillRect(x + 10, y, w, h);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = "700 46px sans-serif";
  ctx.fillText(text, x + 34, y + 14);
  if (sub) {
    ctx.fillStyle = "#c9cdfb";
    ctx.font = "500 30px sans-serif";
    ctx.fillText(sub, x + 34, y + 72);
  }
}

function titleBar(ctx: Ctx, text: string) {
  ctx.font = "800 40px sans-serif";
  const w = ctx.measureText(text).width + 60;
  ctx.fillStyle = "rgba(16,17,20,0.8)";
  ctx.beginPath();
  ctx.roundRect((STAGE_W - w) / 2, 28, w, 70, 14);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, STAGE_W / 2, 63);
}

function card(ctx: Ctx, text: string) {
  const g = ctx.createLinearGradient(0, 0, STAGE_W, STAGE_H);
  g.addColorStop(0, "#2b2f8f");
  g.addColorStop(1, "#7a2b8f");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `800 ${Math.round(STAGE_W / 22)}px sans-serif`;
  const lines = text.split("\n").slice(0, 4);
  lines.forEach((l, i) => ctx.fillText(l, STAGE_W / 2, STAGE_H / 2 + (i - (lines.length - 1) / 2) * (STAGE_W / 17)));
}
