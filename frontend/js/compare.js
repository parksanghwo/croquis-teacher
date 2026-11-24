// Compare the reference line art (overlay layer a) with the croquis (layer b, placed by fit).
// Reference lines far from any croquis line, over a whole area, become red; the rest fade.

const RED = [220, 38, 43];
const FADED_ALPHA = 0.12;   // matching reference lines
const RED_ALPHA = 0.95;     // strongly differing reference lines

const load = src => new Promise((ok, no) => {
  const im = new Image();
  im.onload = () => ok(im);
  im.onerror = () => no(new Error('겹쳐 보기 이미지를 불러오지 못했습니다'));
  im.src = src;
});

function alphaOf(img, w, h, place) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (place) g.drawImage(img, ...place); else g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return a;
}

/** Squared Euclidean distance transform (Felzenszwalb–Huttenlocher), distance to the nearest `on` pixel. */
function distanceTo(on, w, h) {
  const INF = 1e12, f = new Float64Array(Math.max(w, h)), out = new Float64Array(w * h);
  const v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1), dd = new Float64Array(Math.max(w, h));
  const pass = (n) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; dd[q] = (q - v[k]) ** 2 + f[v[k]]; }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = on[y * w + x] ? 0 : INF;
    pass(h);
    for (let y = 0; y < h; y++) out[y * w + x] = dd[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) out[y * w + x] = dd[x];
  }
  return out;
}

/** Box sum with radius r (summed-area table). */
function boxSum(src, w, h, r) {
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += src[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0];
    }
  }
  return out;
}

/**
 * Returns { url, redShare } — url is a PNG of the reference line art recoloured
 * (red where it differs strongly, faint elsewhere); redShare is the share of
 * reference ink marked red (0–1). Throws a readable Error when it cannot compare.
 */
export async function compareLayers(urlA, urlB, fit) {
  const [A, B] = await Promise.all([load(urlA), load(urlB)]);
  const W = A.naturalWidth, H = A.naturalHeight;

  // analysis at a working size (long side 640) for speed
  const k = 640 / Math.max(W, H), w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
  const f = fit || { s: 1, dx: 0, dy: 0 };
  const aA = alphaOf(A, w, h), aB = alphaOf(B, w, h, [f.dx * w, f.dy * h, w * f.s, h * f.s]);

  const inkA = new Uint8Array(w * h), inkB = new Uint8Array(w * h);
  let nA = 0, nB = 0;
  for (let i = 0; i < w * h; i++) { if (aA[i] > 64) { inkA[i] = 1; nA++; } if (aB[i] > 64) { inkB[i] = 1; nB++; } }
  // a layer that is mostly opaque is a photo, not lines (overlay made without AI extraction)
  if (nA > w * h * 0.4 || nB > w * h * 0.4) throw new Error('비교는 AI로 선을 뽑은 겹쳐 보기에서만 할 수 있습니다. 서버에 OpenAI API 키를 넣고 화살표를 다시 눌러 주세요');
  if (nA < 50 || nB < 50) throw new Error('비교할 선이 거의 없습니다');

  // per reference pixel: how far is the nearest croquis line? (in working pixels)
  const dist2 = distanceTo(inkB, w, h);
  // tuned on a real photo/croquis pair: about 0.8% of the figure counts as "on the line",
  // 2.5% and beyond as clearly off
  const L = Math.max(w, h), near = L * 0.008, far = L * 0.025;
  const miss = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!inkA[i]) continue;
    const d = Math.sqrt(dist2[i]);
    miss[i] = Math.min(1, Math.max(0, (d - near) / (far - near)));
  }
  // judge areas, not single pixels: share of "missed" reference ink within ~3.5% of the figure
  const R = Math.max(2, Math.round(L * 0.035));
  const sumMiss = boxSum(miss, w, h, R), sumInk = boxSum(Float64Array.from(inkA), w, h, R);
  const red = new Uint8Array(w * h);
  let nRed = 0;
  for (let i = 0; i < w * h; i++) {
    if (!inkA[i]) continue;
    if (sumMiss[i] / Math.max(1, sumInk[i]) > 0.42) { red[i] = 1; nRed++; }
  }

  // recolour the full-size reference line art using the working-size map
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(A, 0, 0);
  const img = g.getImageData(0, 0, W, H), d = img.data;
  for (let y = 0; y < H; y++) {
    const wy = Math.min(h - 1, Math.floor(y * k));
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      if (!d[p + 3]) continue;
      if (red[wy * w + Math.min(w - 1, Math.floor(x * k))]) {
        d[p] = RED[0]; d[p + 1] = RED[1]; d[p + 2] = RED[2]; d[p + 3] = Math.round(d[p + 3] * RED_ALPHA);
      } else {
        d[p + 3] = Math.round(d[p + 3] * FADED_ALPHA);
      }
    }
  }
  g.putImageData(img, 0, 0);
  return { url: c.toDataURL('image/png'), redShare: nRed / nA };
}
