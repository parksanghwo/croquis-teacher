// 무한 사진 캔버스 — backend
// Serves the frontend, stores the board (items, arrows, camera) and uploaded images,
// and builds the 50/50 overlay images.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { board, persist, flushNow, imageUrl, collectGarbage, UPLOAD_DIR } from './store.js';
import { composeOverlay, hasContent } from './compose.js';

const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_DIR = path.resolve(import.meta.dirname, '..', 'frontend');
const MAX_UPLOAD = '40mb';

const app = express();
app.disable('x-powered-by');

/* ---------- validation ---------- */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SIDES = new Set(['n', 'e', 's', 'w']);
const num = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function cleanStrokes(strokes) {
  if (!Array.isArray(strokes)) return undefined;
  const out = [];
  for (const s of strokes.slice(0, 5000)) {
    if (!s || !num(s.w) || !Array.isArray(s.pts)) continue;
    const pts = s.pts.filter(p => Array.isArray(p) && p.length === 3 && p.every(num)).slice(0, 20000);
    if (!pts.length) continue;
    const st = { w: clamp(s.w, 0.0005, 0.1), pts };
    if (typeof s.c === 'string' && /^#[0-9a-f]{3,8}$/i.test(s.c)) st.c = s.c;
    out.push(st);
  }
  return out.length ? out : undefined;
}

/** Whitelist the fields of an item sent by the frontend. */
function cleanItem(id, body) {
  if (!body || typeof body !== 'object') throw new Error('item body missing');
  for (const k of ['x', 'y', 'w', 'h', 'order']) if (!num(body[k])) throw new Error(`item.${k} must be a number`);
  if (body.w <= 0 || body.h <= 0) throw new Error('item size must be positive');
  const it = { id, x: body.x, y: body.y, w: body.w, h: body.h, order: body.order };
  if (body.image != null) {
    if (!board.images[body.image]) throw new Error('unknown image');
    it.image = body.image;
  }
  if (body.cover) it.cover = true;
  if (Array.isArray(body.pos) && body.pos.length === 2 && body.pos.every(num)) it.pos = body.pos.map(v => clamp(v, 0, 100));
  if (num(body.zoom) && body.zoom !== 1) it.zoom = clamp(body.zoom, 1, 8);
  if (typeof body.label === 'string' && body.label) it.label = body.label.slice(0, 80);
  if (body.example) it.example = true;
  const strokes = cleanStrokes(body.strokes);
  if (strokes) it.strokes = strokes;
  return it;
}

function cleanLink(id, body) {
  if (!body || !ID.test(body.from || '') || !ID.test(body.to || '')) throw new Error('link needs from and to');
  if (!SIDES.has(body.side)) throw new Error('link.side must be n, e, s or w');
  const l = { id, from: body.from, to: body.to, side: body.side };
  if (ID.test(body.overlay || '')) l.overlay = body.overlay;
  return l;
}

const withUrl = it => (it.image ? { ...it, url: imageUrl(it.image) } : it);

/* ---------- API ---------- */
const api = express.Router();
api.use(express.json({ limit: '20mb' }));

api.param('id', (req, res, next, id) => (ID.test(id) ? next() : res.status(400).json({ error: '잘못된 id입니다' })));

api.get('/board', (req, res) => {
  res.json({
    camera: board.camera,
    items: Object.values(board.items).map(withUrl),
    links: Object.values(board.links),
  });
});

api.put('/camera', (req, res) => {
  const { x, y, z } = req.body || {};
  if (![x, y, z].every(num) || z <= 0) return res.status(400).json({ error: 'camera needs x, y, z' });
  board.camera = { x, y, z };
  persist();
  res.json({ ok: true });
});

// Upload an image as the raw request body (Content-Type: image/*).
api.post('/images', express.raw({ type: 'image/*', limit: MAX_UPLOAD }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '이미지 데이터가 없습니다' });
  let meta;
  try { meta = await sharp(req.body).metadata(); }
  catch { return res.status(415).json({ error: '이미지로 읽을 수 없는 파일입니다' }); }
  const ext = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif', svg: 'svg', heif: 'heic', tiff: 'tif' }[meta.format];
  if (!ext) return res.status(415).json({ error: `지원하지 않는 형식입니다 (${meta.format})` });
  // EXIF orientations 5–8 swap width and height, the same way the browser shows them
  const swap = meta.orientation >= 5;
  const width = swap ? meta.height : meta.width, height = swap ? meta.width : meta.height;
  const id = crypto.randomUUID().replace(/-/g, '');
  const file = `${id}.${ext}`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, file), req.body);
  board.images[id] = { file, width, height, bytes: req.body.length, createdAt: new Date().toISOString() };
  persist();
  res.status(201).json({ id, url: imageUrl(id), width, height });
});

api.put('/items/:id', (req, res) => {
  try {
    board.items[req.params.id] = cleanItem(req.params.id, req.body);
  } catch (err) { return res.status(400).json({ error: err.message }); }
  collectGarbage();
  persist();
  res.json(withUrl(board.items[req.params.id]));
});

api.delete('/items/:id', (req, res) => {
  const id = req.params.id;
  delete board.items[id];
  for (const [lid, l] of Object.entries(board.links)) {
    if (l.from === id || l.to === id) delete board.links[lid];
    else if (l.overlay === id) delete l.overlay;
  }
  collectGarbage();
  persist();
  res.status(204).end();
});

api.put('/links/:id', (req, res) => {
  try {
    board.links[req.params.id] = cleanLink(req.params.id, req.body);
  } catch (err) { return res.status(400).json({ error: err.message }); }
  persist();
  res.json(board.links[req.params.id]);
});

api.delete('/links/:id', (req, res) => {
  delete board.links[req.params.id];
  persist();
  res.status(204).end();
});

/* overlay placement helpers (same rules as the frontend's arrows) */
const NORM = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
const OPP = { n: 's', s: 'n', e: 'w', w: 'e' };
const GAP = 80;
function facingSide(target, from) {
  const dx = (from.x + from.w / 2) - (target.x + target.w / 2), dy = (from.y + from.h / 2) - (target.y + target.h / 2);
  return Math.abs(dx) / (target.w + from.w) > Math.abs(dy) / (target.h + from.h) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n');
}

// Build (or rebuild) the 50/50 overlay of an arrow's two ends, placed beside the target.
api.post('/links/:id/overlay', async (req, res) => {
  const link = board.links[req.params.id];
  if (!link) return res.status(404).json({ error: '화살표를 찾을 수 없습니다' });
  const A = board.items[link.from], B = board.items[link.to];
  if (!hasContent(A) || !hasContent(B)) return res.status(422).json({ error: '겹쳐 보려면 화살표 양쪽에 사진이나 그림이 있어야 합니다' });

  let png, width, height;
  try { ({ png, width, height } = await composeOverlay(A, B)); }
  catch (err) { console.error('[overlay]', err); return res.status(500).json({ error: '겹쳐 보기 이미지를 만들지 못했습니다' }); }

  const imgId = crypto.randomUUID().replace(/-/g, '');
  const file = `${imgId}.png`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, file), png);
  board.images[imgId] = { file, width, height, bytes: png.length, createdAt: new Date().toISOString(), overlayOf: link.id };

  let ov = link.overlay && board.items[link.overlay];
  let created = false;
  if (ov) {
    const cx = ov.x + ov.w / 2, cy = ov.y + ov.h / 2;
    Object.assign(ov, { w: B.w, h: B.h, x: cx - B.w / 2, y: cy - B.h / 2, image: imgId });
    delete ov.cover; delete ov.pos; delete ov.zoom; // red markup (strokes) is kept
  } else {
    const side = OPP[facingSide(B, A)], [nx, ny] = NORM[side];
    const order = Math.max(0, ...Object.values(board.items).map(i => i.order)) + 1;
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    ov = { id, x: B.x + nx * (B.w + GAP), y: B.y + ny * (B.h + GAP), w: B.w, h: B.h, order, image: imgId, label: '겹쳐 보기 · 각 50%' };
    board.items[id] = ov;
    link.overlay = id;
    created = true;
  }
  collectGarbage();
  persist();
  res.status(created ? 201 : 200).json({ item: withUrl(ov), link, created });
});

api.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: `파일이 너무 큽니다 (최대 ${MAX_UPLOAD})` });
  console.error('[api]', err);
  res.status(500).json({ error: '서버 오류가 발생했습니다' });
});
api.use((req, res) => res.status(404).json({ error: '없는 API 경로입니다' }));

app.use('/api', api);
app.use('/images', express.static(UPLOAD_DIR, { immutable: true, maxAge: '365d', fallthrough: false }));
app.use(express.static(FRONTEND_DIR, { index: 'index.html' }));

app.listen(PORT, () => {
  console.log(`무한 사진 캔버스: http://localhost:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flushNow(); process.exit(0); });
