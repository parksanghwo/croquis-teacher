import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import type { CritiqueSettings, Feedback, Img, Issue, Piece, Pt } from '../types';
import { CorrectionLayer } from '../components/CorrectionLayer';
import { PieceLayer } from '../components/PieceLayer';
import { SettingsPanel } from '../components/SettingsPanel';
import { ArrowRightIcon, KeyIcon, MinusIcon, PencilIcon, PlusIcon, TrashIcon, UploadIcon } from '../components/Icons';
import { bounds, clipPoly, inPoly, ringOf, stack } from '../lib/geometry';

/**
 * 크로키 선생님 캔버스 — 끝없이 넓은 책상 위에 원본 사진, 기준 선화, 내 크로키 종이를 펼쳐 둔 화면.
 * 업로드(끌어다 놓기·빈 곳 클릭·붙여넣기)부터 첨삭, 오답노트까지 이 한 화면에서 한다.
 * 카메라(이동·확대)는 리렌더 없이 DOM에 직접 적용하고, 1.5배 이상 확대하면 메모 상세 설명이 드러난다.
 */

export type Kind = 'photo' | 'drawing';

interface Props {
  /** 원본 사진 (첨삭 후엔 정렬된 것) */
  photo: Img | null;
  /** 기준 선화 (추출 중이면 null) */
  lineArt: Img | null;
  /** 연필선만 남긴 내 크로키 (추출 중이면 null) */
  croquis: Img | null;
  /** 추출 전 크로키 원본 (처리 중 표시용) */
  croquisRaw: Img | null;
  /** 빨간 기준 선화 (올가미 강조·끌어다 놓은 조각) */
  lineArtRed: string | null;
  aligned: boolean;
  busy: { photo?: boolean; croquis?: boolean; critique?: boolean };
  source: { lineArt?: 'ai' | 'local'; croquis?: 'ai' | 'local' };
  feedback: Feedback | null;
  extras: Issue[];
  regionError: string | null;
  banner: string | null;
  settings: CritiqueSettings;
  hasKey: boolean;
  onSettings: (s: CritiqueSettings) => void;
  onStart: () => void;
  onCancel: () => void;
  onUpload: () => void;
  onFiles: (files: File[]) => void;
  onSwap: () => void;
  onRemove: (k: Kind) => void;
  onDropPiece: (piece: Piece, at: Pt) => void;
  onDismissBanner: () => void;
  onKey: () => void;
}

type CardKey = 'photo' | 'trace' | 'croq';
type Pos = Partial<Record<CardKey, { x: number; y: number }>>;
interface Cam {
  x: number;
  y: number;
  z: number;
}
interface Snap {
  moved: Pos;
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
const GAP = 60;
const NOTE_W = 210;
const NOTE_GAP = 24;
const NOTE_H = 96;
const DEEP_Z = 1.5;
const clampZ = (z: number) => Math.max(0.15, Math.min(5, z));
const canReadClipboard = typeof navigator !== 'undefined' && !!navigator.clipboard && 'read' in navigator.clipboard;

const size = (img: Img | null, h: number, fallbackW: number) => {
  if (!img) return { w: fallbackW, h };
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

  const fb = p.feedback;
  const hasPhoto = !!p.photo, hasCroq = !!(p.croquis ?? p.croquisRaw);
  const ref = size(p.lineArt ?? p.photo, REF_H, 420);
  const croq = size(p.croquis ?? p.croquisRaw, CROQ_H, 300);
  const CW = croq.w, CH = croq.h;

  // 카드 위치: 기본 배치 + 사용자가 옮긴 것만 따로 기억
  const [moved, setMoved] = useState<Pos>({});
  const defaults: Record<CardKey, { x: number; y: number }> = {
    // 사진이 아직 없으면 기준 선화 자리가 없으니 크로키 옆에 붙여 둔다
    photo: hasPhoto ? { x: -(ref.w * 2 + GAP + 300), y: (CH - ref.h) / 2 } : { x: -(ref.w + 140), y: (CH - ref.h) / 2 },
    trace: { x: -(ref.w + 300), y: (CH - ref.h) / 2 },
    croq: { x: 0, y: 0 },
  };
  const cards = { photo: moved.photo ?? defaults.photo, trace: moved.trace ?? defaults.trace, croq: moved.croq ?? defaults.croq };
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragFiles, setDragFiles] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastT = useRef(0);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const noteEls = useRef(new Map<string, HTMLButtonElement>());

  // ---------- 되돌리기 ----------
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  const [, bump] = useState(0);
  const snapshot = (): Snap => ({ moved, hidden, showLines, off, removed, selPoly });
  const record = (s: Snap = snapshot()) => {
    past.current.push(s);
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    bump((n) => n + 1);
  };
  const restore = (s: Snap) => {
    setMoved(s.moved);
    setHidden(s.hidden);
    setShowLines(s.showLines);
    setOff(s.off);
    setRemoved(s.removed);
    setSelPoly(s.selPoly);
  };
  const say = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastT.current);
    toastT.current = window.setTimeout(() => setToast(null), 1800);
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

  // 새 첨삭 결과(또는 결과가 지워짐)마다 메모 상태를 처음으로
  useEffect(() => {
    setOff({});
    setRemoved([]);
    setSelected(null);
    setSelPoly(null);
    past.current = [];
    future.current = [];
    if (!fb) setDrawer(false);
  }, [fb]);

  useEffect(() => {
    if (p.regionError) say('고른 부분을 첨삭하지 못했어요');
  }, [p.regionError, say]);

  // ---------- 메모 ----------
  const all = useMemo(() => (fb ? [...fb.issues, ...p.extras.filter((x) => !x.pending)] : []), [fb, p.extras]);
  const live = all.filter((it) => !removed.includes(it.id));
  const isOn = (id: string) => showLines && !off[id];
  const pendings = fb ? p.extras.filter((x) => x.pending) : [];

  const parts = useMemo(() => {
    const base = live.map((it, i) => {
      const ring = ringOf(it, CW, CH, 14, it.piece ? 56 : 40);
      return { it, n: i + 1, L: ring.cx < CW / 2, cx: ring.cx, cy: ring.cy, r: ring.r, custom: !!it.piece };
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
    if (!narrow || !hasCroq) {
      if (!hidden.photo || !hasPhoto) boxes.push([cards.photo.x, cards.photo.y - 40, cards.photo.x + ref.w, cards.photo.y + ref.h]);
      if (hasPhoto && !hidden.trace) boxes.push([cards.trace.x, cards.trace.y - 40, cards.trace.x + ref.w, cards.trace.y + ref.h]);
    }
    if (!hasPhoto && !hasCroq) boxes.push([cards.photo.x, Math.min(cards.photo.y, 0) - 150, cards.croq.x + CW, 0]); // 빈 화면 안내 문구
    const top = Math.min(0, ...parts.map((q) => q.ny));
    const bottom = Math.max(CH, ...parts.map((q) => q.ny + q.h));
    const side = fb ? NOTE_W + NOTE_GAP : 0;
    boxes.push([cards.croq.x - side, cards.croq.y + top - 40, cards.croq.x + CW + side, cards.croq.y + bottom]);
    const x0 = Math.min(...boxes.map((b) => b[0])), y0 = Math.min(...boxes.map((b) => b[1]));
    const x1 = Math.max(...boxes.map((b) => b[2])), y1 = Math.max(...boxes.map((b) => b[3]));
    const s = stageSize();
    const z = clampZ(Math.min(1.2, (s.w - 80) / (x1 - x0), (s.h - 200) / (y1 - y0)));
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

  // 처음, 그리고 카드 구성이 바뀔 때(사진·그림이 들어오거나 첨삭 결과가 오면) 전체 보기
  const layoutKey = `${hasPhoto}|${hasCroq}|${!!p.lineArt}|${!!p.croquis}|${fb ? 'fb' : ''}|${Math.round(CW)}x${Math.round(CH)}|${Math.round(ref.w)}`;
  const fittedFor = useRef('');
  const firstFit = useRef(true);
  useEffect(() => {
    if (fittedFor.current === layoutKey) return;
    if (fb && live.length && Object.keys(heights).length === 0) return; // 메모 높이를 잰 다음
    fittedFor.current = layoutKey;
    if (firstFit.current) {
      firstFit.current = false;
      cam.current = fit();
      applyCam();
    } else flyTo(fit());
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
    | { type: 'pan'; sx: number; sy: number; ox: number; oy: number; t: number; empty: boolean }
    | { type: 'card'; group: CardKey[]; sx: number; sy: number; starts: [number, number][]; snap: Snap }
    | { type: 'lasso'; pts: Pt[]; snap: Snap }
    | { type: 'snip' };
  const gesture = useRef<Gesture | null>(null);

  const tracePt = (e: { clientX: number; clientY: number }): Pt => {
    const r = tracePaperRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  const overCroquis = (w: Pt) => w.x > cards.croq.x - 60 && w.x < cards.croq.x + CW + 60 && w.y > cards.croq.y - 60 && w.y < cards.croq.y + CH + 60;
  const canLasso = !!(fb && p.lineArt && p.lineArtRed);

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    const t = e.target as Element;
    setMenu(null);
    if (t.closest('.note, button, input, a, label.bar__range')) return;
    if (e.button === 2) return;
    setSettingsOpen(false);
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
    if (!panMode && canLasso && t.closest('#trace-paper')) {
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
    // 종이 밖 빈 곳이면, 움직이지 않고 떼었을 때 메뉴를 띄운다
    const empty = !t.closest('.paper, .placeholder, .empty-hint');
    gesture.current = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: cam.current.x, oy: cam.current.y, t: performance.now(), empty };
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
      setMoved((m) => {
        const next = { ...m };
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
    if (g.type === 'pan') {
      const still = Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 4 && performance.now() - g.t < 500;
      if (still && g.empty && e.type === 'pointerup' && tool === 'select' && !spaceDown && e.button === 0) {
        const r = stageRef.current!.getBoundingClientRect();
        // 화면 밖으로 나가지 않게
        setMenu({ x: Math.min(e.clientX - r.left, r.width - 220), y: Math.min(e.clientY - r.top, r.height - 160) });
      }
    } else if (g.type === 'card') {
      setPicked([]);
      const moved2 = g.group.some((k, i) => Math.hypot(cards[k].x - g.starts[i][0], cards[k].y - g.starts[i][1]) > 1);
      if (moved2) record(g.snap);
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
      if ((e.target as Element).closest('.drawer, .settings-pop')) return;
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
      setMenu(null);
      setSettingsOpen(false);
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
    else if (e.code === 'KeyU') p.onUpload();
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

  const pasteFromClipboard = async () => {
    setMenu(null);
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const it of items) {
        const type = it.types.find((x) => x.startsWith('image/'));
        if (type) files.push(new File([await it.getType(type)], `pasted.${type.split('/')[1]}`, { type }));
      }
      if (files.length) p.onFiles(files);
      else say('클립보드에 이미지가 없어요');
    } catch {
      say('브라우저가 클립보드 읽기를 막았어요 · Ctrl+V로 붙여넣어 주세요');
    }
  };

  // 파일 끌어다 놓기 (화면 어디든)
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (hasFiles(e)) setDragFiles(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDragFiles(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget === e.target || !(e.currentTarget as Element).contains(e.relatedTarget as Node)) setDragFiles(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragFiles(false);
      const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
      if (files.length) p.onFiles(files);
      else say('이미지 파일만 올릴 수 있어요');
    },
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
  const ready = !!(p.photo && p.lineArt && p.croquis) && !p.busy.photo && !p.busy.croquis;
  const empty = !hasPhoto && !hasCroq;
  const chain = (
    <svg className="chain" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  );
  const working = (text: string) => (
    <div className="working">
      <span className="spinner" />
      {text}
    </div>
  );
  const placeholder = (title: string, sub: ReactNode, w: number, h: number) => (
    <button type="button" className="placeholder" style={{ width: w, height: h }} onClick={p.onUpload}>
      <UploadIcon />
      <b>{title}</b>
      <span>{sub}</span>
    </button>
  );
  const labelActions = (k: Kind) => (
    <span className="label__actions">
      <button type="button" onClick={p.onSwap} title={k === 'photo' ? '이 이미지는 그림이에요' : '이 이미지는 사진이에요'}>
        {k === 'photo' ? '그림이에요' : '사진이에요'}
      </button>
      <button type="button" onClick={() => p.onRemove(k)}>
        빼기
      </button>
    </span>
  );
  const startLabel = p.busy.critique ? null : fb ? '다시 첨삭' : '첨삭 시작하기';

  return (
    <div className="ws" {...dropProps}>
      <div ref={stageRef} className={stageClass} aria-label="크로키 첨삭 캔버스" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onContextMenu={(e) => e.preventDefault()}>
        <div ref={worldRef} className="world">
          {empty && (
            <div className="empty-hint" style={{ left: cards.photo.x, top: Math.min(cards.photo.y, 0) - 140, width: cards.croq.x + CW - cards.photo.x }}>
              <p className="hand-note">사진과 내 크로키를 올려 주세요!</p>
              <p>파일을 화면에 끌어다 놓거나, 빈 곳을 클릭해서 올려요. 사진인지 그림인지는 알아서 나눠요.</p>
            </div>
          )}

          {/* 원본 사진 */}
          {(!hasPhoto || !hidden.photo) && (
            <div className={cardClass('photo')} style={{ left: cards.photo.x, top: cards.photo.y }}>
              {hasPhoto ? (
                <>
                  <div className="label" data-drag="photo" {...linkHover}>
                    <b>원본 사진</b>
                    <span title="기준 선화와 함께 움직여요">{chain}</span>
                    {labelActions('photo')}
                  </div>
                  <div className="paper" style={{ width: ref.w, height: ref.h }}>
                    <img src={p.photo!.url} alt="원본 참고 사진" draggable={false} style={{ objectFit: p.aligned ? 'fill' : 'contain' }} />
                  </div>
                </>
              ) : (
                <>
                  <div className="label">
                    <b>원본 사진</b>
                  </div>
                  {placeholder('참고 사진을 올려 주세요', '보고 그린 원본 사진', ref.w, ref.h)}
                </>
              )}
            </div>
          )}

          {/* 기준 선화 */}
          {hasPhoto && !hidden.trace && (
            <div className={cardClass('trace')} style={{ left: cards.trace.x, top: cards.trace.y }}>
              <div className="label" data-drag="trace" {...linkHover}>
                <b>{p.source.lineArt === 'ai' ? 'AI 기준 선화' : '기준 선화'}</b>
                {chain}
                <span>{canLasso ? '· 위에서 드래그하면 올가미로 골라요' : '· 사진에서 딴 선'}</span>
              </div>
              <div ref={tracePaperRef} id="trace-paper" className={['paper', canLasso ? 'lassoable' : '', selPoly ? 'has-sel' : ''].join(' ')} style={{ width: ref.w, height: ref.h }}>
                {p.lineArt ? (
                  <img src={p.lineArt.url} alt="원본 사진에서 추출한 기준 선화" draggable={false} />
                ) : (
                  <>
                    <img src={p.photo!.url} alt="" draggable={false} style={{ opacity: 0.18 }} />
                    {working(p.settings.extract === 'ai' ? 'AI가 선화를 따는 중… (수십 초)' : '선화를 따는 중…')}
                  </>
                )}
                {selPoly && p.lineArtRed && <img src={p.lineArtRed} alt="" draggable={false} style={{ clipPath: clipPoly(selPoly) }} />}
                {selShown && (
                  <svg className="lasso" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                    <polygon points={selShown.map((q) => `${q.x},${q.y}`).join(' ')} />
                  </svg>
                )}
              </div>
            </div>
          )}

          {/* 내 크로키 */}
          <div className={cardClass('croq')} style={{ left: cards.croq.x, top: cards.croq.y }}>
            {hasCroq ? (
              <div className="label" data-drag="croq">
                <b>내 크로키</b>· {p.settings.time} · {dateLabel}
                {labelActions('drawing')}
              </div>
            ) : (
              <div className="label">
                <b>내 크로키</b>
              </div>
            )}
            {!hasCroq && placeholder('내 크로키를 올려 주세요', '종이에 그린 그림을 찍거나 스캔해서', CW, CH)}
            {hasCroq && (
              <div className="paper" style={{ width: CW, height: CH }}>
                {p.croquis ? (
                  <img src={p.croquis.url} alt="내 크로키" draggable={false} />
                ) : (
                  <>
                    <img src={p.croquisRaw!.url} alt="" draggable={false} style={{ opacity: 0.25 }} />
                    {working(p.settings.extract === 'ai' ? 'AI가 연필선만 남기는 중… (수십 초)' : '종이를 지우는 중…')}
                  </>
                )}
                {fb && (
                  <>
                    <CorrectionLayer issues={visibleIssues.filter((x) => !x.piece)} w={CW} h={CH} opacity={opacity / 100} />
                    {p.lineArtRed && <PieceLayer issues={[...visibleIssues.filter((x) => x.piece), ...pendings]} redLineArt={p.lineArtRed} opacity={opacity / 100} />}
                  </>
                )}
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
                {p.busy.critique && working('선생님이 보는 중…')}
              </div>
            )}

            {fb && (
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
            )}

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

          {ghost && selPoly && ghostBox && p.lineArtRed && (
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

        {menu && (
          <div className="ctx" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                p.onUpload();
              }}
            >
              <UploadIcon width={18} height={18} />
              파일 업로드…<kbd>U</kbd>
            </button>
            {canReadClipboard && (
              <button type="button" role="menuitem" onClick={pasteFromClipboard}>
                붙여넣기<kbd>Ctrl+V</kbd>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                fitView();
              }}
            >
              전체 보기<kbd>0</kbd>
            </button>
          </div>
        )}
      </div>

      {dragFiles && (
        <div className="file-drop" aria-hidden="true">
          <div>
            <UploadIcon />
            <b>여기에 놓으면 올라가요</b>
            <span>사진인지 그림인지는 알아서 나눠요</span>
          </div>
        </div>
      )}

      <div className="top">
        <div className="logo">
          <PencilIcon width={18} height={18} />
        </div>
        <h1>크로키 선생님</h1>
        <button type="button" className="top__btn" onClick={p.onUpload}>
          <UploadIcon width={16} height={16} />
          올리기
        </button>
      </div>

      <div className="startbar">
        <button type="button" className={settingsOpen ? 'pill-btn on' : 'pill-btn'} aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}>
          <span className="pill-label">첨삭 설정</span>
          <span className="pill-short">설정</span>
          <span className="startbar__meta">{p.settings.time}</span>
        </button>
        {p.busy.critique ? (
          <>
            <span className="pill-btn startbar__busy">
              <span className="spinner" />
              선생님이 보는 중…
            </span>
            <button type="button" className="pill-btn" onClick={p.onCancel}>
              취소
            </button>
          </>
        ) : (
          <button type="button" className="pill-btn pill-btn--primary" disabled={!ready} onClick={p.onStart} title={ready ? undefined : '사진과 내 크로키를 올리면 시작할 수 있어요'}>
            {startLabel}
            <ArrowRightIcon width={16} height={16} />
          </button>
        )}
        {settingsOpen && <SettingsPanel settings={p.settings} onChange={p.onSettings} />}
      </div>

      {p.banner && (
        <div className="banner" role="status">
          {p.banner}
          <button type="button" onClick={p.onDismissBanner} aria-label="알림 닫기">
            ✕
          </button>
        </div>
      )}

      <div className="top-right">
        <button type="button" className="pill-btn" onClick={p.onKey} aria-label="API 키">
          <KeyIcon />
          <span className="pill-label">API 키</span>
          <span className={p.hasKey ? 'key-dot key-dot--on' : 'key-dot'} aria-label={p.hasKey ? '입력됨' : '없음'} />
        </button>
        {fb && (
          <button type="button" className="pill-btn" aria-expanded={drawer} aria-controls="drawer" onClick={() => setDrawer(!drawer)}>
            <span className="pill-label">노트 정리</span>
            <span className="pill-short" aria-hidden="true">
              노트
            </span>{' '}
            <em>{live.length}</em>
          </button>
        )}
      </div>

      {drawer && fb && (
        <aside className="drawer" id="drawer" aria-label="노트 정리">
          <header>
            <h2>크로키 노트</h2>
            <span>
              {dateLabel} · {fb.pose}
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
            {fb.good && <li className="good">잘한 점: {fb.good}</li>}
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
        <button type="button" aria-pressed={!hidden.photo} disabled={!hasPhoto} onClick={() => toggleCard('photo')}>
          사진
        </button>
        <button type="button" aria-pressed={!hidden.trace} disabled={!hasPhoto} onClick={() => toggleCard('trace')}>
          기준 선화
        </button>
        {fb && (
          <>
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
          </>
        )}
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
        {fb ? (
          <>
            <b>빈 곳 드래그</b> 이동 · <b>Ctrl+휠</b> 확대
            <br />
            <b>기준 선화 위 드래그</b> 올가미로 고르기
            <br />
            <b>고른 부분 → 내 크로키</b>로 끌면 빨간 펜 첨삭
            <br />
            <b>메모 클릭</b> 확대 · <b>오른쪽 클릭</b> 선 끄기 · <b>Delete</b> 지우기
            <br />
            <b>Ctrl+Z</b> 되돌리기 · <b>Ctrl+Shift+Z</b> 다시 하기
          </>
        ) : (
          <>
            <b>파일 끌어다 놓기</b> 또는 <b>빈 곳 클릭 → 파일 업로드</b>
            <br />
            <b>Ctrl+V</b> 붙여넣기 · <b>휴대폰</b>은 업로드 창의 QR로
            <br />
            사진과 그림은 자동으로 나눠요
            <br />
            <b>빈 곳 드래그</b> 이동 · <b>Ctrl+휠</b> 확대
          </>
        )}
      </div>
      <div className={toast ? 'toast on' : 'toast'} role="status">
        {toast}
      </div>
    </div>
  );
}
