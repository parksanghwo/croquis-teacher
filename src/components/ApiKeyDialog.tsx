import { useEffect, useRef, useState } from 'react';
import { DEFAULT_MODEL, getApiKey, getModel, saveSettings } from '../lib/settings';

interface Props {
  open: boolean;
  onClose: (saved: boolean) => void;
}

export function ApiKeyDialog({ open, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [key, setKey] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setKey(getApiKey());
      setModel(getModel());
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className="dialog" onCancel={() => onClose(false)} aria-labelledby="key-title">
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          saveSettings(key, model, remember);
          onClose(true);
        }}
      >
        <h2 id="key-title">Anthropic API 키</h2>
        <p>첨삭은 Claude가 해요. 키는 이 브라우저에만 저장되고, 요청은 브라우저에서 Anthropic API로 바로 가요.</p>
        <label className="field">
          API 키
          <input type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <label className="field">
          모델
          <input type="text" spellCheck={false} value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />이 기기에 저장
        </label>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={() => onClose(false)}>
            취소
          </button>
          <button type="submit" className="btn btn--dark">
            저장
          </button>
        </div>
      </form>
    </dialog>
  );
}
