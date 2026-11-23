/**
 * 휴대폰 → PC 사진 전달 (개발 서버 전용)
 *
 * PC 앱이 세션을 만들고 QR로 휴대폰에 주소를 넘긴다.
 * 휴대폰은 /phone/<토큰> 페이지에서 사진을 찍어 올리고, PC 앱은 짧은 간격으로 받아 간다.
 * 토큰은 추측할 수 없는 난수이고, 사진은 메모리에만 잠깐 있다가 PC가 받아 가면 지운다.
 */
import type { Connect, Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';

const MAX_BYTES = 25 * 1024 * 1024;
const TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 50;

interface Session {
  created: number;
  file?: { type: string; data: Buffer };
}
const sessions = new Map<string, Session>();

function sweep() {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.created > TTL_MS) sessions.delete(k);
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return out.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}

function send(res: ServerResponse, status: number, body?: string | Buffer, type = 'application/json; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  if (body !== undefined) res.setHeader('Content-Type', type);
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const handler: Connect.NextHandleFunction = async (req, res, next) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  sweep();

  // PC: 새 세션 + 휴대폰이 열 주소들
  if (path === '/api/phone/session' && req.method === 'POST') {
    if (sessions.size >= MAX_SESSIONS) return send(res, 429, JSON.stringify({ error: 'too many sessions' }));
    const token = randomBytes(16).toString('hex');
    sessions.set(token, { created: Date.now() });
    const port = req.socket.localPort;
    const urls = lanAddresses().map((ip) => `http://${ip}:${port}/phone/${token}`);
    return send(res, 200, JSON.stringify({ token, urls }));
  }

  let m = path.match(/^\/phone\/([0-9a-f]{32})$/);
  if (m && req.method === 'GET') {
    const ok = sessions.has(m[1]);
    return send(res, ok ? 200 : 404, ok ? PHONE_PAGE : EXPIRED_PAGE, 'text/html; charset=utf-8');
  }

  m = path.match(/^\/api\/phone\/([0-9a-f]{32})(\/file)?$/);
  if (m) {
    const s = sessions.get(m[1]);
    if (!s) return send(res, 404, JSON.stringify({ error: 'expired' }));
    // 휴대폰: 사진 올리기
    if (!m[2] && req.method === 'POST') {
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
      if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/.test(type)) return send(res, 415, JSON.stringify({ error: 'image only' }));
      const data = await readBody(req);
      if (!data) return send(res, 413, JSON.stringify({ error: 'too large' }));
      s.file = { type, data };
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    // PC: 받아 가기 (한 번 받으면 지움)
    if (m[2] && req.method === 'GET') {
      if (!s.file) return send(res, 204);
      const f = s.file;
      s.file = undefined;
      return send(res, 200, f.data, f.type);
    }
    // PC: 창 닫을 때 정리
    if (!m[2] && req.method === 'DELETE') {
      sessions.delete(m[1]);
      return send(res, 204);
    }
  }
  next();
};

export function phoneUpload(): Plugin {
  return {
    name: 'croquis-phone-upload',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

const STYLE = `
:root{--bg:#f6f4ef;--surface:#fff;--line:#e2ded4;--ink:#1b1b1f;--muted:#5e5a52;--accent:#d3263e;--ok:#2f6b50}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:'IBM Plex Sans KR',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:480px;margin:0 auto;padding:24px 16px 40px;display:flex;flex-direction:column;gap:16px}
.brand{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:700;letter-spacing:-.4px}
.mark{width:36px;height:36px;border-radius:10px;background:var(--ink);display:flex;align-items:center;justify-content:center}
h1{margin:8px 0 0;font-size:24px;line-height:1.3;letter-spacing:-.5px}
p{margin:0;font-size:15px;line-height:1.6;color:var(--muted)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;overflow:hidden}
.preview{height:38vh;min-height:200px;background:#efece6;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:14px}
.preview img{width:100%;height:100%;object-fit:contain;background:#fff}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;min-height:52px;width:100%;border-radius:12px;font-size:16px;font-weight:700;border:0;cursor:pointer;font-family:inherit}
.btn--primary{background:var(--accent);color:#fff}
.btn--ghost{background:#fff;color:var(--ink);border:1px solid #dcd7cc;font-weight:600}
.status{font-size:15px;font-weight:600}.status:empty{display:none}
.status.ok{color:var(--ok)}.status.err{color:#a11b2e}
input{display:none}
`;

const PEN = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F6F4EF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M14 7l3 3"/></svg>`;

const EXPIRED_PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>크로키 선생님</title><style>${STYLE}</style></head>
<body><main><div class="brand"><span class="mark">${PEN}</span>크로키 선생님</div>
<h1>QR 코드가 만료됐어요</h1><p>PC 화면에서 "휴대폰으로" 버튼을 다시 눌러 새 QR 코드를 찍어 주세요.</p></main></body></html>`;

const PHONE_PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>크로키 선생님 — 사진 보내기</title><style>${STYLE}</style></head>
<body><main>
<div class="brand"><span class="mark">${PEN}</span>크로키 선생님</div>
<div><h1>PC로 사진 보내기</h1><p>찍거나 고른 사진이 PC 화면의 칸에 바로 들어가요. 종이 크로키는 위에서 똑바로, 그림자가 덜 지게 찍어 주세요.</p></div>
<div class="status" id="status" role="status" aria-live="polite"></div>
<label class="btn btn--primary" for="cam">카메라로 찍기</label>
<input id="cam" type="file" accept="image/*" capture="environment">
<label class="btn btn--ghost" for="pick">앨범에서 고르기</label>
<input id="pick" type="file" accept="image/*">
<div class="card"><div class="preview" id="preview">아직 고른 사진이 없어요</div></div>
</main>
<script>
const token = location.pathname.split('/').pop();
const statusEl = document.getElementById('status');
const preview = document.getElementById('preview');
function setStatus(t, cls) { statusEl.textContent = t; statusEl.className = 'status ' + (cls || ''); }
async function shrink(file) {
  // 휴대폰 사진은 커서 긴 변 2000px JPEG로 줄여 보냄
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
    const s = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
  } catch (e) { return file; } finally { URL.revokeObjectURL(url); }
}
async function onPick(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  setStatus('PC로 보내는 중…');
  const blob = await shrink(file);
  preview.innerHTML = '';
  const im = document.createElement('img'); im.alt = '보낼 사진'; im.src = URL.createObjectURL(blob); preview.appendChild(im);
  try {
    const r = await fetch('/api/phone/' + token, { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
    if (r.status === 404) return setStatus('QR 코드가 만료됐어요. PC에서 새로 띄워 주세요.', 'err');
    if (!r.ok) return setStatus('보내지 못했어요 (' + r.status + '). 다시 시도해 주세요.', 'err');
    setStatus('보냈어요! PC 화면을 확인하세요.', 'ok');
  } catch (err) { setStatus('PC에 연결할 수 없어요. 같은 와이파이인지 확인해 주세요.', 'err'); }
}
document.getElementById('cam').addEventListener('change', onPick);
document.getElementById('pick').addEventListener('change', onPick);
</script></body></html>`;
