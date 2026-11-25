// 끄로뀌끼끼끼끼익 — backend
// Serves the frontend, stores the board (items, arrows, camera) and uploaded images,
// and builds the 50/50 overlay images.
import fs from 'node:fs';
import path from 'node:path';

// Read KEY=value lines from .env in the project folder (values already in the environment win).
try {
  for (const line of fs.readFileSync(path.resolve(import.meta.dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const { default: express } = await import('express');
const { default: crypto } = await import('node:crypto');
const { default: sharp } = await import('sharp');
const { board, persist, flushNow, imageUrl, collectGarbage, UPLOAD_DIR } = await import('./store.js');
const { composeOverlay, hasContent } = await import('./compose.js');
const { aiEnabled, aiConfig, processedImage } = await import('./ai.js');
const { reviewItem, allRows, toCsv } = await import('./review.js');
const { createGroup, computeGroup, groupsWith, forgetMember } = await import('./groups.js');
const { findPinPhotos } = await import('./pins.js');

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
  if (num(body.zoom) && body.zoom !== 1) it.zoom = clamp(body.zoom, 0.2, 8);
  if (body.layers && board.images[body.layers.a] && board.images[body.layers.b]) it.layers = { a: body.layers.a, b: body.layers.b };
  if (it.layers && body.fit && ['s', 'dx', 'dy'].every(k => num(body.fit[k]))) {
    it.fit = { s: clamp(body.fit.s, 0.1, 10), dx: clamp(body.fit.dx, -5, 5), dy: clamp(body.fit.dy, -5, 5) };
    if (body.fit.manual) it.fit.manual = true;
  }
  if (typeof body.label === 'string' && body.label) it.label = body.label.slice(0, 80);
  if (body.example) it.example = true;
  if (body.refOff) it.refOff = true;
  if (typeof body.source === 'string' && /^https?:\/\//.test(body.source)) it.source = body.source.slice(0, 500);
  if (typeof body.note === 'string' && body.note) it.note = body.note.slice(0, 200);
  if (body.compare) it.compare = true;
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

const withUrl = it => {
  const out = it.image ? { ...it, url: imageUrl(it.image) } : { ...it };
  if (it.layers) out.layerUrls = { a: imageUrl(it.layers.a), b: imageUrl(it.layers.b) };
  return out;
};

/* ---------- API ---------- */
const api = express.Router();
api.use(express.json({ limit: '20mb' }));

api.param('id', (req, res, next, id) => (ID.test(id) ? next() : res.status(400).json({ error: '잘못된 id입니다' })));

api.get('/board', (req, res) => {
  res.json({
    camera: board.camera,
    items: Object.values(board.items).map(withUrl),
    links: Object.values(board.links),
    groups: Object.values(board.groups || {}),
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
  // original file name (sent URL-encoded in a header) for the correction log's 그림 파일명
  let name = '';
  try { name = decodeURIComponent(String(req.get('X-File-Name') || '')).replace(/[\u0000-\u001f]/g, '').slice(0, 200); } catch {}
  board.images[id] = { file, width, height, bytes: req.body.length, createdAt: new Date().toISOString(), ...(name ? { name } : {}) };
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
  forgetMember(id);
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
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/** Build (or rebuild) an arrow's overlay. Used by the route and by the start-up refresh. */
async function buildOverlay(link, { refit = false } = {}) {
  const A = board.items[link.from], B = board.items[link.to];
  if (!hasContent(A) || !hasContent(B)) throw new HttpError(422, '겹쳐 보려면 화살표 양쪽에 사진이나 그림이 있어야 합니다');

  // With an API key: the arrow's start goes through prompt 1 (photo → line art) and its end
  // through prompt 2 (croquis photo → pencil lines) before they are mixed. Drawings made on
  // the board (pen strokes) are already lines and are used as they are.
  const ai = aiEnabled();
  let drawA = A.image, drawB = B.image;
  if (ai) {
    try {
      [drawA, drawB] = await Promise.all([
        A.image ? processedImage(A.image, 'lineart') : null,
        B.image ? processedImage(B.image, 'pencil') : null,
      ]);
    } catch (err) {
      console.error('[ai]', err.message);
      throw new HttpError(502, err.message);
    }
  }

  // Fit the drawings onto each other only when both sides are lines (AI-extracted or pen
  // strokes); on a raw photo the "dark pixels" would be the background, not the figure.
  const isLines = it => !it.image || ai;
  const align = isLines(A) && isLines(B);
  const prev = link.overlay && board.items[link.overlay];
  // a fit the person set by hand (Alt+drag / Alt+scroll) survives automatic rebuilds;
  // clicking the arrow again ({ refit: true }) goes back to the automatic fit
  const keepFit = !refit && prev?.fit?.manual ? prev.fit : null;

  let png, width, height, fit, layers;
  try { ({ png, width, height, fit, layers } = await composeOverlay(A, B, drawA, drawB, { align, fit: keepFit })); }
  catch (err) { console.error('[overlay]', err); throw new HttpError(500, '겹쳐 보기 이미지를 만들지 못했습니다'); }
  const label = ai ? '겹쳐 보기 · AI 선화 (사진 30% · 크로키 50%)' : '겹쳐 보기 · 원본 (사진 30% · 크로키 50%)';

  const saveImage = async (buf, extra) => {
    const id = crypto.randomUUID().replace(/-/g, '');
    const file = `${id}.png`;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, file), buf);
    board.images[id] = { file, width, height, bytes: buf.length, createdAt: new Date().toISOString(), overlayOf: link.id, ...extra };
    return id;
  };
  const imgId = await saveImage(png);
  const layerIds = { a: await saveImage(layers.a, { layer: 'a' }), b: await saveImage(layers.b, { layer: 'b' }) };
  const fitOut = { s: fit.s, dx: fit.dx, dy: fit.dy, ...(keepFit ? { manual: true } : {}) };

  let ov = link.overlay && board.items[link.overlay];
  let created = false;
  if (ov) {
    const cx = ov.x + ov.w / 2, cy = ov.y + ov.h / 2;
    Object.assign(ov, { w: B.w, h: B.h, x: cx - B.w / 2, y: cy - B.h / 2, image: imgId, label });
    delete ov.cover; delete ov.pos; delete ov.zoom; delete ov.layers; delete ov.fit; // red markup (strokes) is kept
  } else {
    const side = OPP[facingSide(B, A)], [nx, ny] = NORM[side];
    const order = Math.max(0, ...Object.values(board.items).map(i => i.order)) + 1;
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    ov = { id, x: B.x + nx * (B.w + GAP), y: B.y + ny * (B.h + GAP), w: B.w, h: B.h, order, image: imgId, label };
    board.items[id] = ov;
    link.overlay = id;
    created = true;
  }
  ov.layers = layerIds; ov.fit = fitOut;
  collectGarbage();
  persist();
  return { created, body: { item: withUrl(ov), link, created, ai, alignment: align && !keepFit ? fitOut : null } };
}

api.post('/links/:id/overlay', async (req, res) => {
  const link = board.links[req.params.id];
  if (!link) return res.status(404).json({ error: '화살표를 찾을 수 없습니다' });
  try {
    const r = await buildOverlay(link, { refit: !!req.body?.refit });
    res.status(r.created ? 201 : 200).json(r.body);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * On start: overlays whose AI line images came from an older line-extraction step are
 * rebuilt (the extraction is redone from stored results, so the model is not called again,
 * and a fit set by hand is kept).
 */
async function refreshOldOverlays() {
  if (!aiEnabled()) return;
  const { INK_VERSION } = await import('./ai.js');
  const stale = Object.values(board.links).filter(l => {
    if (!l.overlay || !board.items[l.overlay]) return false;
    return [[board.items[l.from], 'lineart'], [board.items[l.to], 'pencil']].some(([it, kind]) => {
      const id = it?.image && board.images[it.image]?.ai?.[kind];
      return id && board.images[id] && board.images[id].inkV !== INK_VERSION;
    });
  });
  for (const l of stale) {
    try { await buildOverlay(l); console.log(`[overlay] rebuilt ${l.overlay} with the new line extraction`); }
    catch (err) { console.error('[overlay] refresh failed:', err.message); }
  }
}

// Correction log (hidden table): analyse the red-pen marks on one canvas.
api.post('/items/:id/review', async (req, res) => {
  const it = board.items[req.params.id];
  if (!it) return res.status(404).json({ error: '항목을 찾을 수 없습니다' });
  if (!aiEnabled()) return res.json({ rows: [], skipped: true, reason: 'no-key' });
  try {
    const result = await reviewItem(it);
    // groups this canvas belongs to compare its log too: bring their common features up to date
    const groups = result.skipped ? [] : await Promise.all(groupsWith(it.id).map(g => computeGroup(g).catch(() => g)));
    res.json({ ...result, groups });
  }
  catch (err) { console.error('[review]', err.message); res.status(502).json({ error: err.message }); }
});
// Groups of overlays: bracket + circles with the features their correction logs share.
api.post('/groups', async (req, res) => {
  const ids = Array.isArray(req.body?.members) ? req.body.members.filter(id => ID.test(id) && board.items[id]) : [];
  if (ids.length < 2) return res.status(400).json({ error: '두 개 이상의 겹쳐 보기를 묶어야 합니다' });
  const g = createGroup(ids);
  try { res.json(await computeGroup(g)); }
  catch (err) { console.error('[groups]', err.message); g.note = err.message; res.json(g); } // shown under the bracket
});
// Practice photos from Pinterest for one circle (feature) of a group.
api.post('/groups/:id/pins', async (req, res) => {
  const g = board.groups?.[req.params.id];
  const f = g && (g.features || []).find(x => x.name === req.body?.name);
  if (!f) return res.status(404).json({ error: '공통 특징을 찾을 수 없습니다' });
  if (!aiEnabled()) return res.status(400).json({ error: 'Pinterest 검색에는 OpenAI API 키가 필요합니다' });
  try { res.json({ photos: await findPinPhotos(f, 4) }); }
  catch (err) { console.error('[pins]', err.message); res.status(502).json({ error: err.message }); }
});

api.delete('/groups/:id', (req, res) => {
  if (board.groups) delete board.groups[req.params.id];
  // arrows drawn from its circles go with it
  for (const [lid, l] of Object.entries(board.links)) if (l.from.startsWith(`f-${req.params.id}-`)) delete board.links[lid];
  persist();
  res.status(204).end();
});

// The whole log as JSON or as a spreadsheet-friendly CSV.
api.get('/reviews', (req, res) => res.json({ rows: allRows() }));
api.get('/reviews.csv', (req, res) => {
  res.type('text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="correction-log.csv"').send(toCsv(allRows()));
});

// Lets the page say up front whether arrows will use AI line extraction.
api.get('/config', (req, res) => {
  res.json({ ai: aiEnabled(), imageModel: aiConfig().model });
});

api.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: `파일이 너무 큽니다 (최대 ${MAX_UPLOAD})` });
  console.error('[api]', err);
  res.status(500).json({ error: '서버 오류가 발생했습니다' });
});
api.use((req, res) => res.status(404).json({ error: '없는 API 경로입니다' }));

app.use('/api', api);
app.use('/images', express.static(UPLOAD_DIR, { immutable: true, maxAge: '365d', fallthrough: false }));
// always revalidate the page's own files, so an iPad never keeps running an old version
app.use(express.static(FRONTEND_DIR, { index: 'index.html', setHeaders: res => res.set('Cache-Control', 'no-cache') }));

app.listen(PORT, () => {
  refreshOldOverlays().catch(err => console.error('[overlay]', err.message));
  console.log(`끄로뀌끼끼끼끼익: http://localhost:${PORT}`);
  console.log(aiEnabled()
    ? `AI 선화 추출 켜짐 (이미지 모델: ${aiConfig().model})`
    : 'AI 선화 추출 꺼짐: .env 에 OPENAI_API_KEY 를 넣으면 화살표 클릭 시 선화를 추출해 겹칩니다');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flushNow(); process.exit(0); });
