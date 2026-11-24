// AI line extraction with an OpenAI image model (images/edits).
//  - lineart: reference photo → croquis-practice line art   (arrow's start)
//  - pencil:  photo of a pencil croquis → pencil lines only  (arrow's end)
// Results are transparent PNGs at the original canvas size, cached per source image,
// so each photo goes to the model once no matter how often the overlay is rebuilt.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { board, persist, imagePath, UPLOAD_DIR } from './store.js';

export const PROMPTS = {
  lineart: `첨부한 실사 사진을 기반으로 크로키 연습용 선화를 추출하세요.
작업 규칙

1. 원본 사진의 인체 비례, 포즈, 관절 위치, 의복 실루엣을 픽셀 단위로 최대한 정확하게 유지하세요.
2. 새로운 그림을 생성하거나 인체를 재해석하지 말고, 원본 사진 위에서 직접 윤곽선을 트레이싱하세요.
3. 인체와 의복의 주요 외곽선은 원본과 동일한 위치를 따라야 합니다.
4. 옷 주름은 형태, 부피, 장력의 방향을 설명하는 핵심 주름만 남기고 단순화하세요.
5. 얼굴, 머리카락, 손, 신발은 주요 형태와 방향을 유지하면서 세부 묘사만 생략하세요.
6. 검은색 선과 흰색 배경으로 구성하고 명암, 색상, 질감은 제거하세요.
7. 원본 사진과 선화를 겹쳤을 때 외곽선이 최대한 일치해야 합니다. 미적으로 보정하거나 비례를 이상화하지 마세요.

출력: 원본과 동일한 캔버스 크기의 선화 PNG. 투명 배경 버전.`,
  pencil: `첨부한 크로키 사진에서 연필선만 추출하세요.
작업 규칙

1. 크로키의 모든 선을 원본 위치와 형태 그대로 보존하세요.
2. 종이 배경, 조명 그림자, 얼룩, 촬영 노이즈만 제거하세요.
3. 희미한 보조선과 진한 윤곽선을 가능한 한 모두 보존하세요.
4. 선을 새로 생성하거나 다듬거나 연결하지 마세요.
5. 인체 비례, 형태, 선 굵기, 선의 흔들림을 임의로 수정하지 마세요.
6. 원본 캔버스의 비율과 크기를 유지하세요.

출력: 검은색 선만 남긴 투명 PNG.
최우선 원칙은 원본 선의 정확한 보존입니다.`,
};

export const aiConfig = () => ({
  key: process.env.OPENAI_API_KEY || '',
  model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.6-flare',
  baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
});
export const aiEnabled = () => !!aiConfig().key;

/**
 * Pad the image with white so its ratio is within 1:3–3:1, scale the long edge to 1536
 * and round both sides to multiples of 16. Returns the PNG and where the original sits.
 */
export async function prepareForModel(file, w, h, longEdge = 1536) {
  const r = Math.max(1 / 3, Math.min(3, w / h));
  const cw = r >= w / h ? Math.round(h * r) : w;
  const ch = r >= w / h ? h : Math.round(w / r);
  const s = longEdge / Math.max(cw, ch);
  const W = Math.max(16, Math.round((cw * s) / 16) * 16);
  const H = Math.max(16, Math.round((ch * s) / 16) * 16);
  const dw = Math.round((w / cw) * W), dh = Math.round((h / ch) * H);
  const ox = Math.round((W - dw) / 2), oy = Math.round((H - dh) / 2);
  const inner = await sharp(file).rotate().flatten({ background: '#ffffff' }).resize(dw, dh, { fit: 'fill' }).png().toBuffer();
  const png = await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
    .composite([{ input: inner, left: ox, top: oy }]).png().toBuffer();
  return { png, size: `${W}x${H}`, crop: { x: ox / W, y: oy / H, w: dw / W, h: dh / H } };
}

/** Cut the original area back out of the model's result and scale it to the original canvas. */
export async function restoreFromModel(buf, crop, w, h) {
  const flat = sharp(buf).flatten({ background: '#ffffff' });
  const { width: W, height: H } = await sharp(buf).metadata();
  const left = Math.max(0, Math.round(crop.x * W)), top = Math.max(0, Math.round(crop.y * H));
  const cw = Math.min(W - left, Math.round(crop.w * W)), ch = Math.min(H - top, Math.round(crop.h * H));
  return flat.extract({ left, top, width: cw, height: ch }).resize(w, h, { fit: 'fill' }).png().toBuffer();
}

/** White paper → transparent: darkness becomes alpha, lines become near-black ink. */
export async function toTransparentInk(buf) {
  const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    const a = Math.max(0, Math.min(255, Math.round((255 - data[i * info.channels]) * (255 / 228))));
    out[i * 4] = 27; out[i * 4 + 1] = 27; out[i * 4 + 2] = 31; out[i * 4 + 3] = a;
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function callModel(png, size, prompt) {
  const { key, model, baseUrl } = aiConfig();
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('output_format', 'png');
  form.append('image', new Blob([png], { type: 'image/png' }), 'input.png');
  let res;
  try {
    res = await fetch(`${baseUrl}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(240_000) });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? '이미지 모델 응답이 4분 안에 오지 않았습니다' : `이미지 모델에 연결하지 못했습니다 (${err.message})`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(res.status === 401 ? 'OpenAI API 키가 올바르지 않습니다' : `이미지 모델 오류: ${msg}`);
  }
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error('이미지 모델이 결과 이미지를 돌려주지 않았습니다');
  return Buffer.from(b64, 'base64');
}

const inflight = new Map();

/**
 * Returns the id of the processed (transparent line) version of an uploaded image,
 * running the model only the first time for each image and kind.
 */
export function processedImage(imageId, kind) {
  const meta = board.images[imageId];
  if (!meta) throw new Error('원본 이미지를 찾을 수 없습니다');
  const cached = meta.ai?.[kind];
  if (cached && board.images[cached]) return Promise.resolve(cached);
  const k = `${imageId}:${kind}`;
  if (inflight.has(k)) return inflight.get(k);
  const job = (async () => {
    const started = Date.now();
    const prep = await prepareForModel(imagePath(imageId), meta.width, meta.height);
    const result = await callModel(prep.png, prep.size, PROMPTS[kind]);
    const restored = await restoreFromModel(result, prep.crop, meta.width, meta.height);
    const png = await toTransparentInk(restored);
    const id = crypto.randomUUID().replace(/-/g, '');
    const file = `${id}.png`;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, file), png);
    board.images[id] = { file, width: meta.width, height: meta.height, bytes: png.length, createdAt: new Date().toISOString(), aiOf: imageId, kind, model: aiConfig().model, attached: true };
    meta.ai = { ...meta.ai, [kind]: id };
    persist();
    console.log(`[ai] ${kind} for ${imageId} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return id;
  })().finally(() => inflight.delete(k));
  inflight.set(k, job);
  return job;
}
