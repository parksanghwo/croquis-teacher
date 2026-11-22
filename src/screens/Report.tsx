import { useEffect, useState } from 'react';
import type { CritiqueSettings, Feedback, Img } from '../types';
import { CorrectionLayer } from '../components/CorrectionLayer';
import { TrashIcon } from '../components/Icons';
import { ringOf } from '../lib/geometry';

interface Props {
  croquis: Img;
  croquisInk: string;
  feedback: Feedback;
  settings: CritiqueSettings;
}

const MAX_H = 700;
const MAX_W = 360;

export function ReportScreen({ croquis, croquisInk, feedback, settings }: Props) {
  const [removed, setRemoved] = useState<string[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    setRemoved([]);
    setSel(null);
  }, [feedback]);

  const all = feedback.issues;
  const visible = all.filter((it) => !removed.includes(it.id));
  const aspect = croquis.w / croquis.h;
  let H = MAX_H, W = H * aspect;
  if (W > MAX_W) {
    W = MAX_W;
    H = W / aspect;
  }

  const remove = (id: string) => {
    const idx = visible.findIndex((v) => v.id === id);
    const next = visible[idx + 1] ?? visible[idx - 1] ?? null;
    setRemoved([...removed, id]);
    setSel(next ? next.id : null);
    // 다음 항목으로 포커스 이동
    if (next) requestAnimationFrame(() => document.getElementById(`note-${next.id}`)?.focus());
  };
  const onKey = (id: string) => (e: React.KeyboardEvent) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove(id);
    }
  };
  const pick = (id: string) => setSel(sel === id ? null : id);

  const today = new Date();
  const date = `${today.getMonth() + 1}월 ${today.getDate()}일`;
  const time = settings.time === '자유' ? '자유 크로키' : `${settings.time} 크로키`;

  return (
    <main className="notebook-wrap">
      <div className="notebook">
        <section aria-label="왼쪽 면: 첨삭된 크로키" className="sheet sheet--left">
          <p className="sheet__label" style={{ alignSelf: 'flex-start' }}>
            오늘의 크로키
          </p>
          <div style={{ position: 'relative', width: W, height: H, flex: 'none', margin: '0 150px', maxWidth: '100%' }}>
            <img src={croquisInk} alt="내 크로키" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
            <CorrectionLayer issues={visible} opacity={0.88} />
            {visible.map((it) => {
              const n = all.indexOf(it) + 1;
              const { cx, cy, r } = ringOf(it, W, H, 20, 44);
              const L = cx < W / 2;
              const selected = sel === it.id;
              return (
                <span key={it.id} style={{ display: 'contents' }}>
                  <span
                    style={{
                      position: 'absolute',
                      left: cx - r,
                      top: cy - r,
                      width: r * 2,
                      height: r * 2,
                      borderRadius: '50%',
                      pointerEvents: 'none',
                      border: selected ? '3px solid #C21F36' : '2px solid rgba(194,31,54,0.75)',
                      background: selected ? 'rgba(251,227,230,0.35)' : undefined,
                    }}
                  />
                  <button
                    type="button"
                    className="tag"
                    aria-pressed={selected}
                    aria-label={`${n}. ${it.name} 고르기`}
                    onClick={() => pick(it.id)}
                    onKeyDown={onKey(it.id)}
                    style={{
                      top: cy,
                      flexDirection: L ? 'row-reverse' : 'row',
                      ...(L ? { right: W - cx + r + 6 } : { left: cx + r + 6 }),
                    }}
                  >
                    <span className="num-dot">{n}</span>
                    <span className="tag__text">{it.name}</span>
                  </button>
                </span>
              );
            })}
          </div>
          <p style={{ margin: 0, fontSize: 22, lineHeight: '40px', color: 'var(--muted-2)' }}>검정 = 내 선 · 빨강 = 고친 선</p>
        </section>

        <section aria-label="오른쪽 면: 노트" className="sheet sheet--right">
          <span aria-hidden="true" className="sheet__margin" />
          <h1>크로키 노트 · {date}</h1>
          <p className="sheet__sub">
            {time} · {feedback.pose}
          </p>

          <ol className="note-list">
            {visible.map((it) => {
              const n = all.indexOf(it) + 1;
              const selected = sel === it.id;
              return (
                <li key={it.id} style={{ position: 'relative' }}>
                  <button
                    id={`note-${it.id}`}
                    type="button"
                    className="note-item"
                    aria-pressed={selected}
                    title="클릭해서 고르고 Delete 키로 지우기"
                    onClick={(e) => {
                      e.currentTarget.focus();
                      pick(it.id);
                    }}
                    onKeyDown={onKey(it.id)}
                  >
                    <span className="note-item__title">
                      {n}. {it.name} — {it.fix}
                    </span>
                    <span className="note-item__why">{it.why}</span>
                    <span className="note-item__how">→ {it.how}</span>
                  </button>
                  {selected && (
                    <button type="button" className="trash" aria-label={`${it.name} 지우기`} onClick={() => remove(it.id)}>
                      <TrashIcon />
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
          {visible.length === 0 && <p style={{ margin: 0, fontSize: 26, lineHeight: '40px', color: 'var(--faint)' }}>다 지웠어요. 되돌리기로 다시 꺼낼 수 있어요.</p>}
          <p style={{ margin: '24px 0 0', fontSize: 24, lineHeight: '40px', color: 'var(--ok-strong)' }}>잘한 점: {feedback.good}</p>
          <div className="footer-row">
            <span>클릭해서 고르고 Delete 키로 지우기 · 지우면 왼쪽 그림의 표시도 같이 사라져요</span>
            {removed.length > 0 && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setSel(removed[removed.length - 1]);
                  setRemoved(removed.slice(0, -1));
                }}
              >
                되돌리기 ({removed.length})
              </button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
