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

const CLEAR = { r: 255, g: 255, b: 255, alpha: 0 };

/**
 * Place a picture on a transparent W×H canvas: scaled to gw×gh with its top-left at (gx, gy).
 * Any part outside the canvas is cut off; offsets may be negative.
 */
async function place(input, gx, gy, gw, gh, W, H) {
  gw = Math.max(1, Math.round(gw)); gh = Math.max(1, Math.round(gh));
  const pad = Math.max(W, H, gw, gh) * 2;
  // two passes: inside one sharp pipeline, extract runs before extend
  const padded = await sharp(input).ensureAlpha()
    .resize(gw, gh, { fit: 'fill' })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: CLEAR })
    .raw().toBuffer({ resolveWithObject: true });
  const { width: PW, height: PH } = padded.info;
  const left = Math.min(PW - W, Math.max(0, pad - Math.round(gx)));
  const top = Math.min(PH - H, Math.max(0, pad - Math.round(gy)));
  return sharp(padded.data, { raw: { width: PW, height: PH, channels: 4 } })
    .extract({ left, top, width: W, height: H }).png().toBuffer();
}

/**
 * One item as a transparent W×H PNG layer: its photo (crop, zoom and position as on the
 * board) plus its pen strokes. `drawId` swaps in another image of the same canvas size
 * (the AI line version). `whole` shows the entire picture, uncropped and undistorted.
 */
export async function renderLayer(item, W, H, drawId = item.image, { whole = false } = {}) {
  const layers = [];
  if (item.image && board.images[item.image] && board.images[drawId]) {
    const meta = board.images[item.image];
    const src = await sharp(imagePath(drawId)).rotate().png().toBuffer(); // EXIF orientation, like the browser
    let g;
    if (whole) {
      const s = Math.min(W / meta.width, H / meta.height), w = meta.width * s, h = meta.height * s;
      g = { x: (W - w) / 2, y: (H - h) / 2, w, h };
    } else if (item.cover) {
      g = cropGeom(item, meta.width, meta.height, W, H);
    } else {
      g = { x: 0, y: 0, w: W, h: H };
    }
    layers.push({ input: await place(src, g.x, g.y, g.w, g.h, W, H) });
  }
  if (item.strokes && item.strokes.length) layers.push({ input: strokesSvg(item.strokes, W, H) });
  return sharp({ create: { width: W, height: H, channels: 4, background: CLEAR } }).composite(layers).png().toBuffer();
}

/** A layer on white, as raw RGB pixels. */
const onWhite = (png) => sharp(png).flatten({ background: WHITE }).removeAlpha().raw().toBuffer();

export function hasContent(item) {
  return !!(item && ((item.image && board.images[item.image]) || (item.strokes && item.strokes.length)));
}

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
  if (x1 - x0 < W * 0.05 || y1 - y0 < H * 0.05) return null; // too little ink to trust
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The fit that lands figure B on figure A: one scale for both axes (proportions never
 * change), the geometric mean of the width and height ratios kept within 0.5–2×, and the
 * offset that matches the box centres. dx, dy are fractions of the canvas size.
 * Layer B is drawn scaled by s from the top-left corner, then moved by (dx·W, dy·H).
 */
export function fitFor(boxA, boxB, W, H) {
  const s = Math.min(2, Math.max(0.5, Math.sqrt((boxA.w / boxB.w) * (boxA.h / boxB.h))));
  const ox = boxA.x + boxA.w / 2 - (boxB.x + boxB.w / 2) * s;
  const oy = boxA.y + boxA.h / 2 - (boxB.y + boxB.h / 2) * s;
  return { s: Math.round(s * 1e4) / 1e4, dx: Math.round((ox / W) * 1e4) / 1e4, dy: Math.round((oy / H) * 1e4) / 1e4 };
}

const applyFit = (layer, fit, W, H) => place(layer, fit.dx * W, fit.dy * H, W * fit.s, H * fit.s, W, H);

/**
 * Overlay of source A and target B at 50% each, at B's aspect ratio.
 * B is placed by `fit`: the one given (set by hand), else with `align` the whole drawing
 * fitted automatically onto A's figure, else as shown on the board. Returns the flattened
 * PNG plus both transparent layers and the fit, so the page can keep adjusting B live.
 */
export async function composeOverlay(A, B, drawA, drawB, { align = false, fit = null } = {}) {
  const long = 1600, r = B.h / B.w;
  const W = r <= 1 ? long : Math.round(long / r);
  const H = Math.round(W * r);
  const wholeB = align && !!B.image;
  const [layerA, layerB] = await Promise.all([
    renderLayer(A, W, H, drawA || A.image),
    renderLayer(B, W, H, drawB || B.image, { whole: wholeB }),
  ]);
  const a = await onWhite(layerA);
  // B always stays a separate layer placed by a fit, so the page can move and size only
  // the croquis. Without auto-fit it starts where the board shows it (scale 1, no offset).
  if (!fit) {
    fit = { s: 1, dx: 0, dy: 0 };
    if (align) {
      const boxA = inkBox(a, W, H), boxB = inkBox(await onWhite(layerB), W, H);
      if (boxA && boxB) fit = fitFor(boxA, boxB, W, H);
    }
  }
  const b = await onWhite(await applyFit(layerB, fit, W, H));
  const out = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i] + 1) >> 1;
  const png = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { png, width: W, height: H, fit, layers: { a: layerA, b: layerB } };
}
