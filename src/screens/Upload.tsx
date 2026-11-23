import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CritiqueSettings, Img } from '../types';
import { ArrowRightIcon, CheckIcon, PhoneIcon, UploadIcon } from '../components/Icons';
import { PhoneUploadDialog } from '../components/PhoneUploadDialog';

type Slot = 'photo' | 'lineArt' | 'croquis';
const SLOT_LABEL: Record<Slot, string> = { photo: '원본 사진', lineArt: '기준 선화', croquis: '내 크로키' };
const canReadClipboard = typeof navigator !== 'undefined' && !!navigator.clipboard && 'read' in navigator.clipboard;

/** 클립보드 이벤트에서 이미지 파일 꺼내기 */
function imageFromPaste(e: ClipboardEvent): File | null {
  const dt = e.clipboardData;
  if (!dt) return null;
  for (const f of Array.from(dt.files)) if (f.type.startsWith('image/')) return f;
  for (const it of Array.from(dt.items)) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

export const TIMES = ['30초', '1분', '3분', '5분', '자유'];
export const FOCUS = ['비례', '관절 각도', '옷 주름', '실루엣', '신발·손'];

interface Props {
  photo: Img | null;
  lineArt: Img | null;
  lineArtCustom: boolean;
  croquis: Img | null;
  busy: { photo?: boolean; croquis?: boolean; critique?: boolean };
  settings: CritiqueSettings;
  /** 각 선화를 AI로 만들었는지 자동 트레이싱으로 만들었는지 */
  source: { lineArt?: 'ai' | 'local'; croquis?: 'ai' | 'local' };
  /** App에서 올린 안내 (AI 추출 실패 등) */
  notice: string | null;
  onDismissNotice: () => void;
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
  const aiLine = p.settings.extract === 'ai';
  const [hovered, setHovered] = useState<Slot | null>(null);
  const [phoneSlot, setPhoneSlot] = useState<Slot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const put = (slot: Slot, f: File) => {
    setNotice(null);
    if (slot === 'photo') p.onPhoto(f);
    else if (slot === 'croquis') p.onCroquis(f);
    else if (p.photo) p.onLineArt(f);
  };
  // 마우스를 올린 칸이 우선, 아니면 비어 있는 칸
  const pasteTarget = (): Slot | null => {
    if (hovered && (hovered !== 'lineArt' || p.photo)) return hovered;
    if (!p.photo) return 'photo';
    if (!p.croquis) return 'croquis';
    return null;
  };
  const latest = useRef({ pasteTarget, put });
  latest.current = { pasteTarget, put };

  // Ctrl/⌘+V로 이미지 붙여넣기
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // 글자 입력 중이거나 다른 창이 떠 있으면 건드리지 않음
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, [contenteditable="true"]') || document.querySelector('dialog[open]')) return;
      const file = imageFromPaste(e);
      if (!file) {
        setNotice('클립보드에 이미지가 없어요. 이미지를 복사한 뒤 다시 붙여넣어 주세요.');
        return;
      }
      e.preventDefault();
      const slot = latest.current.pasteTarget();
      if (!slot) {
        setNotice('어느 칸에 넣을지 정해 주세요. 바꿀 칸 위에 마우스를 올리고 다시 붙여넣으면 돼요.');
        return;
      }
      latest.current.put(slot, file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // 붙여넣기 버튼 (Clipboard API)
  const pasteInto = async (slot: Slot) => {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await it.getType(type);
          put(slot, new File([blob], `pasted.${type.split('/')[1]}`, { type }));
          return;
        }
      }
      setNotice('클립보드에 이미지가 없어요. 이미지를 복사한 뒤 다시 눌러 주세요.');
    } catch {
      setNotice('브라우저가 클립보드 읽기를 막았어요. Ctrl+V(Mac은 ⌘+V)로 붙여넣어 주세요.');
    }
  };

  const hover = (slot: Slot) => ({ onMouseEnter: () => setHovered(slot), onMouseLeave: () => setHovered((h) => (h === slot ? null : h)) });
  const emptyActions = (slot: Slot, pickLabel: string) => (
    <div className="drop__actions">
      <FilePicker label={pickLabel} onFile={(f) => put(slot, f)} className="btn btn--dark" />
      {canReadClipboard && (
        <button type="button" className="btn" onClick={() => pasteInto(slot)}>
          붙여넣기
        </button>
      )}
      <button type="button" className="btn" onClick={() => setPhoneSlot(slot)}>
        <PhoneIcon />
        휴대폰으로
      </button>
    </div>
  );
  const headActions = (slot: Slot) => (
    <div style={{ display: 'flex', gap: 6 }}>
      <button type="button" className="btn icon-btn" aria-label={`휴대폰으로 ${SLOT_LABEL[slot]} 다시 보내기`} title="휴대폰으로" onClick={() => setPhoneSlot(slot)}>
        <PhoneIcon />
      </button>
      <FilePicker label="교체" onFile={(f) => put(slot, f)} />
    </div>
  );
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
        <article className="card" {...hover('photo')}>
          <div className="card__head">
            <span className="badge">1</span>
            <h2>원본 사진</h2>
            {p.photo && headActions('photo')}
          </div>
          <DropArea
            img={p.photo}
            alt="원본 참고 사진"
            onFile={p.onPhoto}
            empty={
              <>
                <UploadIcon />
                참고한 사진을 올려 주세요
                {emptyActions('photo', '사진 선택')}
                <span className="paste-hint">끌어다 놓기 · Ctrl+V 붙여넣기도 돼요</span>
              </>
            }
          />
          <div className="status">
            {p.photo ? <Ok>업로드 완료 · {p.photo.w}×{p.photo.h}</Ok> : p.busy.photo ? <Working>사진 읽는 중…</Working> : 'JPG, PNG'}
          </div>
        </article>

        <article className="card" {...hover('lineArt')}>
          <div className="card__head">
            <span className="badge badge--accent">
              <PencilBadge />
            </span>
            <h2>{p.lineArtCustom ? '기준 선화 (직접 올림)' : aiLine ? '기준 선화 (AI 추출)' : '기준 선화 (자동 트레이싱)'}</h2>
          </div>
          <DropArea img={p.lineArt} alt="사진에서 추출한 기준 선화" white onFile={p.photo ? (f) => p.onLineArt(f) : undefined} empty={
              p.busy.photo ? (
                <Working>{aiLine ? 'AI가 사진에서 선화를 따는 중… (수십 초 걸릴 수 있어요)' : '선 추출 중…'}</Working>
              ) : (
                '원본 사진을 올리면 선화를 따요'
              )
            }
          />
          <div className="status">
            {p.busy.photo ? (
              <Working>선 추출 중…</Working>
            ) : p.lineArt ? (
              <Ok>{p.lineArtCustom ? '직접 그린 선화' : p.source.lineArt === 'ai' ? 'AI 추출 완료' : '자동 트레이싱 완료'}</Ok>
            ) : null}
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

        <article className="card" {...hover('croquis')}>
          <div className="card__head">
            <span className="badge">2</span>
            <h2>내 크로키</h2>
            {p.croquis && headActions('croquis')}
          </div>
          <DropArea
            img={p.croquis}
            alt="내가 그린 크로키"
            white
            onFile={p.onCroquis}
            empty={
              p.busy.croquis ? (
                <Working>{aiLine ? 'AI가 연필선만 남기는 중… (수십 초 걸릴 수 있어요)' : '종이 보정 중…'}</Working>
              ) : (
              <>
                <UploadIcon />
                종이에 그린 크로키를 찍거나 스캔해서 올려 주세요
                {emptyActions('croquis', '크로키 선택')}
                <span className="paste-hint">끌어다 놓기 · Ctrl+V 붙여넣기도 돼요</span>
              </>
              )
            }
          />
          <div className="status">
            {p.busy.croquis ? (
              <Working>선 추출 중…</Working>
            ) : p.croquis ? (
              <Ok>{p.source.croquis === 'ai' ? 'AI 연필선 추출 완료' : '종이 보정 · 선 추출 완료'}</Ok>
            ) : (
              '종이 배경과 그림자는 지우고 선만 남겨요'
            )}
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
          <label className="check">
            <input type="checkbox" checked={s.extract === 'ai'} onChange={(e) => p.onSettings({ ...s, extract: e.target.checked ? 'ai' : 'local' })} />
            AI로 선화 추출 (더 정확하지만 시간·비용이 들어요)
          </label>
        </fieldset>
      </section>

      {(notice ?? p.notice) && (
        <div className="alert" role="status">
          {notice ?? p.notice}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              if (notice) setNotice(null);
              else p.onDismissNotice();
            }}
          >
            닫기
          </button>
        </div>
      )}

      <PhoneUploadDialog
        target={phoneSlot ? SLOT_LABEL[phoneSlot] : null}
        onFile={(f) => {
          if (phoneSlot) put(phoneSlot, f);
          setPhoneSlot(null);
        }}
        onClose={() => setPhoneSlot(null)}
      />

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
