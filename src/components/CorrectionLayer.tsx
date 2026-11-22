import type { Issue } from '../types';
import { smoothPath } from '../lib/geometry';

/** 크로키 박스 위에 덮는 빨간 펜 수정선 */
export function CorrectionLayer({ issues, opacity = 0.9, width = 2.6 }: { issues: Issue[]; opacity?: number; width?: number }) {
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible', opacity }}
    >
      {issues.map((it) =>
        it.strokes.map((s, k) => (
          <path
            key={`${it.id}-${k}`}
            d={smoothPath(s)}
            fill="none"
            stroke="#D3263E"
            strokeWidth={width}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )),
      )}
    </svg>
  );
}
