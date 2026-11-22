import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import type { Feedback, Img } from '../types';
import { ArrowRightIcon, MinusIcon, PlusIcon } from '../components/Icons';
import { CorrectionLayer } from '../components/CorrectionLayer';
import { ringOf, spread } from '../lib/geometry';

interface Props {
  photo: Img;
  lineArt: Img;
  croquis: Img;
  aligned: boolean;
  croquisInk: string;
  lineArtInk: string;
  feedback: Feedback;
  onNext: () => void;
}

const SHEET_H = 700;
const MAX_BOX_H = 640;
const MAX_BOX_W = 460;
const NOTE_GAP = 28;
const LEFT_H = 600;
const clampZ = (z: number) => Math.max(0.6, Math.min(3, Math.round(z * 10) / 10));

export function CompareScreen({ photo, lineArt, croquis, aligned, croquisInk, lineArtInk, feedback, onNext }: Props) {
  const [trace, setTrace] = useState(true);
  const [showPhoto, setShowPhoto] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [view, setView] = useState({ z: 1, tx: 0, ty: 0 });
  const [sel, setSel] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(feedback.issues.map((i) => [i.id, true])));
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const vpRef = useRef<HTMLDivElement>(null);
  const wheelAt = useRef(0);

  useEffect(() => {
    setOn(Object.fromEntries(feedback.issues.map((i) => [i.id, true])));
    setSel(null);
    setView({ z: 1, tx: 0, ty: 0 });
  }, [feedback]);

  // Ctrl/⌘ + 휠 확대 (passive: false 필요)
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const ox = e.clientX - (r.left + r.width / 2), oy = e.clientY - (r.top + r.height / 2);
      wheelAt.current = Date.now();
      setSel(null);
      setView((v) => {
        const z2 = Math.max(0.6, Math.min(3, v.z * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
        return { z: z2, tx: v.tx + ox / z2 - ox / v.z, ty: v.ty + oy / z2 - oy / v.z };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 시트 좌표: x는 가운데 0, y는 0~700
  const aspect = croquis.w / croquis.h;
  let BH = MAX_BOX_H, BW = BH * aspect;
  if (BW > MAX_BOX_W) {
    BW = MAX_BOX_W;
    BH = BW / aspect;
  }
  const BX = -BW / 2, BY = (SHEET_H - BH) / 2;

  const parts = useMemo(() => {
    const base = feedback.issues.map((it, i) => {
      const ring = ringOf(it, BW, BH, 14, 40);
      const L = ring.cx < BW / 2;
      return { it, n: i + 1, L, px: BX + ring.cx, py: BY + ring.cy, r: ring.r, e: L ? BX - NOTE_GAP : BX + BW + NOTE_GAP };
    });
    const ny = new Array<number>(base.length);
    for (const side of [true, false]) {
      const idx = base.map((b, i) => (b.L === side ? i : -1)).filter((i) => i >= 0);
      const ys = spread(idx.map((i) => base[i].py - 15), 78, 8, SHEET_H - 90);
      idx.forEach((i, k) => (ny[i] = ys[k]));
    }
    return base.map((b, i) => ({ ...b, ny: ny[i] }));
  }, [feedback, BW, BH, BX, BY]);

  const { z, tx, ty } = view;
  let active: string | null = null;
  if (z >= 1.2) {
    const live = parts.filter((p) => on[p.it.id]);
    if (sel && on[sel]) active = sel;
    else {
      let best = Infinity;
      for (const p of live) {
        const d = (p.px + tx) ** 2 + (p.py - 350 + ty) ** 2;
        if (d < best) {
          best = d;
          active = p.it.id;
        }
      }
    }
  }
  const reveal = Math.max(0, Math.min(1, (z - 1.2) / 0.5));
  const animate = !dragging && Date.now() - wheelAt.current > 250;
  const onCount = parts.filter((p) => on[p.it.id]).length;
  const visible = feedback.issues.filter((i) => on[i.id]);

  const k = LEFT_H / SHEET_H;
  const fit: CSSProperties['objectFit'] = aligned ? 'fill' : 'contain';

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { x: e.clientX, y: e.clientY, tx, ty };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.x) / v.z, ty: d.ty + (e.clientY - d.y) / v.z }));
  };
  const onUp = () => {
    if (drag.current) {
      drag.current = null;
      setDragging(false);
    }
  };

  return (
    <div className="compare">
      <div className="compare__row">
        <section aria-label="원본" className="pane pane--left">
          <div className="pane__head" style={{ paddingRight: 16 }}>
            <h2>원본</h2>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className="toggle" aria-pressed={trace} onClick={() => setTrace(!trace)}>
                <span className="toggle__knob" />
                기준 선화
              </button>
              <button type="button" className="toggle" aria-pressed={showPhoto} onClick={() => setShowPhoto(!showPhoto)}>
                <span className="toggle__knob" />
                원본 사진
              </button>
            </div>
          </div>
          <div className="left-stage">
            <div
              style={{
                position: 'relative',
                height: BH * k,
                width: BW * k,
                flex: 'none',
                transformOrigin: 'center',
                transform: `scale(${z}) translate(${tx * k}px, ${ty * k}px)`,
                transition: animate ? 'transform 0.35s ease' : undefined,
              }}
            >
              {showPhoto && (
                <img src={photo.url} alt="원본 사진" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit, borderRadius: 6, opacity: trace ? 0.45 : 1 }} />
              )}
              {trace && <img src={lineArt.url} alt="기준 선화" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit, mixBlendMode: 'multiply' }} />}
              {!trace && !showPhoto && (
                <div className="left-empty">
                  기준 선화나 원본 사진을
                  <br />
                  위에서 켜 주세요
                </div>
              )}
            </div>
          </div>
        </section>

        <section aria-label="내 크로키 첨삭" className="pane pane--right">
          <div className="pane__head">
            <h2>내 크로키 첨삭</h2>
            <span className="pane__hint">클릭: 확대/축소 · 오른쪽 클릭: 켜기/끄기</span>
            <button type="button" className="toggle" style={{ marginLeft: 'auto' }} aria-pressed={overlay} onClick={() => setOverlay(!overlay)}>
              <span className="toggle__knob" />
              기준선 겹치기
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                const v = onCount === 0;
                setOn(Object.fromEntries(parts.map((p) => [p.it.id, v])));
              }}
            >
              {onCount ? '빨간 선 모두 끄기' : '빨간 선 모두 켜기'}
            </button>
            <div role="group" aria-label="확대 축소" className="zoom">
              <button
                type="button"
                className="zoom__btn"
                aria-label="축소"
                onClick={() => {
                  const nz = clampZ(z - 0.4);
                  if (nz <= 1) {
                    setView({ z: nz, tx: 0, ty: 0 });
                    setSel(null);
                  } else setView({ ...view, z: nz });
                }}
              >
                <MinusIcon />
              </button>
              <span className="zoom__label">{Math.round(z * 100)}%</span>
              <button type="button" className="zoom__btn" aria-label="확대" onClick={() => setView({ ...view, z: clampZ(z + 0.4) })}>
                <PlusIcon />
              </button>
              <button
                type="button"
                className="zoom__fit"
                onClick={() => {
                  setView({ z: 1, tx: 0, ty: 0 });
                  setSel(null);
                }}
              >
                전체 보기
              </button>
            </div>
          </div>

          <div
            ref={vpRef}
            className="viewport"
            style={{ cursor: dragging ? 'grabbing' : 'grab' }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: '50%',
                height: SHEET_H,
                marginTop: -SHEET_H / 2,
                transformOrigin: `50% ${SHEET_H / 2}px`,
                transform: `scale(${z}) translate(${tx}px, ${ty}px)`,
                transition: animate ? 'transform 0.35s ease' : undefined,
              }}
            >
              <div style={{ position: 'absolute', left: `calc(50% + ${BX}px)`, top: BY, width: BW, height: BH }}>
                <img src={croquisInk} alt="내 크로키" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
                {overlay && (
                  <img src={lineArtInk} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit, opacity: 0.3, pointerEvents: 'none' }} />
                )}
                <CorrectionLayer issues={visible} />
              </div>

              <svg width="1200" height={SHEET_H} viewBox={`-600 0 1200 ${SHEET_H}`} fill="none" aria-hidden="true" style={{ position: 'absolute', left: 'calc(50% - 600px)', top: 0, pointerEvents: 'none', overflow: 'visible' }}>
                {parts
                  .filter((p) => on[p.it.id])
                  .map((p) => {
                    const ax = p.L ? p.e + 2 : p.e - 2, ay = p.ny + 15;
                    const ex = p.L ? p.px - p.r : p.px + p.r;
                    const hasLeader = p.L ? ex - ax > 6 : ax - ex > 6;
                    return (
                      <g key={p.it.id}>
                        {hasLeader && <path d={`M ${ax} ${ay} Q ${(ax + ex) / 2} ${ay + (p.py - ay) * 0.1 - 20}, ${ex} ${p.py}`} stroke="#C21F36" strokeWidth="1.8" strokeLinecap="round" />}
                        <circle cx={p.px} cy={p.py} r={p.r} stroke="#C21F36" strokeWidth="2" />
                      </g>
                    );
                  })}
              </svg>

              {parts.map((p) => {
                const id = p.it.id;
                const isOn = !!on[id];
                const isActive = active === id;
                const a = isActive ? reveal : 0;
                const dist = Math.abs(p.e);
                return (
                  <div
                    key={id}
                    style={{
                      position: 'absolute',
                      top: p.ny,
                      minWidth: 80,
                      [p.L ? 'right' : 'left']: `calc(50% + ${p.L ? -p.e : p.e}px)`,
                      width: `min(220px, calc(50% - ${dist}px - 6px))`,
                      display: 'flex',
                      flexDirection: p.L ? 'row-reverse' : 'row',
                      zIndex: isActive ? 2 : undefined,
                      opacity: active && !isActive ? 0.5 : 1,
                      transition: 'opacity 0.7s ease',
                    }}
                  >
                    <button
                      type="button"
                      className="note-btn"
                      aria-pressed={isOn}
                      title="클릭: 확대 · 오른쪽 클릭: 빨간 선 켜기/끄기"
                      style={{ alignItems: p.L ? 'flex-end' : 'flex-start', textAlign: p.L ? 'right' : 'left' }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setOn({ ...on, [id]: !isOn });
                      }}
                      onClick={() => {
                        if (sel === id) {
                          setSel(null);
                          setView({ z: 1, tx: 0, ty: 0 });
                          return;
                        }
                        const mx = (p.px + (p.L ? p.e - 80 : p.e + 80)) / 2;
                        const my = (p.py + p.ny + 40) / 2 + 10;
                        setSel(id);
                        setView({ z: 1.8, tx: -mx, ty: 350 - my });
                      }}
                    >
                      <span className="note-title" style={{ color: isOn ? '#C21F36' : '#8A8478' }}>
                        {p.n}. {p.it.name}
                      </span>
                      {isOn && <span className="note-fix">{p.it.fix}</span>}
                      {isOn && (
                        <span style={{ position: 'relative', display: 'block', width: '100%', maxWidth: 150, marginTop: 3 }}>
                          <span
                            aria-hidden="true"
                            style={{
                              position: 'absolute',
                              left: 0,
                              right: 0,
                              top: 0,
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: p.L ? 'flex-end' : 'flex-start',
                              pointerEvents: 'none',
                              opacity: (1 - a) * 0.9,
                              transition: 'opacity 0.7s ease',
                            }}
                          >
                            {[100, 72, 94, 58].map((w, i) => (
                              <span key={i} className="hint-line" style={{ width: `${w}%` }} />
                            ))}
                          </span>
                          <span
                            aria-hidden={!isActive}
                            style={{
                              display: 'block',
                              pointerEvents: 'none',
                              opacity: a,
                              filter: `blur(${((1 - a) * 4).toFixed(1)}px)`,
                              transform: `translateY(${((1 - a) * 6).toFixed(1)}px)`,
                              transition: 'opacity 0.7s ease, filter 0.7s ease, transform 0.7s ease',
                            }}
                          >
                            <span className="note-detail" style={{ color: '#4A463F' }}>
                              {p.it.why}
                            </span>
                            <span className="note-detail" style={{ marginTop: 2, color: '#C21F36' }}>
                              → {p.it.how}
                            </span>
                          </span>
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
            <span className="viewport__hint">드래그로 이동 · Ctrl+휠로 확대하면 상세 설명 · 메모 오른쪽 클릭으로 켜고 끄기</span>
          </div>
        </section>
      </div>

      <div className="summary">
        <div className="summary__good">
          <strong>잘한 점</strong>
          <p>{feedback.good}</p>
        </div>
        <button type="button" className="btn btn--primary" onClick={onNext}>
          노트 정리 보기
          <ArrowRightIcon />
        </button>
      </div>
    </div>
  );
}
