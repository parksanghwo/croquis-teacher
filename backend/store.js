// Board storage: one JSON file (data/board.json) plus image files in data/uploads/.
// Everything is kept in memory and written back shortly after each change.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.resolve(import.meta.dirname, '..', 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const BOARD_FILE = path.join(DATA_DIR, 'board.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function emptyBoard() {
  return { version: 1, camera: null, items: {}, links: {}, images: {} };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
    return { ...emptyBoard(), ...raw };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[store] board.json could not be read, starting empty:', err.message);
    return emptyBoard();
  }
}

export const board = load();

// labels written by older versions ("각 50%") → current mix (photo line art 30%, croquis 50%)
for (const it of Object.values(board.items)) {
  if (it.label && it.label.endsWith(' 각 50%')) it.label = it.label.replace(' 각 50%', ' (사진 30% · 크로키 50%)');
}

let timer = null;
let writing = Promise.resolve();
export function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const json = JSON.stringify(board);
    // write to a temp file, then rename, so a crash never leaves a half-written board
    writing = writing.then(async () => {
      const tmp = BOARD_FILE + '.tmp';
      await fs.promises.writeFile(tmp, json);
      await fs.promises.rename(tmp, BOARD_FILE);
    }).catch(err => console.error('[store] save failed:', err.message));
  }, 200);
}

export function flushNow() {
  clearTimeout(timer);
  fs.writeFileSync(BOARD_FILE, JSON.stringify(board));
}

export const imageUrl = id => (board.images[id] ? `/images/${board.images[id].file}` : null);
export const imagePath = id => path.join(UPLOAD_DIR, board.images[id].file);

/**
 * Delete image files that no item uses any more. An upload arrives before the item
 * that uses it is saved, so images never attached to an item get an hour of grace.
 */
const GRACE_MS = 60 * 60 * 1000;
export function collectGarbage() {
  const used = new Set(Object.values(board.items).flatMap(it => [it.image, it.layers?.a, it.layers?.b]).filter(Boolean));
  for (const g of Object.values(board.groups || {})) for (const f of g.features || []) if (f.crop) used.add(f.crop);
  // AI line versions live as long as the photo they were made from
  for (const id of [...used]) for (const aiId of [...Object.values(board.images[id]?.ai || {}), ...Object.values(board.images[id]?.aiRaw || {})]) used.add(aiId);
  const now = Date.now();
  for (const [id, img] of Object.entries(board.images)) {
    if (used.has(id)) { img.attached = true; continue; }
    if (!img.attached && now - Date.parse(img.createdAt) < GRACE_MS) continue;
    delete board.images[id];
    fs.promises.unlink(path.join(UPLOAD_DIR, img.file)).catch(() => {});
  }
}
