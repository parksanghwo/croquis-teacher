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

const PIN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pins'],
  properties: { pins: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string' } } } } },
};

/** Step 1: pin page addresses from a web search limited to Pinterest. */
async function searchPinPages(feature) {
  const prompt = `다음 크로키 연습에 쓸 참고 사진을 Pinterest에서 찾으세요.
연습 사진 조건: ${feature.practice || feature.name}
고치려는 습관: ${feature.name}

- pinterest.com의 핀 페이지(주소에 /pin/이 들어간 페이지)만 고르세요.
- 사람의 실사 사진으로, 조건의 포즈나 부위가 잘 보이는 핀을 고르세요. 그림·일러스트, 여러 장을 이어 붙인 이미지, 글자가 많은 이미지, 광고는 빼세요.
- 서로 다른 핀으로 8개까지, 실제 검색 결과에 나온 주소만 적으세요.`;
  const data = await responses({
    model: textModel(),
    tools: [{ type: 'web_search', filters: { allowed_domains: ['pinterest.com'] } }],
    input: prompt,
    text: { format: { type: 'json_schema', name: 'pinterest_pins', schema: PIN_SCHEMA, strict: true } },
  }, 180_000);
  let listed = [];
  try { listed = JSON.parse(outputText(data)).pins.map(p => p.url); } catch {}
  const urls = [...new Set([...listed, ...citedUrls(data)])]
    .map(u => u.replace(/[?#].*$/, ''))
    .filter(u => allowedUrl(u) && /\/pin\//.test(u));
  return [...new Set(urls)].slice(0, 8);
}

/** Step 2: the pin's preview image (og:image), downloaded and checked. */
async function pinImage(pageUrl) {
  const page = await fetch(pageUrl, { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'ko,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  if (!page.ok || !allowedUrl(page.url)) throw new Error(`핀 페이지 ${page.status}`);
  const html = (await page.text()).slice(0, 2_000_000);
  const meta = name => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    return tag && tag.match(/content=["']([^"']+)["']/i)?.[1];
  };
  let src = meta('og:image') || meta('twitter:image') || meta('twitter:image:src');
  if (!src) throw new Error('미리보기 이미지가 없습니다');
  src = new URL(src.replace(/&amp;/g, '&'), page.url).toString();
  if (!allowedUrl(src)) throw new Error('Pinterest 밖의 이미지 주소');
  const img = await fetch(src, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(20_000) });
  if (!img.ok) throw new Error(`이미지 ${img.status}`);
  const buf = Buffer.from(await img.arrayBuffer());
  if (buf.length > MAX_IMAGE) throw new Error('이미지가 너무 큽니다');
  const m = await sharp(buf).metadata();
  if (!m.width || Math.min(m.width, m.height) < 250) throw new Error('이미지가 너무 작습니다');
  return { pageUrl, buf, width: m.width, height: m.height, format: m.format };
}

/** Step 3: which candidates fit the condition (indices). Falls back to all on failure. */
async function keepFitting(feature, cands) {
  try {
    const content = [{ type: 'input_text', text: `다음 크로키 연습 사진 조건에 맞는 사진의 번호를 고르세요. 사람의 실사 사진이어야 하고, 조건의 포즈나 부위가 잘 보여야 합니다. 그림, 여러 장을 이어 붙인 이미지, 글자가 많은 이미지는 빼세요.
조건: ${feature.practice || feature.name}` }];
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
  board.images[id] = { file, width: c.width, height: c.height, bytes: c.buf.length, createdAt: new Date().toISOString(), name: `pinterest-${pin || id.slice(0, 8)}`, source: c.pageUrl };
  return { id, url: imageUrl(id), width: c.width, height: c.height, source: c.pageUrl };
}

/** Up to `count` Pinterest photos for a feature → [{ id, url, width, height, source }]. */
export async function findPinPhotos(feature, count = 4) {
  const started = Date.now();
  const pages = await searchPinPages(feature);
  if (!pages.length) throw new Error('조건에 맞는 핀을 찾지 못했습니다');
  const got = (await Promise.allSettled(pages.map(pinImage))).filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!got.length) throw new Error('핀 이미지를 가져오지 못했습니다');
  const order = await keepFitting(feature, got);
  const chosen = (order.length ? order : got.map((_, i) => i)).slice(0, count).map(i => got[i]);
  const photos = [];
  for (const c of chosen) photos.push(await saveImage(c));
  persist();
  console.log(`[pins] ${feature.name}: ${pages.length} pins found, ${got.length} fetched, ${photos.length} kept in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return photos;
}
