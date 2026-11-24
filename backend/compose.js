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

/** Render one item to raw RGB pixels (W×H, white background). */
async function renderItem(item, W, H) {
  const layers = [];
  if (item.image && board.images[item.image]) {
    const meta = board.images[item.image];
    let input = sharp(imagePath(item.image)).rotate(); // apply EXIF orientation like the browser does
    if (item.cover) {
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
export async function composeOverlay(A, B) {
  const long = 1600, r = B.h / B.w;
  const W = r <= 1 ? long : Math.round(long / r);
  const H = Math.round(W * r);
  const [a, b] = await Promise.all([renderItem(A, W, H), renderItem(B, W, H)]);
  const out = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i] + 1) >> 1;
  const png = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { png, width: W, height: H };
}
