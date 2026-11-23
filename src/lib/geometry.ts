import type { Issue, Pt } from '../types';

/** 폴리라인을 Catmull-Rom 곡선으로 부드럽게 (좌표 단위 그대로) */
export function smoothPath(pts: Pt[]): string {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

/** 박스(px) 안에서 항목의 표시 원 중심·반지름 */
export function ringOf(it: Issue, boxW: number, boxH: number, minR = 16, maxR = 48) {
  if (it.piece) {
    const span = Math.max(it.piece.w * boxW, it.piece.h * boxH);
    return { cx: (it.x / 100) * boxW, cy: (it.y / 100) * boxH, r: Math.round(Math.max(minR, Math.min(maxR + 12, span / 2 + 6))) };
  }
  const pts = it.strokes.flat();
  if (!pts.length) return { cx: (it.x / 100) * boxW, cy: (it.y / 100) * boxH, r: minR + 4 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  const cx = (((x0 + x1) / 2 + it.x) / 2 / 100) * boxW;
  const cy = (((y0 + y1) / 2 + it.y) / 2 / 100) * boxH;
  const span = Math.max(((x1 - x0) / 100) * boxW, ((y1 - y0) / 100) * boxH);
  return { cx, cy, r: Math.max(minR, Math.min(maxR, span / 2 + 6)) };
}

/** 같은 쪽 메모가 겹치지 않도록 y를 아래로 밀어낸다 */
export function spread(ys: number[], gap: number, min: number, max: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const out = new Array<number>(ys.length);
  let prev = -Infinity;
  for (const o of order) {
    const y = Math.max(min, o.y, prev + gap);
    out[o.i] = y;
    prev = y;
  }
  // 아래로 넘치면 위로 되밀기
  let next = Infinity;
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k].i;
    out[i] = Math.min(out[i], max, next - gap);
    next = out[i];
  }
  return out;
}

/** 점들의 경계 상자 (0~1 좌표) */
export function bounds(pts: Pt[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

export function inPoly(pt: Pt, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** 이미지(0~1 좌표) 위의 다각형을 CSS clip-path로 */
export const clipPoly = (poly: Pt[]) => `polygon(${poly.map((p) => `${(p.x * 100).toFixed(2)}% ${(p.y * 100).toFixed(2)}%`).join(', ')})`;
