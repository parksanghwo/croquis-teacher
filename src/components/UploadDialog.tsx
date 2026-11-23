import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { UploadIcon } from './Icons';

interface Props {
  open: boolean;
  onFiles: (files: File[]) => void;
  onClose: () => void;
}

type Qr = { kind: 'loading' } | { kind: 'ready'; urls: string[]; url: string; img: string } | { kind: 'unavailable'; reason: string };

const qrOf = (url: string) => QRCode.toDataURL(url, { margin: 1, width: 440, color: { dark: '#1B1B1F', light: '#FFFFFF' } });

/**
 * 사진·그림 올리기 창: 파일 선택 / 끌어다 놓기 / 휴대폰 QR.
 * 창이 열려 있는 동안 휴대폰에서 보낸 이미지를 계속 받아서 onFiles로 넘긴다.
 */
export function UploadDialog({ open, onFiles, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [qr, setQr] = useState<Qr>({ kind: 'loading' });
  const [received, setReceived] = useState(0);
  const [over, setOver] = useState(false);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let token = '';
    let timer = 0;
    let stopped = false;
    setQr({ kind: 'loading' });
    setReceived(0);
    (async () => {
      try {
        const r = await fetch('/api/phone/session', { method: 'POST' });
        if (!r.ok) throw new Error(String(r.status));
        const s = (await r.json()) as { token: string; urls: string[] };
        token = s.token;
        if (!s.urls.length) {
          setQr({ kind: 'unavailable', reason: '이 PC의 네트워크 주소를 찾지 못해서 QR을 만들 수 없어요. 와이파이에 연결돼 있는지 확인해 주세요.' });
          return;
        }
        const img = await qrOf(s.urls[0]);
        if (stopped) return;
        setQr({ kind: 'ready', urls: s.urls, url: s.urls[0], img });
        const poll = async () => {
          if (stopped) return;
          try {
            const f = await fetch(`/api/phone/${token}/file`, { cache: 'no-store' });
            if (f.status === 200) {
              const blob = await f.blob();
              setReceived((n) => n + 1);
              onFilesRef.current([new File([blob], `phone.${blob.type.split('/')[1] ?? 'jpg'}`, { type: blob.type })]);
              timer = window.setTimeout(poll, 100); // 더 쌓여 있을 수 있음
              return;
            }
            if (f.status === 404) {
              setQr({ kind: 'unavailable', reason: 'QR 코드가 만료됐어요. 창을 닫고 다시 열어 주세요.' });
              return;
            }
          } catch {
            /* 잠깐 끊겨도 계속 시도 */
          }
          timer = window.setTimeout(poll, 1200);
        };
        poll();
      } catch {
        if (!stopped) setQr({ kind: 'unavailable', reason: '휴대폰 QR 업로드는 개발 서버(npm run dev)로 실행했을 때만 돼요. 파일 선택이나 끌어다 놓기를 써 주세요.' });
      }
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if (token) fetch(`/api/phone/${token}`, { method: 'DELETE' }).catch(() => undefined);
    };
  }, [open]);

  const take = (list: FileList | null | undefined) => {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      onFiles(files);
      onClose();
    }
  };

  return (
    <dialog ref={ref} className="dialog dialog--wide" onCancel={onClose} aria-labelledby="up-title">
      <div className="dialog__body">
        <h2 id="up-title">사진·그림 올리기</h2>
        <p>참고 사진과 종이에 그린 크로키를 올려 주세요. 사진인지 그림인지는 자동으로 나눠서, 사진은 기준 선화를 따고 그림은 연필선만 남겨요.</p>
        <div className="up-grid">
          <div
            className={over ? 'up-drop up-drop--over' : 'up-drop'}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              take(e.dataTransfer.files);
            }}
          >
            <UploadIcon />
            <span>여기에 끌어다 놓거나</span>
            <button type="button" className="btn btn--dark" onClick={() => input.current?.click()}>
              파일 선택
            </button>
            <span className="paste-hint">여러 장 한 번에 · Ctrl+V 붙여넣기도 돼요</span>
            <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => take(e.target.files)} />
          </div>
          <div className="up-qr">
            <b>휴대폰으로 찍어서 올리기</b>
            {qr.kind === 'loading' && (
              <p style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="spinner" />
                QR 코드 만드는 중…
              </p>
            )}
            {qr.kind === 'ready' && (
              <>
                <img className="qr" src={qr.img} alt={`휴대폰으로 열 주소: ${qr.url}`} width={200} height={200} />
                <span className="paste-hint">PC와 같은 와이파이에서 카메라로 찍어 주세요</span>
                {qr.urls.length > 1 && (
                  <label className="field">
                    QR이 안 열리면 다른 주소로
                    <select
                      value={qr.url}
                      onChange={async (e) => {
                        const url = e.target.value;
                        setQr({ ...qr, url, img: await qrOf(url) });
                      }}
                    >
                      {qr.urls.map((u) => (
                        <option key={u} value={u}>
                          {new URL(u).host}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <p className="waiting">
                  <span className="spinner" />
                  {received ? `${received}장 받았어요 · 더 보내도 돼요` : '휴대폰에서 보내기를 기다리는 중…'}
                </p>
              </>
            )}
            {qr.kind === 'unavailable' && (
              <p className="alert" role="alert">
                {qr.reason}
              </p>
            )}
          </div>
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onClose}>
            {received ? '완료' : '닫기'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
