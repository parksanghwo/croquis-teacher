// 끄로뀌끼끼끼끼익 — frontend
// Board UI: camera, items, arrows, knobs, drawing mode, viewer. Saving, image storage
// and overlay composition go through the backend (see api.js).
import { api } from './api.js';
import { cropGeom, strokeSeg, drawStroke, renderStrokes } from './strokes.js';
import { compareLayers } from './compare.js';

const vp = document.getElementById('viewport');
const world = document.getElementById('world');
const zoomLabel = document.getElementById('zoomLabel');
const delBtn = document.getElementById('delBtn');
const fileInput = document.getElementById('fileInput');
const dropEl = document.getElementById('drop');
const toastEl = document.getElementById('toast');

const cam = { x: 0, y: 0, z: 1 };
let items = [];            // {id,x,y,w,h,order,image,url,el,cover,pos,zoom,strokes,label,example}; image = server image id
const selected = new Set();
let links = [];            // {id, from, to, side}  side = knob side on the source
let selLink = null;
const linksSvg = document.getElementById('links');
const SVGNS = 'http://www.w3.org/2000/svg';
let orderCounter = 0;
const MINZ = 0.03, MAXZ = 12;

/* ---------- camera ---------- */
function applyCam() {
  world.style.transform = `translate(${cam.x}px,${cam.y}px) scale(${cam.z})`;
  let g = 24 * cam.z;
  while (g < 12) g *= 4;
  while (g > 96) g /= 4;
  vp.style.backgroundSize = `${g}px ${g}px`;
  vp.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
  document.documentElement.style.setProperty('--inv', String(1 / cam.z));
  zoomLabel.textContent = Math.round(cam.z * 100) + '%';
  renderLinks();
  scheduleSave();
}
const toWorld = (sx, sy) => ({ x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z });
function zoomAt(sx, sy, factor) {
  const nz = Math.min(MAXZ, Math.max(MINZ, cam.z * factor));
  const w = toWorld(sx, sy);
  cam.z = nz;
  cam.x = sx - w.x * nz;
  cam.y = sy - w.y * nz;
  applyCam();
}
const center = () => ({ x: vp.clientWidth / 2, y: vp.clientHeight / 2 });

function fitAll() {
  if (!items.length) { cam.x = center().x; cam.y = center().y; cam.z = 1; applyCam(); return; }
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const it of items) { a = Math.min(a, it.x); b = Math.min(b, it.y); c = Math.max(c, it.x + it.w); d = Math.max(d, it.y + it.h); }
  const pad = 80, W = vp.clientWidth, H = vp.clientHeight;
  const z = Math.min(MAXZ, Math.max(MINZ, Math.min((W - pad * 2) / (c - a), (H - pad * 2 - 60) / (d - b), 2)));
  cam.z = z;
  cam.x = W / 2 - ((a + c) / 2) * z;
  cam.y = (H - 60) / 2 - ((b + d) / 2) * z;
  applyCam();
}

/* ---------- items ---------- */
function makeEl(it) {
  const el = document.createElement('div');
  el.className = 'item';
  el.dataset.id = it.id;
  fillContent(it, el);
  const tagText = it.example ? '예시 이미지 · 지워도 됩니다' : it.label;
  if (tagText) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = tagText; el.appendChild(t); }
  for (const k of ['nw', 'ne', 'sw', 'se']) { const h = document.createElement('div'); h.className = 'h ' + k; h.dataset.h = k; el.appendChild(h); }
  for (const k of ['n', 'e', 's', 'w']) {
    const kn = document.createElement('div'); kn.className = 'k ' + k; kn.dataset.k = k;
    kn.title = '드래그해서 같은 크기의 빈 캔버스 만들기';
    kn.innerHTML = '<svg viewBox="0 0 12 12"><path d="M6 2v8M2 6h8"/></svg>';
    el.appendChild(kn);
  }
  it.el = el;
  layout(it);
  world.appendChild(el);
}
function fillContent(it, el) {
  const old = el.querySelector('.clip, .frame-box'); if (old) old.remove();
  let node;
  if (it.layers && it.layerUrls) {
    // AI overlay kept as two layers on white, each at 50%: reference line art (a) fixed,
    // croquis (b) placed by it.fit so Alt+drag / Alt+scroll can move and size it live
    node = document.createElement('div'); node.className = 'clip layered';
    for (const k of ['a', 'b']) {
      const img = document.createElement('img');
      img.className = 'layer-' + k; img.src = it.layerUrls[k]; img.alt = ''; img.draggable = false;
      node.appendChild(img);
    }
    if (it.strokes && it.strokes.length) {
      const c = document.createElement('canvas');
      const long = 1600, r = it.h / it.w;
      c.width = r <= 1 ? long : Math.round(long / r); c.height = Math.round(c.width * r);
      renderStrokes(c.getContext('2d'), it.strokes, c.width);
      node.appendChild(c);
    }
    if (it.compare) queueMicrotask(() => refreshCompare(it));
  } else if (it.image) {
    node = document.createElement('div'); node.className = 'clip';
    const img = document.createElement('img'); img.src = it.url; img.alt = ''; img.draggable = false;
    img.onload = () => { if (it.el) layout(it); };
    node.appendChild(img);
    if (it.strokes && it.strokes.length) { // red markup drawn over a photo
      const c = document.createElement('canvas');
      const long = 1600, r = it.h / it.w;
      c.width = r <= 1 ? long : Math.round(long / r); c.height = Math.round(c.width * r);
      renderStrokes(c.getContext('2d'), it.strokes, c.width);
      node.appendChild(c);
    }
  } else {
    node = document.createElement('div'); node.className = 'frame-box';
    node.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg><span>사진을 놓거나 붙여넣기<br>더블클릭해서 그리기</span>';
    if (it.strokes && it.strokes.length) {
      node.classList.add('drawn');
      const c = document.createElement('canvas');
      const long = 1600, r = it.h / it.w;
      c.width = r <= 1 ? long : Math.round(long / r); c.height = Math.round(c.width * r);
      renderStrokes(c.getContext('2d'), it.strokes, c.width);
      node.appendChild(c);
    }
  }
  el.insertBefore(node, el.firstChild);
}

function layout(it) {
  const s = it.el.style;
  s.left = it.x + 'px'; s.top = it.y + 'px'; s.width = it.w + 'px'; s.height = it.h + 'px'; s.zIndex = it.order;
  it.el.classList.toggle('cover', !!it.cover);
  it.el.classList.toggle('ref-off', !!it.refOff);
  const lb = it.layers && it.el.querySelector('img.layer-b');
  const img = !it.layers && it.el.querySelector('img');
  if (lb) {
    const f = it.fit || { s: 1, dx: 0, dy: 0 };
    Object.assign(lb.style, { left: f.dx * 100 + '%', top: f.dy * 100 + '%', width: f.s * 100 + '%', height: f.s * 100 + '%' });
  }
  if (img) {
    const g = it.cover ? cropGeom(it, img) : null;
    if (g) Object.assign(img.style, { left: g.x + 'px', top: g.y + 'px', width: g.w + 'px', height: g.h + 'px' });
    else Object.assign(img.style, { left: '', top: '', width: '', height: '' });
  }
  if (links.length) renderLinks();
}

/* ---------- connectors ---------- */
const NORM = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
function sidePoint(it, side) {
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
  return side === 'n' ? [cx, it.y] : side === 's' ? [cx, it.y + it.h] : side === 'e' ? [it.x + it.w, cy] : [it.x, cy];
}
function facingSide(target, from) {
  const dx = (from.x + from.w / 2) - (target.x + target.w / 2), dy = (from.y + from.h / 2) - (target.y + target.h / 2);
  return Math.abs(dx) / (target.w + from.w) > Math.abs(dy) / (target.h + from.h) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n');
}
function linkPath(a, sa, b, sb) {
  const [ax, ay] = a, [bx, by] = b;
  const d = Math.max(40 / cam.z, Math.hypot(bx - ax, by - ay) * 0.4);
  const [nax, nay] = NORM[sa], [nbx, nby] = sb ? NORM[sb] : [0, 0];
  const c1 = [ax + nax * d, ay + nay * d], c2 = sb ? [bx + nbx * d, by + nby * d] : [ (ax + bx) / 2 + nax * d / 2, (ay + by) / 2 + nay * d / 2 ];
  const p = `M${ax},${ay} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${bx},${by}`;
  // arrowhead along the curve's final tangent
  let tx = bx - c2[0], ty = by - c2[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
  const s = 11 / cam.z, wdt = 5.5 / cam.z;
  const head = `${bx},${by} ${bx - tx * s - ty * wdt},${by - ty * s + tx * wdt} ${bx - tx * s + ty * wdt},${by - ty * s - tx * wdt}`;
  return { p, head };
}
function drawLink(g, a, sa, b, sb) {
  const { p, head } = linkPath(a, sa, b, sb);
  g.innerHTML = '';
  const hit = document.createElementNS(SVGNS, 'path'); hit.setAttribute('class', 'hit'); hit.setAttribute('d', p); hit.setAttribute('vector-effect', 'non-scaling-stroke');
  const line = document.createElementNS(SVGNS, 'path'); line.setAttribute('class', 'line'); line.setAttribute('d', p); line.setAttribute('vector-effect', 'non-scaling-stroke');
  const hd = document.createElementNS(SVGNS, 'polygon'); hd.setAttribute('class', 'head'); hd.setAttribute('points', head);
  g.append(hit, line, hd);
}
function renderLinks() {
  const keep = new Set();
  for (const l of links) {
    const A = byId(l.from), B = byId(l.to);
    if (!A || !B) continue;
    let g = linksSvg.querySelector(`g[data-id="${l.id}"]`);
    if (!g) { g = document.createElementNS(SVGNS, 'g'); g.dataset.id = l.id; linksSvg.appendChild(g); }
    g.classList.toggle('sel', selLink === l.id);
    g.classList.toggle('busy', !!l.busy);
    const sb = facingSide(B, A);
    drawLink(g, sidePoint(A, l.side), l.side, sidePoint(B, sb), sb);
    keep.add(l.id);
  }
  for (const g of [...linksSvg.querySelectorAll('g[data-id]')]) if (!keep.has(g.dataset.id)) g.remove();
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Upload to the backend → {id, url, w, h}, or null (and a toast) when it fails. */
async function upload(blob) {
  setSaveState('saving');
  try {
    const r = await api.uploadImage(blob);
    setSaveState('saved');
    return { id: r.id, url: r.url, w: r.width, h: r.height };
  } catch (err) {
    setSaveState(err.offline ? 'offline' : 'saved');
    toast(err.message);
    return null;
  }
}

async function fillFrame(it, blob) {
  const up = await upload(blob);
  if (!up) return false;
  const size = { w: up.w, h: up.h };
  const linked = links.some(l => l.to === it.id);
  if (linked) {
    // an arrow points here: keep the frame's size and crop the photo to fill it
    it.cover = true;
  } else {
    // fit the photo inside the frame, keeping the frame's center
    const s = Math.min(it.w / size.w, it.h / size.h);
    const w = size.w * s, h = size.h * s;
    it.x += (it.w - w) / 2; it.y += (it.h - h) / 2; it.w = w; it.h = h;
  }
  it.image = up.id; it.url = up.url; delete it.strokes;
  fillContent(it, it.el); layout(it);
  select([it.id]); scheduleSave();
  toast(linked ? '화살표 출발 사진과 같은 크기로 잘라 채웠습니다' : '빈 캔버스에 사진을 채웠습니다');
  refreshOverlaysFor(it.id);
  return true;
}
const frameAt = (x, y) => {
  for (const el of document.elementsFromPoint(x, y)) {
    const itemEl = el.closest && el.closest('.item');
    if (itemEl) { const it = byId(itemEl.dataset.id); return it && !it.image ? it : null; }
  }
  return null;
};

async function addBlobs(blobs, at, target) {
  blobs = [...blobs];
  if (target && !target.image && blobs.length) {
    const ok = await fillFrame(target, blobs.shift());
    if (!blobs.length) return;
    if (ok) at = { x: target.x * cam.z + cam.x + target.w * cam.z + 40, y: (target.y + target.h / 2) * cam.z + cam.y };
  }
  const p = at || center();
  const added = [];
  let off = 0;
  for (const blob of blobs) {
    const up = await upload(blob);
    if (!up) continue;
    const size = { w: up.w, h: up.h };
    const maxScreen = Math.min(480, vp.clientWidth * 0.6);
    const s = Math.min(1, maxScreen / Math.max(size.w, size.h) / cam.z);
    const w = size.w * s / 1, h = size.h * s;
    const c = toWorld(p.x, p.y);
    const it = { id: uid(), x: c.x - w / 2 + off, y: c.y - h / 2 + off, w, h, order: ++orderCounter, image: up.id, url: up.url };
    off += 28 / cam.z;
    items.push(it); makeEl(it); added.push(it);
  }
  if (added.length) {
    select(added.map(i => i.id));
    toast(added.length === 1 ? '사진 1장을 추가했습니다' : `사진 ${added.length}장을 추가했습니다`);
    scheduleSave();
  }
}

function removeSelected() {
  if (selLink) {
    links = links.filter(l => l.id !== selLink); selLink = null; renderLinks(); scheduleSave();
    toast('연결선을 삭제했습니다'); return;
  }
  if (!selected.size) return;
  const n = selected.size;
  items = items.filter(it => {
    if (selected.has(it.id)) { it.el.remove(); return false; }
    return true;
  });
  links = links.filter(l => !selected.has(l.from) && !selected.has(l.to));
  selected.clear(); refreshSel(); renderLinks(); scheduleSave();
  toast(`${n}개를 삭제했습니다`);
}
function duplicateSelected() {
  const src = items.filter(it => selected.has(it.id));
  if (!src.length) return;
  const d = 24 / cam.z, made = [];
  for (const s of src) {
    const it = { id: uid(), x: s.x + d, y: s.y + d, w: s.w, h: s.h, order: ++orderCounter, image: s.image || null, url: s.url || null, strokes: s.strokes ? s.strokes.slice() : undefined, cover: !!s.cover, pos: s.pos ? s.pos.slice() : null, zoom: s.zoom || null };
    items.push(it); makeEl(it); made.push(it.id);
  }
  select(made); scheduleSave();
}

/* ---------- knob → new empty frame ---------- */
const GAP = 80;
function spawnFrame(src, side, cx, cy) {
  let x, y;
  if (cx == null) { // click: place right next to the source in the knob's direction
    const [nx, ny] = NORM[side];
    x = src.x + nx * (src.w + GAP); y = src.y + ny * (src.h + GAP);
  } else { x = cx - src.w / 2; y = cy - src.h / 2; }
  const it = { id: uid(), x, y, w: src.w, h: src.h, order: ++orderCounter, image: null, url: null };
  items.push(it); makeEl(it);
  links.push({ id: uid(), from: src.id, to: it.id, side });
  select([it.id]); renderLinks(); scheduleSave();
  return it;
}
function itemAt(x, y, excludeId) {
  for (const el of document.elementsFromPoint(x, y)) {
    const itemEl = el.closest && el.closest('.item');
    if (itemEl && itemEl.dataset.id !== excludeId) return byId(itemEl.dataset.id) || null;
  }
  return null;
}
let linkTarget = null;
function setLinkTarget(it) {
  if (linkTarget === it) return;
  if (linkTarget && linkTarget.el) linkTarget.el.classList.remove('link-target');
  linkTarget = it; if (it) it.el.classList.add('link-target');
}
function connect(src, side, tgt) {
  const dup = links.find(l => (l.from === src.id && l.to === tgt.id) || (l.from === tgt.id && l.to === src.id));
  if (dup) {
    dup.from = src.id; dup.to = tgt.id; dup.side = side;
  } else {
    links.push({ id: uid(), from: src.id, to: tgt.id, side });
  }
  syncFrom(src);
  toast(tgt.image ? '같은 크기·비율로 맞춰 잘랐습니다. Alt+드래그로 위치를 옮길 수 있습니다' : '화살표로 연결하고, 같은 크기로 맞췄습니다');
  renderLinks(); scheduleSave();
}
/* ---------- arrow click → overlay: reference line art at 30%, croquis at 50% (built by the backend) ---------- */
/** " 도착 그림을 112%로 키우고 위치를 맞췄습니다" — how the server fitted the arrow's end onto its start */
function fitNote(a) {
  if (!a) return '';
  const pct = Math.round(a.s * 100);
  const size = pct === 100 ? '크기는 그대로 두고' : `도착 그림을 ${pct}%로 ${pct > 100 ? '키우고' : '줄이고'}`;
  return ` ${size} 위치를 맞췄습니다`;
}
const REF_OPACITY = 0.3; // photo line art in the overlay

/**
 * Compare mode on an overlay (Enter): the reference line art turns red where it differs
 * strongly from the croquis and fades where they match. Recomputed whenever the croquis
 * layer moves; the result is not stored, only whether the mode is on.
 */
async function refreshCompare(it, announce) {
  const imgA = it.el && it.el.querySelector('img.layer-a');
  if (!imgA) return;
  const token = (it._cmpToken || 0) + 1; it._cmpToken = token;
  if (!it.compare || !it.layers) {
    it.el.classList.remove('comparing');
    it._diffUrl = null;
    imgA.src = it.layerUrls.a;
    if (announce) toast('비교를 끄고 원래대로 겹쳐 보입니다');
    return;
  }
  if (announce) toast('선화와 크로키를 비교하는 중입니다', 0);
  try {
    const res = await compareLayers(it.layerUrls.a, it.layerUrls.b, it.fit);
    if (it._cmpToken !== token || !it.compare) return; // a newer comparison or the mode was turned off
    it._diffUrl = res.url;
    imgA.src = res.url;
    it.el.classList.add('comparing');
    const pct = Math.round(res.redShare * 100);
    if (announce) toast(pct ? `크로키와 크게 다른 부위를 빨갛게 표시했습니다 (선화의 ${pct}%). Enter를 다시 누르면 꺼집니다` : '크게 다른 부위가 없습니다. 맞는 선은 흐리게 표시했습니다', 4000);
  } catch (err) {
    if (it._cmpToken !== token) return;
    it.compare = false;
    it.el.classList.remove('comparing');
    imgA.src = it.layerUrls.a;
    toast(err.message, 6000);
    scheduleSave();
  }
}
let overlayBusy = false;
/* keep existing overlays in step when either side changes */
function refreshOverlaysFor(id) {
  for (const l of links) if (l.overlay && byId(l.overlay) && (l.from === id || l.to === id)) makeOverlay(l, true);
}
async function makeOverlay(l, silent) {
  const A = byId(l.from), B = byId(l.to);
  if (!A || !B) return;
  if (overlayBusy) { l.pending = true; return; }
  if (!A.image && !(A.strokes && A.strokes.length) || !B.image && !(B.strokes && B.strokes.length)) {
    toast('겹쳐 보려면 화살표 양쪽에 사진이나 그림이 있어야 합니다'); return;
  }
  overlayBusy = true;
  l.busy = true; renderLinks();
  if (!silent && serverConfig.ai) toast('AI로 선화를 추출하는 중입니다. 사진마다 처음 한 번은 1분쯤 걸릴 수 있습니다', 0);
  try {
    await flushSave(); // the server composes from what it has stored, so send pending edits first
    // clicking the arrow re-fits automatically; quiet rebuilds keep a hand-set fit
    const res = await api.overlay(l.id, { refit: !silent });
    const r = res.item;
    let it = byId(r.id);
    if (it) {
      Object.assign(it, { x: r.x, y: r.y, w: r.w, h: r.h, image: r.image, url: r.url, label: r.label });
      delete it.cover; delete it.pos; delete it.zoom; delete it.layers; delete it.layerUrls; delete it.fit;
      if (r.layers) Object.assign(it, { layers: r.layers, layerUrls: r.layerUrls, fit: r.fit });
      fillContent(it, it.el); layout(it);
      const tag = it.el.querySelector('.tag'); if (tag) tag.textContent = r.label;
      if (!silent) toast(res.ai ? `AI 선화로 겹쳐 보기를 새로 고쳤습니다.${fitNote(res.alignment)}` : '겹쳐 보기를 새로 고쳤습니다', 3200);
    } else {
      it = { ...r };
      orderCounter = Math.max(orderCounter, it.order);
      items.push(it); makeEl(it);
      toast(res.ai ? `AI로 추출한 사진 선화(30%)와 크로키 선화(50%)를 겹쳤습니다.${fitNote(res.alignment)}`
                   : '원본을 겹쳤습니다(사진 30%, 크로키 50%). 서버에 OpenAI API 키가 없어 선화 추출은 건너뛰었습니다', res.ai ? 3600 : 5000);
    }
    l.overlay = res.link.overlay;
    markSent(it, l); // the server already has this state
  } catch (err) {
    if (!silent) toast(err.message, 6000);
  } finally {
    l.busy = false; renderLinks();
    overlayBusy = false;
    const next = links.find(x => x.pending);
    if (next) { next.pending = false; makeOverlay(next, true); }
  }
}

/* an arrow's target takes the source's size and ratio (center stays put, photo is center-cropped) */
function matchTo(src, tgt) {
  const cx = tgt.x + tgt.w / 2, cy = tgt.y + tgt.h / 2;
  tgt.w = src.w; tgt.h = src.h;
  tgt.x = cx - tgt.w / 2; tgt.y = cy - tgt.h / 2;
  if (tgt.image) tgt.cover = true;
  layout(tgt);
}
function syncFrom(src, seen = new Set()) {
  seen.add(src.id);
  for (const l of links) {
    if (l.from !== src.id || seen.has(l.to)) continue;
    const t = byId(l.to); if (!t) continue;
    matchTo(src, t); syncFrom(t, seen);
  }
}
let ghostEl = null, tmpLink = null;
function clearSpawnPreview() {
  if (ghostEl) { ghostEl.remove(); ghostEl = null; }
  if (tmpLink) { tmpLink.remove(); tmpLink = null; }
  document.querySelectorAll('.k.active').forEach(k => k.classList.remove('active'));
}

/* ---------- selection ---------- */
function select(ids, additive) {
  if (!additive) selected.clear();
  if (selLink) { selLink = null; renderLinks(); }
  for (const id of ids) selected.add(id);
  refreshSel();
}
function refreshSel() {
  for (const it of items) {
    it.el.classList.toggle('sel', selected.has(it.id));
    it.el.classList.toggle('solo', selected.size === 1);
  }
  delBtn.disabled = !selected.size && !selLink;
}
const byId = id => items.find(i => i.id === id);
function bringToFront(ids) { for (const id of ids) { const it = byId(id); if (it) { it.order = ++orderCounter; layout(it); } } }

/* ---------- pointer handling ---------- */
const pointers = new Map(); // id -> {x,y}
let mode = null;            // 'pan' | 'move' | 'resize' | 'marquee' | 'pinch'
let drag = null;
let spaceDown = false;
let marqueeEl = null;

vp.addEventListener('pointerdown', e => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  vp.setPointerCapture(e.pointerId);

  if (pointers.size === 2) { startPinch(); return; }
  if (pointers.size > 2) return;

  const target = e.target;
  const itemEl = target.closest && target.closest('.item');
  const isTouch = e.pointerType === 'touch';

  if (e.button === 1 || spaceDown || (!itemEl && isTouch)) {
    mode = 'pan'; drag = { sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
    vp.classList.add('panning'); e.preventDefault(); return;
  }
  if (e.button !== 0) return;

  const knob = target.closest && target.closest('.k');
  if (knob && itemEl) {
    const src = byId(itemEl.dataset.id);
    knob.classList.add('active');
    mode = 'spawn';
    drag = { src, side: knob.dataset.k, sx: e.clientX, sy: e.clientY, moved: false };
    e.preventDefault(); return;
  }
  const linkG = target.closest && target.closest('#links g[data-id]');
  if (linkG) {
    selected.clear(); refreshSel();
    selLink = linkG.dataset.id; renderLinks(); refreshSel();
    const l = links.find(x => x.id === selLink);
    if (l) makeOverlay(l);
    mode = null; return;
  }

  if (itemEl) {
    const id = itemEl.dataset.id;
    if (target.dataset.h) {
      const it = byId(id);
      mode = 'resize';
      drag = { it, corner: target.dataset.h, ox: it.x, oy: it.y, ow: it.w, oh: it.h, start: toWorld(e.clientX, e.clientY) };
      return;
    }
    const cit = byId(id);
    if (e.altKey && cit && cit.layers) {
      // Alt + drag on an AI overlay: move the croquis layer over the reference line art
      select([id]);
      mode = 'fit';
      drag = { it: cit, sx: e.clientX, sy: e.clientY, f0: { ...(cit.fit || { s: 1, dx: 0, dy: 0 }) } };
      return;
    }
    if (e.altKey && cit && cit.image && isOverlay(cit)) {
      // an older overlay saved as one flat image: rebuild it as layers instead of moving it whole
      upgradeOverlay(cit); mode = null; return;
    }
    if (e.altKey && cit && cit.image) {
      cit.cover = true;
      // Alt + drag: slide the photo inside its crop
      const cg = cropGeom(cit, cit.el.querySelector('img')) || { ox: 0, oy: 0 };
      select([id]);
      mode = 'crop';
      drag = { it: cit, sx: e.clientX, sy: e.clientY, pos: (cit.pos || [50, 50]).slice(), ox: cg.ox, oy: cg.oy };
      return;
    }
    if (e.shiftKey) {
      if (selected.has(id)) { selected.delete(id); refreshSel(); mode = null; return; }
      select([id], true);
    } else if (!selected.has(id)) select([id]);
    bringToFront([...selected]);
    mode = 'move';
    drag = { start: toWorld(e.clientX, e.clientY), orig: [...selected].map(id => { const it = byId(id); return { it, x: it.x, y: it.y }; }), moved: false };
    return;
  }

  // empty space: marquee select
  if (!e.shiftKey) select([]);
  mode = 'marquee';
  drag = { sx: e.clientX, sy: e.clientY, base: new Set(selected) };
  marqueeEl = document.createElement('div'); marqueeEl.id = 'marquee'; vp.appendChild(marqueeEl);
  updateMarquee(e.clientX, e.clientY);
});

vp.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (mode === 'pinch') { movePinch(); return; }
  if (!drag) return;

  if (mode === 'pan') {
    cam.x = drag.cx + (e.clientX - drag.sx); cam.y = drag.cy + (e.clientY - drag.sy); applyCam();
  } else if (mode === 'move') {
    const p = toWorld(e.clientX, e.clientY);
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    for (const o of drag.orig) { o.it.x = o.x + dx; o.it.y = o.y + dy; layout(o.it); }
    drag.moved = true;
  } else if (mode === 'resize') {
    const p = toWorld(e.clientX, e.clientY);
    const { it, corner, ox, oy, ow, oh } = drag;
    const ratio = ow / oh;
    // anchor is the opposite corner
    const ax = corner.includes('w') ? ox + ow : ox;
    const ay = corner.includes('n') ? oy + oh : oy;
    let w = Math.abs(p.x - ax), h = Math.abs(p.y - ay);
    if (w / h > ratio) h = w / ratio; else w = h * ratio;
    const minW = 24 / cam.z;
    if (w < minW) { w = minW; h = w / ratio; }
    it.w = w; it.h = h;
    it.x = corner.includes('w') ? ax - w : ax;
    it.y = corner.includes('n') ? ay - h : ay;
    layout(it);
  } else if (mode === 'marquee') {
    updateMarquee(e.clientX, e.clientY);
  } else if (mode === 'crop') {
    const clamp = v => Math.max(0, Math.min(100, v));
    const dx = (e.clientX - drag.sx) / cam.z, dy = (e.clientY - drag.sy) / cam.z;
    // ox/oy < 0 when the photo is smaller than its frame (Alt+scroll below 100%); the same
    // formula then slides it around inside the frame
    drag.it.pos = [
      Math.abs(drag.ox) > 0.5 ? clamp(drag.pos[0] - dx / drag.ox * 100) : 50,
      Math.abs(drag.oy) > 0.5 ? clamp(drag.pos[1] - dy / drag.oy * 100) : 50,
    ];
    layout(drag.it);
  } else if (mode === 'fit') {
    const it = drag.it;
    it.fit = { ...drag.f0, manual: true,
      dx: drag.f0.dx + (e.clientX - drag.sx) / (it.w * cam.z),
      dy: drag.f0.dy + (e.clientY - drag.sy) / (it.h * cam.z) };
    layout(it);
  } else if (mode === 'spawn') {
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
    drag.moved = true;
    const { src, side } = drag;
    const c = toWorld(e.clientX, e.clientY);
    // hovering another photo or frame: preview an arrow to it instead of a new frame
    const tgt = itemAt(e.clientX, e.clientY, src.id);
    setLinkTarget(tgt);
    if (tgt) {
      if (ghostEl) { ghostEl.remove(); ghostEl = null; }
      if (!tmpLink) { tmpLink = document.createElementNS(SVGNS, 'g'); tmpLink.setAttribute('class', 'tmp'); linksSvg.appendChild(tmpLink); }
      const sb = facingSide(tgt, src);
      drawLink(tmpLink, sidePoint(src, side), side, sidePoint(tgt, sb), sb);
      return;
    }
    if (!ghostEl) { ghostEl = document.createElement('div'); ghostEl.className = 'ghost'; world.appendChild(ghostEl); }
    Object.assign(ghostEl.style, { left: (c.x - src.w / 2) + 'px', top: (c.y - src.h / 2) + 'px', width: src.w + 'px', height: src.h + 'px', zIndex: orderCounter + 1 });
    if (!tmpLink) { tmpLink = document.createElementNS(SVGNS, 'g'); tmpLink.setAttribute('class', 'tmp'); linksSvg.appendChild(tmpLink); }
    const ghost = { x: c.x - src.w / 2, y: c.y - src.h / 2, w: src.w, h: src.h };
    const sb = facingSide(ghost, src);
    drawLink(tmpLink, sidePoint(src, side), side, sidePoint(ghost, sb), sb);
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (mode === 'pinch') {
    if (pointers.size < 2) { mode = null; drag = null; }
    return;
  }
  if (mode === 'move' && drag && drag.moved) scheduleSave();
  if (mode === 'resize' && drag) { syncFrom(drag.it); refreshOverlaysFor(drag.it.id); scheduleSave(); }
  if (mode === 'crop' && drag) { refreshOverlaysFor(drag.it.id); scheduleSave(); }
  if (mode === 'fit') { scheduleSave(); if (drag && drag.it.compare) refreshCompare(drag.it); }
  if (mode === 'spawn' && drag) {
    const tgt = linkTarget;
    clearSpawnPreview(); setLinkTarget(null);
    if (e.type === 'pointerup') {
      if (drag.moved && tgt) connect(drag.src, drag.side, tgt);
      else if (drag.moved) { const c = toWorld(e.clientX, e.clientY); spawnFrame(drag.src, drag.side, c.x, c.y); }
      else spawnFrame(drag.src, drag.side);
    }
  }
  if (marqueeEl) { marqueeEl.remove(); marqueeEl = null; }
  vp.classList.remove('panning');
  mode = null; drag = null;
}
vp.addEventListener('pointerup', endPointer);
vp.addEventListener('pointercancel', endPointer);
vp.addEventListener('auxclick', e => e.preventDefault());
// Right-click on an overlay: hide / show the reference (photo) line art
vp.addEventListener('contextmenu', e => {
  const it = itemAt(e.clientX, e.clientY);
  if (!it || !isOverlay(it)) return;
  e.preventDefault();
  if (!it.layers) { upgradeOverlay(it); return; }
  it.refOff = !it.refOff;
  layout(it);
  toast(it.refOff ? '사진 선화를 숨겼습니다. 다시 오른쪽 클릭하면 보입니다' : '사진 선화를 다시 표시합니다');
  scheduleSave();
});

function updateMarquee(x, y) {
  const l = Math.min(x, drag.sx), t = Math.min(y, drag.sy), r = Math.max(x, drag.sx), b = Math.max(y, drag.sy);
  Object.assign(marqueeEl.style, { left: l + 'px', top: t + 'px', width: (r - l) + 'px', height: (b - t) + 'px' });
  if (r - l < 3 && b - t < 3) return;
  const A = toWorld(l, t), B = toWorld(r, b);
  selected.clear();
  for (const id of drag.base) selected.add(id);
  for (const it of items) if (it.x < B.x && it.x + it.w > A.x && it.y < B.y && it.y + it.h > A.y) selected.add(it.id);
  refreshSel();
}

function pinchInfo() {
  const [a, b] = [...pointers.values()];
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
}
function startPinch() {
  if (marqueeEl) { marqueeEl.remove(); marqueeEl = null; }
  mode = 'pinch';
  const p = pinchInfo();
  drag = { ...p, z: cam.z, wp: toWorld(p.cx, p.cy) };
}
function movePinch() {
  const p = pinchInfo();
  const z = Math.min(MAXZ, Math.max(MINZ, drag.z * p.d / drag.d));
  cam.z = z; cam.x = p.cx - drag.wp.x * z; cam.y = p.cy - drag.wp.y * z;
  applyCam();
}

let cropWheelTimer = null;
vp.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.altKey) {
    // Alt + wheel over a cropped photo: zoom the photo inside its crop
    const it = itemAt(e.clientX, e.clientY);
    const wdy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    // fine steps: one mouse-wheel notch changes the size by about 3%; trackpads go smoother still
    const fine = Math.exp(-Math.max(-60, Math.min(60, wdy)) * 0.0005);
    if (it && it.layers) {
      // Alt + wheel on an AI overlay: size the croquis layer around the pointer
      const r = it.el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      const f0 = it.fit || { s: 1, dx: 0, dy: 0 };
      const s = Math.min(10, Math.max(0.1, f0.s * fine)), k = s / f0.s;
      it.fit = { s, dx: px - (px - f0.dx) * k, dy: py - (py - f0.dy) * k, manual: true };
      layout(it);
      toast(`크로키 선화 크기 ${Math.round(s * 100)}%`, 900);
      clearTimeout(cropWheelTimer);
      cropWheelTimer = setTimeout(() => { scheduleSave(); if (it.compare) refreshCompare(it); }, 250);
      return;
    }
    if (it && it.image && isOverlay(it)) { upgradeOverlay(it); return; } // never zoom the overlay as a whole
    if (it && it.image) {
      it.cover = true; // a photo at its own ratio crops to itself, so this changes nothing until zoomed
      const dy = wdy;
      // down to 20%: the croquis can be made smaller than its frame, not only larger
      it.zoom = Math.min(8, Math.max(0.2, (it.zoom || 1) * fine));
      toast(`크로키 크기 ${Math.round(it.zoom * 100)}%`, 900);
      layout(it);
      clearTimeout(cropWheelTimer);
      cropWheelTimer = setTimeout(() => { refreshOverlaysFor(it.id); scheduleSave(); }, 250);
      return;
    }
  }
  let dx = e.deltaX, dy = e.deltaY;
  if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
  if (e.ctrlKey || e.metaKey) {
    zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0025 * (e.ctrlKey && Math.abs(dy) < 50 ? 4 : 1)));
  } else {
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    cam.x -= dx; cam.y -= dy; applyCam();
  }
}, { passive: false });

/* Safari trackpad pinch */
let gzStart = 1;
vp.addEventListener('gesturestart', e => { e.preventDefault(); gzStart = cam.z; });
vp.addEventListener('gesturechange', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, (gzStart * e.scale) / cam.z); });

/* ---------- keyboard ---------- */
const typing = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable); };
window.addEventListener('keydown', e => {
  if (!drawer.hidden) {
    const k = e.key.toLowerCase();
    if (e.key === 'Escape' || e.key === 'Enter') closeDrawer();
    else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) redoDraw();
    else if ((e.ctrlKey || e.metaKey) && k === 'z') undoDraw();
    else if (e.key === 'Tab' || e.key === ' ') return;
    e.preventDefault(); return;
  }
  if (!lb.hidden) {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowRight' || e.key === ' ') stepLb(1);
    else if (e.key === 'ArrowLeft') stepLb(-1);
    else if (e.key === 'Tab') return;
    e.preventDefault(); return;
  }
  if (typing()) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Enter' && !mod && selected.size === 1) {
    // Enter on a selected overlay: compare the line art with the croquis (again: back to normal)
    const it = byId([...selected][0]);
    if (it && isOverlay(it)) {
      e.preventDefault();
      if (!it.layers) { upgradeOverlay(it); return; }
      it.compare = !it.compare;
      refreshCompare(it, true);
      scheduleSave();
      return;
    }
  }
  if (e.code === 'Space') { if (!spaceDown) { spaceDown = true; vp.classList.add('space'); } e.preventDefault(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { removeSelected(); e.preventDefault(); return; }
  if (e.key === 'Escape') { select([]); return; }
  if (mod && e.key.toLowerCase() === 'a') { select(items.map(i => i.id)); e.preventDefault(); return; }
  if (mod && e.key.toLowerCase() === 'd') { duplicateSelected(); e.preventDefault(); return; }
  if (e.shiftKey && (e.code === 'Digit1')) { fitAll(); e.preventDefault(); return; }
  if (e.shiftKey && (e.code === 'Digit0')) { zoomAt(center().x, center().y, 1 / cam.z); e.preventDefault(); return; }
  if (!mod && (e.key === '+' || e.key === '=')) { zoomAt(center().x, center().y, 1.25); return; }
  if (!mod && (e.key === '-' || e.key === '_')) { zoomAt(center().x, center().y, 0.8); return; }
  if (selected.size && e.key.startsWith('Arrow')) {
    const step = (e.shiftKey ? 10 : 1) / cam.z;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    for (const id of selected) { const it = byId(id); it.x += dx; it.y += dy; layout(it); }
    scheduleSave(); e.preventDefault();
  }
});
window.addEventListener('keyup', e => { if (e.code === 'Space') { spaceDown = false; vp.classList.remove('space'); } });
window.addEventListener('blur', () => { spaceDown = false; vp.classList.remove('space'); });

/* ---------- paste ---------- */
let lastPointer = null;
vp.addEventListener('pointermove', e => { lastPointer = { x: e.clientX, y: e.clientY }; });
window.addEventListener('paste', e => {
  if (typing() || !lb.hidden || !drawer.hidden) return;
  const files = [];
  for (const item of (e.clipboardData && e.clipboardData.items) || []) {
    if (item.kind === 'file' && item.type.startsWith('image/')) { const f = item.getAsFile(); if (f) files.push(f); }
  }
  // target: a single selected empty frame, else the empty frame under the pointer
  const selIt = selected.size === 1 ? byId([...selected][0]) : null;
  const target = selIt && !selIt.image ? selIt : (lastPointer ? frameAt(lastPointer.x, lastPointer.y) : null);
  if (files.length) { e.preventDefault(); addBlobs(files, lastPointer, target); }
  else {
    const html = e.clipboardData && e.clipboardData.getData('text/html');
    const m = html && html.match(/<img[^>]+src="(data:image\/[^"]+)"/i);
    if (m) { e.preventDefault(); dataUrlToBlob(m[1]).then(b => addBlobs([b], lastPointer, target)); }
    else toast('클립보드에 이미지가 없습니다. 이미지를 복사한 뒤 다시 붙여넣으세요');
  }
});
function dataUrlToBlob(u) { return fetch(u).then(r => r.blob()); }

/* ---------- drag & drop ---------- */
let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropEl.hidden = false; });
let overFrame = null;
function setOver(it) {
  if (overFrame === it) return;
  if (overFrame) overFrame.el.classList.remove('over');
  overFrame = it; if (it) it.el.classList.add('over');
  dropEl.textContent = it ? '놓으면 이 빈 캔버스에 사진이 채워집니다' : '여기에 놓으면 캔버스에 추가됩니다';
}
window.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(frameAt(e.clientX, e.clientY)); });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { dropEl.hidden = true; setOver(null); } });
window.addEventListener('drop', e => {
  if (!e.dataTransfer) return;
  e.preventDefault(); dragDepth = 0; dropEl.hidden = true; setOver(null);
  const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(f.name));
  if (files.length) addBlobs(files, { x: e.clientX, y: e.clientY }, frameAt(e.clientX, e.clientY));
  else if (e.dataTransfer.files.length) toast('이미지 파일만 놓을 수 있습니다');
  else toast('웹페이지의 이미지는 복사(우클릭 → 이미지 복사) 후 붙여넣어 주세요');
});

/* ---------- toolbar ---------- */
let fileTarget = null;
document.getElementById('addBtn').onclick = () => {
  const s = selected.size === 1 ? byId([...selected][0]) : null;
  fileTarget = s && !s.image ? s : null; fileInput.click();
};
fileInput.onchange = () => { addBlobs([...fileInput.files], null, fileTarget); fileTarget = null; fileInput.value = ''; };
vp.addEventListener('dblclick', e => {
  // pointer capture retargets dblclick to the viewport, so hit-test by position
  let it = null;
  for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
    const itemEl = el.closest && el.closest('.item');
    if (itemEl) { it = byId(itemEl.dataset.id); break; }
  }
  if (it && (!it.image || isOverlay(it))) openDrawer(it);
  else if (it) openLightbox(it);
});

/* ---------- drawing mode ---------- */
const drawer = document.getElementById('drawer'), paper = document.getElementById('paper');
const dc = document.getElementById('drawCanvas'), dg = dc.getContext('2d');
const undoBtn = document.getElementById('undoBtn'), redoBtn = document.getElementById('redoBtn');
let dItem = null, dStrokes = [], dUndo = [], dRedo = [], dCur = null, dPointer = null, penSeen = false;
let penSize = 0.006;
try { const v = parseFloat(localStorage.getItem('ic-pen')); if (v) penSize = v; } catch {}
const paperRect = { x: 0, y: 0, w: 0, h: 0 };

function layoutPaper() {
  const W = innerWidth, H = innerHeight, top = 76, side = 24, bottom = 24;
  const aw = W - side * 2, ah = H - top - bottom, r = dItem.h / dItem.w;
  let w = aw, h = aw * r;
  if (h > ah) { h = ah; w = ah / r; }
  paperRect.w = w; paperRect.h = h; paperRect.x = (W - w) / 2; paperRect.y = top + (ah - h) / 2;
  Object.assign(paper.style, { left: paperRect.x + 'px', top: paperRect.y + 'px', width: w + 'px', height: h + 'px' });
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  dc.width = Math.round(w * dpr); dc.height = Math.round(h * dpr);
  redrawPaper();
}
const redrawPaper = () => renderStrokes(dg, dStrokes, dc.width);
function rectTransform(r) { // transform that maps the full paper onto rect r (screen)
  return `translate(${r.left - paperRect.x}px,${r.top - paperRect.y}px) scale(${r.width / paperRect.w},${r.height / paperRect.h})`;
}
function syncUndo() { undoBtn.disabled = !dUndo.length; redoBtn.disabled = !dRedo.length; }
function setPen(v) {
  penSize = v;
  drawer.querySelectorAll('[data-size]').forEach(b => b.setAttribute('aria-pressed', String(parseFloat(b.dataset.size) === v)));
  try { localStorage.setItem('ic-pen', String(v)); } catch {}
}
drawer.querySelectorAll('[data-size]').forEach(b => b.onclick = () => setPen(parseFloat(b.dataset.size)));

const RED = '#e0262b';
let dColor = '#111';
const paperImg = document.getElementById('paperImg');
const isOverlay = it => links.some(l => l.overlay === it.id);
/** Rebuild an overlay saved before it had separate layers, so only its croquis layer moves. */
function upgradeOverlay(it) {
  const l = links.find(x => x.overlay === it.id);
  if (!l || it.layers) return;
  toast('겹쳐 보기를 크로키 층만 움직일 수 있게 다시 만드는 중입니다');
  makeOverlay(l, true);
}
/** The layered overlay as one picture (for the red-pen paper): white, reference at 30% (unless hidden), croquis at 50%. */
async function layeredPreview(it) {
  const load = src => new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = src; });
  const [a, b] = await Promise.all([load(it.layerUrls.a), load(it.layerUrls.b)]);
  const W = a.naturalWidth, H = a.naturalHeight, f = it.fit || { s: 1, dx: 0, dy: 0 };
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  if (!it.refOff && it.compare && it._diffUrl) { g.drawImage(await load(it._diffUrl), 0, 0, W, H); }
  else if (!it.refOff) { g.globalAlpha = REF_OPACITY; g.drawImage(a, 0, 0, W, H); }
  g.globalAlpha = 0.5;
  g.drawImage(b, f.dx * W, f.dy * H, W * f.s, H * f.s);
  return c.toDataURL('image/png');
}
function openDrawer(it) {
  dItem = it; dStrokes = (it.strokes || []).slice(); dUndo = []; dRedo = []; dCur = null; dPointer = null;
  // photos (the overlay) get a red pen drawn over the image; empty frames get black on white
  dColor = it.image ? RED : '#111';
  drawer.style.setProperty('--pen', dColor);
  if (it.layers) { paperImg.hidden = false; layeredPreview(it).then(u => { if (dItem === it) paperImg.src = u; }); }
  else if (it.image) { paperImg.src = it.url; paperImg.hidden = false; } else { paperImg.hidden = true; paperImg.removeAttribute('src'); }
  select([it.id]);
  drawer.hidden = false; drawer.classList.add('enter');
  layoutPaper(); setPen(penSize); syncUndo();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce) {
    paper.style.transition = 'none';
    paper.style.transform = rectTransform(it.el.getBoundingClientRect());
    paper.getBoundingClientRect();
    paper.style.transition = '';
  }
  requestAnimationFrame(() => { paper.style.transform = 'none'; drawer.classList.remove('enter'); });
  document.getElementById('doneBtn').focus({ preventScroll: true });
}
function closeDrawer() {
  if (drawer.hidden || !dItem) return;
  const it = dItem;
  const changed = JSON.stringify(it.strokes || []) !== JSON.stringify(dStrokes);
  if (dStrokes.length) it.strokes = dStrokes; else delete it.strokes;
  if (changed) { fillContent(it, it.el); refreshOverlaysFor(it.id); scheduleSave(); }
  const finish = () => { drawer.hidden = true; paper.style.transform = 'none'; dItem = null; };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return finish();
  drawer.classList.add('enter');
  paper.style.transform = rectTransform(it.el.getBoundingClientRect());
  setTimeout(finish, 270);
}

function paperPoint(e) {
  const r = dc.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.width; // both in paper-width units
  const p = e.pointerType === 'pen' ? 0.35 + (e.pressure || 0.5) * 1.3 : 1;
  return [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4, Math.round(p * 100) / 100];
}
dc.addEventListener('pointerdown', e => {
  if (e.pointerType === 'pen') penSeen = true;
  if (dPointer !== null || (e.pointerType === 'touch' && penSeen) || e.button > 0) return; // palm rejection once a pen is used
  dc.setPointerCapture(e.pointerId); dPointer = e.pointerId;
  dCur = { w: penSize, pts: [paperPoint(e)] };
  if (dColor !== '#111') dCur.c = dColor;
  dg.save(); drawStroke(dg, dCur, dc.width); dg.restore();
  e.preventDefault();
});
dc.addEventListener('pointermove', e => {
  if (e.pointerId !== dPointer || !dCur) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of (evs.length ? evs : [e])) {
    const pt = paperPoint(ev), last = dCur.pts[dCur.pts.length - 1];
    if (Math.abs(pt[0] - last[0]) + Math.abs(pt[1] - last[1]) < 0.0008) continue;
    dCur.pts.push(pt);
    dg.strokeStyle = dCur.c || '#111'; dg.lineCap = 'round'; strokeSeg(dg, dCur, last, pt, dc.width);
  }
});
function endStroke(e) {
  if (e.pointerId !== dPointer) return;
  dPointer = null;
  if (dCur) { dUndo.push(dStrokes); dStrokes = dStrokes.concat([dCur]); dRedo = []; dCur = null; syncUndo(); redrawPaper(); }
}
dc.addEventListener('pointerup', endStroke);
dc.addEventListener('pointercancel', endStroke);
function undoDraw() { if (!dUndo.length) return; dRedo.push(dStrokes); dStrokes = dUndo.pop(); syncUndo(); redrawPaper(); }
function redoDraw() { if (!dRedo.length) return; dUndo.push(dStrokes); dStrokes = dRedo.pop(); syncUndo(); redrawPaper(); }
undoBtn.onclick = undoDraw; redoBtn.onclick = redoDraw;
document.getElementById('clearBtn').onclick = () => { if (!dStrokes.length) return; dUndo.push(dStrokes); dStrokes = []; dRedo = []; syncUndo(); redrawPaper(); toast('모두 지웠습니다. 실행 취소로 되돌릴 수 있습니다'); };
document.getElementById('doneBtn').onclick = closeDrawer;
drawer.addEventListener('pointerdown', e => { if (e.target === drawer) closeDrawer(); });
drawer.addEventListener('wheel', e => e.preventDefault(), { passive: false });
window.addEventListener('resize', () => { if (!drawer.hidden) layoutPaper(); });

/* ---------- full-screen viewer ---------- */
const lb = document.getElementById('lightbox'), lbImg = document.getElementById('lbImg'), lbCount = document.getElementById('lbCount');
let lbList = [], lbIdx = 0, lbFs = false;
function openLightbox(it) {
  // browse photos in reading order: top-to-bottom, then left-to-right
  lbList = items.filter(i => i.image && !i.layers).sort((a, b) => (Math.abs(a.y - b.y) < Math.min(a.h, b.h) / 2 ? a.x - b.x : a.y - b.y));
  lbIdx = Math.max(0, lbList.indexOf(it));
  showLb();
  lb.hidden = false;
  document.getElementById('lbClose').focus({ preventScroll: true });
  lbFs = false;
  try {
    const r = lb.requestFullscreen && lb.requestFullscreen();
    if (r && r.then) r.then(() => { lbFs = true; }, () => {});
  } catch {}
}
function showLb() {
  const it = lbList[lbIdx]; if (!it) return;
  lbImg.src = it.url;
  lbCount.textContent = lbList.length > 1 ? `${lbIdx + 1} / ${lbList.length}` : '';
  document.getElementById('lbPrev').hidden = document.getElementById('lbNext').hidden = lbList.length < 2;
}
function stepLb(d) { if (lbList.length < 2) return; lbIdx = (lbIdx + d + lbList.length) % lbList.length; showLb(); }
function closeLightbox() {
  if (lb.hidden) return;
  lb.hidden = true;
  const it = lbList[lbIdx]; if (it) select([it.id]);
  if (document.fullscreenElement) { try { document.exitFullscreen(); } catch {} }
  lbFs = false;
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && lbFs) { lbFs = false; closeLightbox(); } });
document.getElementById('lbClose').onclick = closeLightbox;
document.getElementById('lbPrev').onclick = e => { e.stopPropagation(); stepLb(-1); };
document.getElementById('lbNext').onclick = e => { e.stopPropagation(); stepLb(1); };
let swipeX = null, swiped = false;
lb.addEventListener('click', e => { if (swiped) { swiped = false; return; } if (e.target === lb) closeLightbox(); });
lb.addEventListener('pointerdown', e => { swipeX = e.clientX; swiped = false; });
lb.addEventListener('pointerup', e => {
  if (swipeX == null) return; const dx = e.clientX - swipeX; swipeX = null;
  if (Math.abs(dx) > 60) { swiped = true; stepLb(dx < 0 ? 1 : -1); }
});
lb.addEventListener('wheel', e => e.preventDefault(), { passive: false });
document.getElementById('zoomIn').onclick = () => zoomAt(center().x, center().y, 1.25);
document.getElementById('zoomOut').onclick = () => zoomAt(center().x, center().y, 0.8);
zoomLabel.onclick = () => zoomAt(center().x, center().y, 1 / cam.z);
document.getElementById('fitBtn').onclick = fitAll;
delBtn.onclick = removeSelected;
const help = document.getElementById('help'), helpToggle = document.getElementById('helpToggle');
function setHelp(collapsed) {
  help.classList.toggle('collapsed', collapsed); helpToggle.textContent = collapsed ? '사용법' : '접기';
  try { localStorage.setItem('ic-help', collapsed ? '1' : '0'); } catch {}
}
helpToggle.onclick = () => setHelp(!help.classList.contains('collapsed'));
try { if (localStorage.getItem('ic-help') === '1') setHelp(true); else if (innerWidth < 560) setHelp(true); } catch { if (innerWidth < 560) setHelp(true); }

let toastTimer;
/** Show a message; ms = 0 keeps it up until the next message. */
function toast(msg, ms = 2200) {
  toastEl.textContent = msg; toastEl.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* what the server can do (AI line extraction on or off) */
const serverConfig = { ai: false, imageModel: '' };
api.config().then(c => Object.assign(serverConfig, c)).catch(() => {});

/* ---------- persistence: sync changes to the backend ---------- */
const saveEl = document.getElementById('saveState');
const SAVE_LABEL = { saved: '저장됨', saving: '저장 중…', offline: '서버 연결 끊김', error: '저장 실패' };
function setSaveState(state) {
  saveEl.dataset.state = state;
  saveEl.querySelector('.lbl').textContent = SAVE_LABEL[state];
  saveEl.title = state === 'offline' ? '서버에 연결할 수 없습니다. 다시 연결되면 자동으로 저장합니다' : SAVE_LABEL[state];
}

// What the server last confirmed, as JSON strings, so only real changes are sent.
const sentItems = new Map(), sentLinks = new Map();
let sentCam = '';
const itemJSON = it => JSON.stringify({
  id: it.id, x: it.x, y: it.y, w: it.w, h: it.h, order: it.order, image: it.image || null,
  cover: !!it.cover, pos: it.pos || null, zoom: it.zoom || null, label: it.label || null,
  example: !!it.example, strokes: it.strokes || null, layers: it.layers || null, fit: it.fit || null, refOff: !!it.refOff, compare: !!it.compare,
});
const linkJSON = l => JSON.stringify({ id: l.id, from: l.from, to: l.to, side: l.side, overlay: l.overlay || null });
const camJSON = () => JSON.stringify({ x: cam.x, y: cam.y, z: cam.z });
function markSent(it, l) {
  if (it) sentItems.set(it.id, itemJSON(it));
  if (l) sentLinks.set(l.id, linkJSON(l));
}

let saveTimer = null, ready = false, syncing = null, retryTimer = null, warned = false;
function scheduleSave() {
  if (!ready) return;
  if (saveEl.dataset.state === 'saved') setSaveState('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!ready) return;
  while (syncing) await syncing;
  syncing = syncOnce();
  try { await syncing; } finally { syncing = null; }
}
async function syncOnce() {
  const curItems = new Map(items.map(it => [it.id, itemJSON(it)]));
  const curLinks = new Map(links.map(l => [l.id, linkJSON(l)]));
  // run every request even if one fails; remember the first failure and report it at the end
  let firstError = null;
  const run = async (list) => {
    const failed = (await Promise.allSettled(list.map(f => f()))).find(r => r.status === 'rejected');
    if (failed && !firstError) firstError = failed.reason;
  };
  try {
    // items first (arrows point at them), then removed items, then arrows, then the camera
    await run([...curItems].filter(([id, j]) => sentItems.get(id) !== j)
      .map(([id, j]) => () => api.putItem(JSON.parse(j)).then(() => sentItems.set(id, j))));
    await run([...sentItems.keys()].filter(id => !curItems.has(id))
      .map(id => () => api.deleteItem(id).then(() => sentItems.delete(id))));
    await run([
      ...[...curLinks].filter(([id, j]) => sentLinks.get(id) !== j)
        .map(([id, j]) => () => api.putLink(JSON.parse(j)).then(() => sentLinks.set(id, j))),
      ...[...sentLinks.keys()].filter(id => !curLinks.has(id))
        .map(id => () => api.deleteLink(id).then(() => sentLinks.delete(id))),
    ]);
    const cj = camJSON();
    if (cj !== sentCam) await run([() => api.camera(cam).then(() => { sentCam = cj; })]);
    if (firstError) throw firstError;
    setSaveState('saved');
    warned = false;
  } catch (err) {
    setSaveState(err.offline ? 'offline' : 'error');
    if (!warned) { toast(err.offline ? err.message : `저장하지 못했습니다: ${err.message}`); warned = true; }
    clearTimeout(retryTimer);
    retryTimer = setTimeout(scheduleSave, 3000); // keep trying; nothing is lost while the page stays open
  }
}
window.addEventListener('beforeunload', e => {
  if (saveEl.dataset.state !== 'saved') { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- example tiles for a first visit ---------- */
function exampleBlob(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  return new Promise(r => c.toBlob(r, 'image/png'));
}
const SEED_SPECS = [
  { w: 640, h: 420, x: -520, y: -250, draw: (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, '#f6c28b'); sky.addColorStop(.55, '#e7837a'); sky.addColorStop(1, '#5a4a8a');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffe3b0'; g.beginPath(); g.arc(w * .62, h * .56, 56, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2f2a4a'; g.beginPath(); g.moveTo(0, h); g.lineTo(0, h * .7); g.lineTo(w * .25, h * .52); g.lineTo(w * .45, h * .72); g.lineTo(w * .7, h * .6); g.lineTo(w, h * .76); g.lineTo(w, h); g.fill();
  } },
  { w: 420, h: 520, x: 180, y: -300, draw: (g, w, h) => {
    g.fillStyle = '#e9efe6'; g.fillRect(0, 0, w, h);
    const cols = ['#3d6b4f', '#7ea36b', '#c9b458', '#d9825b'];
    for (let i = 0; i < 28; i++) { g.fillStyle = cols[i % 4]; g.globalAlpha = .85; g.beginPath();
      g.ellipse(40 + (i * 97) % (w - 60), 40 + (i * 61) % (h - 60), 18 + (i % 5) * 9, 10 + (i % 3) * 8, i, 0, Math.PI * 2); g.fill(); }
    g.globalAlpha = 1;
  } },
  { w: 520, h: 340, x: -180, y: 230, draw: (g, w, h) => {
    g.fillStyle = '#1f2a44'; g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 26) for (let x = 0; x < w; x += 26) {
      g.fillStyle = `hsl(${200 + (x + y) / 6},70%,${45 + ((x * y) % 30)}%)`; g.fillRect(x + 4, y + 4, 18, 18); }
  } },
];
async function seedExamples() {
  const specs = SEED_SPECS;
  for (const s of specs) {
    const blob = await exampleBlob(s.w, s.h, s.draw);
    const up = await upload(blob);
    if (!up) return;
    const it = { id: uid(), x: s.x, y: s.y, w: s.w * .75, h: s.h * .75, order: ++orderCounter, image: up.id, url: up.url, example: true };
    items.push(it); makeEl(it);
  }
}

/* ---------- boot: load the board from the backend ---------- */
(async () => {
  cam.x = center().x; cam.y = center().y; applyCam();
  let data;
  try {
    data = await api.board();
  } catch (err) {
    setSaveState('offline');
    toast(err.message);
    return;
  }
  if (data.items.length || data.camera) {
    data.items.sort((a, b) => a.order - b.order);
    for (const r of data.items) {
      const it = { ...r };
      orderCounter = Math.max(orderCounter, r.order);
      items.push(it); makeEl(it);
    }
    links = data.links.filter(l => byId(l.from) && byId(l.to));
    if (data.camera) Object.assign(cam, data.camera);
    applyCam();
    for (const it of items) markSent(it);
    for (const l of links) markSent(null, l);
    sentCam = data.camera ? camJSON() : '';
  } else {
    await seedExamples();
    fitAll();
  }
  ready = true;
  // overlays saved as one flat image (older version) are rebuilt as two layers
  for (const l of links) { const ov = l.overlay && byId(l.overlay); if (ov && ov.image && !ov.layers) makeOverlay(l, true); }
  scheduleSave();
})();
window.addEventListener('resize', () => applyCam());
