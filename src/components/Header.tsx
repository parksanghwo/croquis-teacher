import type { Step } from '../types';
import { CheckIcon, KeyIcon, PencilIcon } from './Icons';

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: '업로드' },
  { n: 2, label: '오버랩 첨삭' },
  { n: 3, label: '노트 정리' },
];

interface Props {
  step: Step;
  maxStep: Step;
  hasKey: boolean;
  onStep: (s: Step) => void;
  onKey: () => void;
}

export function Header({ step, maxStep, hasKey, onStep, onKey }: Props) {
  return (
    <header className="header">
      <div className="header__inner">
        <button type="button" className="brand" onClick={() => onStep(1)}>
          <span className="brand__mark">
            <PencilIcon stroke="#F6F4EF" />
          </span>
          <span className="brand__name">크로키 선생님</span>
        </button>
        <nav aria-label="진행 단계" className="steps">
          {STEPS.map((s, i) => {
            const cls = s.n === step ? 'step step--current' : s.n < step ? 'step step--done' : 'step';
            return (
              <span key={s.n} style={{ display: 'contents' }}>
                {i > 0 && <span className="steps__sep" aria-hidden="true" />}
                <button
                  type="button"
                  className={cls}
                  disabled={s.n > maxStep}
                  aria-current={s.n === step ? 'step' : undefined}
                  onClick={() => onStep(s.n)}
                >
                  <span className="step__num">{s.n < step ? <CheckIcon width={12} height={12} strokeWidth={3} /> : s.n}</span>
                  {s.label}
                </button>
              </span>
            );
          })}
        </nav>
        <button type="button" className="btn btn--sm" onClick={onKey}>
          <KeyIcon />
          API 키
          <span className={hasKey ? 'key-dot key-dot--on' : 'key-dot'} aria-label={hasKey ? '입력됨' : '없음'} />
        </button>
      </div>
    </header>
  );
}
