import { useEffect, useRef, useState } from 'react';
import type { CritiqueSettings, Feedback, Img, Issue, Piece, Pt } from './types';
import { ApiKeyDialog } from './components/ApiKeyDialog';
import { UploadDialog } from './components/UploadDialog';
import { Workspace, type Kind } from './screens/Workspace';
import { classifyImage, cleanPaper, crop, cutRegion, inkBounds, loadFile, toInk, traceLineArt } from './lib/image';
import { aiLineArt, aiPencilLines, describeError, MissingKeyError, requestCritique, requestRegionCritique } from './lib/ai';
import { getApiKey } from './lib/settings';

/** 첨삭에 쓴, 정렬된 이미지들 */
interface Prepared {
  photo: Img;
  lineArt: Img;
  croquis: Img;
  aligned: boolean;
  lineArtRed: string;
}

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

export default function App() {
  const [photo, setPhoto] = useState<Img | null>(null);
  const [lineArt, setLineArt] = useState<Img | null>(null);
  /** 보정 전 크로키 원본 (추출 방식을 바꾸거나 사진↔그림을 바꾸면 다시 추출) */
  const [croquisRaw, setCroquisRaw] = useState<Img | null>(null);
  const [croquis, setCroquis] = useState<Img | null>(null);
  const [lineArtRed, setLineArtRed] = useState<string | null>(null);
  const [source, setSource] = useState<{ lineArt?: 'ai' | 'local'; croquis?: 'ai' | 'local' }>({});
  const [busy, setBusy] = useState<{ photo?: boolean; croquis?: boolean; critique?: boolean }>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [settings, setSettings] = useState<CritiqueSettings>({
    time: '1분',
    focus: ['비례', '관절 각도', '실루엣'],
    excludeHead: true,
    autoAlign: true,
    detailedTone: false,
    extract: 'ai',
  });
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [extras, setExtras] = useState<Issue[]>([]);
  const [regionError, setRegionError] = useState<string | null>(null);
  const extraSeq = useRef(0);
  const seq = useRef({ photo: 0, croquis: 0 });
  const [keyOpen, setKeyOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [hasKey, setHasKey] = useState(!!getApiKey());
  const pendingStart = useRef(false);
  const abort = useRef<AbortController | null>(null);

  // 올가미 강조용 빨간 기준 선화
  useEffect(() => {
    let alive = true;
    setLineArtRed(null);
    if (lineArt) toInk(lineArt, [211, 38, 62]).then((u) => alive && setLineArtRed(u));
    return () => {
      alive = false;
    };
  }, [lineArt]);

  /** 이미지가 바뀌면 이전 첨삭은 더 이상 맞지 않으니 지운다 */
  const clearCritique = () => {
    abort.current?.abort();
    if (feedback) setBanner('이미지가 바뀌어서 이전 첨삭을 지웠어요. 다시 첨삭해 주세요.');
    setFeedback(null);
    setPrepared(null);
    setExtras([]);
    setRegionError(null);
  };

  /**
   * 선화 추출: AI(프롬프트 1·2, 이미지 모델) → 실패하거나 키가 없으면 브라우저 자동 트레이싱.
   * 나중에 들어온 이미지가 먼저 끝나도 꼬이지 않게 순번으로 확인한다.
   */
  async function extract(kind: 'photo' | 'croquis', src: Img, mode = settings.extract) {
    const n = ++seq.current[kind];
    const local = () => (kind === 'photo' ? traceLineArt(src) : cleanPaper(src));
    setBusy((b) => ({ ...b, [kind]: true }));
    try {
      let out: Img;
      let from: 'ai' | 'local' = 'local';
      if (mode === 'ai' && getApiKey()) {
        try {
          out = kind === 'photo' ? await aiLineArt(src) : await aiPencilLines(src);
          from = 'ai';
        } catch (e) {
          if (n !== seq.current[kind]) return;
          setBanner(`AI ${kind === 'photo' ? '선화' : '연필선'} 추출에 실패해서 자동 트레이싱으로 대신했어요. (${describeError(e)})`);
          out = await local();
        }
      } else {
        if (mode === 'ai') setBanner('API 키가 없어서 자동 트레이싱으로 선을 땄어요. 키를 넣은 뒤 다시 올리면 AI로 추출해요.');
        out = await local();
      }
      if (n !== seq.current[kind]) return;
      if (kind === 'photo') setLineArt(out);
      else setCroquis(out);
      setSource((s) => ({ ...s, [kind === 'photo' ? 'lineArt' : 'croquis']: from }));
    } catch (e) {
      if (n === seq.current[kind]) setBanner(describeError(e));
    } finally {
      if (n === seq.current[kind]) setBusy((b) => ({ ...b, [kind]: false }));
    }
  }

  /** 사진은 원본 사진 칸에, 그림은 내 크로키 칸에 */
  function place(kind: Kind, img: Img | null) {
    if (kind === 'photo') {
      seq.current.photo++;
      setPhoto(img);
      setLineArt(null);
      setBusy((b) => ({ ...b, photo: false }));
      if (img) void extract('photo', img);
    } else {
      seq.current.croquis++;
      setCroquisRaw(img);
      setCroquis(null);
      setBusy((b) => ({ ...b, croquis: false }));
      if (img) void extract('croquis', img);
    }
  }

  /** 올라온 이미지를 사진/그림으로 자동 구분해서 넣는다 */
  async function onFiles(files: File[]) {
    setBanner(null);
    let changed = false;
    for (const f of files) {
      try {
        const img = await loadFile(f);
        const kind = await classifyImage(img);
        if (!changed) clearCritique();
        changed = true;
        place(kind, img);
        setBanner(kind === 'photo' ? '참고 사진으로 올렸어요. 그림이라면 카드 위 "그림이에요"를 눌러 주세요.' : '내 크로키로 올렸어요. 사진이라면 카드 위 "사진이에요"를 눌러 주세요.');
      } catch (e) {
        setBanner(describeError(e));
      }
    }
  }

  /** 자동 구분이 틀렸을 때: 사진 ↔ 그림 자리를 바꾼다 */
  function onSwap() {
    const a = photo, b = croquisRaw;
    clearCritique();
    place('photo', b);
    place('drawing', a);
    setBanner(null);
  }

  function onRemove(kind: Kind) {
    clearCritique();
    place(kind, null);
  }

  function onSettings(next: CritiqueSettings) {
    // 추출 방식을 바꾸면 이미 올린 이미지도 다시 추출
    if (next.extract !== settings.extract) {
      setBanner(null);
      if (photo) void extract('photo', photo, next.extract);
      if (croquisRaw) void extract('croquis', croquisRaw, next.extract);
      clearCritique();
    }
    setSettings(next);
  }

  // Ctrl/⌘+V 붙여넣기 (글자 입력 중이거나 다른 창이 떠 있으면 건드리지 않음)
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, [contenteditable="true"]') || document.querySelector('dialog[open]:not(.dialog--wide)')) return;
      const files = imagesFromPaste(e);
      if (!files.length) return;
      e.preventDefault();
      setUploadOpen(false);
      void onFilesRef.current(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  async function start() {
    if (!photo || !lineArt || !croquis) return;
    if (!getApiKey()) {
      pendingStart.current = true;
      setKeyOpen(true);
      return;
    }
    setBanner(null);
    setBusy((b) => ({ ...b, critique: true }));
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      let imgs = { photo, lineArt, croquis };
      if (settings.autoAlign) {
        const refRect = await inkBounds(lineArt);
        imgs = {
          photo: await crop(photo, refRect),
          lineArt: await crop(lineArt, refRect),
          croquis: await crop(croquis, await inkBounds(croquis)),
        };
      }
      // 3번 프롬프트: 기준 선화 A와 학생 크로키 B만 보낸다
      const fb = await requestCritique({ lineArt: imgs.lineArt, croquis: imgs.croquis }, settings, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setPrepared({ ...imgs, aligned: settings.autoAlign, lineArtRed: await toInk(imgs.lineArt, [211, 38, 62]) });
      setExtras([]);
      setRegionError(null);
      setFeedback(fb);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      if (e instanceof MissingKeyError) setKeyOpen(true);
      setBanner(describeError(e));
    } finally {
      if (abort.current === ctrl) abort.current = null;
      setBusy((b) => ({ ...b, critique: false }));
    }
  }

  /** 올가미로 고른 기준 선화 조각을 크로키 위에 놓으면, 그 부위만 따로 첨삭 받는다 */
  async function onDropPiece(piece: Piece, at: Pt) {
    if (!prepared) return;
    const id = `pick-${++extraSeq.current}`;
    setRegionError(null);
    setExtras((xs) => [...xs, { id, name: '', fix: '', why: '', how: '', x: at.x, y: at.y, strokes: [], piece, pending: true }]);
    try {
      const region = await cutRegion(prepared.lineArt, piece.poly, piece);
      const r = await requestRegionCritique(
        { lineArt: prepared.lineArt, region, croquis: prepared.croquis },
        { x: at.x, y: at.y, w: piece.w * 100, h: piece.h * 100 },
        settings,
      );
      setExtras((xs) => xs.map((x) => (x.id === id ? { ...x, ...r, pending: false } : x)));
    } catch (e) {
      setExtras((xs) => xs.filter((x) => x.id !== id));
      if (e instanceof MissingKeyError) setKeyOpen(true);
      setRegionError(`고른 부분을 첨삭하지 못했어요. ${describeError(e)}`);
      setBanner(`고른 부분을 첨삭하지 못했어요. ${describeError(e)}`);
    }
  }

  // 첨삭 결과가 있으면 정렬된 이미지로, 없으면 올린 그대로 보여 준다
  const view = prepared ?? { photo, lineArt, croquis, aligned: false, lineArtRed };

  return (
    <>
      <Workspace
        photo={view.photo}
        lineArt={view.lineArt}
        croquis={view.croquis}
        croquisRaw={croquisRaw}
        lineArtRed={view.lineArtRed}
        aligned={view.aligned}
        busy={busy}
        source={source}
        feedback={feedback}
        extras={extras}
        regionError={regionError}
        banner={banner}
        settings={settings}
        hasKey={hasKey}
        onSettings={onSettings}
        onStart={start}
        onCancel={() => {
          abort.current?.abort();
          setBusy((b) => ({ ...b, critique: false }));
        }}
        onUpload={() => setUploadOpen(true)}
        onFiles={(f) => void onFiles(f)}
        onSwap={onSwap}
        onRemove={onRemove}
        onDropPiece={onDropPiece}
        onDismissBanner={() => setBanner(null)}
        onKey={() => setKeyOpen(true)}
      />

      <UploadDialog open={uploadOpen} onFiles={(f) => void onFiles(f)} onClose={() => setUploadOpen(false)} />

      <ApiKeyDialog
        open={keyOpen}
        onClose={(saved) => {
          setKeyOpen(false);
          setHasKey(!!getApiKey());
          if (saved && pendingStart.current && getApiKey()) {
            pendingStart.current = false;
            void start();
          } else pendingStart.current = false;
        }}
      />
    </>
  );
}
