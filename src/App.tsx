import { useEffect, useRef, useState } from 'react';
import type { CritiqueSettings, Feedback, Img, Issue, Piece, Pt, Step } from './types';
import { Header } from './components/Header';
import { ApiKeyDialog } from './components/ApiKeyDialog';
import { UploadScreen } from './screens/Upload';
import { CompareScreen } from './screens/Compare';
import { ReportScreen } from './screens/Report';
import { cleanPaper, crop, cutRegion, inkBounds, loadFile, toInk, traceLineArt } from './lib/image';
import { aiLineArt, aiPencilLines, describeError, MissingKeyError, requestCritique, requestRegionCritique } from './lib/ai';
import { getApiKey } from './lib/settings';

interface Prepared {
  photo: Img;
  lineArt: Img;
  croquis: Img;
  aligned: boolean;
  /** 화면 표시용 투명 배경 버전 */
  croquisInk: string;
  lineArtInk: string;
  lineArtRed: string;
}

export default function App() {
  const [step, setStep] = useState<Step>(1);
  const [photo, setPhoto] = useState<Img | null>(null);
  const [autoLineArt, setAutoLineArt] = useState<Img | null>(null);
  const [customLineArt, setCustomLineArt] = useState<Img | null>(null);
  const [croquis, setCroquis] = useState<Img | null>(null);
  /** 보정 전 크로키 원본 (추출 방식을 바꾸면 다시 추출) */
  const [croquisRaw, setCroquisRaw] = useState<Img | null>(null);
  /** 각 선화를 무엇으로 만들었는지 */
  const [source, setSource] = useState<{ lineArt?: 'ai' | 'local'; croquis?: 'ai' | 'local' }>({});
  const [notice, setNotice] = useState<string | null>(null);
  const seq = useRef({ photo: 0, croquis: 0 });
  const [busy, setBusy] = useState<{ photo?: boolean; croquis?: boolean; critique?: boolean }>({});
  const [error, setError] = useState<string | null>(null);
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
  const [keyOpen, setKeyOpen] = useState(false);
  const [hasKey, setHasKey] = useState(!!getApiKey());
  const pendingStart = useRef(false);
  const abort = useRef<AbortController | null>(null);

  const lineArt = customLineArt ?? autoLineArt;
  const maxStep: Step = feedback ? 3 : 1;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [step]);

  const fail = (e: unknown) => setError(describeError(e));

  /**
   * 선화 추출: AI(프롬프트 1·2, 이미지 모델) → 실패하거나 키가 없으면 브라우저 자동 트레이싱.
   * 나중에 올린 이미지가 먼저 끝나도 꼬이지 않게 순번으로 확인한다.
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
          setNotice(`AI ${kind === 'photo' ? '선화' : '연필선'} 추출에 실패해서 자동 트레이싱으로 대신했어요. (${describeError(e)})`);
          out = await local();
        }
      } else {
        if (mode === 'ai') setNotice('API 키가 없어서 자동 트레이싱으로 선을 땄어요. 키를 넣은 뒤 이미지를 다시 올리면 AI로 추출해요.');
        out = await local();
      }
      if (n !== seq.current[kind]) return;
      if (kind === 'photo') setAutoLineArt(out);
      else setCroquis(out);
      setSource((s) => ({ ...s, [kind === 'photo' ? 'lineArt' : 'croquis']: from }));
    } catch (e) {
      if (n === seq.current[kind]) fail(e);
    } finally {
      if (n === seq.current[kind]) setBusy((b) => ({ ...b, [kind]: false }));
    }
  }

  async function onPhoto(f: File) {
    setError(null);
    setNotice(null);
    try {
      const img = await loadFile(f);
      setPhoto(img);
      setAutoLineArt(null);
      await extract('photo', img);
    } catch (e) {
      fail(e);
    }
  }

  function onSettings(next: CritiqueSettings) {
    // 추출 방식을 바꾸면 이미 올린 이미지도 다시 추출
    if (next.extract !== settings.extract) {
      setNotice(null);
      if (photo) void extract('photo', photo, next.extract);
      if (croquisRaw) void extract('croquis', croquisRaw, next.extract);
    }
    setSettings(next);
  }

  async function onLineArt(f: File | null) {
    setError(null);
    if (!f) return setCustomLineArt(null);
    try {
      setCustomLineArt(await cleanPaper(await loadFile(f)));
    } catch (e) {
      fail(e);
    }
  }

  async function onCroquis(f: File) {
    setError(null);
    setNotice(null);
    try {
      const img = await loadFile(f);
      setCroquisRaw(img);
      setCroquis(null);
      await extract('croquis', img);
    } catch (e) {
      fail(e);
    }
  }

  async function start() {
    if (!photo || !lineArt || !croquis) return;
    if (!getApiKey()) {
      pendingStart.current = true;
      setKeyOpen(true);
      return;
    }
    setError(null);
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
      setPrepared({
        ...imgs,
        aligned: settings.autoAlign,
        croquisInk: await toInk(imgs.croquis),
        lineArtInk: await toInk(imgs.lineArt),
        lineArtRed: await toInk(imgs.lineArt, [211, 38, 62]),
      });
      setExtras([]);
      setRegionError(null);
      setFeedback(fb);
      setStep(2);
    } catch (e) {
      if (e instanceof MissingKeyError) setKeyOpen(true);
      fail(e);
    } finally {
      abort.current = null;
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
    }
  }

  const doneExtras = extras.filter((x) => !x.pending);

  return (
    <div className={step === 3 ? 'app app--sunk' : 'app'}>
      <Header step={step} maxStep={maxStep} hasKey={hasKey} onStep={(s) => s <= maxStep && setStep(s)} onKey={() => setKeyOpen(true)} />

      {step === 1 && (
        <UploadScreen
          photo={photo}
          lineArt={lineArt}
          lineArtCustom={!!customLineArt}
          croquis={croquis}
          busy={busy}
          settings={settings}
          source={source}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          error={error}
          onPhoto={onPhoto}
          onLineArt={onLineArt}
          onCroquis={onCroquis}
          onSettings={onSettings}
          onStart={start}
          onCancel={() => abort.current?.abort()}
        />
      )}
      {step === 2 && prepared && feedback && <CompareScreen {...prepared} feedback={feedback} extras={extras} regionError={regionError} onDropPiece={onDropPiece} onNext={() => setStep(3)} />}
      {step === 3 && prepared && feedback && <ReportScreen croquis={prepared.croquis} croquisInk={prepared.croquisInk} lineArtRed={prepared.lineArtRed} feedback={feedback} extras={doneExtras} settings={settings} />}

      <ApiKeyDialog
        open={keyOpen}
        onClose={(saved) => {
          setKeyOpen(false);
          setHasKey(!!getApiKey());
          if (saved && getApiKey()) setError(null);
          if (saved && pendingStart.current && getApiKey()) {
            pendingStart.current = false;
            void start();
          } else pendingStart.current = false;
        }}
      />
    </div>
  );
}
