// Correction log: after a red-pen correction, a vision model (default gpt-6-luna) compares
// the croquis' own lines with the red correction lines, arrows and notes, and returns one
// table row per error. Rows are kept per canvas in board.reviews and never shown on the board;
// read them from GET /api/reviews (JSON) or /api/reviews.csv.
import crypto from 'node:crypto';
import fs from 'node:fs';
import sharp from 'sharp';
import { board, persist, imagePath } from './store.js';
import { renderLayer, strokesSvg, applyFit, onWhite } from './compose.js';
import { aiConfig } from './ai.js';

export const REVIEW_PROMPT = `첨부한 크로키의 원래 선과 교정선·화살표·메모를 비교해, 피드백에서 확인되는 오류를 한 행에 하나씩 기록하세요.

| 그림 파일명 | 부위 | 교정 내용 | 오류 유형 | 반복 패턴 |

- ‘교정 내용’에는 어디를 어떻게 고쳤는지 적으세요. ‘팔을 안쪽으로’처럼 방향만 쓰지 말고 ‘허리 옆의 팔을 몸통 쪽으로 붙임’처럼 기준점을 밝혀 주세요.
- ‘오류 유형’은 각도, 위치·간격, 크기·비율, 윤곽·형태, 선의 흐름 중 가장 적합한 하나를 고르세요.
- ‘반복 패턴’은 ‘팔과 몸통 사이를 넓게 그림’처럼 원래 그림이 어떻게 어긋났는지 짧게 쓰세요. 여러 그림에서 같은 오류가 나오면 같은 표현을 쓰고, 어긋난 방향이 반대라면 구분하세요.
- 표시만으로 오류를 특정하기 어려우면 해당 칸에 ‘판단 어려움’으로 적으세요. 새로운 피드백을 추가하지 말고 표만 출력하세요.`;

export const COLUMNS = ['그림 파일명', '부위', '교정 내용', '오류 유형', '반복 패턴'];
const textModel = () => process.env.OPENAI_MODEL || 'gpt-6-luna';
const RED = /^#e0262b$/i;

/** The red-pen strokes on an item (black pen strokes on empty frames are the drawing itself). */
const redStrokes = it => (it.strokes || []).filter(s => s.c && RED.test(s.c));

/** File name shown in the table: the croquis photo's original name where there is one. */
export function fileNameFor(it) {
  const link = Object.values(board.links).find(l => l.overlay === it.id);
  const base = link ? board.items[link.to] : it;            // an overlay is a correction of its croquis
  const name = base?.image && board.images[base.image]?.name;
  if (name) return name;
  return base?.image ? `사진 ${base.image.slice(0, 8)}` : `보드 그림 ${base?.id || it.id}`;
}

/**
 * The picture the model reads: the croquis' own lines (gray, like pencil) with the red
 * corrections on top. On an overlay the reference line art is left out, so only the
 * student's lines and the teacher's marks are compared.
 */
async function renderForReview(it) {
  let W, H, base;
  if (it.layers && board.images[it.layers.b]) {
    ({ width: W, height: H } = board.images[it.layers.b]);
    const layerB = await fs.promises.readFile(imagePath(it.layers.b));
    base = await onWhite(await applyFit(layerB, it.fit || { s: 1, dx: 0, dy: 0 }, W, H));
  } else {
    const long = 1600, r = it.h / it.w;
    W = r <= 1 ? long : Math.round(long / r); H = Math.round(W * r);
    base = await onWhite(await renderLayer({ ...it, strokes: (it.strokes || []).filter(s => !RED.test(s.c || '')) }, W, H));
  }
  // lighten the croquis to pencil gray so the red marks stand out, as on paper
  for (let i = 0; i < base.length; i++) base[i] = 255 - Math.round((255 - base[i]) * 0.55);
  // two passes: in one sharp pipeline the resize would run before the composite
  const marked = await sharp(base, { raw: { width: W, height: H, channels: 3 } })
    .composite([{ input: strokesSvg(redStrokes(it), W, H) }])
    .png().toBuffer();
  const png = await sharp(marked)
    .resize({ width: W >= H ? 1536 : undefined, height: H > W ? 1536 : undefined, withoutEnlargement: true })
    .png().toBuffer();
  return png;
}

/** Rows of a markdown table (header and separator lines dropped). */
export function parseTable(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (cells.every(c => /^:?-{2,}:?$/.test(c) || c === '')) continue;   // |---|---|
    if (cells[0] === COLUMNS[0] && cells[1] === COLUMNS[1]) continue;    // header
    if (cells.length < 5) continue;
    rows.push(Object.fromEntries(COLUMNS.map((k, i) => [k, cells.slice(0, 5)[i] || ''])));
  }
  return rows;
}

async function askModel(png, fileName) {
  const { key, baseUrl } = aiConfig();
  // Earlier wording of 반복 패턴 from other drawings, so the model can reuse the same phrase.
  const known = [...new Set(Object.values(board.reviews || {}).flatMap(r => r.rows.map(x => x['반복 패턴'])).filter(p => p && p !== '판단 어려움'))].slice(-60);
  const context = [`그림 파일명: ${fileName}`, known.length ? `지금까지 기록된 반복 패턴 표현: ${known.join(' / ')}` : ''].filter(Boolean).join('\n');
  let res;
  try {
    res = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: textModel(),
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: `${REVIEW_PROMPT}\n\n${context}` },
            { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}`, detail: 'high' },
          ],
        }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? '교정 분석 응답이 3분 안에 오지 않았습니다' : `교정 분석 모델에 연결하지 못했습니다 (${err.message})`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 401 ? 'OpenAI API 키가 올바르지 않습니다' : `교정 분석 모델 오류: ${body?.error?.message || res.status}`);
  const parts = (body.output || []).flatMap(o => o.content || []);
  if (parts.some(c => c.type === 'refusal')) throw new Error('이 그림은 분석할 수 없다는 응답을 받았습니다');
  return parts.filter(c => c.type === 'output_text').map(c => c.text).join('\n') || body.output_text || '';
}

const running = new Map();

/**
 * Log the corrections on one item. Skips when nothing changed since the last log; clears
 * the item's rows when its red marks are all gone. Returns { rows, skipped?, cleared? }.
 */
export function reviewItem(it) {
  board.reviews ||= {};
  const red = redStrokes(it);
  if (!red.length) {
    if (board.reviews[it.id]) { delete board.reviews[it.id]; persist(); }
    return Promise.resolve({ rows: [], cleared: true });
  }
  const key = crypto.createHash('sha1').update(JSON.stringify([red, it.fit || null, it.layers || null, it.image || null])).digest('hex');
  const prev = board.reviews[it.id];
  if (prev && prev.key === key) return Promise.resolve({ rows: prev.rows, skipped: true });
  if (running.has(it.id)) return running.get(it.id);
  const job = (async () => {
    const started = Date.now();
    const fileName = fileNameFor(it);
    const text = await askModel(await renderForReview(it), fileName);
    const rows = parseTable(text).map(r => ({ ...r, '그림 파일명': r['그림 파일명'] || fileName }));
    board.reviews[it.id] = { file: fileName, rows, key, model: textModel(), at: new Date().toISOString() };
    persist();
    console.log(`[review] ${fileName}: ${rows.length} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return { rows };
  })().finally(() => running.delete(it.id));
  running.set(it.id, job);
  return job;
}

/** All rows, oldest canvas first, as one table. */
export function allRows() {
  return Object.entries(board.reviews || {})
    .sort((a, b) => a[1].at.localeCompare(b[1].at))
    .flatMap(([itemId, r]) => r.rows.map(row => ({ ...row, itemId, at: r.at })));
}

export function toCsv(rows) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '﻿' + [COLUMNS.map(esc).join(','), ...rows.map(r => COLUMNS.map(k => esc(r[k])).join(','))].join('\r\n') + '\r\n';
}
