import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { CritiqueSettings, Img, Issue, Item, Kind, Link, Piece, Pt } from '../types';
import { CorrectionLayer } from '../components/CorrectionLayer';
import { PieceLayer } from '../components/PieceLayer';
import { SettingsPanel } from '../components/SettingsPanel';
import { KeyIcon, MinusIcon, PencilIcon, PlusIcon, TrashIcon, UploadIcon } from '../components/Icons';
import { bounds, clipPoly, inPoly, ringOf, stack } from '../lib/geometry';

/**
 * 크로키 선생님 캔버스 — 끝없이 넓은 책상 위에 올린 이미지를 카드로 펼쳐 둔 화면.
 * 올린 이미지는 같은 카드로 놓이고, 사진인지 그림인지 판별되면 각각 처리된다.
 * 사진 카드에서 그림 카드로 끌어 화살표로 이으면 그 둘로 첨삭이 시작된다.
 * 사진 카드를 오른쪽 클릭하면 트레이싱(기준 선화)이 켜지고 꺼진다.
 */

interface Props {
  items: Item[];
  links: Link[];
  banner: string | null;
  settings: CritiqueSettings;
  hasKey: boolean;
  onSettings: (s: CritiqueSettings) => void;
  onUpload: (at?: Pt) => void;
  onFiles: (files: File[], at?: Pt) => void;
  onSetKind: (id: string, kind: Kind) => void;
  onRemove: (id: string) => void;
  onLink: (photoId: string, drawingId: string) => void;
  onUnlink: (linkId: string) => void;
  onRetry: (linkId: string) => void;
  onDropPiece: (linkId: string, piece: Piece, at: Pt) => void;
  onDismissBanner: () => void;
  onKey: () => void;
}

interface Cam {
  x: number;
  y: number;
  z: number;
}
interface Snap {
  moved: Record<string, Pt>;
  traceOn: Record<string, boolean>;
  showLines: boolean;
  off: Record<string, boolean>;
  removed: string[];
}
/** 메모 한 개의 배치 (그림 카드 기준 좌표) */
interface Part {
  it: Issue;
  n: number;
  L: boolean;
  cx: number;
  cy: number;
  r: number;
  ny: number;
  h: number;
  custom: boolean;
}
type Rect = { x: number; y: number; w: number; h: number };

const PHOTO_H = 600;
const DRAW_H = 700;
const MAX_W = 520;
const NOTE_W = 210;
const NOTE_GAP = 24;
const NOTE_H = 96;
const DEEP_Z = 1.5;
const clampZ = (z: number) => Math.max(0.15, Math.min(5, z));
const canReadClipboard = typeof navigator !== 'undefined' && !!navigator.clipboard && 'read' in navigator.clipboard;

const fitSize = (img: Img, h: number) => {
  let w = (h * img.w) / img.h;
  if (w > MAX_W) {
    w = MAX_W;
    h = (w * img.h) / img.w;
  }
  return { w, h };
};

/** 올가미 좌표(원본 기준 선화 0~1) → 첨삭에 쓴 잘라 낸 기준 선화 0~1 */
const toCropped = (p: Pt, src: Img, r: Rect | null): Pt => (r ? { x: (p.x * src.w - r.x) / r.w, y: (p.y * src.h - r.y) / r.h } : p);

/** 화살표: 사진 카드 가장자리 → 그림 카드 가장자리 (또는 마우스 위치) */
function arrowPath(a: Rect, to: Pt, b?: Rect) {
  const toRight = (b ? b.x + b.w / 2 : to.x) >= a.x + a.w / 2;
  const sx = toRight ? a.x + a.w : a.x, sy = a.y + a.h / 2;
  const ex = b ? (toRight ? b.x : b.x + b.w) : to.x, ey = b ? b.y + b.h / 2 : to.y;
  const dx = Math.max(60, Math.abs(ex - sx) / 2) * (toRight ? 1 : -1);
  return { d: `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`, mid: { x: (sx + ex) / 2, y: (sy + ey) / 2 } };
}

export function Workspace(p: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const pctRef = useRef<HTMLSpanElement>(null);
  const cam = useRef<Cam>({ x: 0, y: 0, z: 1 });
  const anim = useRef(0);
  const [deep, setDeep] = useState(false);
  const deepRef = useRef(false);

  const [moved, setMoved] = useState<Record<string, Pt>>({});
  const [traceOn, setTraceOn] = useState<Record<string, boolean>>({});
  const [showLines, setShowLines] = useState(true);
  const [opacity, setOpacity] = useState(90);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [removed, setRemoved] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const prevCam = useRef<Cam | null>(null);
  const [tool, setTool] = useState<'select' | 'hand'>('select');
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const [sel, setSel] = useState<{ photoId: string; poly: Pt[] } | null>(null);
  const [lasso, setLasso] = useState<{ photoId: string; pts: Pt[] } | null>(null);
  const [ghost, setGhost] = useState<Pt | null>(null);
  const [linking, setLinking] = useState<{ photoId: string; to: Pt } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; world: Pt } | null>(null);
  const [dragFiles, setDragFiles] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastT = useRef(0);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const noteEls = useRef(new Map<string, HTMLButtonElement>());

  // ---------- 카드 ----------
  const linkOf = (drawingId: string) => p.links.find((l) => l.drawingId === drawingId);
  const doneLinkOf = (drawingId: string) => {
    const l = linkOf(drawingId);
    return l && l.status === 'done' && l.prepared && l.feedback ? l : undefined;
  };
  /** 카드에 보여 줄 이미지: 첨삭이 끝난 그림은 정렬된 크로키 */
  const shown = (it: Item): Img => (it.kind === 'drawing' ? (doneLinkOf(it.id)?.prepared?.croquis ?? it.out ?? it.raw) : it.raw);
  const sizeOf = (it: Item) => fitSize(shown(it), it.kind === 'photo' ? PHOTO_H : DRAW_H);

  // 처음 보는 카드는 놓은 자리(겹치면 오른쪽으로 비켜서), 아니면 오른쪽 빈 자리에
  const [home, setHome] = useState<Record<string, Pt>>({});
  useEffect(() => {
    const missing = p.items.filter((it) => !home[it.id]);
    if (!missing.length) return;
    setHome((h) => {
      const next = { ...h };
      const taken: Rect[] = p.items.filter((it) => next[it.id]).map((it) => ({ ...(moved[it.id] ?? next[it.id]), ...sizeOf(it) }));
      const pad = NOTE_W + NOTE_GAP + 40; // 메모가 들어갈 자리까지 비워 둠
      const free = (r: Rect): Rect => {
        for (let k = 0; k < 50; k++) {
          const hit = taken.find((t) => r.x < t.x + t.w + pad && t.x < r.x + r.w + pad && r.y < t.y + t.h + 40 && t.y < r.y + r.h + 40);
          if (!hit) return r;
          r = { ...r, x: hit.x + hit.w + pad };
        }
        return r;
      };
      for (const it of missing) {
        const s = sizeOf(it);
        let r: Rect;
        if (it.at) r = { x: it.at.x - s.w / 2, y: it.at.y - s.h / 2, ...s };
        else {
          const right = Math.max(-Infinity, ...taken.map((t) => t.x + t.w));
          r = { x: Number.isFinite(right) ? right + pad : -s.w / 2, y: -s.h / 2, ...s };
        }
        r = free(r);
        next[it.id] = { x: r.x, y: r.y };
        taken.push(r);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.items]);
  const posOf = (id: string): Pt => moved[id] ?? home[id] ?? { x: 0, y: 0 };
  const placed = p.items.filter((it) => home[it.id]);
  const rectOf = (it: Item): Rect => ({ ...posOf(it.id), ...sizeOf(it) });

  // ---------- 되돌리기 ----------
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  const [, bump] = useState(0);
  const snapshot = (): Snap => ({ moved, traceOn, showLines, off, removed });
  const record = (s: Snap = snapshot()) => {
    past.current.push(s);
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    bump((n) => n + 1);
  };
  const restore = (s: Snap) => {
    setMoved(s.moved);
    setTraceOn(s.traceOn);
    setShowLines(s.showLines);
    setOff(s.off);
    setRemoved(s.removed);
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

  // ---------- 메모 (그림마다) ----------
  const isOn = (id: string) => showLines && !off[id];
  const notesOf = (l: Link) => [...(l.feedback?.issues ?? []), ...l.extras.filter((x) => !x.pending)].filter((x) => !removed.includes(x.id));
  const doneLinks = p.links.filter((l) => l.status === 'done' && l.feedback && l.prepared && placed.some((it) => it.id === l.drawingId));
  const allNotes = doneLinks.flatMap((l) => notesOf(l).map((it) => ({ it, link: l })));
  const partsByDrawing = useMemo(() => {
    const out: Record<string, Part[]> = {};
    for (const l of doneLinks) {
      const dr = p.items.find((x) => x.id === l.drawingId)!;
      const { w: CW, h: CH } = sizeOf(dr);
      const base = notesOf(l).map((it, i) => {
        const ring = ringOf(it, CW, CH, 14, it.piece ? 56 : 40);
        return { it, n: i + 1, L: ring.cx < CW / 2, cx: ring.cx, cy: ring.cy, r: ring.r, custom: !!it.piece };
      });
      const ny = new Array<number>(base.length);
      for (const side of [true, false]) {
        const idx = base.map((b, i) => (b.L === side ? i : -1)).filter((i) => i >= 0);
        const ys = stack(idx.map((i) => ({ y: base[i].cy - 15, h: heights[base[i].it.id] ?? NOTE_H })), 10, -20, CH + 20);
        idx.forEach((i, k) => (ny[i] = ys[k]));
      }
      out[l.drawingId] = base.map((b, i) => ({ ...b, ny: ny[i], h: heights[b.it.id] ?? NOTE_H }));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneLinks.map((l) => `${l.id}:${notesOf(l).map((x) => x.id).join(',')}`).join('|'), heights, p.items]);

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
    if (!placed.length) return camFor(0, 0, 1);
    const boxes = placed.map((it) => {
      const pos = posOf(it.id), s = sizeOf(it), parts = partsByDrawing[it.id];
      const side = parts?.length ? NOTE_W + NOTE_GAP : 0;
      const top = Math.min(0, ...(parts ?? []).map((q) => q.ny));
      const bottom = Math.max(s.h, ...(parts ?? []).map((q) => q.ny + q.h));
      return [pos.x - side, pos.y + top - 40, pos.x + s.w + side, pos.y + bottom];
    });
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

  // 카드가 늘거나 줄 때, 첨삭 결과가 올 때 전체 보기
  const layoutKey = placed.map((it) => `${it.id}:${it.kind}:${Math.round(sizeOf(it).w)}`).join('|') + '#' + doneLinks.map((l) => l.id).join(',');
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (fittedFor.current === layoutKey) return;
    if (allNotes.length && Object.keys(heights).length === 0) return; // 메모 높이를 잰 다음
    const first = fittedFor.current === null;
    fittedFor.current = layoutKey;
    if (first) {
      cam.current = fit();
      applyCam();
    } else flyTo(fit());
  });
  useEffect(() => {
    const onResize = () => applyCam();
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  });

  const toWorld = (e: { clientX: number; clientY: number }): Pt => {
    const r = stageRef.current!.getBoundingClientRect(), c = cam.current;
    return { x: (e.clientX - r.left - c.x) / c.z, y: (e.clientY - r.top - c.y) / c.z };
  };
  const cardAt = (w: Pt, margin = 0) =>
    [...placed].reverse().find((it) => {
      const r = rectOf(it);
      return w.x > r.x - margin && w.x < r.x + r.w + margin && w.y > r.y - margin && w.y < r.y + r.h + margin;
    });

  // ---------- 메모 선택 ----------
  const findPart = (id: string) => {
    for (const [drawingId, parts] of Object.entries(partsByDrawing)) {
      const q = parts.find((x) => x.it.id === id);
      if (q) return { q, drawingId };
    }
    return null;
  };
  const selectNote = (id: string, fly: boolean) => {
    const f = findPart(id);
    if (!f) return;
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
      const dr = p.items.find((x) => x.id === f.drawingId)!;
      const pos = posOf(dr.id), CW = sizeOf(dr).w, q = f.q;
      const nx = q.L ? -NOTE_GAP - NOTE_W / 2 : CW + NOTE_GAP + NOTE_W / 2;
      flyTo(camFor(pos.x + (q.cx + nx) / 2, pos.y + (q.cy + q.ny + 40) / 2, Math.max(cam.current.z, 2.2)));
    }
  };
  const deleteNote = (id: string) => {
    const i = allNotes.findIndex((x) => x.it.id === id);
    if (i < 0) return;
    record();
    const next = allNotes[i + 1] ?? allNotes[i - 1];
    setRemoved([...removed, id]);
    setSelected(next ? next.it.id : null);
    say('메모를 지웠어요 · Ctrl+Z로 되돌리기');
  };
  const toggleNote = (id: string) => {
    record();
    setOff({ ...off, [id]: !off[id] });
  };
  const toggleTrace = (it: Item) => {
    if (!it.out) return say('아직 선화를 따는 중이에요');
    record();
    const on = !traceOn[it.id];
    setTraceOn({ ...traceOn, [it.id]: on });
    if (!on && sel?.photoId === it.id) setSel(null);
    say(on ? '트레이싱 켰어요 · 오른쪽 클릭으로 끄기' : '트레이싱 껐어요');
  };

  // ---------- 포인터 ----------
  type Gesture =
    | { type: 'pan'; sx: number; sy: number; ox: number; oy: number; t: number; empty: boolean }
    | { type: 'card'; id: string; sx: number; sy: number; start: Pt; snap: Snap }
    | { type: 'lasso'; photoId: string; pts: Pt[] }
    | { type: 'snip'; photoId: string }
    | { type: 'link'; photoId: string };
  const gesture = useRef<Gesture | null>(null);

  const photoPt = (photoId: string, e: { clientX: number; clientY: number }): Pt => {
    const el = document.querySelector(`[data-paper="${photoId}"]`)!;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  /** 이 사진과 첨삭이 끝난 연결 (올가미에 필요) */
  const photoDone = (photoId: string) => doneLinks.filter((l) => l.photoId === photoId);

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    const t = e.target as Element;
    setMenu(null);
    if (t.closest('.note, button, input, a, label.bar__range, .ctx')) return;
    if (e.button === 2) return;
    setSettingsOpen(false);
    const panMode = e.button === 1 || tool === 'hand' || spaceDown;
    stageRef.current!.setPointerCapture(e.pointerId);
    cancelAnimationFrame(anim.current);
    const w = toWorld(e);
    if (!panMode) {
      const lbl = t.closest<HTMLElement>('[data-drag]');
      if (lbl) {
        const id = lbl.dataset.drag!;
        gesture.current = { type: 'card', id, sx: w.x, sy: w.y, start: posOf(id), snap: snapshot() };
        setPicked(id);
        return;
      }
      const port = t.closest<HTMLElement>('[data-port]');
      if (port) {
        gesture.current = { type: 'link', photoId: port.dataset.port! };
        setLinking({ photoId: port.dataset.port!, to: w });
        return;
      }
      const paper = t.closest<HTMLElement>('[data-paper]');
      const it = paper && p.items.find((x) => x.id === paper.dataset.paper);
      if (it && it.kind === 'photo') {
        // 트레이싱이 켜져 있고 첨삭이 끝난 사진이면 올가미, 아니면 그림으로 끌어 연결
        if (traceOn[it.id] && it.out && photoDone(it.id).length) {
          const pt = photoPt(it.id, e);
          if (sel?.photoId === it.id && inPoly(pt, sel.poly)) {
            gesture.current = { type: 'snip', photoId: it.id };
            setGhost(w);
            return;
          }
          gesture.current = { type: 'lasso', photoId: it.id, pts: [pt] };
          setSel(null);
          setLasso({ photoId: it.id, pts: [pt] });
          return;
        }
        gesture.current = { type: 'link', photoId: it.id };
        setLinking({ photoId: it.id, to: w });
        return;
      }
    }
    // 카드 밖 빈 곳이면, 움직이지 않고 떼었을 때 메뉴를 띄운다
    const empty = !t.closest('.paper, .empty-hint, .link-badge');
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
      setMoved((m) => ({ ...m, [g.id]: { x: g.start.x + w.x - g.sx, y: g.start.y + w.y - g.sy } }));
    } else if (g.type === 'lasso') {
      const pt = photoPt(g.photoId, e), last = g.pts[g.pts.length - 1];
      const it = p.items.find((x) => x.id === g.photoId)!;
      const s = sizeOf(it);
      if (Math.hypot((pt.x - last.x) * s.w, (pt.y - last.y) * s.h) * cam.current.z > 3) {
        g.pts.push(pt);
        setLasso({ photoId: g.photoId, pts: g.pts.slice() });
      }
    } else if (g.type === 'snip') setGhost(toWorld(e));
    else if (g.type === 'link') setLinking({ photoId: g.photoId, to: toWorld(e) });
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    setPanning(false);
    const w = toWorld(e);
    if (g.type === 'pan') {
      const still = Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 4 && performance.now() - g.t < 500;
      if (still && g.empty && e.type === 'pointerup' && tool === 'select' && !spaceDown && e.button === 0) {
        const r = stageRef.current!.getBoundingClientRect();
        // 화면 밖으로 나가지 않게
        setMenu({ x: Math.min(e.clientX - r.left, r.width - 220), y: Math.min(e.clientY - r.top, r.height - 160), world: w });
      }
    } else if (g.type === 'card') {
      setPicked(null);
      const now = posOf(g.id);
      if (Math.hypot(now.x - g.start.x, now.y - g.start.y) > 1) record(g.snap);
    } else if (g.type === 'lasso') {
      const it = p.items.find((x) => x.id === g.photoId)!;
      const s = sizeOf(it), b = bounds(g.pts);
      const ok = g.pts.length >= 5 && b.w * s.w * b.h * s.h > 300;
      setLasso(null);
      setSel(ok ? { photoId: g.photoId, poly: g.pts } : null);
      if (ok) say('고른 부분을 연결된 그림 위로 끌어다 놓으세요');
    } else if (g.type === 'snip') {
      setGhost(null);
      const target = cardAt(w, 60);
      const link = target && photoDone(g.photoId).find((l) => l.drawingId === target.id);
      if (e.type === 'pointerup' && sel && target && link?.prepared) {
        const ph = p.items.find((x) => x.id === g.photoId)!;
        const poly = sel.poly.map((q) => toCropped(q, ph.out!, link.prepared!.refRect));
        const r = rectOf(target);
        p.onDropPiece(link.id, { poly, ...bounds(poly) }, { x: ((w.x - r.x) / r.w) * 100, y: ((w.y - r.y) / r.h) * 100 });
        setSel(null);
      } else if (e.type === 'pointerup' && target && !link) say('이 사진과 연결해서 첨삭한 그림 위에 놓아 주세요');
    } else if (g.type === 'link') {
      setLinking(null);
      const target = cardAt(w, 20);
      if (e.type !== 'pointerup' || !target || target.id === g.photoId) return;
      if (target.kind === 'drawing') {
        p.onLink(g.photoId, target.id);
        say('연결했어요 · 첨삭을 시작해요');
      } else say('그림 카드 위에 놓아야 연결돼요');
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
      setSel(null);
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

  const pasteFromClipboard = async (at?: Pt) => {
    setMenu(null);
    try {
      const its = await navigator.clipboard.read();
      const files: File[] = [];
      for (const it of its) {
        const type = it.types.find((x) => x.startsWith('image/'));
        if (type) files.push(new File([await it.getType(type)], `pasted.${type.split('/')[1]}`, { type }));
      }
      if (files.length) p.onFiles(files, at);
      else say('클립보드에 이미지가 없어요');
    } catch {
      say('브라우저가 클립보드 읽기를 막았어요 · Ctrl+V로 붙여넣어 주세요');
    }
  };

  // 파일 끌어다 놓기 (화면 어디든, 놓은 자리에 카드가 생김)
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
      if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) setDragFiles(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragFiles(false);
      const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
      if (files.length) p.onFiles(files, toWorld(e));
      else say('이미지 파일만 올릴 수 있어요');
    },
  };

  // ---------- 그리기 ----------
  const today = new Date();
  const dateLabel = `${today.getMonth() + 1}월 ${today.getDate()}일`;
  const stageClass = ['stage', deep ? 'deep' : '', panning ? 'panning' : tool === 'hand' || spaceDown ? 'hand' : ''].join(' ');
  const photos = placed.filter((x) => x.kind === 'photo');
  const drawings = placed.filter((x) => x.kind === 'drawing');
  const nameOf = (it: Item) => {
    if (it.kind === 'photo') return photos.length > 1 ? `사진 ${photos.indexOf(it) + 1}` : '사진';
    if (it.kind === 'drawing') return drawings.length > 1 ? `그림 ${drawings.indexOf(it) + 1}` : '내 크로키';
    return '판별 중…';
  };
  const working = (text: string) => (
    <div className="working">
      <span className="spinner" />
      {text}
    </div>
  );
  const ai = p.settings.extract === 'ai';
  const needLink = photos.some((x) => x.out) && drawings.some((x) => x.out) && !p.links.length;
  const anyNotes = doneLinks.length > 0;

  return (
    <div className="ws" {...dropProps}>
      <div ref={stageRef} className={stageClass} aria-label="크로키 첨삭 캔버스" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onContextMenu={(e) => e.preventDefault()}>
        <div ref={worldRef} className="world">
          {!placed.length && (
            <div className="empty-hint" style={{ left: -360, top: -80, width: 720 }}>
              <p className="hand-note">사진과 내 크로키를 올려 주세요!</p>
              <p>파일을 화면에 끌어다 놓거나, 빈 곳을 클릭해서 올려요. 사진인지 그림인지는 올린 다음에 알아서 나눠요.</p>
              <p>그다음 사진에서 그림으로 끌어 화살표로 이으면 첨삭을 시작해요.</p>
            </div>
          )}

          {/* 연결 화살표 */}
          <svg className="links" aria-hidden="true">
            <defs>
              <marker id="arrow-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#d3263e" />
              </marker>
            </defs>
            {p.links.map((l) => {
              const a = placed.find((x) => x.id === l.photoId), b = placed.find((x) => x.id === l.drawingId);
              if (!a || !b) return null;
              return <path key={l.id} d={arrowPath(rectOf(a), { x: 0, y: 0 }, rectOf(b)).d} className={`link link--${l.status}`} markerEnd="url(#arrow-head)" />;
            })}
            {linking &&
              (() => {
                const a = placed.find((x) => x.id === linking.photoId);
                if (!a) return null;
                const over = cardAt(linking.to, 20);
                const b = over && over.kind === 'drawing' ? rectOf(over) : undefined;
                return <path d={arrowPath(rectOf(a), linking.to, b).d} className="link link--draft" markerEnd="url(#arrow-head)" />;
              })()}
          </svg>
          {p.links.map((l) => {
            const a = placed.find((x) => x.id === l.photoId), b = placed.find((x) => x.id === l.drawingId);
            if (!a || !b) return null;
            const { mid } = arrowPath(rectOf(a), { x: 0, y: 0 }, rectOf(b));
            const label = { waiting: a.busy || b.busy ? '선 따는 중 · 기다려요' : '첨삭 대기', running: '첨삭 중…', done: '첨삭 완료', error: '첨삭 실패' }[l.status];
            return (
              <div key={l.id} className={`link-badge link-badge--${l.status}`} style={{ left: mid.x, top: mid.y }} title={l.error}>
                {l.status === 'running' && <span className="spinner" />}
                <span>{label}</span>
                {(l.status === 'done' || l.status === 'error') && (
                  <button type="button" onClick={() => p.onRetry(l.id)} aria-label="다시 첨삭" title="다시 첨삭">
                    ↻
                  </button>
                )}
                <button type="button" onClick={() => p.onUnlink(l.id)} aria-label="연결 끊기" title="연결 끊기">
                  ✕
                </button>
              </div>
            );
          })}

          {placed.map((it) => {
            const pos = posOf(it.id), s = sizeOf(it);
            const link = it.kind === 'drawing' ? linkOf(it.id) : undefined;
            const done = it.kind === 'drawing' ? doneLinkOf(it.id) : undefined;
            const parts = partsByDrawing[it.id] ?? [];
            const tracing = it.kind === 'photo' && !!traceOn[it.id] && !!it.out;
            const canLasso = tracing && photoDone(it.id).length > 0;
            const selHere = sel?.photoId === it.id ? sel.poly : null;
            const lassoHere = lasso?.photoId === it.id ? lasso.pts : selHere;
            const issues = done ? notesOf(done).filter((x) => isOn(x.id)) : [];
            const pend = done ? done.extras.filter((x) => x.pending) : [];
            const target = !!linking && linking.photoId !== it.id && it.kind === 'drawing';
            return (
              <div key={it.id} className={['sheet-card', picked === it.id ? 'picked' : '', target ? 'link-target' : ''].join(' ')} style={{ left: pos.x, top: pos.y }}>
                <div className="label" data-drag={it.id}>
                  <b>{nameOf(it)}</b>
                  {it.kind === 'photo' && it.out && <span>{tracing ? `· 트레이싱 켜짐${canLasso ? ' · 드래그로 올가미' : ''}` : '· 그림으로 끌어 연결'}</span>}
                  {it.kind === 'drawing' && (
                    <span>
                      · {p.settings.time} · {dateLabel}
                    </span>
                  )}
                  {it.kind && (
                    <span className="label__actions">
                      <button type="button" onClick={() => p.onSetKind(it.id, it.kind === 'photo' ? 'drawing' : 'photo')}>
                        {it.kind === 'photo' ? '그림이에요' : '사진이에요'}
                      </button>
                      <button type="button" onClick={() => p.onRemove(it.id)}>
                        빼기
                      </button>
                    </span>
                  )}
                </div>
                <div
                  className={['paper', it.kind === 'photo' ? (canLasso ? 'lassoable' : 'linkable') : '', selHere ? 'has-sel' : ''].join(' ')}
                  data-paper={it.id}
                  style={{ width: s.w, height: s.h }}
                  title={it.kind === 'photo' && it.out ? '오른쪽 클릭: 트레이싱 켜기/끄기' : undefined}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (it.kind === 'photo') toggleTrace(it);
                  }}
                >
                  {it.kind === 'photo' ? (
                    <>
                      <img src={it.raw.url} alt="원본 참고 사진" draggable={false} style={tracing ? { opacity: 0.22 } : undefined} />
                      {tracing && <img src={it.out!.url} alt="사진에서 딴 기준 선화" draggable={false} style={{ mixBlendMode: 'multiply' }} />}
                      {selHere && it.red && <img src={it.red} alt="" draggable={false} style={{ clipPath: clipPoly(selHere) }} />}
                      {lassoHere && (
                        <svg className="lasso" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                          <polygon points={lassoHere.map((q) => `${q.x},${q.y}`).join(' ')} />
                        </svg>
                      )}
                      {it.busy && working(ai ? 'AI가 선화를 따는 중… (수십 초)' : '선화를 따는 중…')}
                    </>
                  ) : it.kind === 'drawing' ? (
                    <>
                      <img src={shown(it).url} alt="내 크로키" draggable={false} style={it.out ? undefined : { opacity: 0.3 }} />
                      {done && (
                        <>
                          <CorrectionLayer issues={issues.filter((x) => !x.piece)} w={s.w} h={s.h} opacity={opacity / 100} />
                          <PieceLayer issues={[...issues.filter((x) => x.piece), ...pend]} redLineArt={done.prepared!.lineArtRed} opacity={opacity / 100} />
                        </>
                      )}
                      {pend.map((x) => {
                        const r = ringOf(x, s.w, s.h, 14, 56);
                        return (
                          <span key={x.id} aria-hidden="true">
                            <span className="ring-pend" style={{ left: r.cx - r.r, top: r.cy - r.r, width: r.r * 2, height: r.r * 2 }} />
                            <span className="pend-text" style={{ left: r.cx, top: r.cy - r.r - 32 }}>
                              분석 중…
                            </span>
                          </span>
                        );
                      })}
                      {it.busy && working(ai ? 'AI가 연필선만 남기는 중… (수십 초)' : '종이를 지우는 중…')}
                      {link?.status === 'running' && working('선생님이 보는 중…')}
                    </>
                  ) : (
                    <>
                      <img src={it.raw.url} alt="올린 이미지" draggable={false} style={{ opacity: 0.4 }} />
                      {working('사진인지 그림인지 보는 중…')}
                    </>
                  )}
                </div>
                {it.kind === 'photo' && it.out && <span className="port" data-port={it.id} title="그림 카드로 끌어서 연결" aria-hidden="true" />}

                {done && (
                  <svg className="leaders" aria-hidden="true">
                    {parts
                      .filter((q) => isOn(q.it.id))
                      .map((q) => {
                        const ax = q.L ? -NOTE_GAP + 2 : s.w + NOTE_GAP - 2, ay = q.ny + 14;
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
                {done &&
                  parts.map((q) => {
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
                        style={{ left: q.L ? -NOTE_GAP - NOTE_W : s.w + NOTE_GAP, top: q.ny, width: NOTE_W }}
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
                            {[100, 72, 94, 58].map((wd, i) => (
                              <i key={i} style={{ width: `${wd}%` }} />
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
            );
          })}

          {ghost &&
            sel &&
            (() => {
              const ph = placed.find((x) => x.id === sel.photoId);
              if (!ph?.red) return null;
              const b = bounds(sel.poly), s = sizeOf(ph);
              const over = cardAt(ghost, 60);
              const ok = over && photoDone(sel.photoId).some((l) => l.drawingId === over.id);
              const r = ok && over ? rectOf(over) : null;
              return (
                <>
                  {r && <div className="drop-hint" style={{ left: r.x - 12, top: r.y - 12, width: r.w + 24, height: r.h + 24 }} />}
                  <div className="ghost" style={{ left: ghost.x - (b.w * s.w) / 2, top: ghost.y - (b.h * s.h) / 2, width: b.w * s.w, height: b.h * s.h }}>
                    <img
                      src={ph.red}
                      alt=""
                      style={{ left: `${(-b.x0 / b.w) * 100}%`, top: `${(-b.y0 / b.h) * 100}%`, width: `${100 / b.w}%`, height: `${100 / b.h}%`, clipPath: clipPoly(sel.poly) }}
                    />
                  </div>
                </>
              );
            })()}
        </div>

        {menu && (
          <div className="ctx" role="menu" style={{ left: menu.x, top: menu.y }}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                p.onUpload(menu.world);
              }}
            >
              <UploadIcon width={18} height={18} />
              파일 업로드…<kbd>U</kbd>
            </button>
            {canReadClipboard && (
              <button type="button" role="menuitem" onClick={() => pasteFromClipboard(menu.world)}>
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
            <span>올린 다음 사진인지 그림인지 알아서 나눠요</span>
          </div>
        </div>
      )}

      <div className="top">
        <div className="logo">
          <PencilIcon width={18} height={18} />
        </div>
        <h1>크로키 선생님</h1>
        <button type="button" className="top__btn" onClick={() => p.onUpload()}>
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
        {settingsOpen && <SettingsPanel settings={p.settings} onChange={p.onSettings} />}
      </div>

      {(p.banner || needLink) && (
        <div className={p.banner ? 'banner' : 'banner banner--hint'} role="status">
          {p.banner ?? '사진 카드에서 그림 카드로 끌어 화살표로 이으면 첨삭을 시작해요.'}
          {p.banner && (
            <button type="button" onClick={p.onDismissBanner} aria-label="알림 닫기">
              ✕
            </button>
          )}
        </div>
      )}

      <div className="top-right">
        <button type="button" className="pill-btn" onClick={p.onKey} aria-label="API 키">
          <KeyIcon />
          <span className="pill-label">API 키</span>
          <span className={p.hasKey ? 'key-dot key-dot--on' : 'key-dot'} aria-label={p.hasKey ? '입력됨' : '없음'} />
        </button>
        {anyNotes && (
          <button type="button" className="pill-btn" aria-expanded={drawer} aria-controls="drawer" onClick={() => setDrawer(!drawer)}>
            <span className="pill-label">노트 정리</span>
            <span className="pill-short" aria-hidden="true">
              노트
            </span>{' '}
            <em>{allNotes.length}</em>
          </button>
        )}
      </div>

      {drawer && anyNotes && (
        <aside className="drawer" id="drawer" aria-label="노트 정리">
          <header>
            <h2>크로키 노트</h2>
            <span>{dateLabel}</span>
          </header>
          <ol>
            {doneLinks.map((l) => {
              const dr = placed.find((x) => x.id === l.drawingId)!;
              const notes = notesOf(l);
              return (
                <li key={l.id} className="group">
                  {doneLinks.length > 1 && <p className="group__title">{nameOf(dr)}</p>}
                  {l.feedback?.pose && <p className="group__pose">{l.feedback.pose}</p>}
                  <ol>
                    {notes.map((it, i) => (
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
                    ))}
                    {!notes.length && <li className="empty">다 지웠어요. 되돌리기로 다시 꺼낼 수 있어요.</li>}
                  </ol>
                  {l.feedback?.good && <p className="good">잘한 점: {l.feedback.good}</p>}
                </li>
              );
            })}
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
        <button type="button" aria-pressed={tool === 'select'} title="이동·연결·올가미 (V)" onClick={() => setTool('select')}>
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
        {anyNotes && (
          <>
            <span className="sep" />
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
        <b>파일 끌어다 놓기</b> 또는 <b>빈 곳 클릭 → 파일 업로드</b>
        <br />
        <b>사진 → 그림</b>으로 끌어 이으면 첨삭 시작
        <br />
        <b>사진 오른쪽 클릭</b> 트레이싱 켜기/끄기
        <br />
        트레이싱 켠 사진 위 <b>드래그</b> 올가미 → 그림으로 끌어 놓기
        <br />
        <b>메모 클릭</b> 확대 · <b>Delete</b> 지우기 · <b>Ctrl+Z</b> 되돌리기
      </div>
      <div className={toast ? 'toast on' : 'toast'} role="status">
        {toast}
      </div>
    </div>
  );
}
