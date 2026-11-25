// Find where the drawing is on a photo of paper, and choose a crop (pos, zoom) that keeps
// the whole figure visible inside a frame of another ratio.

const load = src => new Promise((ok, no) => {
  const im = new Image();
  im.onload = () => ok(im);
  im.onerror = () => no(new Error('이미지를 불러오지 못했습니다'));
  im.src = src;
});

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / (2 * r + 1);
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/**
 * Box around the drawn figure, as fractions of the image (0–1), or null when nothing
 * stands out. Paper shading is removed by dividing by a heavy blur; the outer 1.5% of
 * the ink on each side is ignored so specks and the paper's edge don't stretch the box.
 */
export async function figureBox(url) {
  const img = await load(url);
  const k = 360 / Math.max(img.naturalWidth, img.naturalHeight);
  const w = Math.max(8, Math.round(img.naturalWidth * k)), h = Math.max(8, Math.round(img.naturalHeight * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const paper = boxBlur(boxBlur(lum, w, h, 12), w, h, 12);
  const cols = new Float64Array(w), rows = new Float64Array(h);
  let total = 0;
  // skip a thin border: photos of paper often catch the table or the sheet's edge there
  const mx = Math.round(w * 0.02), my = Math.round(h * 0.02);
  for (let y = my; y < h - my; y++) {
    for (let x = mx; x < w - mx; x++) {
      const i = y * w + x;
      const dark = 1 - lum[i] / Math.max(1, paper[i]);   // 0 on paper, larger on pencil
      if (dark < 0.12) continue;
      cols[x] += dark; rows[y] += dark; total += dark;
    }
  }
  if (total === 0) return null;
  const span = (hist, trim) => {
    let acc = 0, lo = 0, hi = hist.length - 1;
    for (let i = 0; i < hist.length; i++) { acc += hist[i]; if (acc >= total * trim) { lo = i; break; } }
    acc = 0;
    for (let i = hist.length - 1; i >= 0; i--) { acc += hist[i]; if (acc >= total * trim) { hi = i; break; } }
    return [lo, hi + 1];
  };
  const [x0, x1] = span(cols, 0.015), [y0, y1] = span(rows, 0.015);
  if (x1 - x0 < w * 0.05 || y1 - y0 < h * 0.05) return null;
  // a little breathing room around the figure
  const pad = 0.04 * Math.max(x1 - x0, y1 - y0);
  const bx0 = Math.max(0, x0 - pad), by0 = Math.max(0, y0 - pad);
  const bx1 = Math.min(w, x1 + pad), by1 = Math.min(h, y1 + pad);
  return { x: bx0 / w, y: by0 / h, w: (bx1 - bx0) / w, h: (by1 - by0) / h, nw: img.naturalWidth, nh: img.naturalHeight };
}

/**
 * Crop settings (same meaning as an item's pos / zoom) that put the figure box in the middle
 * of a W×H frame, shrinking the photo below 100% only when the figure would not fit.
 */
export function cropForBox(box, W, H) {
  const { nw, nh } = box;
  const s0 = Math.max(W / nw, H / nh);             // cover scale at zoom 1
  const bw = box.w * nw * s0, bh = box.h * nh * s0; // figure size in the frame at zoom 1
  const zoom = Math.max(0.2, Math.min(1, W / bw, H / bh));
  const dw = nw * s0 * zoom, dh = nh * s0 * zoom;
  const cx = (box.x + box.w / 2) * dw, cy = (box.y + box.h / 2) * dh; // figure centre in the scaled photo
  const pct = (free, want) => (Math.abs(free) < 0.5 ? 50 : Math.max(0, Math.min(100, (want / free) * 100)));
  return { zoom: Math.round(zoom * 1000) / 1000, pos: [pct(W - dw, W / 2 - cx), pct(H - dh, H / 2 - cy)] };
}
