// Pure drawing helpers shared by the board, the drawing mode and the thumbnails.

/* where a cropped photo sits inside its box (box units): cover × zoom, slid by pos (0–100%).
   The backend uses the same math (backend/compose.js) to build overlays. */
export function cropGeom(it, img, W = it.w, H = it.h) {
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh) return null;
  const s = Math.max(W / nw, H / nh) * (it.zoom || 1), w = nw * s, h = nh * s;
  const [px, py] = it.pos || [50, 50];
  return { x: (W - w) * px / 100, y: (H - h) * py / 100, w, h, ox: w - W, oy: h - H };
}

/* strokes: [{w, c?, pts:[[x,y,pressure],...]}] in units of the frame's width, so they scale with the frame */
export function strokeSeg(g, s, a, b, scale) {
  const wa = s.w * scale * a[2], wb = s.w * scale * b[2];
  g.lineWidth = (wa + wb) / 2;
  g.beginPath(); g.moveTo(a[0] * scale, a[1] * scale); g.lineTo(b[0] * scale, b[1] * scale); g.stroke();
}
export function drawStroke(g, s, scale) {
  g.strokeStyle = s.c || '#111'; g.fillStyle = s.c || '#111'; g.lineCap = 'round'; g.lineJoin = 'round';
  const p = s.pts;
  if (p.length === 1) { g.beginPath(); g.arc(p[0][0] * scale, p[0][1] * scale, s.w * scale * p[0][2] / 2, 0, Math.PI * 2); g.fill(); return; }
  for (let i = 1; i < p.length; i++) strokeSeg(g, s, p[i - 1], p[i], scale);
}
export function renderStrokes(g, strokes, scale) {
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
  for (const s of strokes) drawStroke(g, s, scale);
}
