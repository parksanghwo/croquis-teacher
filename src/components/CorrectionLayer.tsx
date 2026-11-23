import type { Issue, Pt } from '../types';
import { smoothPath } from '../lib/geometry';

interface Props {
  issues: Issue[];
  /** 크로키 박스 크기 (px). 좌표 %를 이 크기로 바꿔 그려서 화살표가 찌그러지지 않게 한다 */
  w: number;
  h: number;
  opacity?: number;
}

export const RED = '#D3263E';
export const BLUE = '#2563B8';

/**
 * 크로키 박스 위에 덮는 교정 레이어.
 * 흐리게(지울 기존 선) → 빨간 교정선 → 파란 축·방향선(끝에 화살표) 순서로 그린다.
 */
export function CorrectionLayer({ issues, w, h, opacity = 0.9 }: Props) {
  const px = (pts: Pt[]) => pts.map((p) => ({ x: (p.x / 100) * w, y: (p.y / 100) * h }));
  const arrow = (pts: Pt[]) => {
    const q = px(pts);
    const a = q[q.length - 2], b = q[q.length - 1];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const L = 9, spread = 0.45;
    const p1 = { x: b.x - L * Math.cos(ang - spread), y: b.y - L * Math.sin(ang - spread) };
    const p2 = { x: b.x - L * Math.cos(ang + spread), y: b.y - L * Math.sin(ang + spread) };
    return `M ${p1.x} ${p1.y} L ${b.x} ${b.y} L ${p2.x} ${p2.y}`;
  };
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible', opacity }}
    >
      {issues.map((it) =>
        (it.fade ?? []).map((s, k) => (
          <path key={`${it.id}-f${k}`} d={smoothPath(px(s))} fill="none" stroke="#FFFEFB" strokeOpacity={0.78} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" />
        )),
      )}
      {issues.map((it) =>
        it.strokes.map((s, k) => (
          <path key={`${it.id}-r${k}`} d={smoothPath(px(s))} fill="none" stroke={RED} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
        )),
      )}
      {issues.map((it) =>
        (it.axes ?? []).map((s, k) => (
          <g key={`${it.id}-b${k}`} fill="none" stroke={BLUE} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d={smoothPath(px(s))} strokeDasharray="6 4" />
            <path d={arrow(s)} />
          </g>
        )),
      )}
    </svg>
  );
}
