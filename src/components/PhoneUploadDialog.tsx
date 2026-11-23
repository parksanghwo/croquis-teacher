import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

interface Props {
  /** 받을 칸 이름 (null이면 닫힘) */
  target: string | null;
  onFile: (f: File) => void;
  onClose: () => void;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; urls: string[]; qr: string; url: string }
  | { kind: 'unavailable'; reason: string };

/** 휴대폰으로 QR을 찍어 사진을 보내면, 받는 즉시 onFile로 넘긴다 */
export function PhoneUploadDialog({ target, onFile, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const onFileRef = useRef(onFile);
  onFileRef.current = onFile;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (target && !d.open) d.showModal();
    else if (!target && d.open) d.close();
  }, [target]);

  useEffect(() => {
    if (!target) return;
    let token = '';
    let timer = 0;
    let stopped = false;
    setState({ kind: 'loading' });

    (async () => {
      try {
        const r = await fetch('/api/phone/session', { method: 'POST' });
        if (!r.ok) throw new Error(String(r.status));
        const s = (await r.json()) as { token: string; urls: string[] };
        token = s.token;
        if (!s.urls.length) {
          setState({ kind: 'unavailable', reason: '이 PC의 네트워크 주소를 찾지 못했어요. 와이파이(같은 네트워크)에 연결돼 있는지 확인해 주세요.' });
          return;
        }
        const qr = await QRCode.toDataURL(s.urls[0], { margin: 1, width: 440, color: { dark: '#1B1B1F', light: '#FFFFFF' } });
        if (stopped) return;
        setState({ kind: 'ready', urls: s.urls, qr, url: s.urls[0] });

        const poll = async () => {
          if (stopped) return;
          try {
            const f = await fetch(`/api/phone/${token}/file`, { cache: 'no-store' });
            if (f.status === 200) {
              const blob = await f.blob();
              const ext = blob.type.split('/')[1] ?? 'jpg';
              onFileRef.current(new File([blob], `phone.${ext}`, { type: blob.type }));
              return;
            }
            if (f.status === 404) {
              setState({ kind: 'unavailable', reason: 'QR 코드가 만료됐어요. 창을 닫고 다시 열어 주세요.' });
              return;
            }
          } catch {
            /* 잠깐 끊겨도 계속 시도 */
          }
          timer = window.setTimeout(poll, 1200);
        };
        poll();
      } catch {
        if (!stopped)
          setState({
            kind: 'unavailable',
            reason: '휴대폰 업로드는 개발 서버(npm run dev)로 실행했을 때만 쓸 수 있어요. 지금은 사진 선택이나 붙여넣기를 써 주세요.',
          });
      }
    })();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if (token) fetch(`/api/phone/${token}`, { method: 'DELETE' }).catch(() => undefined);
    };
  }, [target]);

  return (
    <dialog ref={ref} className="dialog" onCancel={onClose} aria-labelledby="phone-title">
      <div className="dialog__body">
        <h2 id="phone-title">휴대폰으로 {target ?? ''} 보내기</h2>
        {state.kind === 'loading' && (
          <p style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="spinner" />
            QR 코드 만드는 중…
          </p>
        )}
        {state.kind === 'ready' && (
          <>
            <p>휴대폰 카메라로 QR 코드를 찍고, 열린 페이지에서 사진을 찍거나 골라 주세요. PC와 휴대폰이 같은 와이파이에 있어야 해요.</p>
            <img className="qr" src={state.qr} alt={`휴대폰으로 열 주소: ${state.url}`} width={220} height={220} />
            {state.urls.length > 1 && (
              <label className="field">
                QR이 안 열리면 다른 주소로
                <select
                  value={state.url}
                  onChange={async (e) => {
                    const url = e.target.value;
                    const qr = await QRCode.toDataURL(url, { margin: 1, width: 440, color: { dark: '#1B1B1F', light: '#FFFFFF' } });
                    setState({ ...state, url, qr });
                  }}
                >
                  {state.urls.map((u) => (
                    <option key={u} value={u}>
                      {new URL(u).host}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="waiting">
              <span className="spinner" />
              휴대폰에서 보내기를 기다리는 중…
            </p>
          </>
        )}
        {state.kind === 'unavailable' && (
          <p className="alert" role="alert">
            {state.reason}
          </p>
        )}
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </dialog>
  );
}
