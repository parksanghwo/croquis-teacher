import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { CritiqueSettings, Feedback, Img, Issue, Piece, Pt } from '../types';
import { CorrectionLayer } from '../components/CorrectionLayer';
import { PieceLayer } from '../components/PieceLayer';
import { KeyIcon, MinusIcon, PencilIcon, PlusIcon, TrashIcon } from '../components/Icons';
import { bounds, clipPoly, inPoly, ringOf, stack } from '../lib/geometry';

/**
 * 크로키 첨삭 캔버스 — 끝없이 넓은 책상 위에 원본 사진, 기준 선화, 내 크로키 종이를 펼쳐 둔 화면.
 * 카메라(이동·확대)는 리렌더 없이 DOM에 직접 적용하고, 1.5배 이상 확대하면 메모 상세 설명이 드러난다.
 */

interface Props {
  photo: Img;
  lineArt: Img;
  croquis: Img;
  croquisInk: string;
  lineArtInk: string;
  lineArtRed: string;
  aligned: boolean;
  feedback: Feedback;
  extras: Issue[];
  regionError: string | null;
  settings: CritiqueSettings;
  lineArtSource?: 'ai' | 'local';
  hasKey: boolean;
  onDropPiece: (piece: Piece, at: Pt) => void;
  onNew: () => void;
  onKey: () => void;
}

type CardKey = 'photo' | 'trace' | 'croq';
type Cards = Record<CardKey, { x: number; y: number }>;
interface Cam {
  x: number;
  y: number;
  z: number;
}
interface Snap {
  cards: Cards;
  hidden: { photo: boolean; trace: boolean };
  showLines: boolean;
  off: Record<string, boolean>;
  removed: string[];
  selPoly: Pt[] | null;
}

const LINKED: CardKey[] = ['photo', 'trace']; // 사진과 기준 선화는 한 묶음으로 움직임
const REF_H = 600; // 사진·기준 선화 카드 높이
const CROQ_H = 700; // 크로키 종이 높이
const MAX_W = 520;
const NOTE_W = 210;
const NOTE_GAP = 24;
const NOTE_H = 96;
const DEEP_Z = 1.5;
const clampZ = (z: number) => Math.max(0.15, Math.min(5, z));

const size = (img: Img, h: number) => {
  let w = (h * img.w) / img.h;
  if (w > MAX_W) {
    w = MAX_W;
    h = (w * img.h) / img.w;
  }
  return { w, h };
};

export function Workspace(p: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const pctRef = useRef<HTMLSpanElement>(null);
  const tracePaperRef = useRef<HTMLDivElement>(null);
  const cam = useRef<Cam>({ x: 0, y: 0, z: 1 });
  const anim = useRef(0);
  const [deep, setDeep] = useState(false);
  const deepRef = useRef(false);

  const ref = size(p.lineArt, REF_H);
  const croq = size(p.croquis, CROQ_H);
  const CW = croq.w, CH = croq.h;

  const [cards, setCards] = useState<Cards>(() => ({
    photo: { x: -(ref.w * 2 + 60 + 300), y: (CH - ref.h) / 2 },
    trace: { x: -(ref.w + 300), y: (CH - ref.h) / 2 },
    croq: { x: 0, y: 0 },
  }));
  const [hidden, setHidden] = useState({ photo: false, trace: false });
  const [showLines, setShowLines] = useState(true);
  const [opacity, setOpacity] = useState(90);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [removed, setRemoved] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const prevCam = useRef<Cam | null>(null);
  const [tool, setTool] = useState<'select' | 'hand'>('select');
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const [selPoly, setSelPoly] = useState<Pt[] | null>(null);
  const [lasso, setLasso] = useState<Pt[] | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [picked, setPicked] = useState<CardKey[]>([]);
  const [linkHl, setLinkHl] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastT = useRef(0);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const noteEls = useRef(new Map<string, HTMLButtonElement>());

  // ---------- 되돌리기 ----------
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  const [, bump] = useState(0);
  const snapshot = (): Snap => ({ cards, hidden, showLines, off, removed, selPoly });
  const record = (s: Snap = snapshot()) => {
    past.current.push(s);
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    bump((n) => n + 1);
  };
  const restore = (s: Snap) => {
    setCards(s.cards);
    setHidden(s.hidden);
    setShowLines(s.showLines);
    setOff(s.off);
    setRemoved(s.removed);
    setSelPoly(s.selPoly);
  };
  const say = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastT.current);
    toastT.current = window.setTimeout(() => setToast(null), 1600);
  }, []);
  const undo = () => {
    const s = past.current.pop();
    if (!s) return say('더 되돌릴 게 없어요');
    future.current.push(snapshot());
    restore(s);
    bump((n) => n + 1);
    say('되돌렸어요');
  };
  const redo = () => {
    const s = future.current.pop();
    if (!s) return;
    past.current.push(snapshot());
    restore(s);
    bump((n) => n + 1);
    say('다시 했어요');
  };

  // 새 첨삭 결과가 오면 처음 상태로
  useEffect(() => {
    setOff({});
    setRemoved([]);
    setSelected(null);
    setSelPoly(null);
    past.current = [];
    future.current = [];
  }, [p.feedback]);

  useEffect(() => {
    if (p.regionError) say('고른 부분을 첨삭하지 못했어요');
  }, [p.regionError, say]);

  // ---------- 메모 ----------
  const all = useMemo(() => [...p.feedback.issues, ...p.extras.filter((x) => !x.pending)], [p.feedback, p.extras]);
  const live = all.filter((it) => !removed.includes(it.id));
  const isOn = (id: string) => showLines && !off[id];
  const pendings = p.extras.filter((x) => x.pending);

  const parts = useMemo(() => {
    const base = live.map((it, i) => {
      const ring = ringOf(it, CW, CH, 14, it.piece ? 56 : 40);
      const L = ring.cx < CW / 2;
      return { it, n: i + 1, L, cx: ring.cx, cy: ring.cy, r: ring.r, custom: !!it.piece };
    });
    const ny = new Array<number>(base.length);
    for (const side of [true, false]) {
      const idx = base.map((b, i) => (b.L === side ? i : -1)).filter((i) => i >= 0);
      const ys = stack(
        idx.map((i) => ({ y: base[i].cy - 15, h: heights[base[i].it.id] ?? NOTE_H })),
        10,
        -20,
        CH + 20,
      );
      idx.forEach((i, k) => (ny[i] = ys[k]));
    }
    return base.map((b, i) => ({ ...b, ny: ny[i], h: heights[b.it.id] ?? NOTE_H }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.map((x) => x.id).join(','), heights, CW, CH]);

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

  // ---------- 카메라 ----------
  const applyCam = () => {
    const c = cam.current;
    if (worldRef.current) worldRef.current.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.z})`;
    const st = stageRef.current;
    if (st) {
      const g = 24 * c.z;
      st.style.backgroundSize = `${g}px ${g}px`;
      st.style.backgroundPosition = `${c.x}px ${c.y}px`;
    }
    if (pctRef.current) pctRef.current.textContent = `${Math.round(c.z * 100)}%`;
    const d = c.z >= DEEP_Z;
    if (d !== deepRef.current) {
      deepRef.current = d;
      setDeep(d);
    }
  };
  const zoomAt = (sx: number, sy: number, z2: number) => {
    const c = cam.current;
    z2 = clampZ(z2);
    const wx = (sx - c.x) / c.z, wy = (sy - c.y) / c.z;
    cam.current = { z: z2, x: sx - wx * z2, y: sy - wy * z2 };
    applyCam();
  };
  const flyTo = (target: Cam, ms = 420) => {
    cancelAnimationFrame(anim.current);
    const from = { ...cam.current }, t0 = performance.now();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const step = (t: number) => {
      const k = reduce ? 1 : Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      cam.current = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, z: from.z + (target.z - from.z) * e };
      applyCam();
      if (k < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  };
  const stageSize = () => {
    const r = stageRef.current?.getBoundingClientRect();
    return { w: r?.width ?? innerWidth, h: r?.height ?? innerHeight };
  };
  const camFor = (cx: number, cy: number, z: number): Cam => {
    const s = stageSize();
    return { z, x: s.w / 2 - cx * z, y: s.h / 2 - cy * z };
  };
  const fit = (): Cam => {
    const boxes: [number, number, number, number][] = [];
    const narrow = stageSize().w < 700; // 휴대폰에서는 내 크로키와 메모만 맞춤
    if (!narrow)
      (['photo', 'trace'] as const).forEach((k) => {
        if (!hidden[k]) boxes.push([cards[k].x, cards[k].y - 40, cards[k].x + ref.w, cards[k].y + ref.h]);
      });
    const top = Math.min(0, ...parts.map((q) => q.ny));
    const bottom = Math.max(CH, ...parts.map((q) => q.ny + q.h));
    boxes.push([cards.croq.x - NOTE_W - NOTE_GAP, cards.croq.y + top - 40, cards.croq.x + CW + NOTE_W + NOTE_GAP, cards.croq.y + bottom]);
    const x0 = Math.min(...boxes.map((b) => b[0])), y0 = Math.min(...boxes.map((b) => b[1]));
    const x1 = Math.max(...boxes.map((b) => b[2])), y1 = Math.max(...boxes.map((b) => b[3]));
    const s = stageSize();
    const z = clampZ(Math.min((s.w - 80) / (x1 - x0), (s.h - 180) / (y1 - y0)));
    return camFor((x0 + x1) / 2, (y0 + y1) / 2 + 10, z);
  };
  const fitView = () => {
    setSelected(null);
    prevCam.current = null;
    flyTo(fit());
  };
  const zoomBy = (k: number) => {
    const c = cam.current, s = stageSize();
    const z = clampZ(c.z * k);
    flyTo({ z, x: s.w / 2 - ((s.w / 2 - c.x) * z) / c.z, y: s.h / 2 - ((s.h / 2 - c.y) * z) / c.z }, 250);
  };

  // 처음 열 때 전체 보기 (메모 높이를 잰 다음)
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || Object.keys(heights).length < Math.min(1, live.length)) return;
    fitted.current = true;
    cam.current = fit();
    applyCam();
  });
  useEffect(() => {
    const onResize = () => applyCam();
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  });

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect(), c = cam.current;
    return { x: (e.clientX - r.left - c.x) / c.z, y: (e.clientY - r.top - c.y) / c.z };
  };

  // ---------- 메모 선택 ----------
  const selectNote = (id: string, fly: boolean) => {
    const q = parts.find((x) => x.it.id === id);
    if (!q) return;
    if (selected === id) {
      setSelected(null);
      if (fly && prevCam.current) {
        flyTo(prevCam.current);
        prevCam.current = null;
      }
      return;
    }
    if (!selected) prevCam.current = { ...cam.current };
    setSelected(id);
    if (fly) {
      const nx = q.L ? -NOTE_GAP - NOTE_W / 2 : CW + NOTE_GAP + NOTE_W / 2;
      flyTo(camFor(cards.croq.x + (q.cx + nx) / 2, cards.croq.y + (q.cy + q.ny + 40) / 2, Math.max(cam.current.z, 2.2)));
    }
  };
  const deleteNote = (id: string) => {
    const i = live.findIndex((x) => x.id === id);
    if (i < 0) return;
    record();
    const next = live[i + 1] ?? live[i - 1];
    setRemoved([...removed, id]);
    setSelected(next ? next.id : null);
    say('메모를 지웠어요 · Ctrl+Z로 되돌리기');
  };
  const toggleNote = (id: string) => {
    record();
    setOff({ ...off, [id]: !off[id] });
  };

  // ---------- 포인터 ----------
  type Gesture =
    | { type: 'pan'; sx: number; sy: number; ox: number; oy: number }
    | { type: 'card'; group: CardKey[]; sx: number; sy: number; starts: [number, number][]; snap: Snap }
    | { type: 'lasso'; pts: Pt[]; snap: Snap }
    | { type: 'snip' };
  const gesture = useRef<Gesture | null>(null);

  const tracePt = (e: { clientX: number; clientY: number }): Pt => {
    const r = tracePaperRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  const overCroquis = (w: Pt) => w.x > cards.croq.x - 60 && w.x < cards.croq.x + CW + 60 && w.y > cards.croq.y - 60 && w.y < cards.croq.y + CH + 60;

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    const t = e.target as Element;
    if (t.closest('.note, button, input, a')) return;
    if (e.button === 2) return;
    const panMode = e.button === 1 || tool === 'hand' || spaceDown;
    stageRef.current!.setPointerCapture(e.pointerId);
    cancelAnimationFrame(anim.current);
    const w = toWorld(e);
    const lbl = t.closest<HTMLElement>('[data-drag]');
    if (!panMode && lbl) {
      const k = lbl.dataset.drag as CardKey;
      const group = LINKED.includes(k) ? LINKED : [k];
      gesture.current = { type: 'card', group, sx: w.x, sy: w.y, starts: group.map((g) => [cards[g].x, cards[g].y]), snap: snapshot() };
      setPicked(group);
      return;
    }
    if (!panMode && t.closest('#trace-paper')) {
      const pt = tracePt(e);
      if (selPoly && inPoly(pt, selPoly)) {
        gesture.current = { type: 'snip' };
        setGhost(w);
        return;
      }
      gesture.current = { type: 'lasso', pts: [pt], snap: snapshot() };
      setSelPoly(null);
      setLasso([pt]);
      return;
    }
    gesture.current = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: cam.current.x, oy: cam.current.y };
    setPanning(true);
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    if (g.type === 'pan') {
      cam.current = { ...cam.current, x: g.ox + e.clientX - g.sx, y: g.oy + e.clientY - g.sy };
      applyCam();
    } else if (g.type === 'card') {
      const w = toWorld(e);
      setCards((c) => {
        const next = { ...c };
        g.group.forEach((k, i) => (next[k] = { x: g.starts[i][0] + w.x - g.sx, y: g.starts[i][1] + w.y - g.sy }));
        return next;
      });
    } else if (g.type === 'lasso') {
      const pt = tracePt(e), last = g.pts[g.pts.length - 1];
      if (Math.hypot((pt.x - last.x) * ref.w, (pt.y - last.y) * ref.h) * cam.current.z > 3) {
        g.pts.push(pt);
        setLasso(g.pts.slice());
      }
    } else if (g.type === 'snip') setGhost(toWorld(e));
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    setPanning(false);
    if (g.type === 'card') {
      setPicked([]);
      const moved = g.group.some((k, i) => Math.hypot(cards[k].x - g.starts[i][0], cards[k].y - g.starts[i][1]) > 1);
      if (moved) record(g.snap);
    } else if (g.type === 'lasso') {
      const b = bounds(g.pts);
      const ok = g.pts.length >= 5 && b.w * ref.w * b.h * ref.h > 300;
      setLasso(null);
      setSelPoly(ok ? g.pts : null);
      if (ok || g.snap.selPoly) record(g.snap);
      if (ok) say('고른 부분을 내 크로키 위로 끌어다 놓으세요');
    } else if (g.type === 'snip') {
      const w = toWorld(e);
      setGhost(null);
      if (e.type === 'pointerup' && selPoly && overCroquis(w)) {
        p.onDropPiece({ poly: selPoly, ...bounds(selPoly) }, { x: ((w.x - cards.croq.x) / CW) * 100, y: ((w.y - cards.croq.y) / CH) * 100 });
        setSelPoly(null);
      }
    }
  };

  // 휠: 이동, Ctrl/⌘+휠: 확대 (passive: false 필요)
  useEffect(() => {
    const st = stageRef.current;
    if (!st) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest('.drawer')) return;
      e.preventDefault();
      cancelAnimationFrame(anim.current);
      if (e.ctrlKey || e.metaKey) {
        const r = st.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, cam.current.z * Math.exp(-e.deltaY * 0.01));
      } else {
        cam.current = { ...cam.current, x: cam.current.x - e.deltaX, y: cam.current.y - e.deltaY };
        applyCam();
      }
    };
    st.addEventListener('wheel', onWheel, { passive: false });
    return () => st.removeEventListener('wheel', onWheel);
  });

  // ---------- 키보드 ----------
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as Element | null;
    if (t?.closest?.('input, textarea, select') || document.querySelector('dialog[open]')) return;
    if (e.code === 'Space' && !spaceDown) {
      setSpaceDown(true);
      e.preventDefault();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault();
      deleteNote(selected);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === 'Escape') {
      if (selPoly) {
        record();
        setSelPoly(null);
      }
      if (selected) selectNote(selected, true);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyV') setTool('select');
    else if (e.code === 'KeyH') setTool('hand');
    else if (e.key === '0') fitView();
    else if (e.key === '+' || e.key === '=') zoomBy(1.4);
    else if (e.key === '-') zoomBy(1 / 1.4);
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => keyRef.current(e);
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    return () => {
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
    };
  }, []);

  const toggleCard = (k: 'photo' | 'trace') => {
    record();
    setHidden({ ...hidden, [k]: !hidden[k] });
    if (k === 'trace' && !hidden.trace) setSelPoly(null);
  };

  // ---------- 그리기 ----------
  const selShown = lasso ?? selPoly;
  const ghostBox = ghost && selPoly ? bounds(selPoly) : null;
  const ghostOver = ghost ? overCroquis(ghost) : false;
  const today = new Date();
  const dateLabel = `${today.getMonth() + 1}월 ${today.getDate()}일`;
  const visibleIssues = live.filter((it) => isOn(it.id));
  const stageClass = ['stage', deep ? 'deep' : '', panning ? 'panning' : tool === 'hand' || spaceDown ? 'hand' : ''].join(' ');
  const cardClass = (k: CardKey) => ['sheet-card', LINKED.includes(k) ? 'linked' : '', picked.includes(k) ? 'picked' : '', linkHl && LINKED.includes(k) ? 'hl' : ''].join(' ');
  const linkHover = { onPointerEnter: () => setLinkHl(true), onPointerLeave: () => setLinkHl(false) };
  const chain = (
    <svg className="chain" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  );

  return (
    <div className="ws">
      <div ref={stageRef} className={stageClass} aria-label="크로키 첨삭 캔버스" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onContextMenu={(e) => e.preventDefault()}>
        <div ref={worldRef} className="world">
          {!hidden.photo && (
            <div className={cardClass('photo')} style={{ left: cards.photo.x, top: cards.photo.y }}>
              <div className="label" data-drag="photo" {...linkHover}>
                <b>원본 사진</b>
                {chain}
                <span>기준 선화와 함께 움직여요</span>
              </div>
              <div className="paper" style={{ width: ref.w, height: ref.h }}>
                <img src={p.photo.url} alt="원본 참고 사진" draggable={false} style={{ objectFit: p.aligned ? 'fill' : 'contain' }} />
              </div>
            </div>
          )}

          {!hidden.trace && (
            <div className={cardClass('trace')} style={{ left: cards.trace.x, top: cards.trace.y }}>
              <div className="label" data-drag="trace" {...linkHover}>
                <b>{p.lineArtSource === 'ai' ? 'AI 기준 선화' : '기준 선화'}</b>
                {chain}
                <span>· 위에서 드래그하면 올가미로 골라요</span>
              </div>
              <div ref={tracePaperRef} id="trace-paper" className={selPoly ? 'paper has-sel' : 'paper'} style={{ width: ref.w, height: ref.h }}>
                <img src={p.lineArt.url} alt="원본 사진에서 추출한 기준 선화" draggable={false} />
                {selPoly && <img src={p.lineArtRed} alt="" draggable={false} style={{ clipPath: clipPoly(selPoly) }} />}
                {selShown && (
                  <svg className="lasso" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                    <polygon points={selShown.map((q) => `${q.x},${q.y}`).join(' ')} />
                  </svg>
                )}
              </div>
            </div>
          )}

          <div className={cardClass('croq')} style={{ left: cards.croq.x, top: cards.croq.y }}>
            <div className="label" data-drag="croq">
              <b>내 크로키</b>· {p.settings.time === '자유' ? '자유' : p.settings.time} · {dateLabel}
            </div>
            <div className="paper" style={{ width: CW, height: CH }}>
              <img src={p.croquisInk} alt="내 크로키" draggable={false} />
              <CorrectionLayer issues={visibleIssues.filter((x) => !x.piece)} w={CW} h={CH} opacity={opacity / 100} />
              <PieceLayer issues={[...visibleIssues.filter((x) => x.piece), ...pendings]} redLineArt={p.lineArtRed} opacity={opacity / 100} />
              {pendings.map((x) => {
                const r = ringOf(x, CW, CH, 14, 56);
                return (
                  <span key={x.id} aria-hidden="true">
                    <span className="ring-pend" style={{ left: r.cx - r.r, top: r.cy - r.r, width: r.r * 2, height: r.r * 2 }} />
                    <span className="pend-text" style={{ left: r.cx, top: r.cy - r.r - 32 }}>
                      분석 중…
                    </span>
                  </span>
                );
              })}
            </div>

            <svg className="leaders" aria-hidden="true">
              {parts
                .filter((q) => isOn(q.it.id))
                .map((q) => {
                  const ax = q.L ? -NOTE_GAP + 2 : CW + NOTE_GAP - 2, ay = q.ny + 14;
                  const ex = q.L ? q.cx - q.r : q.cx + q.r;
                  return (
                    <g key={q.it.id}>
                      <path d={`M ${ax} ${ay} Q ${(ax + ex) / 2} ${ay + (q.cy - ay) * 0.1 - 16}, ${ex} ${q.cy}`} />
                      <circle cx={q.cx} cy={q.cy} r={q.r} />
                    </g>
                  );
                })}
            </svg>

            {parts.map((q) => {
              const on = isOn(q.it.id);
              return (
                <button
                  key={q.it.id}
                  ref={(el) => {
                    if (el) noteEls.current.set(q.it.id, el);
                    else noteEls.current.delete(q.it.id);
                  }}
                  type="button"
                  className={['note', q.L ? 'L' : 'R', on ? '' : 'off', selected === q.it.id ? 'sel' : ''].join(' ')}
                  style={{ left: q.L ? -NOTE_GAP - NOTE_W : CW + NOTE_GAP, top: q.ny, width: NOTE_W }}
                  title="클릭: 확대 · 오른쪽 클릭: 빨간 선 켜기/끄기 · Delete: 지우기"
                  aria-pressed={selected === q.it.id}
                  onClick={(e) => {
                    e.currentTarget.focus();
                    selectNote(q.it.id, true);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    toggleNote(q.it.id);
                  }}
                >
                  <span className="t">
                    {q.n}. {q.it.name}
                    {q.custom && ' (고른 부분)'}
                  </span>
                  <span className="f">{q.it.fix}</span>
                  <span className="more">
                    <span className="lines" aria-hidden="true">
                      {[100, 72, 94, 58].map((w, i) => (
                        <i key={i} style={{ width: `${w}%` }} />
                      ))}
                    </span>
                    <span className="detail" aria-hidden={!deep}>
                      <span>{q.it.why}</span>
                      <span>→ {q.it.how}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {ghost && selPoly && ghostBox && (
            <>
              {ghostOver && <div className="drop-hint" style={{ left: cards.croq.x - 12, top: cards.croq.y - 12, width: CW + 24, height: CH + 24 }} />}
              <div className="ghost" style={{ left: ghost.x - (ghostBox.w * CW) / 2, top: ghost.y - (ghostBox.h * CH) / 2, width: ghostBox.w * CW, height: ghostBox.h * CH }}>
                <img
                  src={p.lineArtRed}
                  alt=""
                  style={{
                    left: `${(-ghostBox.x0 / ghostBox.w) * 100}%`,
                    top: `${(-ghostBox.y0 / ghostBox.h) * 100}%`,
                    width: `${100 / ghostBox.w}%`,
                    height: `${100 / ghostBox.h}%`,
                    clipPath: clipPoly(selPoly),
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="top">
        <div className="logo">
          <PencilIcon width={18} height={18} />
        </div>
        <h1>크로키 선생님</h1>
        <button type="button" className="top__btn" onClick={p.onNew}>
          새 크로키
        </button>
      </div>
      <div className="top-right">
        <button type="button" className="pill-btn" onClick={p.onKey}>
          <KeyIcon />
          <span className="pill-label">API 키</span>
          <span className={p.hasKey ? 'key-dot key-dot--on' : 'key-dot'} aria-label={p.hasKey ? '입력됨' : '없음'} />
        </button>
        <button type="button" className="pill-btn" aria-expanded={drawer} aria-controls="drawer" onClick={() => setDrawer(!drawer)}>
          <span className="pill-label">노트 정리</span>
          <span className="pill-short" aria-hidden="true">노트</span> <em>{live.length}</em>
        </button>
      </div>

      {drawer && (
        <aside className="drawer" id="drawer" aria-label="노트 정리">
          <header>
            <h2>크로키 노트</h2>
            <span>
              {dateLabel} · {p.feedback.pose}
            </span>
          </header>
          <ol>
            {live.length ? (
              live.map((it, i) => (
                <li key={it.id}>
                  <button
                    type="button"
                    className={selected === it.id ? 'item sel' : 'item'}
                    onClick={() => {
                      if (selected === it.id) setSelected(null);
                      else {
                        setSelected(null);
                        selectNote(it.id, true);
                      }
                    }}
                  >
                    <b>
                      {i + 1}. {it.name}
                      {it.piece && ' (고른 부분)'} — {it.fix}
                    </b>
                    <span>관찰: {it.why}</span>
                    {it.cause && <span>원인: {it.cause}</span>}
                    <span className="how">→ 수정: {it.how}</span>
                    {it.rule && <span className="rule">다음 규칙: {it.rule}</span>}
                  </button>
                  {selected === it.id && (
                    <button type="button" className="del" aria-label={`${it.name} 지우기`} onClick={() => deleteNote(it.id)}>
                      <TrashIcon />
                    </button>
                  )}
                </li>
              ))
            ) : (
              <li className="empty">다 지웠어요. 되돌리기로 다시 꺼낼 수 있어요.</li>
            )}
            {p.feedback.good && <li className="good">잘한 점: {p.feedback.good}</li>}
          </ol>
          <footer>
            <span>클릭해서 고르고 Delete로 지우기</span>
            {past.current.length > 0 && (
              <button type="button" onClick={undo} title="Ctrl+Z · 다시 하기는 Ctrl+Shift+Z">
                되돌리기
              </button>
            )}
          </footer>
        </aside>
      )}

      <div className="bar" role="toolbar" aria-label="도구">
        <button type="button" aria-pressed={tool === 'select'} title="이동·올가미 (V)" onClick={() => setTool('select')}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 3l14 8-6 2-2 6z" />
          </svg>
          이동
        </button>
        <button type="button" aria-pressed={tool === 'hand'} title="손 (H, 또는 스페이스 누른 채)" onClick={() => setTool('hand')}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 13V5a1.5 1.5 0 0 1 3 0v6M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V6a1.5 1.5 0 0 1 3 0v8c0 4-2.5 7-6 7s-5-2-6.5-4.5L3 13a1.5 1.5 0 0 1 2.5-1.5L8 14" />
          </svg>
          손
        </button>
        <span className="sep" />
        <button type="button" aria-pressed={!hidden.photo} onClick={() => toggleCard('photo')}>
          사진
        </button>
        <button type="button" aria-pressed={!hidden.trace} onClick={() => toggleCard('trace')}>
          기준 선화
        </button>
        <button
          type="button"
          aria-pressed={showLines}
          onClick={() => {
            record();
            setShowLines(!showLines);
          }}
        >
          빨간 선
        </button>
        <label className="bar__range" title="교정선 투명도">
          <span className="sr-only">교정선 투명도</span>
          <input type="range" min={10} max={100} step={5} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-valuetext={`${opacity}%`} />
        </label>
        <span className="sep" />
        <button type="button" aria-label="축소" onClick={() => zoomBy(1 / 1.4)}>
          <MinusIcon />
        </button>
        <span className="pct" ref={pctRef}>
          100%
        </span>
        <button type="button" aria-label="확대" onClick={() => zoomBy(1.4)}>
          <PlusIcon />
        </button>
        <button type="button" title="전체 보기 (0)" onClick={fitView}>
          전체
        </button>
      </div>

      <div className="tip">
        <b>빈 곳 드래그</b> 이동 · <b>Ctrl+휠</b> 확대
        <br />
        <b>기준 선화 위 드래그</b> 올가미로 고르기
        <br />
        <b>고른 부분 → 내 크로키</b>로 끌면 빨간 펜 첨삭
        <br />
        <b>메모 클릭</b> 확대 · <b>오른쪽 클릭</b> 선 끄기 · <b>Delete</b> 지우기
        <br />
        <b>Ctrl+Z</b> 되돌리기 · <b>Ctrl+Shift+Z</b> 다시 하기
      </div>
      <div className={toast ? 'toast on' : 'toast'} role="status">
        {toast}
      </div>
    </div>
  );
}
