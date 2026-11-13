// Crops a screen share to a window's area (see sharearea.ts). Frames pass straight through;
// a crop is just a "visible part" on the same frame, no copying of the picture.
let rect: { x: number; y: number; w: number; h: number; mw: number; mh: number } | null = null;

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.rect !== undefined) rect = m.rect;
  if (m.readable && m.writable) pipe(m.readable, m.writable);
};

async function pipe(readable: ReadableStream<VideoFrame>, writable: WritableStream<VideoFrame>) {
  const r = readable.getReader();
  const w = writable.getWriter();
  for (;;) {
    const { value: f, done } = await r.read();
    if (done || !f) break;
    let out: VideoFrame = f;
    if (rect) {
      // the capture may be smaller than the monitor: scale the window's position to it
      const sx = f.codedWidth / rect.mw;
      const sy = f.codedHeight / rect.mh;
      const even = (n: number) => Math.max(0, Math.floor(n / 2) * 2);
      const x = even(rect.x * sx);
      const y = even(rect.y * sy);
      const w2 = Math.min(f.codedWidth - x, even(rect.w * sx));
      const h2 = Math.min(f.codedHeight - y, even(rect.h * sy));
      if (w2 >= 16 && h2 >= 16) {
        try {
          out = new VideoFrame(f, { visibleRect: { x, y, width: w2, height: h2 } });
          f.close();
        } catch {
          out = f;
        }
      }
    }
    await w.write(out).catch(() => out.close());
  }
  w.close().catch(() => {});
}
