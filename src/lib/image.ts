import type { Img } from '../types';

const MAX_EDGE = 1400;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 읽을 수 없어요.'));
    img.src = src;
  });
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return { c, ctx };
}

/** 파일을 읽어 긴 변 MAX_EDGE 이하로 줄인다. 투명 배경은 흰색으로. */
export async function loadFile(file: File): Promise<Img> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const s = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * s);
    const h = Math.round(img.naturalHeight * s);
    const { c, ctx } = canvas(w, h);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return { url: c.toDataURL('image/jpeg', 0.92), w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function pixels(src: Img) {
  const img = await loadImage(src.url);
  const { c, ctx } = canvas(src.w, src.h);
  ctx.drawImage(img, 0, 0);
  return { c, ctx, data: ctx.getImageData(0, 0, src.w, src.h) };
}

function luminance(d: Uint8ClampedArray, n: number) {
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return g;
}

function boxBlur(src: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
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

function percentile(values: Float32Array, p: number) {
  const hist = new Uint32Array(1024);
  let max = 0;
  for (const v of values) if (v > max) max = v;
  if (max === 0) return 0;
  for (const v of values) hist[Math.min(1023, Math.floor((v / max) * 1023))]++;
  const target = values.length * p;
  let acc = 0;
  for (let i = 0; i < 1024; i++) {
    acc += hist[i];
    if (acc >= target) return (i / 1023) * max;
  }
  return max;
}

function writeGray(ctx: CanvasRenderingContext2D, data: ImageData, gray: Float32Array) {
  const d = data.data;
  for (let i = 0; i < gray.length; i++) {
    const v = Math.max(0, Math.min(255, gray[i]));
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
}

/** 사진에서 윤곽선을 뽑아 흰 바탕의 선화로 만든다 (블러 + 소벨 에지). */
export async function traceLineArt(photo: Img): Promise<Img> {
  const { c, ctx, data } = await pixels(photo);
  const { w, h } = photo;
  const n = w * h;
  const blurred = boxBlur(boxBlur(luminance(data.data, n), w, h, 1), w, h, 1);
  const mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = blurred[i - w + 1] + 2 * blurred[i + 1] + blurred[i + w + 1] - blurred[i - w - 1] - 2 * blurred[i - 1] - blurred[i + w - 1];
      const gy = blurred[i + w - 1] + 2 * blurred[i + w] + blurred[i + w + 1] - blurred[i - w - 1] - 2 * blurred[i - w] - blurred[i - w + 1];
      mag[i] = Math.hypot(gx, gy);
    }
  }
  const lo = percentile(mag, 0.86);
  const hi = Math.max(lo + 1, percentile(mag, 0.97));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, Math.min(1, (mag[i] - lo) / (hi - lo)));
    out[i] = 255 - t * 225;
  }
  writeGray(ctx, data, out);
  return { url: c.toDataURL('image/png'), w, h };
}

/** 종이 보정: 회색 종이와 그림자를 흰색으로 날리고 선만 남긴다. */
export async function cleanPaper(src: Img): Promise<Img> {
  const { c, ctx, data } = await pixels(src);
  const { w, h } = src;
  const g = luminance(data.data, w * h);
  // 큰 블러로 종이 밝기(조명 얼룩)를 추정해 나눈다
  const paper = boxBlur(boxBlur(g, w, h, 24), w, h, 24);
  const norm = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) norm[i] = Math.min(1, g[i] / Math.max(1, paper[i] * 1.02));
  const black = percentile(norm, 0.01);
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) {
    const t = Math.max(0, Math.min(1, (norm[i] - black) / Math.max(0.05, 0.9 - black)));
    out[i] = t >= 1 ? 255 : 255 * Math.pow(t, 1.4);
  }
  writeGray(ctx, data, out);
  return { url: c.toDataURL('image/png'), w, h };
}

export interface Rect { x: number; y: number; w: number; h: number }

/** 어두운 선이 있는 영역(+여백). 찾지 못하면 null. */
export async function inkBounds(src: Img, pad = 0.04): Promise<Rect | null> {
  const { data } = await pixels(src);
  const { w, h } = src;
  const g = luminance(data.data, w * h);
  const rowHits = new Uint32Array(h);
  const colHits = new Uint32Array(w);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (g[y * w + x] < 170) {
        rowHits[y]++;
        colHits[x]++;
      }
  // 잡티 무시: 각 행/열에 일정 개수 이상 잉크가 있어야 함
  const minRow = Math.max(1, Math.round(w * 0.002));
  const minCol = Math.max(1, Math.round(h * 0.002));
  let y0 = 0, y1 = h - 1, x0 = 0, x1 = w - 1;
  while (y0 < h && rowHits[y0] < minRow) y0++;
  while (y1 > y0 && rowHits[y1] < minRow) y1--;
  while (x0 < w && colHits[x0] < minCol) x0++;
  while (x1 > x0 && colHits[x1] < minCol) x1--;
  if (y1 - y0 < h * 0.1 || x1 - x0 < w * 0.05) return null;
  const p = Math.round(Math.max(x1 - x0, y1 - y0) * pad);
  x0 = Math.max(0, x0 - p);
  y0 = Math.max(0, y0 - p);
  x1 = Math.min(w - 1, x1 + p);
  y1 = Math.min(h - 1, y1 + p);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export async function crop(src: Img, r: Rect | null): Promise<Img> {
  if (!r) return src;
  const img = await loadImage(src.url);
  const { c, ctx } = canvas(r.w, r.h);
  ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  const png = src.url.startsWith('data:image/png');
  return { url: png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.92), w: r.w, h: r.h };
}

/** 흰 종이를 투명하게: 화면에서 줄 노트 위에 선만 얹을 때 쓴다 */
export async function toInk(src: Img, rgb: [number, number, number] = [27, 27, 31]): Promise<string> {
  const { c, ctx, data } = await pixels(src);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const a = 255 - lum;
    // 알파를 빼낸 뒤 원래 색이 되도록 (흰 바탕 기준 역합성), 회색 선은 짙은 잉크색으로
    d[i] = rgb[0];
    d[i + 1] = rgb[1];
    d[i + 2] = rgb[2];
    d[i + 3] = Math.max(0, Math.min(255, a * (255 / 228)));
  }
  ctx.putImageData(data, 0, 0);
  return c.toDataURL('image/png');
}

/** 올가미 영역만 남기고(바깥은 흰색) 그 영역의 경계 상자로 잘라낸다. poly는 0~1 좌표 */
export async function cutRegion(src: Img, poly: { x: number; y: number }[], b: { x0: number; y0: number; w: number; h: number }): Promise<Img> {
  const img = await loadImage(src.url);
  const x = Math.floor(b.x0 * src.w), y = Math.floor(b.y0 * src.h);
  const w = Math.max(1, Math.ceil(b.w * src.w)), h = Math.max(1, Math.ceil(b.h * src.h));
  const { c, ctx } = canvas(w, h);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.beginPath();
  poly.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, p.x * src.w - x, p.y * src.h - y));
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, -x, -y);
  return { url: c.toDataURL('image/png'), w, h };
}

/** data URL → API에 보낼 base64 + 미디어 타입 */
export function toBase64(img: Img): { media_type: 'image/png' | 'image/jpeg'; data: string } {
  const [head, data] = img.url.split(',', 2);
  return { media_type: head.includes('image/png') ? 'image/png' : 'image/jpeg', data };
}
