// Practice photos from Pinterest for a common-feature circle:
// 1. the model (OPENAI_MODEL, default gpt-6-luna) searches the web, limited to pinterest.com,
//    for pin pages that fit the circle's "next practice photo" condition;
// 2. the server opens each pin page and takes its preview image (og:image);
// 3. the model looks at the candidates and keeps the ones that fit; up to 4 are saved.
// Only Pinterest hosts are ever fetched (PINTEREST_HOSTS), so the server can't be pointed
// at arbitrary addresses.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { board, persist, imageUrl, UPLOAD_DIR } from './store.js';
import { aiConfig } from './ai.js';

const textModel = () => process.env.OPENAI_MODEL || 'gpt-6-luna';
const HOSTS = () => (process.env.PINTEREST_HOSTS || 'pinterest.com,pinimg.com').split(',').map(h => h.trim()).filter(Boolean);
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const MAX_IMAGE = 15 * 1024 * 1024;

/** Pinterest addresses only (any pinterest.<tld>, pin.it short links and pinimg.com images). */
export function allowedUrl(u) {
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    return HOSTS().some(h => host === h || host.endsWith('.' + h)) || /(^|\.)pinterest\.[a-z.]+$/.test(host) || host === 'pin.it';
  } catch { return false; }
}

async function responses(body, timeoutMs) {
  const { key, baseUrl } = aiConfig();
  const res = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}
const outputText = data => (data.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('') || data.output_text || '';
const citedUrls = data => (data.output || []).flatMap(o => o.content || []).flatMap(c => c.annotations || []).filter(a => a.type === 'url_citation').map(a => a.url);

export const PIN_PROMPT = `첨부한 표의 ‘다음 연습 사진의 조건’을 읽고, 각 공통 오류 패턴을 연습하기 좋은 실사 사진을 핀터레스트에서 찾아주세요.

- 머리부터 양발 끝까지 화면 안에 들어온 선명한 전신 사진을 고르세요. 확대했을 때 인물의 윤곽과 연습할 부위를 뚜렷하게 볼 수 있어야 합니다.
- 각 사진이 해당 행의 연습 조건을 충족하는지 직접 확인하세요. 예를 들어 ‘팔과 몸통 사이 간격’이 연습 대상이면 팔과 옆구리 사이의 여백이 잘 보이는 사진을 고르세요.
- 사진마다 어떤 부분을 보고 연습하면 되는지 한 문장으로 적고, 해당 사진을 바로 열 수 있는 개별 핀 링크를 제공하세요. 검색 결과나 보드 링크는 제외하세요.`;

const PIN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pins'],
  properties: {
    pins: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['url', 'note'],
        properties: {
          url: { type: 'string', description: '개별 핀 링크 (주소에 /pin/이 들어간 핀 페이지)' },
          note: { type: 'string', description: '이 사진에서 어떤 부분을 보고 연습하면 되는지 한 문장' },
        },
      },
    },
  },
};

/** Step 1: pin pages (with a one-line practice note each) from a web search limited to Pinterest. */
async function searchPinPages(feature) {
  const table = `| 공통 오류 패턴 | 다음 연습 사진의 조건 |\n|---|---|\n| ${feature.name} | ${feature.practice || feature.name} |`;
  const data = await responses({
    model: textModel(),
    tools: [{ type: 'web_search', filters: { allowed_domains: ['pinterest.com'] } }],
    // the user's prompt as written, the table it refers to, and how many candidates to send
    // (a few are dropped later when the photos are checked)
    input: `${PIN_PROMPT}\n\n${table}\n\n후보 핀은 서로 다른 것으로 8개까지 주세요.`,
    text: { format: { type: 'json_schema', name: 'pinterest_pins', schema: PIN_SCHEMA, strict: true } },
  }, 180_000);
  const notes = new Map();
  try {
    for (const p of JSON.parse(outputText(data)).pins) notes.set(p.url.replace(/[?#].*$/, ''), String(p.note || '').slice(0, 200));
  } catch {}
  const urls = [...new Set([...notes.keys(), ...citedUrls(data).map(u => u.replace(/[?#].*$/, ''))])]
    .filter(u => allowedUrl(u) && /\/pin\//.test(u));   // individual pins only: no search or board links
  return urls.slice(0, 8).map(url => ({ url, note: notes.get(url) || '' }));
}

/** The pin's picture address: og:image / twitter:image, else the first full-size pinimg.com
 *  image in the page, else Pinterest's oEmbed thumbnail (pages often come without meta tags). */
async function pinImageUrl(pageUrl) {
  let page = null, html = '';
  try {
    page = await fetch(pageUrl, { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'ko,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    if (page.ok && allowedUrl(page.url)) html = (await page.text()).slice(0, 3_000_000);
  } catch {}
  const meta = name => {
    const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i'))?.[0];
    return tag && tag.match(/content=["']([^"']+)["']/i)?.[1];
  };
  let src = meta('og:image') || meta('twitter:image') || meta('twitter:image:src');
  if (!src) src = html.match(/https:\/\/i\.pinimg\.com\/(?:originals|736x|564x)\/[0-9a-f/]+\.(?:jpg|jpeg|png|webp)/i)?.[0];
  if (src) return new URL(src.replace(/&amp;/g, '&'), page.url).toString();
  try {
    const o = await fetch(`https://www.pinterest.com/oembed.json?url=${encodeURIComponent(pageUrl)}`, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(15_000) });
    const j = o.ok ? await o.json() : null;
    if (j?.thumbnail_url) return j.thumbnail_url.replace(/\/(?:236x|474x)\//, '/736x/');
  } catch {}
  throw new Error(page ? (page.ok ? '핀 페이지에 이미지 주소가 없음' : `핀 페이지 ${page.status}`) : '핀 페이지에 연결하지 못함');
}

/** Step 2: the pin's picture, downloaded and checked. */
async function pinImage({ url: pageUrl, note }) {
  const src = await pinImageUrl(pageUrl);
  if (!allowedUrl(src)) throw new Error('Pinterest 밖의 이미지 주소');
  const img = await fetch(src, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(20_000) });
  if (!img.ok) throw new Error(`이미지 ${img.status}`);
  const buf = Buffer.from(await img.arrayBuffer());
  if (buf.length > MAX_IMAGE) throw new Error('이미지가 너무 큽니다');
  const m = await sharp(buf).metadata();
  if (!m.width || Math.min(m.width, m.height) < 250) throw new Error('이미지가 너무 작습니다');
  return { pageUrl, note, buf, width: m.width, height: m.height, format: m.format };
}

/** Step 3: which candidates fit the condition (indices). Falls back to all on failure. */
async function keepFitting(feature, cands) {
  try {
    const content = [{ type: 'input_text', text: `아래 사진들 가운데 크로키 연습에 쓸 수 있는 사진의 번호를 고르세요.
- 머리부터 양발 끝까지 화면 안에 들어온 선명한 전신 실사 사진이어야 합니다. 확대했을 때 인물의 윤곽과 연습할 부위를 뚜렷하게 볼 수 있어야 합니다.
- 다음 연습 조건을 충족하는지 사진을 직접 보고 확인하세요. 예를 들어 ‘팔과 몸통 사이 간격’이 연습 대상이면 팔과 옆구리 사이의 여백이 잘 보여야 합니다.
- 그림, 여러 장을 이어 붙인 이미지, 글자가 많은 이미지는 빼세요.
공통 오류 패턴: ${feature.name}
다음 연습 사진의 조건: ${feature.practice || feature.name}` }];
    for (const [i, c] of cands.entries()) {
      const small = await sharp(c.buf).rotate().resize({ width: 512, height: 512, fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
      content.push({ type: 'input_text', text: `${i + 1}번` }, { type: 'input_image', image_url: `data:image/jpeg;base64,${small.toString('base64')}`, detail: 'low' });
    }
    const data = await responses({
      model: textModel(),
      input: [{ role: 'user', content }],
      text: { format: { type: 'json_schema', name: 'fitting', strict: true, schema: { type: 'object', additionalProperties: false, required: ['fit'], properties: { fit: { type: 'array', items: { type: 'integer' } } } } } },
    }, 90_000);
    const fit = JSON.parse(outputText(data)).fit.map(n => n - 1).filter(i => i >= 0 && i < cands.length);
    return [...new Set(fit)];
  } catch (err) {
    console.error('[pins] check:', err.message);
    return cands.map((_, i) => i);
  }
}

async function saveImage(c) {
  const ext = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif' }[c.format] || 'jpg';
  const id = crypto.randomUUID().replace(/-/g, '');
  const file = `${id}.${ext}`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, file), c.buf);
  const pin = c.pageUrl.match(/\/pin\/([^/]+)/)?.[1];
  board.images[id] = { file, width: c.width, height: c.height, bytes: c.buf.length, createdAt: new Date().toISOString(), name: `pinterest-${pin || id.slice(0, 8)}`, source: c.pageUrl, note: c.note };
  return { id, url: imageUrl(id), width: c.width, height: c.height, source: c.pageUrl, note: c.note };
}

/** Up to `count` Pinterest photos for a feature → [{ id, url, width, height, source }]. */
export async function findPinPhotos(feature, count = 4) {
  const started = Date.now();
  let pages;
  try { pages = await searchPinPages(feature); }
  catch (err) { throw new Error(err.name === 'TimeoutError' ? 'Pinterest 검색이 3분 안에 끝나지 않았습니다' : `Pinterest 검색 오류: ${err.message}`); }
  if (!pages.length) throw new Error('웹 검색에서 개별 핀 링크를 찾지 못했습니다');
  const settled = await Promise.allSettled(pages.map(pinImage));
  const got = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!got.length) {
    // the most common reason, e.g. "핀 페이지 403 (5/6)"
    const why = new Map();
    for (const r of settled) if (r.status === 'rejected') why.set(r.reason.message, (why.get(r.reason.message) || 0) + 1);
    const [top, n] = [...why].sort((a, b) => b[1] - a[1])[0];
    console.error('[pins] no images:', [...why].map(([m, k]) => `${m} ×${k}`).join(', '), pages.map(p => p.url).join(' '));
    throw new Error(`핀 ${pages.length}개를 찾았지만 사진을 가져오지 못했습니다: ${top} (${n}/${pages.length})`);
  }
  const order = await keepFitting(feature, got);
  const chosen = (order.length ? order : got.map((_, i) => i)).slice(0, count).map(i => got[i]);
  const photos = [];
  for (const c of chosen) photos.push(await saveImage(c));
  persist();
  console.log(`[pins] ${feature.name}: ${pages.length} pins found, ${got.length} fetched, ${photos.length} kept in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return photos;
}
