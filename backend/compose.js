// Server-side image work: builds the "겹쳐 보기" image (two items mixed 50/50).
// Each item is rendered exactly as it looks on the board: its crop, zoom and
// position inside the frame, or its pen strokes when it is an empty frame.
import sharp from 'sharp';
import { board, imagePath } from './store.js';

const WHITE = { r: 255, g: 255, b: 255 };

/** Same math as the frontend's cropGeom(): cover × zoom, slid by pos (0–100%). */
export function cropGeom(item, nw, nh, W, H) {
  const s = Math.max(W / nw, H / nh) * (item.zoom || 1);
  const w = nw * s, h = nh * s;
  const [px, py] = item.pos || [50, 50];
  return { x: (W - w) * px / 100, y: (H - h) * py / 100, w, h };
}

function strokesSvg(strokes, W, H) {
  // strokes are stored in units of the frame's width; segment width follows pen pressure
  const parts = [];
  for (const s of strokes) {
    const color = /^#[0-9a-f]{3,8}$/i.test(s.c || '') ? s.c : '#111';
    const p = s.pts || [];
    if (p.length === 1) {
      parts.push(`<circle cx="${p[0][0] * W}" cy="${p[0][1] * W}" r="${(s.w * W * p[0][2]) / 2}" fill="${color}"/>`);
      continue;
    }
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      const sw = (s.w * W * a[2] + s.w * W * b[2]) / 2;
      parts.push(`<line x1="${a[0] * W}" y1="${a[1] * W}" x2="${b[0] * W}" y2="${b[1] * W}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`);
    }
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`);
}

/**
 * Render one item to raw RGB pixels (W×H, white background).
 * `drawId` swaps in another image of the same canvas size (the AI line version),
 * keeping the item's crop, zoom and position.
 */
async function renderItem(item, W, H, drawId = item.image, { whole = false } = {}) {
  const layers = [];
  if (item.image && board.images[item.image] && board.images[drawId]) {
    const meta = board.images[item.image];
    let input = sharp(imagePath(drawId)).rotate(); // apply EXIF orientation like the browser does
    if (whole) {
      // the entire image, uncropped and undistorted, centred on white
      input = input.resize(W, H, { fit: 'contain', background: { ...WHITE, alpha: 0 } });
    } else if (item.cover) {
      const g = cropGeom(item, meta.width, meta.height, W, H);
      const rw = Math.max(W, Math.round(g.w)), rh = Math.max(H, Math.round(g.h));
      const left = Math.min(rw - W, Math.max(0, Math.round(-g.x)));
      const top = Math.min(rh - H, Math.max(0, Math.round(-g.y)));
      input = input.resize(rw, rh, { fit: 'fill' }).extract({ left, top, width: W, height: H });
    } else {
      input = input.resize(W, H, { fit: 'fill' });
    }
    layers.push({ input: await input.png().toBuffer() });
  }
  if (item.strokes && item.strokes.length) layers.push({ input: strokesSvg(item.strokes, W, H) });

  return sharp({ create: { width: W, height: H, channels: 3, background: WHITE } })
    .composite(layers)
    .flatten({ background: WHITE })
    .removeAlpha()
    .raw()
    .toBuffer();
}

export function hasContent(item) {
  return !!(item && ((item.image && board.images[item.image]) || (item.strokes && item.strokes.length)));
}

/**
 * Mix source A and target B at 50% each, at B's aspect ratio.
 * Returns a PNG buffer plus its pixel size.
 */
/**
 * Where the drawn figure is: the box holding the middle 98% of the dark (line) pixels
 * along each axis, so a few stray marks at the edges don't stretch it.
 */
export function inkBox(raw, W, H, { dark = 60, trim = 0.01 } = {}) {
  const cols = new Float64Array(W), rows = new Float64Array(H);
  let total = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const d = 255 - (0.299 * raw[i] + 0.587 * raw[i + 1] + 0.114 * raw[i + 2]);
      if (d < dark) continue;
      cols[x] += d; rows[y] += d; total += d;
    }
  }
  if (total === 0) return null;
  const span = (hist) => {
    let acc = 0, lo = 0, hi = hist.length - 1;
    for (let i = 0; i < hist.length; i++) { acc += hist[i]; if (acc >= total * trim) { lo = i; break; } }
    acc = 0;
    for (let i = hist.length - 1; i >= 0; i--) { acc += hist[i]; if (acc >= total * trim) { hi = i; break; } }
    return [lo, hi + 1];
  };
  const [x0, x1] = span(cols), [y0, y1] = span(rows);
  // too little ink to trust (an almost empty drawing)
  if (x1 - x0 < W * 0.05 || y1 - y0 < H * 0.05) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Move and scale drawing B so its figure lands on figure A. One scale factor for both
 * axes (proportions never change): the geometric mean of the width and height ratios,
 * kept between 0.5× and 2×. Box centers are matched.
 */
export async function alignTo(rawB, boxA, boxB, W, H) {
  const s = Math.min(2, Math.max(0.5, Math.sqrt((boxA.w / boxB.w) * (boxA.h / boxB.h))));
  const ox = Math.round(boxA.x + boxA.w / 2 - (boxB.x + boxB.w / 2) * s);
  const oy = Math.round(boxA.y + boxA.h / 2 - (boxB.y + boxB.h / 2) * s);
  const sw = Math.max(1, Math.round(W * s)), sh = Math.max(1, Math.round(H * s));
  const pad = Math.max(W, H) * 2;
  // two passes: sharp runs extract before extend inside a single pipeline
  const padded = await sharp(rawB, { raw: { width: W, height: H, channels: 3 } })
    .resize(sw, sh, { fit: 'fill' })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: WHITE })
    .raw().toBuffer({ resolveWithObject: true });
  const left = Math.min(padded.info.width - W, Math.max(0, pad - ox));
  const top = Math.min(padded.info.height - H, Math.max(0, pad - oy));
  const raw = await sharp(padded.data, { raw: { width: padded.info.width, height: padded.info.height, channels: 3 } })
    .extract({ left, top, width: W, height: H })
    .raw().toBuffer();
  return { raw, scale: s, dx: ox, dy: oy };
}

/**
 * Mix source A and target B at 50% each, at B's aspect ratio.
 * With `align`, drawing B is first scaled (uniformly) and moved so its figure overlaps A's.
 */
export async function composeOverlay(A, B, drawA, drawB, { align = false } = {}) {
  const long = 1600, r = B.h / B.w;
  const W = r <= 1 ? long : Math.round(long / r);
  const H = Math.round(W * r);
  // When fitting automatically, B is taken whole (not the crop shown on the board): the fit
  // decides its size and position, and nothing of the drawing gets cut off first.
  const [a, b0] = await Promise.all([
    renderItem(A, W, H, drawA || A.image),
    renderItem(B, W, H, drawB || B.image, { whole: align && !!B.image }),
  ]);
  let b = b0, alignment = null;
  if (align) {
    const boxA = inkBox(a, W, H), boxB = inkBox(b0, W, H);
    if (boxA && boxB) {
      const res = await alignTo(b0, boxA, boxB, W, H);
      b = res.raw;
      alignment = { scale: Math.round(res.scale * 1000) / 1000, dx: res.dx / W, dy: res.dy / H };
    } else if (B.image) {
      b = await renderItem(B, W, H, drawB || B.image); // no figure found: fall back to the board's crop
    }
  }
  const out = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i] + 1) >> 1;
  const png = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { png, width: W, height: H, alignment };
}
