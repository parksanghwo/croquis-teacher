import type { CritiqueSettings } from '../types';

export const TIMES = ['30초', '1분', '3분', '5분', '자유'];
export const FOCUS = ['비례', '관절 각도', '옷 주름', '실루엣', '신발·손'];

/** 첨삭 설정: 연습 시간, 중점, 비교 옵션 */
export function SettingsPanel({ settings: s, onChange }: { settings: CritiqueSettings; onChange: (s: CritiqueSettings) => void }) {
  const toggleFocus = (f: string) => onChange({ ...s, focus: s.focus.includes(f) ? s.focus.filter((x) => x !== f) : [...s.focus, f] });
  return (
    <div className="settings-pop" role="dialog" aria-label="첨삭 설정">
      <fieldset className="settings__group">
        <legend>연습 시간</legend>
        <div className="chips">
          {TIMES.map((t) => (
            <button key={t} type="button" className="chip" aria-pressed={s.time === t} onClick={() => onChange({ ...s, time: t })}>
              {t}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="settings__group">
        <legend>
          무엇을 중점으로 볼까요? <span className="sub">(여러 개)</span>
        </legend>
        <div className="chips">
          {FOCUS.map((f) => (
            <button key={f} type="button" className="chip" aria-pressed={s.focus.includes(f)} onClick={() => toggleFocus(f)}>
              {f}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="settings__group" style={{ gap: 10 }}>
        <legend>비교 옵션</legend>
        <label className="check">
          <input type="checkbox" checked={s.excludeHead} onChange={(e) => onChange({ ...s, excludeHead: e.target.checked })} />
          머리·얼굴은 캐릭터화로 보고 제외
        </label>
        <label className="check">
          <input type="checkbox" checked={s.autoAlign} onChange={(e) => onChange({ ...s, autoAlign: e.target.checked })} />
          전체 크기·위치 자동 정렬
        </label>
        <label className="check">
          <input type="checkbox" checked={s.detailedTone} onChange={(e) => onChange({ ...s, detailedTone: e.target.checked })} />
          꼼꼼한 말투로 피드백
        </label>
        <label className="check">
          <input type="checkbox" checked={s.extract === 'ai'} onChange={(e) => onChange({ ...s, extract: e.target.checked ? 'ai' : 'local' })} />
          AI로 선화 추출 (더 정확하지만 시간·비용이 들어요)
        </label>
      </fieldset>
    </div>
  );
}
