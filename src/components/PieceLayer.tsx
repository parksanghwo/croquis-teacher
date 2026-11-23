import type { Issue } from '../types';
import { clipPoly } from '../lib/geometry';

/**
 * 끌어다 놓은 기준 선화 조각을 크로키 박스 위에 빨간 선으로 그린다.
 * 부모는 크로키 박스(position: relative)여야 하고, 기준 선화와 크로키는 같은 박스에 정렬돼 있다고 본다.
 */
export function PieceLayer({ issues, redLineArt, opacity = 0.92 }: { issues: Issue[]; redLineArt: string; opacity?: number }) {
  return (
    <>
      {issues.map((it) => {
        const p = it.piece;
        if (!p || p.w <= 0 || p.h <= 0) return null;
        return (
          <div
            key={it.id}
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: `${it.x - (p.w * 100) / 2}%`,
              top: `${it.y - (p.h * 100) / 2}%`,
              width: `${p.w * 100}%`,
              height: `${p.h * 100}%`,
              pointerEvents: 'none',
            }}
          >
            <img
              src={redLineArt}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                left: `${(-p.x0 / p.w) * 100}%`,
                top: `${(-p.y0 / p.h) * 100}%`,
                width: `${100 / p.w}%`,
                height: `${100 / p.h}%`,
                maxWidth: 'none',
                opacity,
                clipPath: clipPoly(p.poly),
              }}
            />
          </div>
        );
      })}
    </>
  );
}
