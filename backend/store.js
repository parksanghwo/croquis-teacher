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
  const used = new Set(Object.values(board.items).map(it => it.image).filter(Boolean));
  const now = Date.now();
  for (const [id, img] of Object.entries(board.images)) {
    if (used.has(id)) { img.attached = true; continue; }
    if (!img.attached && now - Date.parse(img.createdAt) < GRACE_MS) continue;
    delete board.images[id];
    fs.promises.unlink(path.join(UPLOAD_DIR, img.file)).catch(() => {});
  }
}
