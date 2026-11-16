// 흰 배경 티셔츠 사진 → 누끼(알파) + 디자인 텍스처 + 몸판 치수 추출.
// DOM에 의존하지 않는 순수 함수라 브라우저와 node 양쪽에서 같은 코드로 테스트할 수 있습니다.
// 입력: RGBA Uint8ClampedArray(src), 너비 w, 높이 h

function median(arr) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[s.length >> 1];
}

/** 테두리 픽셀의 중앙값으로 배경색을 추정하고, 배경이 균일한 정도(0~1)도 돌려줍니다. */
function estimateBackground(src, w, h, tol) {
  const r = [], g = [], b = [];
  const take = (x, y) => {
    const i = (y * w + x) * 4;
    if (src[i + 3] >= 128) { r.push(src[i]); g.push(src[i + 1]); b.push(src[i + 2]); }
  };
  const m = Math.min(2, (h >> 1) - 1, (w >> 1) - 1);
  for (let k = 0; k <= m; k++) {
    for (let x = 0; x < w; x++) { take(x, k); take(x, h - 1 - k); }
    for (let y = 0; y < h; y++) { take(k, y); take(w - 1 - k, y); }
  }
  if (!r.length) return { color: [255, 255, 255], uniform: 1 };   // 투명 PNG
  const color = [median(r), median(g), median(b)];
  let ok = 0;
  const lim = (tol * 1.5) ** 2;
  for (let i = 0; i < r.length; i++) {
    const dr = r[i] - color[0], dg = g[i] - color[1], db = b[i] - color[2];
    if (dr * dr + dg * dg + db * db <= lim) ok++;
  }
  return { color, uniform: ok / r.length };
}

/** 4방향 침식. 가장자리에 남는 흰 테두리(halo)를 줄입니다. */
function erode(mask, w, h, times) {
  let cur = mask;
  for (let t = 0; t < times; t++) {
    const nxt = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (cur[i] && cur[i - 1] && cur[i + 1] && cur[i - w] && cur[i + w]) nxt[i] = 1;
      }
    }
    cur = nxt;
  }
  return cur;
}

/** 가장 큰 연결 영역만 남깁니다(그림자 조각, 먼지 제거). */
function largestComponent(mask, w, h) {
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let best = 0, bestSize = 0, id = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue;
    id++;
    let head = 0, tail = 0;
    queue[tail++] = s; label[s] = id;
    while (head < tail) {
      const i = queue[head++], x = i % w;
      if (x > 0 && mask[i - 1] && !label[i - 1]) { label[i - 1] = id; queue[tail++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !label[i + 1]) { label[i + 1] = id; queue[tail++] = i + 1; }
      if (i >= w && mask[i - w] && !label[i - w]) { label[i - w] = id; queue[tail++] = i - w; }
      if (i < w * (h - 1) && mask[i + w] && !label[i + w]) { label[i + w] = id; queue[tail++] = i + w; }
    }
    if (tail > bestSize) { bestSize = tail; best = id; }
  }
  const out = new Uint8Array(w * h);
  if (best) for (let i = 0; i < w * h; i++) if (label[i] === best) out[i] = 1;
  return { mask: out, size: bestSize };
}

/** 몸판 영역에서 가장 많이 나오는 색(양자화 최빈값)을 옷 기본색으로 씁니다. 로고가 작으면 로고에 끌려가지 않습니다. */
function dominantColor(src, w, mask, x0, x1, y0, y1) {
  const bins = new Map();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!mask[y * w + x]) continue;
      const i = (y * w + x) * 4;
      const key = ((src[i] >> 4) << 8) | ((src[i + 1] >> 4) << 4) | (src[i + 2] >> 4);
      let e = bins.get(key);
      if (!e) { e = [0, 0, 0, 0]; bins.set(key, e); }
      e[0]++; e[1] += src[i]; e[2] += src[i + 1]; e[3] += src[i + 2];
    }
  }
  let top = null;
  for (const e of bins.values()) if (!top || e[0] > top[0]) top = e;
  return top ? [Math.round(top[1] / top[0]), Math.round(top[2] / top[0]), Math.round(top[3] / top[0])] : [200, 200, 200];
}


/** 한쪽 소매 띠: 몸판 가장자리(f=0) → 소매 끝(f=1) 순서로 열별 위·아래 경계를 돌려줍니다. 못 찾으면 null. */
function sleeveStrip(fg, w, xStart, xEnd, y0, y1, minX, minY, cw) {
  const step = xEnd >= xStart ? 1 : -1;
  const xs = [], top = [], bot = [];
  for (let x = xStart; step > 0 ? x <= xEnd : x >= xEnd; x += step) {
    let t = -1;
    for (let y = y0; y <= y1; y++) if (fg[y * w + x]) { t = y; break; }
    if (t < 0) continue;
    let b = t;
    while (b + 1 <= y1 && fg[(b + 1) * w + x]) b++;       // 위에서부터 이어지는 덩어리까지만
    xs.push(x - minX); top.push(t - minY); bot.push(b - minY);
  }
  if (xs.length < Math.max(4, Math.round(cw * 0.03))) return null;
  // 가장자리 들쭉날쭉함을 줄이는 이동평균
  const sm = (a) => a.map((_, i) => { let s = 0, n = 0; for (let k = -2; k <= 2; k++) if (a[i + k] !== undefined) { s += a[i + k]; n++; } return s / n; });
  return { xs, top: sm(top), bot: sm(bot) };
}

function extractSleeves(src, w, fg, g) {
  const y1 = Math.min(g.minY + Math.round(g.ch * 0.6), g.minY + g.ch - 1);
  const xl = Math.round(g.bodyC - g.bodyW / 2), xr = Math.round(g.bodyC + g.bodyW / 2);
  const L = xl - 1 > g.minX ? sleeveStrip(fg, w, xl - 1, g.minX, g.minY, y1, g.minX, g.minY, g.cw) : null;
  const R = xr + 1 < g.maxX ? sleeveStrip(fg, w, xr + 1, g.maxX, g.minY, y1, g.minX, g.minY, g.cw) : null;
  if (!L && !R) return null;
  const colorL = L ? dominantColor(src, w, fg, g.minX, xl, g.minY, y1 + 1) : null;
  const colorR = R ? dominantColor(src, w, fg, xr + 1, g.maxX + 1, g.minY, y1 + 1) : null;
  return { L, R, colorL: colorL || colorR, colorR: colorR || colorL };
}

/** 알파 가중 쌍선형 샘플: 옷 밖(alpha 0) 픽셀의 색이 가장자리로 번지지 않게 합니다. */
function sampleWeighted(rgba, w, h, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  let r = 0, g = 0, b = 0, ws = 0;
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const xx = x0 + dx, yy = y0 + dy;
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const i = (yy * w + xx) * 4;
    const a = (rgba[i + 3] / 255) * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
    r += rgba[i] * a; g += rgba[i + 1] * a; b += rgba[i + 2] * a; ws += a;
  }
  return ws > 1e-3 ? [r / ws, g / ws, b / ws] : null;
}

/**
 * 소매 텍스처: 가로 = 몸판 쪽(0) → 소매 끝(1), 세로 = 소매 윗선(0) → 아랫선(1).
 * 왼쪽 절반 = 사진 왼쪽 소매, 오른쪽 절반 = 사진 오른쪽 소매. 소매 색을 기준으로 그림자를 펴 줍니다.
 */
export function buildSleeveTexture(rgba, w, h, sleeves, flat, SW = 256, SH = 256) {
  const out = new Uint8ClampedArray(2 * SW * SH * 4);
  [[sleeves.L || sleeves.R, sleeves.colorL, 0], [sleeves.R || sleeves.L, sleeves.colorR, 1]].forEach(([st, col, half]) => {
    const tile = new Uint8ClampedArray(SW * SH * 4);
    const n = st.xs.length;
    for (let i = 0; i < SW; i++) {
      const f = (i / (SW - 1)) * (n - 1), i0 = Math.min(n - 2, Math.floor(f)), t = f - i0;
      const x = st.xs[i0] + (st.xs[i0 + 1] - st.xs[i0]) * t;
      const top = st.top[i0] + (st.top[i0 + 1] - st.top[i0]) * t + 1.5;   // 가장자리 1.5px 안쪽부터
      const bot = st.bot[i0] + (st.bot[i0 + 1] - st.bot[i0]) * t - 1.5;
      for (let j = 0; j < SH; j++) {
        const c = sampleWeighted(rgba, w, h, x + 0.5, top + (bot - top) * (j / (SH - 1)) + 0.5) || col;
        const di = (j * SW + i) * 4;
        tile[di] = c[0]; tile[di + 1] = c[1]; tile[di + 2] = c[2]; tile[di + 3] = 255;
      }
    }
    const flatTile = flattenShading(tile, SW, SH, col, flat);
    for (let j = 0; j < SH; j++) out.set(flatTile.subarray(j * SW * 4, (j + 1) * SW * 4), (j * 2 * SW + half * SW) * 4);
  });
  return out;
}

/**
 * 메인 함수. 성공하면 {ok:true, w, h, rgba, base, fit, info, warnings} 를 돌려줍니다.
 * rgba: bbox로 잘라낸 텍스처(옷 밖은 alpha 0, RGB는 기본색)
 * fit : 텍스처 좌표(0~1, y는 위가 0)로 표현한 몸판 기준 {cx, halfW}
 */
export function extractTee(src, w, h, { tol = 30, erodePx = 2 } = {}) {
  const warnings = [];
  const bg = estimateBackground(src, w, h, tol);
  if (bg.uniform < 0.85) warnings.push('배경이 단색이 아닌 것 같아요. 흰 배경 사진일수록 누끼가 정확합니다.');

  const tol2 = tol * tol;
  const isBg = (i) => {
    if (src[i * 4 + 3] < 128) return true;
    const dr = src[i * 4] - bg.color[0], dg = src[i * 4 + 1] - bg.color[1], db = src[i * 4 + 2] - bg.color[2];
    return dr * dr + dg * dg + db * db <= tol2;
  };

  // 테두리에서 시작하는 flood fill: 바깥 배경만 지우므로 옷 안쪽의 흰 무늬는 살아남습니다.
  const reached = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const seed = (i) => { if (!reached[i] && isBg(i)) { reached[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (head < tail) {
    const i = queue[head++], x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < w * (h - 1)) seed(i + w);
  }
  let fg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) fg[i] = reached[i] ? 0 : 1;

  const comp = largestComponent(fg, w, h);
  fg = erode(comp.mask, w, h, erodePx);
  const ratio = comp.size / (w * h);
  if (comp.size === 0 || ratio < 0.04) return { ok: false, reason: '옷 영역을 찾지 못했어요. 배경 민감도를 낮추거나 더 선명한 사진을 써 보세요.', warnings };
  if (ratio > 0.92) return { ok: false, reason: '배경이 지워지지 않았어요. 흰 배경인지 확인하거나 민감도를 높여 보세요.', warnings };

  // bbox + 행별 너비
  let minX = w, maxX = -1, minY = h, maxY = -1;
  const rowMin = new Int32Array(h).fill(w), rowMax = new Int32Array(h).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!fg[y * w + x]) continue;
      if (x < rowMin[y]) rowMin[y] = x;
      if (x > rowMax[y]) rowMax[y] = x;
    }
    if (rowMax[y] >= 0) {
      if (rowMin[y] < minX) minX = rowMin[y];
      if (rowMax[y] > maxX) maxX = rowMax[y];
      if (y < minY) minY = y;
      maxY = y;
    }
  }
  const cw = maxX - minX + 1, ch = maxY - minY + 1;

  // 밑단 부근(아래 4~14%)의 너비·중심 중앙값 = 소매가 섞이지 않은 몸판 폭
  const hemW = [], hemC = [];
  for (let y = maxY - Math.round(ch * 0.14); y <= maxY - Math.round(ch * 0.04); y++) {
    if (rowMax[y] >= 0) { hemW.push(rowMax[y] - rowMin[y] + 1); hemC.push((rowMax[y] + rowMin[y]) / 2); }
  }
  const bodyW = median(hemW) || cw, bodyC = median(hemC) || (minX + maxX) / 2;

  // 소매가 몸판보다 얼마나 튀어나왔는지(상단 45% 최대 너비 / 몸판 너비)
  let topMaxW = 0;
  for (let y = minY; y <= minY + Math.round(ch * 0.45); y++) if (rowMax[y] >= 0) topMaxW = Math.max(topMaxW, rowMax[y] - rowMin[y] + 1);
  const sleeveRatio = topMaxW / bodyW;

  const aspect = ch / bodyW;
  if (aspect < 0.7 || aspect > 2.2) warnings.push('티셔츠 비율이 평소와 달라요. 정면 평면 사진인지 확인해 주세요.');

  const base = dominantColor(src, w, fg, Math.round(bodyC - bodyW * 0.35), Math.round(bodyC + bodyW * 0.35),
    minY + Math.round(ch * 0.45), minY + Math.round(ch * 0.92));

  // 소매 띠: 몸판 폭 바깥쪽 열들(위쪽 60%)에서 열마다 위·아래 가장자리를 기록합니다(텍스처 좌표).
  // 래글런처럼 소매 색이 몸판과 다른 옷, 소매에 줄무늬·프린트가 있는 옷을 3D 소매에 입히는 데 씁니다.
  const sleeves = extractSleeves(src, w, fg, { minX, maxX, minY, ch, cw, bodyC, bodyW });

  // 텍스처: bbox로 자르고, 옷 밖은 기본색 + alpha 0 (경계에서 흰색이 번지지 않게)
  const rgba = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((y + minY) * w + (x + minX));
      const di = (y * cw + x) * 4;
      if (fg[si]) {
        rgba[di] = src[si * 4]; rgba[di + 1] = src[si * 4 + 1]; rgba[di + 2] = src[si * 4 + 2]; rgba[di + 3] = 255;
      } else {
        rgba[di] = base[0]; rgba[di + 1] = base[1]; rgba[di + 2] = base[2]; rgba[di + 3] = 0;
      }
    }
  }

  return {
    ok: true, w: cw, h: ch, rgba, base, sleeves,
    fit: { cx: (bodyC - minX + 0.5) / cw, halfW: bodyW / 2 / cw },
    info: { bg: bg.color, coverage: ratio, sleeveRatio, aspect },
    warnings,
  };
}

/**
 * 사진에 박힌 큰 그림자·주름 밝기를 줄여 "디자인만" 남깁니다.
 * 저주파 밝기(마스크 가중 박스블러)를 기본색 밝기로 맞추는 방식이라 로고 같은 고주파 디테일은 유지됩니다.
 * strength 0 = 원본 그대로, 1 = 최대 보정
 */
export function flattenShading(rgba, w, h, base, strength) {
  const out = new Uint8ClampedArray(rgba);
  if (strength <= 0) return out;
  const W = w + 1;
  const sumL = new Float64Array(W * (h + 1)), sumM = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rl = 0, rm = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (rgba[i + 3] > 0) { rl += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]; rm += 1; }
      sumL[(y + 1) * W + x + 1] = sumL[y * W + x + 1] + rl;
      sumM[(y + 1) * W + x + 1] = sumM[y * W + x + 1] + rm;
    }
  }
  const rad = Math.max(4, Math.round(w * 0.06));
  const target = 0.299 * base[0] + 0.587 * base[1] + 0.114 * base[2];
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rad), y1 = Math.min(h, y + rad + 1);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (rgba[i + 3] === 0) continue;
      const x0 = Math.max(0, x - rad), x1 = Math.min(w, x + rad + 1);
      const m = sumM[y1 * W + x1] - sumM[y0 * W + x1] - sumM[y1 * W + x0] + sumM[y0 * W + x0];
      const l = sumL[y1 * W + x1] - sumL[y0 * W + x1] - sumL[y1 * W + x0] + sumL[y0 * W + x0];
      const local = m > 0 ? l / m : target;
      let f = target / Math.max(local, 8);
      f = Math.min(1.7, Math.max(0.6, f));
      f = 1 + (f - 1) * strength;
      out[i] = rgba[i] * f; out[i + 1] = rgba[i + 1] * f; out[i + 2] = rgba[i + 2] * f;
    }
  }
  return out;
}

/**
 * 텍스처 위쪽을 P행 늘립니다: 각 열의 맨 위 옷 픽셀 색을 위로 이어 붙여요.
 * 3D 옷은 어깨·목 쪽이 사진 윗가장자리보다 위까지 올라가는데, 이 부분이 기본색으로 비면
 * 래글런처럼 어깨까지 소매색인 옷이 어깨만 흰색으로 보입니다.
 */
export function extendTop(rgba, w, h, P) {
  const out = new Uint8ClampedArray(w * (h + P) * 4);
  out.set(rgba, P * w * 4);
  const lim = Math.round(h * 0.3);
  for (let x = 0; x < w; x++) {
    let t = -1;
    for (let y = 0; y < lim; y++) if (rgba[(y * w + x) * 4 + 3] > 0) { t = y; break; }
    const src = t >= 0 ? (Math.min(h - 1, t + 2) * w + x) * 4 : x * 4;     // 가장자리 반투명 픽셀은 피해서 2행 아래 색
    // 새로 늘린 P행 + 원래 사진에서 어깨 경사선 위쪽의 빈 영역(t행 전까지)을 모두 채웁니다.
    const fillTo = t >= 0 ? P + t : P;
    for (let y = 0; y < fillTo; y++) {
      const di = (y * w + x) * 4;
      out[di] = rgba[src]; out[di + 1] = rgba[src + 1]; out[di + 2] = rgba[src + 2];
      out[di + 3] = t >= 0 ? 255 : 0;
    }
  }
  return out;
}
