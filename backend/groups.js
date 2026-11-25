// Groups of overlays (Shift+click several, or lasso them): the board draws a bracket joining
// them and circles with the error features their correction logs have in common.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { board, persist, imagePath, imageUrl, UPLOAD_DIR } from './store.js';
import { onWhite, applyFit, strokesSvg } from './compose.js';
import { aiConfig, aiEnabled } from './ai.js';
import { reviewItem, fileNameFor } from './review.js';

const textModel = () => process.env.OPENAI_MODEL || 'gpt-6-luna';
const UNSURE = '판단 어려움';

export const COMMON_PROMPT = `여러 크로키 피드백 표를 비교해, 서로 다른 그림 2장 이상에서 반복된 오류를 추출하세요.

- ‘교정 내용’과 ‘반복 패턴’을 함께 읽고, 무엇을 어떻게 잘못 그렸는지가 같으면 표현이 달라도 한 그룹으로 묶으세요. 예를 들어 ‘숙인 고개가 들려 보임’과 ‘고개를 덜 숙여 그림’은 같은 패턴입니다.
- 부위나 오류 유형만 같다고 묶지 마세요. 같은 부위라도 ‘넓게 그림’과 ‘좁게 그림’처럼 오차 방향이 반대면 구분하고, ‘판단 어려움’인 기록은 제외하세요.
- 같은 그림에서 같은 패턴이 여러 번 나와도 1장으로 세세요. 패턴별로 다음 연습에 적합한 사진의 조건을 한 가지씩 제시하세요.`;

// Output shape (the prompt above is used word for word; the field descriptions only say
// where each part goes on the board)
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['features'],
  properties: {
    features: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'drawings', 'practice', 'example'],
        properties: {
          name: { type: 'string', description: '원 안에 들어갈 반복된 오류 패턴. 무엇을 어떻게 잘못 그렸는지 15자 안팎으로' },
          drawings: { type: 'array', items: { type: 'string' }, description: '이 패턴이 나온 그림 파일명(표에 적힌 그대로), 그림마다 한 번씩' },
          practice: { type: 'string', description: '이 패턴을 연습하기에 적합한 사진의 조건 한 가지' },
          example: {
            type: 'object', additionalProperties: false, required: ['drawing', 'part'],
            description: '이 패턴이 가장 잘 드러난 그림 한 장과 그 표에 적힌 부위',
            properties: { drawing: { type: 'string' }, part: { type: 'string' } },
          },
        },
      },
    },
  },
};

/** Correction rows per member: { itemId, file, rows } (rows without '판단 어려움' patterns). */
function memberLogs(ids) {
  return ids.map(id => {
    const r = board.reviews?.[id];
    const file = r?.file || (board.items[id] ? fileNameFor(board.items[id]) : id);
    return { itemId: id, file, rows: (r?.rows || []).filter(x => x['반복 패턴'] && x['반복 패턴'] !== UNSURE) };
  });
}

/** Without AI: the same 반복 패턴 wording in two or more drawings. */
function commonByWording(logs) {
  const byPattern = new Map();
  for (const log of logs) for (const row of log.rows) {
    const key = row['반복 패턴'];
    if (!byPattern.has(key)) byPattern.set(key, { name: key, practice: '', drawings: new Set() });
    byPattern.get(key).drawings.add(log.file);
  }
  return [...byPattern.values()].filter(f => f.drawings.size >= 2).map(f => ({ ...f, drawings: [...f.drawings] }));
}

async function commonByModel(logs) {
  const { key, baseUrl } = aiConfig();
  const tables = logs.map(l => [
    `[${l.file}]`,
    '| 부위 | 교정 내용 | 오류 유형 | 반복 패턴 |',
    ...l.rows.map(r => `| ${r['부위']} | ${r['교정 내용']} | ${r['오류 유형']} | ${r['반복 패턴']} |`),
  ].join('\n')).join('\n\n');
  const res = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: textModel(),
      input: [{ role: 'user', content: [{ type: 'input_text', text: `${COMMON_PROMPT}\n\n${tables}` }] }],
      text: { format: { type: 'json_schema', name: 'common_features', schema: SCHEMA, strict: true } },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`공통 특징 분석 오류: ${body?.error?.message || res.status}`);
  const text = (body.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('') || body.output_text || '{}';
  const files = new Set(logs.map(l => l.file));
  return (JSON.parse(text).features || [])
    .map(f => ({
      name: String(f.name).slice(0, 40), practice: String(f.practice || '').slice(0, 80),
      drawings: [...new Set(f.drawings)].filter(d => files.has(d)),
      example: f.example && files.has(f.example.drawing) ? { drawing: f.example.drawing, part: String(f.example.part || '').slice(0, 40) } : null,
    }))
    .filter(f => f.drawings.length >= 2);
}

/* ---------- the picture inside each circle ---------- */

/** An overlay as it looks on the board: photo line art 30%, croquis 50%, red marks on top. */
async function overlayPicture(it) {
  const { width: W, height: H } = board.images[it.layers.b];
  const [la, lb] = await Promise.all([fs.promises.readFile(imagePath(it.layers.a)), fs.promises.readFile(imagePath(it.layers.b))]);
  const a = await onWhite(la), b = await onWhite(await applyFit(lb, it.fit || { s: 1, dx: 0, dy: 0 }, W, H));
  const out = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.round(0.5 * (0.7 * 255 + 0.3 * a[i]) + 0.5 * b[i]);
  const reds = (it.strokes || []).filter(s => s.c);
  const png = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { png: reds.length ? await sharp(png).composite([{ input: strokesSvg(reds, W, H) }]).png().toBuffer() : png, W, H };
}

const REGION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'h'],
  properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
};

/** Ask the model where a body part is on the picture: a box in percent of the image. */
async function locate(png, part, notes) {
  const { key, baseUrl } = aiConfig();
  const small = await sharp(png).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  const prompt = `첨부한 크로키 교정 이미지에서 ‘${part}’ 부분이 그려진 영역을 찾으세요.${notes ? ` 이 부위의 교정 내용: ${notes}` : ''}
빨간 교정선이 있으면 함께 포함하세요. 이미지 전체를 기준으로 영역의 왼쪽 위 x, y와 너비 w, 높이 h를 0~100 사이의 퍼센트로 답하세요.`;
  const res = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: textModel(),
      input: [{ role: 'user', content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: `data:image/png;base64,${small.toString('base64')}`, detail: 'high' },
      ] }],
      text: { format: { type: 'json_schema', name: 'region', schema: REGION_SCHEMA, strict: true } },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  const text = (body.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('') || '{}';
  const r = JSON.parse(text);
  if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w <= 0 || r.h <= 0) throw new Error('영역을 찾지 못했습니다');
  return r;
}

/** Square crop around a box (percent), a little roomier than the box, saved as an image. */
async function saveCrop(png, W, H, box) {
  const cx = ((box.x + box.w / 2) / 100) * W, cy = ((box.y + box.h / 2) / 100) * H;
  let side = Math.max((box.w / 100) * W, (box.h / 100) * H) * 1.35;
  side = Math.round(Math.min(Math.min(W, H), Math.max(side, Math.min(W, H) * 0.22)));
  const left = Math.round(Math.min(W - side, Math.max(0, cx - side / 2)));
  const top = Math.round(Math.min(H - side, Math.max(0, cy - side / 2)));
  const out = await sharp(png).extract({ left, top, width: side, height: side }).resize(480, 480).png().toBuffer();
  const id = crypto.randomUUID().replace(/-/g, '');
  const file = `${id}.png`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, file), out);
  board.images[id] = { file, width: 480, height: 480, bytes: out.length, createdAt: new Date().toISOString(), cropOf: 'group', attached: true };
  return id;
}

/** Give each feature a crop: from its example drawing (else the first one that shows it). */
async function addCrops(features, logs) {
  const byFile = new Map(logs.map(l => [l.file, l]));
  await Promise.all(features.map(async f => {
    const log = byFile.get(f.example?.drawing) || byFile.get(f.drawings[0]);
    const it = log && board.items[log.itemId];
    if (!it || !it.layers || !board.images[it.layers.a] || !board.images[it.layers.b]) return;
    try {
      const pic = await overlayPicture(it);
      let box = { x: 0, y: 0, w: 100, h: 100 };
      if (aiEnabled() && f.example?.part) {
        const notes = log.rows.filter(r => r['부위'] === f.example.part).map(r => r['교정 내용']).join(' / ');
        box = await locate(pic.png, f.example.part, notes);
      }
      f.crop = await saveCrop(pic.png, pic.W, pic.H, box);
      f.cropUrl = imageUrl(f.crop);
    } catch (err) {
      console.error('[groups] crop:', err.message);
    }
  }));
}

/** Work out a group's common features (logging any member corrections not yet logged). */
export async function computeGroup(group) {
  const members = group.members.filter(id => board.items[id]);
  if (aiEnabled()) await Promise.all(members.map(id => reviewItem(board.items[id]).catch(() => null)));
  const logs = memberLogs(members);
  const enough = logs.filter(l => l.rows.length).length >= 2;
  let features = [];
  if (enough) features = aiEnabled() ? await commonByModel(logs) : commonByWording(logs);
  features.sort((a, b) => b.drawings.length - a.drawings.length);
  await addCrops(features, logs);
  Object.assign(group, { members, features, total: members.length, at: new Date().toISOString() });
  persist();
  return group;
}

export function createGroup(memberIds) {
  board.groups ||= {};
  const members = [...new Set(memberIds)].filter(id => board.items[id]);
  const same = Object.values(board.groups).find(g => g.members.length === members.length && g.members.every(m => members.includes(m)));
  if (same) return same;
  // grouping again over a bigger set replaces the smaller groups it covers
  for (const old of Object.values(board.groups)) if (old.members.every(m => members.includes(m))) delete board.groups[old.id];
  const g = { id: crypto.randomUUID().replace(/-/g, '').slice(0, 16), members, features: [], total: members.length, at: new Date().toISOString() };
  board.groups[g.id] = g;
  persist();
  return g;
}

/** Groups that contain an item. */
export const groupsWith = id => Object.values(board.groups || {}).filter(g => g.members.includes(id));

/** Drop a deleted item from its groups; a group left with fewer than two members goes. */
export function forgetMember(id) {
  for (const g of groupsWith(id)) {
    g.members = g.members.filter(m => m !== id);
    if (g.members.length < 2) delete board.groups[g.id];
  }
}
