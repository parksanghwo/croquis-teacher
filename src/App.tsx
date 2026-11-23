import { useEffect, useRef, useState } from 'react';
import type { CritiqueSettings, Feedback, Img, Issue, Piece, Pt, Step } from './types';
import { Header } from './components/Header';
import { ApiKeyDialog } from './components/ApiKeyDialog';
import { UploadScreen } from './screens/Upload';
import { CompareScreen } from './screens/Compare';
import { ReportScreen } from './screens/Report';
import { cleanPaper, crop, cutRegion, inkBounds, loadFile, toInk, traceLineArt } from './lib/image';
import { describeError, MissingKeyError, requestCritique, requestRegionCritique } from './lib/ai';
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
  const [busy, setBusy] = useState<{ photo?: boolean; croquis?: boolean; critique?: boolean }>({});
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<CritiqueSettings>({
    time: '1분',
    focus: ['비례', '관절 각도', '실루엣'],
    excludeHead: true,
    autoAlign: true,
    detailedTone: false,
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

  async function onPhoto(f: File) {
    setError(null);
    setBusy((b) => ({ ...b, photo: true }));
    try {
      const img = await loadFile(f);
      setPhoto(img);
      setAutoLineArt(await traceLineArt(img));
    } catch (e) {
      fail(e);
    } finally {
      setBusy((b) => ({ ...b, photo: false }));
    }
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
    setBusy((b) => ({ ...b, croquis: true }));
    try {
      setCroquis(await cleanPaper(await loadFile(f)));
    } catch (e) {
      fail(e);
    } finally {
      setBusy((b) => ({ ...b, croquis: false }));
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
      const fb = await requestCritique(imgs, settings, ctrl.signal);
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
          error={error}
          onPhoto={onPhoto}
          onLineArt={onLineArt}
          onCroquis={onCroquis}
          onSettings={setSettings}
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
