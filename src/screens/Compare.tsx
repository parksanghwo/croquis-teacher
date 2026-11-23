import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import type { Feedback, Img, Issue, Piece, Pt } from '../types';
import { ArrowRightIcon, MinusIcon, PlusIcon } from '../components/Icons';
import { CorrectionLayer } from '../components/CorrectionLayer';
import { PieceLayer } from '../components/PieceLayer';
import { bounds, clipPoly, inPoly, ringOf, stack } from '../lib/geometry';

interface Props {
  photo: Img;
  lineArt: Img;
  croquis: Img;
  aligned: boolean;
  croquisInk: string;
  lineArtInk: string;
  /** 빨간 기준 선화 (투명 배경) — 올가미 조각 표시용 */
  lineArtRed: string;
  feedback: Feedback;
  /** 올가미로 끌어다 놓은 항목들 (분석 중 포함) */
  extras: Issue[];
  regionError: string | null;
  onDropPiece: (piece: Piece, at: Pt) => void;
  onNext: () => void;
}

const SHEET_H = 700;
const MAX_BOX_H = 640;
const MAX_BOX_W = 460;
const NOTE_GAP = 28;
const NOTE_W = 260;
const NOTE_PAD = 10;
/** 측정 전 메모 높이 추정값 */
const NOTE_H = 96;
type View = { z: number; tx: number; ty: number };
const LEFT_H = 600;
const LEFT_MAX_W = 400;
const clampZ = (z: number, min = 0.6) => Math.max(min, Math.min(3, Math.round(z * 10) / 10));

export function CompareScreen({ photo, lineArt, croquis, aligned, croquisInk, lineArtInk, lineArtRed, feedback, extras, regionError, onDropPiece, onNext }: Props) {
  const [trace, setTrace] = useState(true);
  const [showPhoto, setShowPhoto] = useState(false);
  const [overlay, setOverlay] = useState(false);
  // null = 전체 보기 (메모까지 모두 들어오게 자동으로 맞춤)
  const [view, setView] = useState<View | null>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const noteEls = useRef(new Map<string, HTMLDivElement>());
  const fitRef = useRef<View>({ z: 1, tx: 0, ty: 0 });
  const [sel, setSel] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const isOn = (id: string) => !off[id];
  // 올가미: 그리는 중인 점, 확정된 선택, 끌고 가는 고스트 위치 (모두 기준 선화 0~1 좌표)
  const [lasso, setLasso] = useState<Pt[] | null>(null);
  const [selPoly, setSelPoly] = useState<Pt[] | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [overVp, setOverVp] = useState(false);
  const mode = useRef<'lasso' | 'move' | null>(null);
  const lpts = useRef<Pt[]>([]);
  const traceRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const vpRef = useRef<HTMLDivElement>(null);
  const wheelAt = useRef(0);

  useEffect(() => {
    setOff({});
    setSel(null);
    setSelPoly(null);
    setView(null);
  }, [feedback]);

  // 메모 실제 높이 재기 (줄바꿈·창 크기에 따라 달라짐)
  const measure = () => {
    const next: Record<string, number> = {};
    noteEls.current.forEach((el, id) => (next[id] = el.offsetHeight));
    setHeights((prev) => {
      const keys = Object.keys(next);
      const same = keys.length === Object.keys(prev).length && keys.every((k) => Math.abs((prev[k] ?? 0) - next[k]) < 1);
      return same ? prev : next;
    });
  };
  useLayoutEffect(measure);
  useEffect(() => {
    const ro = new ResizeObserver(() => measure());
    noteEls.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  });

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
      setView((cur) => {
        const v = cur ?? fitRef.current;
        const z2 = Math.max(Math.min(0.6, fitRef.current.z), Math.min(3, v.z * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
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
    const toPart = (it: Issue, n: number, custom: boolean) => {
      const ring = ringOf(it, BW, BH, 14, custom ? 48 : 40);
      const L = ring.cx < BW / 2;
      return { it, n, L, px: BX + ring.cx, py: BY + ring.cy, r: ring.r, e: L ? BX - NOTE_GAP : BX + BW + NOTE_GAP, custom };
    };
    // 끌어다 놓은 조각도 같은 메모 열에 놓고, 한쪽 메모끼리 겹치지 않게 함께 정리
    const base = [
      ...feedback.issues.map((it, i) => toPart(it, i + 1, false)),
      ...extras.filter((it) => !it.pending).map((it, j) => toPart(it, feedback.issues.length + j + 1, true)),
    ];
    const ny = new Array<number>(base.length);
    for (const side of [true, false]) {
      const idx = base.map((b, i) => (b.L === side ? i : -1)).filter((i) => i >= 0);
      const ys = stack(
        idx.map((i) => ({ y: base[i].py - 15, h: heights[base[i].it.id] ?? NOTE_H })),
        NOTE_PAD,
        8,
        SHEET_H - 8,
      );
      idx.forEach((i, k) => (ny[i] = ys[k]));
    }
    return base.map((b, i) => ({ ...b, ny: ny[i], h: heights[b.it.id] ?? NOTE_H }));
  }, [feedback, extras, heights, BW, BH, BX, BY]);

  // 메모가 시트 밖으로 넘치면 전체 보기를 그만큼 축소
  const top = Math.min(BY, ...parts.map((p) => p.ny));
  const bottom = Math.max(BY + BH, ...parts.map((p) => p.ny + p.h));
  const fit: View =
    top >= 0 && bottom <= SHEET_H
      ? { z: 1, tx: 0, ty: 0 }
      : { z: Math.max(0.4, Math.min(1, SHEET_H / (bottom - top + 24))), tx: 0, ty: SHEET_H / 2 - (top + bottom) / 2 };
  fitRef.current = fit;
  const pendings = extras
    .filter((it) => it.pending)
    .map((it) => {
      const ring = ringOf(it, BW, BH, 14, 48);
      return { id: it.id, px: BX + ring.cx, py: BY + ring.cy, r: ring.r };
    });

  const { z, tx, ty } = view ?? fit;
  let active: string | null = null;
  if (z >= 1.2) {
    const live = parts.filter((p) => isOn(p.it.id));
    if (sel && isOn(sel)) active = sel;
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
  const onCount = parts.filter((p) => isOn(p.it.id)).length;
  const visible = feedback.issues.filter((i) => isOn(i.id));
  const visibleExtras = extras.filter((i) => i.pending || isOn(i.id));

  const k = LEFT_H / SHEET_H;
  // 왼쪽 기준 선화 박스: 기준 선화 비율 그대로 (올가미 좌표 = 기준 선화 0~1 좌표)
  const la = lineArt.w / lineArt.h;
  let LH = BH * k, LW = LH * la;
  if (LW > LEFT_MAX_W) {
    LW = LEFT_MAX_W;
    LH = LW / la;
  }

  const localPt = (e: { clientX: number; clientY: number }): Pt => {
    const r = traceRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  const overViewport = (e: { clientX: number; clientY: number }) => {
    const r = vpRef.current?.getBoundingClientRect();
    return !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };
  const lDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!trace || e.button !== 0) return;
    const p = localPt(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    if (selPoly && inPoly(p, selPoly)) {
      mode.current = 'move';
      setGhost({ x: e.clientX, y: e.clientY });
      setOverVp(false);
    } else {
      mode.current = 'lasso';
      lpts.current = [p];
      setLasso([p]);
      setSelPoly(null);
    }
  };
  const lMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (mode.current === 'lasso') {
      const p = localPt(e), last = lpts.current[lpts.current.length - 1];
      if (Math.hypot((p.x - last.x) * LW * z, (p.y - last.y) * LH * z) > 3) {
        lpts.current.push(p);
        setLasso(lpts.current.slice());
      }
    } else if (mode.current === 'move') {
      setGhost({ x: e.clientX, y: e.clientY });
      setOverVp(overViewport(e));
    }
  };
  const lUp = (e: RPointerEvent<HTMLDivElement>) => {
    if (mode.current === 'lasso') {
      const pts = lpts.current;
      const b = bounds(pts);
      const ok = pts.length >= 5 && b.w * LW * b.h * LH > 300;
      setLasso(null);
      setSelPoly(ok ? pts.slice() : null);
    } else if (mode.current === 'move') {
      if (selPoly && overViewport(e)) {
        // 놓은 지점을 시트 좌표 → 크로키 박스 % 로
        const r = vpRef.current!.getBoundingClientRect();
        const ox = e.clientX - (r.left + r.width / 2), oy = e.clientY - (r.top + r.height / 2);
        const sx = ox / z - tx, sy = oy / z - ty + SHEET_H / 2;
        onDropPiece({ poly: selPoly, ...bounds(selPoly) }, { x: ((sx - BX) / BW) * 100, y: ((sy - BY) / BH) * 100 });
        setSelPoly(null);
      }
      setGhost(null);
      setOverVp(false);
    }
    mode.current = null;
  };
  const selShown = lasso ?? selPoly;
  const leftHint = !trace ? '기준 선화를 켜면 올가미로 고를 수 있어요' : selPoly ? '고른 부분을 끌어서 내 크로키 위에 놓으세요' : '기준 선화 위를 드래그해서 올가미로 고르기';
  const ghostBox = ghost && selPoly ? bounds(selPoly) : null;
  const objFit: CSSProperties['objectFit'] = aligned ? 'fill' : 'contain';

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { x: e.clientX, y: e.clientY, tx, ty };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setView((cur) => {
      const v = cur ?? fitRef.current;
      return { ...v, tx: d.tx + (e.clientX - d.x) / v.z, ty: d.ty + (e.clientY - d.y) / v.z };
    });
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
              ref={traceRef}
              onPointerDown={lDown}
              onPointerMove={lMove}
              onPointerUp={lUp}
              onPointerCancel={lUp}
              style={{
                position: 'relative',
                height: LH,
                width: LW,
                flex: 'none',
                touchAction: 'none',
                userSelect: 'none',
                cursor: !trace ? 'default' : ghost ? 'grabbing' : selPoly ? 'grab' : 'crosshair',
                transformOrigin: 'center',
                transform: `scale(${z}) translate(${tx * k}px, ${ty * k}px)`,
                transition: animate ? 'transform 0.35s ease' : undefined,
              }}
            >
              {showPhoto && (
                <img src={photo.url} alt="원본 사진" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', borderRadius: 6, opacity: trace ? 0.45 : 1 }} />
              )}
              {trace && <img src={lineArt.url} alt="기준 선화" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', mixBlendMode: 'multiply' }} />}
              {trace && selPoly && (
                <img src={lineArtRed} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', clipPath: clipPoly(selPoly) }} />
              )}
              {trace && selShown && (
                <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}>
                  <polygon
                    points={selShown.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="rgba(211,38,62,0.07)"
                    stroke="#D3263E"
                    strokeWidth="1.5"
                    strokeDasharray="5 4"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              )}
              {!trace && !showPhoto && (
                <div className="left-empty">
                  기준 선화나 원본 사진을
                  <br />
                  위에서 켜 주세요
                </div>
              )}
            </div>
            <span className="viewport__hint" style={selPoly ? { background: 'var(--accent)' } : undefined}>
              {leftHint}
            </span>
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
                const hide = onCount > 0;
                setOff(Object.fromEntries(parts.map((p) => [p.it.id, hide])));
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
                  const nz = clampZ(z - 0.4, Math.min(0.6, fit.z));
                  if (nz <= fit.z) {
                    setView(null);
                    setSel(null);
                  } else setView({ z: nz, tx, ty });
                }}
              >
                <MinusIcon />
              </button>
              <span className="zoom__label">{Math.round(z * 100)}%</span>
              <button type="button" className="zoom__btn" aria-label="확대" onClick={() => setView({ z: clampZ(z + 0.4), tx, ty })}>
                <PlusIcon />
              </button>
              <button
                type="button"
                className="zoom__fit"
                onClick={() => {
                  setView(null);
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
                  <img src={lineArtInk} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: objFit, opacity: 0.3, pointerEvents: 'none' }} />
                )}
                <CorrectionLayer issues={visible} />
                <PieceLayer issues={visibleExtras} redLineArt={lineArtRed} />
              </div>

              {pendings.map((p) => (
                <span key={p.id} aria-hidden="true">
                  <span
                    className="pulse"
                    style={{ position: 'absolute', left: `calc(50% + ${p.px - p.r}px)`, top: p.py - p.r, width: p.r * 2, height: p.r * 2, border: '2px dashed var(--accent)', borderRadius: '50%', pointerEvents: 'none' }}
                  />
                  <span
                    className="pulse note-title"
                    style={{ position: 'absolute', left: `calc(50% + ${p.px}px)`, top: p.py - p.r - 32, transform: 'translateX(-50%)', fontSize: 24, color: '#C21F36', whiteSpace: 'nowrap', pointerEvents: 'none' }}
                  >
                    분석 중…
                  </span>
                </span>
              ))}

              <svg width="1200" height={SHEET_H} viewBox={`-600 0 1200 ${SHEET_H}`} fill="none" aria-hidden="true" style={{ position: 'absolute', left: 'calc(50% - 600px)', top: 0, pointerEvents: 'none', overflow: 'visible' }}>
                {parts
                  .filter((p) => isOn(p.it.id))
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
                const shown = isOn(id);
                const isActive = active === id;
                const a = isActive ? reveal : 0;
                const dist = Math.abs(p.e);
                return (
                  <div
                    key={id}
                    ref={(el) => {
                      if (el) noteEls.current.set(id, el);
                      else noteEls.current.delete(id);
                    }}
                    style={{
                      position: 'absolute',
                      top: p.ny,
                      minWidth: 80,
                      [p.L ? 'right' : 'left']: `calc(50% + ${p.L ? -p.e : p.e}px)`,
                      width: `min(${NOTE_W}px, calc(50% - ${dist}px - 6px))`,
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
                      aria-pressed={shown}
                      title="클릭: 확대 · 오른쪽 클릭: 빨간 선 켜기/끄기"
                      style={{ alignItems: p.L ? 'flex-end' : 'flex-start', textAlign: p.L ? 'right' : 'left' }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setOff({ ...off, [id]: shown });
                      }}
                      onClick={() => {
                        if (sel === id) {
                          setSel(null);
                          setView(null);
                          return;
                        }
                        const mx = (p.px + (p.L ? p.e - 80 : p.e + 80)) / 2;
                        const my = (p.py + p.ny + 40) / 2 + 10;
                        setSel(id);
                        setView({ z: 1.8, tx: -mx, ty: 350 - my });
                      }}
                    >
                      <span className="note-title" style={{ color: shown ? '#C21F36' : '#8A8478' }}>
                        {p.n}. {p.it.name}
                        {p.custom && ' (선택)'}
                      </span>
                      {shown && <span className="note-fix">{p.it.fix}</span>}
                      {shown && (
                        <span style={{ position: 'relative', display: 'block', width: '100%', maxWidth: 150, minHeight: 52, marginTop: 3 }}>
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
            {ghost && overVp && (
              <div className="drop-target">
                <span>여기에 놓으면 이 부분을 빨간 펜으로 첨삭해요</span>
              </div>
            )}
            <span className="viewport__hint">드래그로 이동 · Ctrl+휠로 확대 · 왼쪽 기준 선화에서 올가미로 골라 여기로 끌어오기</span>
          </div>
        </section>
      </div>

      {regionError && (
        <div className="alert" role="alert">
          {regionError}
        </div>
      )}

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

      {ghost && selPoly && ghostBox && (
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            left: ghost.x - (ghostBox.w * BW * z) / 2,
            top: ghost.y - (ghostBox.h * BH * z) / 2,
            width: ghostBox.w * BW * z,
            height: ghostBox.h * BH * z,
            pointerEvents: 'none',
            zIndex: 50,
            opacity: 0.9,
          }}
        >
          <img
            src={lineArtRed}
            alt=""
            draggable={false}
            style={{
              position: 'absolute',
              left: `${(-ghostBox.x0 / ghostBox.w) * 100}%`,
              top: `${(-ghostBox.y0 / ghostBox.h) * 100}%`,
              width: `${100 / ghostBox.w}%`,
              height: `${100 / ghostBox.h}%`,
              maxWidth: 'none',
              clipPath: clipPoly(selPoly),
            }}
          />
        </div>
      )}
    </div>
  );
}
