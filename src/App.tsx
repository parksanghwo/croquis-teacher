import { useEffect, useRef, useState } from 'react';
import type { CritiqueSettings, Img, Item, Kind, Link, Piece, Pt } from './types';
import { ApiKeyDialog } from './components/ApiKeyDialog';
import { UploadDialog } from './components/UploadDialog';
import { Workspace } from './screens/Workspace';
import { classifyImage, cleanPaper, crop, cutRegion, inkBounds, loadFile, toInk, traceLineArt, type Rect } from './lib/image';
import { aiLineArt, aiPencilLines, describeError, MissingKeyError, requestCritique, requestRegionCritique } from './lib/ai';
import { getApiKey } from './lib/settings';

/** 클립보드 이벤트에서 이미지 파일 꺼내기 */
function imagesFromPaste(e: ClipboardEvent): File[] {
  const dt = e.clipboardData;
  if (!dt) return [];
  const files = Array.from(dt.files).filter((f) => f.type.startsWith('image/'));
  if (files.length) return files;
  return Array.from(dt.items)
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f);
}

let idSeq = 0;
const newId = (p: string) => `${p}${++idSeq}`;

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [settings, setSettings] = useState<CritiqueSettings>({
    time: '1분',
    focus: ['비례', '관절 각도', '실루엣'],
    excludeHead: true,
    autoAlign: true,
    detailedTone: false,
    extract: 'ai',
  });
  const [keyOpen, setKeyOpen] = useState(false);
  const [upload, setUpload] = useState<{ open: boolean; at?: Pt }>({ open: false });
  const [hasKey, setHasKey] = useState(!!getApiKey());
  const itemSeq = useRef<Record<string, number>>({});
  const running = useRef(new Map<string, AbortController>());
  /** 진행 중인 첨삭을 멈추고 바로 다시 시작할 수 있게 비움 */
  const stop = (linkId: string) => {
    running.current.get(linkId)?.abort();
    running.current.delete(linkId);
  };
  /** 키가 없을 때 키 입력 창은 연결할 때 한 번만 띄움 */
  const keyAsked = useRef(false);

  const patchItem = (id: string, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const patchLink = (id: string, p: Partial<Link> | ((l: Link) => Partial<Link>)) =>
    setLinks((ls) => ls.map((l) => (l.id === id ? { ...l, ...(typeof p === 'function' ? p(l) : p) } : l)));

  /** 그 이미지가 들어간 연결은 다시 첨삭해야 한다 */
  const resetLinksOf = (itemId: string) => {
    setLinks((ls) =>
      ls.map((l) => {
        if (l.photoId !== itemId && l.drawingId !== itemId) return l;
        stop(l.id);
        return { ...l, status: 'waiting', feedback: undefined, prepared: undefined, extras: [], error: undefined };
      }),
    );
  };

  /**
   * 판별된 이미지 처리: 사진 → 기준 선화(프롬프트 1), 그림 → 연필선만(프롬프트 2).
   * AI가 실패하거나 키가 없으면 브라우저 자동 트레이싱. 나중 작업이 먼저 끝나도 꼬이지 않게 순번 확인.
   */
  async function processItem(id: string, kind: Kind, raw: Img, mode = settings.extract) {
    const n = (itemSeq.current[id] = (itemSeq.current[id] ?? 0) + 1);
    const stale = () => itemSeq.current[id] !== n;
    patchItem(id, { kind, out: null, red: null, busy: true });
    const local = () => (kind === 'photo' ? traceLineArt(raw) : cleanPaper(raw));
    let out: Img;
    let source: 'ai' | 'local' = 'local';
    try {
      if (mode === 'ai' && getApiKey()) {
        try {
          out = kind === 'photo' ? await aiLineArt(raw) : await aiPencilLines(raw);
          source = 'ai';
        } catch (e) {
          if (stale()) return;
          setBanner(`AI ${kind === 'photo' ? '선화' : '연필선'} 추출에 실패해서 자동 트레이싱으로 대신했어요. (${describeError(e)})`);
          out = await local();
        }
      } else {
        if (mode === 'ai') setBanner('API 키가 없어서 자동 트레이싱으로 선을 땄어요. 키를 넣은 뒤 다시 올리면 AI로 추출해요.');
        out = await local();
      }
      const red = kind === 'photo' ? await toInk(out, [211, 38, 62]) : null;
      if (stale()) return;
      patchItem(id, { out, red, source, busy: false });
    } catch (e) {
      if (stale()) return;
      patchItem(id, { busy: false });
      setBanner(describeError(e));
    }
  }

  /** 올린 이미지는 일단 같은 카드로 책상에 놓고, 그다음 사진인지 그림인지 판별해서 처리 */
  async function onFiles(files: File[], at?: Pt) {
    setBanner(null);
    for (const [i, f] of files.entries()) {
      const id = newId('img');
      try {
        const raw = await loadFile(f);
        const pos = at ? { x: at.x + i * 40, y: at.y + i * 40 } : undefined;
        setItems((xs) => [...xs, { id, raw, kind: null, out: null, red: null, busy: true, at: pos }]);
        const kind = await classifyImage(raw);
        void processItem(id, kind, raw);
      } catch (e) {
        setItems((xs) => xs.filter((x) => x.id !== id));
        setBanner(describeError(e));
      }
    }
  }

  /** 판별이 틀렸을 때: 사진 ↔ 그림 */
  function onSetKind(id: string, kind: Kind) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    setLinks((ls) => ls.filter((l) => l.photoId !== id && l.drawingId !== id));
    void processItem(id, kind, it.raw);
  }

  function onRemove(id: string) {
    itemSeq.current[id] = (itemSeq.current[id] ?? 0) + 1;
    setLinks((ls) => {
      ls.filter((l) => l.photoId === id || l.drawingId === id).forEach((l) => stop(l.id));
      return ls.filter((l) => l.photoId !== id && l.drawingId !== id);
    });
    setItems((xs) => xs.filter((x) => x.id !== id));
  }

  /** 사진에서 그림으로 끌어 연결 → 첨삭 대기 (그림 하나엔 사진 하나만) */
  function onLink(photoId: string, drawingId: string) {
    setLinks((ls) => {
      const same = ls.find((l) => l.photoId === photoId && l.drawingId === drawingId);
      if (same) return ls;
      ls.filter((l) => l.drawingId === drawingId).forEach((l) => stop(l.id));
      keyAsked.current = false;
      return [...ls.filter((l) => l.drawingId !== drawingId), { id: newId('link'), photoId, drawingId, status: 'waiting', extras: [] }];
    });
  }
  function onUnlink(linkId: string) {
    stop(linkId);
    setLinks((ls) => ls.filter((l) => l.id !== linkId));
  }
  function onRetry(linkId: string) {
    stop(linkId);
    patchLink(linkId, { status: 'waiting', feedback: undefined, prepared: undefined, extras: [], error: undefined });
  }

  /** 3번 프롬프트: 기준 선화 A와 학생 크로키 B로 첨삭 */
  async function runCritique(link: Link) {
    const photo = items.find((x) => x.id === link.photoId), drawing = items.find((x) => x.id === link.drawingId);
    if (!photo?.out || !drawing?.out || running.current.has(link.id)) return;
    const ctrl = new AbortController();
    running.current.set(link.id, ctrl);
    patchLink(link.id, { status: 'running', error: undefined });
    try {
      let lineArt = photo.out, croquis = drawing.out;
      let refRect: Rect | null = null;
      if (settings.autoAlign) {
        refRect = await inkBounds(photo.out);
        lineArt = await crop(photo.out, refRect);
        croquis = await crop(drawing.out, await inkBounds(drawing.out));
      }
      const fb = await requestCritique({ lineArt, croquis }, settings, ctrl.signal);
      if (ctrl.signal.aborted) return;
      const lineArtRed = await toInk(lineArt, [211, 38, 62]);
      // 메모 id가 연결끼리 겹치지 않게
      const feedback = { ...fb, issues: fb.issues.map((it) => ({ ...it, id: `${link.id}:${it.id}` })) };
      patchLink(link.id, { status: 'done', feedback, prepared: { lineArt, croquis, lineArtRed, refRect }, extras: [] });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      if (e instanceof MissingKeyError) {
        patchLink(link.id, { status: 'waiting' });
        setKeyOpen(true);
        return;
      }
      patchLink(link.id, { status: 'error', error: describeError(e) });
      setBanner(`첨삭하지 못했어요. ${describeError(e)}`);
    } finally {
      if (running.current.get(link.id) === ctrl) running.current.delete(link.id);
    }
  }

  // 연결됐고 두 이미지가 준비되면 첨삭 시작 (키가 없으면 키부터)
  const runRef = useRef(runCritique);
  runRef.current = runCritique;
  useEffect(() => {
    for (const l of links) {
      if (l.status !== 'waiting' || running.current.has(l.id)) continue;
      const ph = items.find((x) => x.id === l.photoId), dr = items.find((x) => x.id === l.drawingId);
      if (!ph?.out || !dr?.out || ph.busy || dr.busy) continue;
      if (!getApiKey()) {
        if (!keyAsked.current) {
          keyAsked.current = true;
          setKeyOpen(true);
          setBanner('API 키를 넣으면 연결한 사진과 그림으로 첨삭을 시작해요.');
        }
        continue;
      }
      void runRef.current(l);
    }
  }, [links, items, hasKey]);

  /** 올가미로 고른 기준 선화 조각을 그림 위에 놓으면, 그 부위만 따로 첨삭 */
  async function onDropPiece(linkId: string, piece: Piece, at: Pt) {
    const link = links.find((l) => l.id === linkId);
    if (!link?.prepared) return;
    const prep = link.prepared;
    const id = `${linkId}:pick-${newId('')}`;
    patchLink(linkId, (l) => ({ extras: [...l.extras, { id, name: '', fix: '', why: '', how: '', x: at.x, y: at.y, strokes: [], piece, pending: true }] }));
    try {
      const region = await cutRegion(prep.lineArt, piece.poly, piece);
      const r = await requestRegionCritique({ lineArt: prep.lineArt, region, croquis: prep.croquis }, { x: at.x, y: at.y, w: piece.w * 100, h: piece.h * 100 }, settings);
      patchLink(linkId, (l) => ({ extras: l.extras.map((x) => (x.id === id ? { ...x, ...r, pending: false } : x)) }));
    } catch (e) {
      patchLink(linkId, (l) => ({ extras: l.extras.filter((x) => x.id !== id) }));
      if (e instanceof MissingKeyError) setKeyOpen(true);
      setBanner(`고른 부분을 첨삭하지 못했어요. ${describeError(e)}`);
    }
  }

  function onSettings(next: CritiqueSettings) {
    // 추출 방식을 바꾸면 올린 이미지를 다시 추출하고, 첨삭도 다시
    if (next.extract !== settings.extract) {
      for (const it of items) {
        if (!it.kind) continue;
        resetLinksOf(it.id);
        void processItem(it.id, it.kind, it.raw, next.extract);
      }
    }
    setSettings(next);
  }

  // Ctrl/⌘+V 붙여넣기 (글자 입력 중이거나 키 입력 창이 떠 있으면 건드리지 않음)
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, [contenteditable="true"]') || document.querySelector('dialog[open]:not(.dialog--wide)')) return;
      const files = imagesFromPaste(e);
      if (!files.length) return;
      e.preventDefault();
      setUpload({ open: false });
      void onFilesRef.current(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  return (
    <>
      <Workspace
        items={items}
        links={links}
        banner={banner}
        settings={settings}
        hasKey={hasKey}
        onSettings={onSettings}
        onUpload={(at) => setUpload({ open: true, at })}
        onFiles={(f, at) => void onFiles(f, at)}
        onSetKind={onSetKind}
        onRemove={onRemove}
        onLink={onLink}
        onUnlink={onUnlink}
        onRetry={onRetry}
        onDropPiece={onDropPiece}
        onDismissBanner={() => setBanner(null)}
        onKey={() => setKeyOpen(true)}
      />

      <UploadDialog open={upload.open} onFiles={(f) => void onFiles(f, upload.at)} onClose={() => setUpload({ open: false })} />

      <ApiKeyDialog
        open={keyOpen}
        onClose={() => {
          setKeyOpen(false);
          setHasKey(!!getApiKey());
        }}
      />
    </>
  );
}
