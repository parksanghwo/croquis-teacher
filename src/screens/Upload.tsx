import { useRef, useState, type ReactNode } from 'react';
import type { CritiqueSettings, Img } from '../types';
import { ArrowRightIcon, CheckIcon, UploadIcon } from '../components/Icons';

export const TIMES = ['30초', '1분', '3분', '5분', '자유'];
export const FOCUS = ['비례', '관절 각도', '옷 주름', '실루엣', '신발·손'];

interface Props {
  photo: Img | null;
  lineArt: Img | null;
  lineArtCustom: boolean;
  croquis: Img | null;
  busy: { photo?: boolean; croquis?: boolean; critique?: boolean };
  settings: CritiqueSettings;
  error: string | null;
  onPhoto: (f: File) => void;
  onLineArt: (f: File | null) => void;
  onCroquis: (f: File) => void;
  onSettings: (s: CritiqueSettings) => void;
  onStart: () => void;
  onCancel: () => void;
}

function FilePicker({ label, onFile, className = 'btn' }: { label: string; onFile: (f: File) => void; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={className} onClick={() => ref.current?.click()}>
        {label}
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
    </>
  );
}

function DropArea({ img, alt, white, onFile, empty }: { img: Img | null; alt: string; white?: boolean; onFile?: (f: File) => void; empty: ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`drop${white ? ' drop--white' : ''}${over ? ' drop--over' : ''}`}
      onDragOver={(e) => {
        if (!onFile) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!onFile) return;
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f && f.type.startsWith('image/')) onFile(f);
      }}
    >
      {img ? <img src={img.url} alt={alt} /> : <div className="drop__empty">{empty}</div>}
    </div>
  );
}

const Ok = ({ children }: { children: ReactNode }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ok)' }}>
    <CheckIcon />
    {children}
  </span>
);
const Working = ({ children }: { children: ReactNode }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
    <span className="spinner" />
    {children}
  </span>
);

export function UploadScreen(p: Props) {
  const s = p.settings;
  const ready = !!(p.photo && p.lineArt && p.croquis) && !p.busy.photo && !p.busy.croquis;
  const toggleFocus = (f: string) =>
    p.onSettings({ ...s, focus: s.focus.includes(f) ? s.focus.filter((x) => x !== f) : [...s.focus, f] });

  return (
    <main className="page">
      <div className="intro">
        <div className="intro__text">
          <p className="eyebrow">새 첨삭</p>
          <h1>오늘 그린 크로키를 올려주세요</h1>
          <p className="lead">원본 사진에서 기준 선화를 따고, 내 크로키 위에 겹쳐서 어디가 다른지 빨간 펜으로 짚어 드려요.</p>
        </div>
        <p className="hand-note">사진은 전신이 다 나오게!</p>
      </div>

      <section aria-label="이미지 업로드" className="uploads">
        <article className="card">
          <div className="card__head">
            <span className="badge">1</span>
            <h2>원본 사진</h2>
            {p.photo && <FilePicker label="교체" onFile={p.onPhoto} />}
          </div>
          <DropArea
            img={p.photo}
            alt="원본 참고 사진"
            onFile={p.onPhoto}
            empty={
              <>
                <UploadIcon />
                참고한 사진을 끌어다 놓거나
                <FilePicker label="사진 선택" onFile={p.onPhoto} className="btn btn--dark" />
              </>
            }
          />
          <div className="status">
            {p.busy.photo ? <Working>사진 읽는 중…</Working> : p.photo ? <Ok>업로드 완료 · {p.photo.w}×{p.photo.h}</Ok> : 'JPG, PNG'}
          </div>
        </article>

        <article className="card">
          <div className="card__head">
            <span className="badge badge--accent">
              <PencilBadge />
            </span>
            <h2>{p.lineArtCustom ? '기준 선화 (직접 올림)' : '기준 선화 (자동 트레이싱)'}</h2>
          </div>
          <DropArea img={p.lineArt} alt="사진에서 추출한 기준 선화" white onFile={p.photo ? (f) => p.onLineArt(f) : undefined} empty="원본 사진을 올리면 자동으로 선을 따요" />
          <div className="status">
            {p.busy.photo ? <Working>선 추출 중…</Working> : p.lineArt ? <Ok>{p.lineArtCustom ? '직접 그린 선화' : '추출 완료'}</Ok> : null}
            {p.photo &&
              (p.lineArtCustom ? (
                <button type="button" className="btn btn--text" onClick={() => p.onLineArt(null)}>
                  자동 선화로 되돌리기
                </button>
              ) : (
                <FilePicker label="직접 그린 선화로 바꾸기" onFile={(f) => p.onLineArt(f)} className="btn btn--text" />
              ))}
          </div>
        </article>

        <article className="card">
          <div className="card__head">
            <span className="badge">2</span>
            <h2>내 크로키</h2>
            {p.croquis && <FilePicker label="교체" onFile={p.onCroquis} />}
          </div>
          <DropArea
            img={p.croquis}
            alt="내가 그린 크로키"
            white
            onFile={p.onCroquis}
            empty={
              <>
                <UploadIcon />
                크로키 사진이나 스캔을 끌어다 놓거나
                <FilePicker label="크로키 선택" onFile={p.onCroquis} className="btn btn--dark" />
              </>
            }
          />
          <div className="status">
            {p.busy.croquis ? <Working>종이 보정 중…</Working> : p.croquis ? <Ok>종이 보정 · 선 추출 완료</Ok> : '종이 그림자는 자동으로 지워요'}
          </div>
        </article>
      </section>

      <section aria-label="첨삭 설정" className="settings">
        <fieldset className="settings__group" style={{ flex: '1 1 260px' }}>
          <legend>연습 시간</legend>
          <div className="chips">
            {TIMES.map((t) => (
              <button key={t} type="button" className="chip" aria-pressed={s.time === t} onClick={() => p.onSettings({ ...s, time: t })}>
                {t}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="settings__group" style={{ flex: '2 1 380px' }}>
          <legend>
            무엇을 중점으로 볼까요? <span className="sub">(여러 개 선택)</span>
          </legend>
          <div className="chips">
            {FOCUS.map((f) => (
              <button key={f} type="button" className="chip" aria-pressed={s.focus.includes(f)} onClick={() => toggleFocus(f)}>
                {f}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="settings__group" style={{ flex: '1 1 260px', gap: 14 }}>
          <legend>비교 옵션</legend>
          <label className="check">
            <input type="checkbox" checked={s.excludeHead} onChange={(e) => p.onSettings({ ...s, excludeHead: e.target.checked })} />
            머리·얼굴은 캐릭터화로 보고 제외
          </label>
          <label className="check">
            <input type="checkbox" checked={s.autoAlign} onChange={(e) => p.onSettings({ ...s, autoAlign: e.target.checked })} />
            전체 크기·위치 자동 정렬
          </label>
          <label className="check">
            <input type="checkbox" checked={s.detailedTone} onChange={(e) => p.onSettings({ ...s, detailedTone: e.target.checked })} />
            꼼꼼한 말투로 피드백
          </label>
        </fieldset>
      </section>

      {p.error && (
        <div className="alert" role="alert">
          {p.error}
        </div>
      )}

      <div className="actions">
        <p>기준 선화는 자동으로 만든 근사치예요. 비례는 사진을 같이 보면서 판단하세요.</p>
        {p.busy.critique && (
          <button type="button" className="btn" onClick={p.onCancel}>
            취소
          </button>
        )}
        <button type="button" className="btn btn--primary" disabled={!ready || p.busy.critique} onClick={p.onStart}>
          {p.busy.critique ? (
            <>
              <span className="spinner" />
              선생님이 보는 중…
            </>
          ) : (
            <>
              첨삭 시작하기
              <ArrowRightIcon />
            </>
          )}
        </button>
      </div>
    </main>
  );
}

const PencilBadge = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" />
  </svg>
);
