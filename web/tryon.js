// 티셔츠 사진 → 누끼 → 천 시뮬레이션 티셔츠에 텍스처 투영.
//
// v2 변경점
//  ① 마네킹: 캡슐 덩어리 → 175cm 인체 비율(어깨 경사·가슴·허리·엉덩이·팔·다리)의 매끈한 단면 곡면
//  ② 천 충돌: 화면에 보이는 몸과 같은 단면(타원)·테이퍼 캡슐로 계산 → 옷이 보이는 몸에 정확히 얹힘
//  ③ 마네킹 체형 슬라이더(어깨너비·가슴·허리·엉덩이 둘레), 옷 사이즈 슬라이더(XS~XXL + 세부 cm)
//  ④ 옷은 실제 실측(어깨너비·가슴단면·총장·소매길이, cm)으로 만들어 둘레가 몸보다 작으면 당겨져 보임
//
// 모든 길이는 cm로 모델링하고, 장면에서는 1 unit = 60cm (U)로 환산합니다.
import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { extractTee, flattenShading, buildSleeveTexture, extendTop } from './tee_extract.js';

const $ = (s) => document.querySelector(s);
const view = $('#view');
const U = 1 / 60;                          // cm → scene unit
const lerp = (a, b, t) => a + (b - a) * t;
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

// ───────────────────────── 물리 파라미터 ─────────────────────────
const GAP = 0.6 * U;                        // 천과 몸 사이 최소 간격(0.6cm)
// 체형 변화에서 충돌이 제약 조건에 밀려 다시 몸 안으로 들어가는 현상을 줄이기 위해
// 충돌 반복을 늘리고, 천의 굽힘 강성은 낮춰 자연스러운 드레이프를 우선합니다.
let ITER = 12, SUBSTEPS = 3;
let GRAVITY = -9.8, DAMPING = 0.985;
let STRETCH = 0.78, BEND = 0.10, GMUL = 1;

// ───────────────────────── 체형 / 옷 치수 상태 ─────────────────────────
const BODY0 = { shoulder: 44, chest: 94, waist: 80, hip: 96 };          // 마네킹 (cm, 둘레는 둘레, 어깨는 끝점 간 폭)
const TEE0 = { shoulder: 46, chest: 52, length: 70, sleeve: 22 };       // 옷 실측 M (cm, 가슴은 단면)
const SIZE_NAMES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];                  // 인덱스 = 사이즈 단계 + 2
const grade = (s) => ({                                                // 한 단계 올라갈 때 실제 의류 그레이딩 폭
  shoulder: TEE0.shoulder + 1.6 * s, chest: TEE0.chest + 4 * s,
  length: TEE0.length + 2 * s, sleeve: TEE0.sleeve + 1 * s,
});
const body = { ...BODY0 };
const tee = { ...TEE0 };

// ───────────────────────── 보간 유틸 (C1 연속 스플라인) ─────────────────────────
function spline(keys) {
  const n = keys.length, xs = keys.map((k) => k[0]), vs = keys.map((k) => k[1]);
  const m = vs.map((_, i) => {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    return (vs[b] - vs[a]) / (xs[b] - xs[a]);
  });
  return (x) => {
    if (x <= xs[0]) return vs[0];
    if (x >= xs[n - 1]) return vs[n - 1];
    let i = 0; while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * vs[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * vs[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}
// 타원 둘레 → 반지름 (a: 좌우 반폭, 비율 ρ = 앞뒤/좌우)
const ellA = (girth, rho) => girth / (2 * Math.PI * Math.sqrt((1 + rho * rho) / 2));

// ───────────────────────── 장면 ─────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef1ea);
scene.fog = new THREE.Fog(0xeef1ea, 14, 32);

const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
camera.position.set(0, 2.45, 5.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 2.05, 0);
controls.enableDamping = true;
controls.autoRotateSpeed = 2.0;
controls.update();

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f84, 1.0));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
dirLight.position.set(4, 8, 5);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
Object.assign(dirLight.shadow.camera, { left: -4, right: 4, top: 5, bottom: -2 });
scene.add(dirLight);
const rim = new THREE.DirectionalLight(0xdfe8ff, 0.5);
rim.position.set(-5, 4, -4);
scene.add(rim);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0xdfe4da, roughness: 0.95 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const base = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.64, 0.035, 56), new THREE.MeshStandardMaterial({ color: 0x8a8f89, metalness: 0.4, roughness: 0.45 }));
base.position.y = 0.0175; base.receiveShadow = true; base.castShadow = true; scene.add(base);

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);
resize();

// ───────────────────────── 마네킹 형상 ─────────────────────────
const skin = new THREE.MeshStandardMaterial({ color: 0xe4ddd2, roughness: 0.5, metalness: 0.0 });
const bodyGroup = new THREE.Group();
bodyGroup.scale.setScalar(U);
scene.add(bodyGroup);

const HEIGHT = 175, Y_NECK = 149.4;           // 키, 목 뒤 접히는 높이(HPS)
const ARM_ANG = 20 * Math.PI / 180, ARM_LEN = 57;
const ARM_PROFILE = [[0, 5.0], [0.1, 4.9], [0.3, 4.3], [0.5, 3.7], [0.58, 3.9], [0.85, 3.1], [1, 2.7]];
const armRadius = spline(ARM_PROFILE);
const LEG_PROFILE = [[0, 8.4], [0.12, 8.9], [0.3, 7.7], [0.5, 5.2], [0.62, 5.4], [0.95, 3.4], [1, 3.2]];

// 단면들을 이어 붙여 매끈한 곡면 만들기. rings[i][j] = Vector3
function loft(rings) {
  const R = rings.length, M = rings[0].length, p = new Float32Array(R * M * 3), idx = [];
  rings.forEach((ring, i) => ring.forEach((v, j) => p.set([v.x, v.y, v.z], (i * M + j) * 3)));
  for (let i = 0; i < R - 1; i++) for (let j = 0; j < M; j++) {
    const a = i * M + j, b = i * M + (j + 1) % M, c = (i + 1) * M + j, d = (i + 1) * M + (j + 1) % M;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // 바깥쪽이 앞면이 되도록 방향 자동 보정
  const mi = R >> 1, cen = new THREE.Vector3();
  rings[mi].forEach((v) => cen.add(v)); cen.divideScalar(M);
  const n = V3(g.attributes.normal.getX(mi * M), g.attributes.normal.getY(mi * M), g.attributes.normal.getZ(mi * M));
  if (n.dot(rings[mi][0].clone().sub(cen)) < 0) {
    for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
    g.setIndex(idx); g.computeVertexNormals();
  }
  return g;
}

// 끝이 둥근 테이퍼 원통 (팔·다리·목). prof = [[t(0~1), 반지름]]
function limb(p0, p1, prof, { M = 28, N = 26 } = {}) {
  const f = spline(prof), dir = p1.clone().sub(p0), L = dir.length(); dir.normalize();
  const ref = Math.abs(dir.z) > 0.9 ? V3(1, 0, 0) : V3(0, 0, 1);
  const u = ref.clone().cross(dir).normalize(), v = dir.clone().cross(u);
  const st = [];
  const r0 = f(0), r1 = f(1), CAP = 5;
  for (let k = 0; k < CAP; k++) { const ph = (Math.PI / 2) * (1 - k / CAP); st.push([-r0 * Math.sin(ph), r0 * Math.cos(ph)]); }
  for (let i = 0; i <= N; i++) { const t = i / N; st.push([t * L, f(t)]); }
  for (let k = 1; k <= CAP; k++) { const ph = (Math.PI / 2) * (k / CAP); st.push([L + r1 * Math.sin(ph), r1 * Math.cos(ph)]); }
  const rings = st.map(([off, rad]) => {
    const c = p0.clone().addScaledVector(dir, off), ring = [];
    for (let j = 0; j < M; j++) {
      const th = 2 * Math.PI * j / M;
      ring.push(c.clone().addScaledVector(u, Math.cos(th) * rad).addScaledVector(v, Math.sin(th) * rad));
    }
    return ring;
  });
  // 충돌용 원뿔 캡슐: 구간별로 근사
  const caps = [], S = 7;
  for (let i = 0; i < S; i++) {
    const t0 = i / S, t1 = (i + 1) / S;
    caps.push({ a: p0.clone().addScaledVector(dir, t0 * L), b: p0.clone().addScaledVector(dir, t1 * L), ra: f(t0), rb: f(t1) });
  }
  return { geo: loft(rings), caps, dir, f };
}

let TORSO = null;                 // 충돌용 몸통 단면 테이블 (scene unit)
let TFN = null;                   // 몸통 단면 함수 {A,B,Z} (cm) — 목선 링을 몸 표면에 붙일 때 사용
let BODY_CAPS = [], SLEEVE_CAPS = [];
let ARMS = [];                    // [{p0, dir}] cm
const T_Y0 = 76, T_Y1 = 153, T_STEP = 0.5;

function torsoFunctions(b) {
  const aCh = ellA(b.chest, 0.68), bCh = aCh * 0.68;
  const aW = ellA(b.waist, 0.76), bW = aW * 0.76;
  const aH = ellA(b.hip, 0.72), bH = aH * 0.72;
  const aSh = b.shoulder / 2 - 3.2;                       // 어깨끝 안쪽 몸통 반폭 (바깥은 팔 윗부분이 채움)
  const A = spline([
    [76, aH * 0.55], [79, aH * 0.76], [84, aH * 0.96], [91, aH], [99, lerp(aH, aW, 0.55)], [106, aW],
    [116, lerp(aW, aCh, 0.65)], [127, aCh], [134, lerp(aCh, aSh, 0.55)], [140.5, aSh], [143.5, aSh * 0.97],
    [146.5, 0.5 * (aSh + 6.8)], [149, 6.9], [150.5, 5.3], [152, 3.0], [153, 0.5],
  ]);
  const B = spline([
    [76, bH * 0.6], [79, bH * 0.82], [91, bH], [106, bW], [118, lerp(bW, bCh, 0.75)], [127, bCh], [135, lerp(bCh, 8.4, 0.55)],
    [141, 8.2], [145, 7.2], [149, 6.7], [150.5, 5.6], [152, 3.0], [153, 0.5],
  ]);
  const Z = spline([[76, -0.4], [91, -1.0], [106, 0.0], [127, 0.8], [141, -0.6], [149, -0.8], [153, -0.6]]);
  return { A, B, Z, aCh, bCh };
}

function buildMannequin() {
  while (bodyGroup.children.length) { const m = bodyGroup.children.pop(); m.geometry.dispose(); }
  const add = (geo, mat = skin) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; bodyGroup.add(m); return m; };
  const { A, B, Z } = torsoFunctions(body);
  TFN = { A, B, Z };

  // 몸통 (타원 단면 스택)
  const Mr = 56, rings = [];
  const ring = (y, k = 1) => {
    const a = Math.max(0.3, A(y)) * k, b = Math.max(0.3, B(y)) * k, z = Z(y), r = [];
    for (let j = 0; j < Mr; j++) { const th = 2 * Math.PI * j / Mr; r.push(V3(a * Math.sin(th), y, z + b * Math.cos(th))); }
    return r;
  };
  rings.push(ring(75.2, 0.2), ring(75.8, 0.55), ring(76.8, 0.85));
  for (let y = 78; y <= 152.5; y += 1.25) rings.push(ring(y));
  rings.push(ring(153, 0.3));
  add(loft(rings));

  // 충돌용 테이블
  const n = Math.round((T_Y1 - T_Y0) / T_STEP) + 1;
  TORSO = { a: new Float32Array(n), b: new Float32Array(n), z: new Float32Array(n), n };
  for (let i = 0; i < n; i++) {
    const y = T_Y0 + i * T_STEP;
    TORSO.a[i] = Math.max(0.3, A(y)) * U + GAP; TORSO.b[i] = Math.max(0.3, B(y)) * U + GAP; TORSO.z[i] = Z(y) * U;
  }

  // 목 + 머리
  const neck = limb(V3(0, 141, 0.2), V3(0, 158, 1.2), [[0, 6.0], [0.4, 5.2], [1, 5.0]], { M: 24, N: 10 });
  add(neck.geo);
  const hp = [];
  for (let i = 0; i <= 28; i++) {
    const ph = -Math.PI / 2 + Math.PI * i / 28, yy = Math.sin(ph), s = (yy + 1) / 2;
    hp.push(new THREE.Vector2(Math.max(0.0001, Math.cos(ph) * (0.78 + 0.22 * s * s * (3 - 2 * s))), yy));
  }
  const head = add(new THREE.LatheGeometry(hp, 40));
  head.scale.set(9.0, 11.6, 10.4); head.position.set(0, 163.6, 1.0);

  // 팔 (A자 포즈) / 다리
  ARMS = []; BODY_CAPS = []; SLEEVE_CAPS = [];
  const caps = { body: [], sleeve: [] };
  for (const sg of [1, -1]) {
    const p0 = V3(sg * (body.shoulder / 2 - 5.0), 138.8, 0.0);
    const dir = V3(sg * Math.sin(ARM_ANG), -Math.cos(ARM_ANG), 0);
    const p1 = p0.clone().addScaledVector(dir, ARM_LEN);
    const arm = limb(p0, p1, ARM_PROFILE);
    add(arm.geo);
    const hand = add(new THREE.SphereGeometry(1, 20, 16));
    hand.scale.set(3.5, 8.6, 1.9);
    hand.position.copy(p1).addScaledVector(dir, 6.3);
    hand.quaternion.setFromUnitVectors(V3(0, 1, 0), dir.clone().negate());
    ARMS.push({ p0, dir, sg });
    caps.sleeve.push(...arm.caps);
    caps.body.push({ a: p0.clone(), b: p0.clone(), ra: 5.3, rb: 5.3, top: true });    // 어깨 둥근 부분(위쪽만)

    const l0 = V3(sg * 9.2, 88, -0.3), l1 = V3(sg * 9.7, 8.5, 0.2);
    const leg = limb(l0, l1, LEG_PROFILE);
    add(leg.geo);
    const foot = add(new THREE.SphereGeometry(1, 20, 14));
    foot.scale.set(4.2, 3.4, 10.5); foot.position.set(sg * 9.7, 5.2, 4.6);
    caps.body.push(...leg.caps); caps.sleeve.push(...leg.caps);
  }
  const headCap = { a: V3(0, 163.6, 1.0), b: V3(0, 163.6, 1.0), ra: 10.5, rb: 10.5 };
  caps.body.push(neck.caps[0], neck.caps[1], neck.caps[2], neck.caps[3], neck.caps[4], neck.caps[5], neck.caps[6], headCap);
  caps.sleeve.push(neck.caps[0], neck.caps[1], neck.caps[2], neck.caps[3], neck.caps[4], neck.caps[5], neck.caps[6], headCap);

  const num = (c) => {
    const a = c.a.clone().multiplyScalar(U), bb = c.b.clone().multiplyScalar(U), ra = c.ra * U + GAP, rb = c.rb * U + GAP;
    return {
      ax: a.x, ay: a.y, az: a.z, bx: bb.x - a.x, by: bb.y - a.y, bz: bb.z - a.z, len2: bb.distanceToSquared(a),
      ra, rb, y0: Math.min(a.y, bb.y) - Math.max(ra, rb), y1: Math.max(a.y, bb.y) + Math.max(ra, rb), top: !!c.top,
    };
  };
  BODY_CAPS = caps.body.map(num);
  SLEEVE_CAPS = caps.sleeve.map(num);
}

// ───────────────────────── 옷 메쉬 (토폴로지는 고정, 치수만 바뀜) ─────────────────────────
// 몸판 키 단면: [목 윗단, 목 아랫단, 어깨선, 겨드랑 위, 가슴, 허리, 엉덩이, 밑단]
const SUBS = [4, 2, 3, 3, 4, 4, 5];
const rowMap = [[0, 0]];
for (let k = 0; k < SUBS.length; k++) for (let s = 1; s <= SUBS[k]; s++) rowMap.push([k, s / SUBS[k]]);
const RB = rowMap.length, CB = 64, PIN_ROWS = 5;
const CS = 22, RS = 12;
const NB = RB * CB, NS = CS * RS, N = NB + NS * 2;
const bi = (r, c) => r * CB + ((c + CB) % CB);
const si = (s, j, k) => NB + s * NS + j * CS + ((k + CS) % CS);

const pos = new Float32Array(N * 3), prev = new Float32Array(N * 3);
const invMass = new Float32Array(N);
const kind = new Uint8Array(N);                 // 0 몸판, 1 소매
for (let q = 0; q < N; q++) kind[q] = q < NB ? 0 : 1;
const restA = new Float32Array(N * 4);          // (sinθ, 텍스처 세로 위치, cosθ, 소매 여부)
for (let q = NB; q < N; q++) restA[q * 4 + 3] = 1;

const ca = [], cb = [], cbd = [];
const idxs = [];
const addC = (a, b, bend = 0) => { ca.push(a); cb.push(b); cbd.push(bend); };
for (let r = 0; r < RB - 1; r++) for (let c = 0; c < CB; c++) {
  addC(bi(r, c), bi(r, c + 1)); addC(bi(r, c), bi(r + 1, c));
  addC(bi(r, c), bi(r + 1, c + 1)); addC(bi(r, c + 1), bi(r + 1, c));
  if (r + 2 < RB) addC(bi(r, c), bi(r + 2, c), 1);
  idxs.push(bi(r, c), bi(r + 1, c), bi(r, c + 1), bi(r, c + 1), bi(r + 1, c), bi(r + 1, c + 1));
}
for (let c = 0; c < CB; c++) addC(bi(RB - 1, c), bi(RB - 1, c + 1));
for (let s = 0; s < 2; s++) {
  for (let j = 0; j < RS; j++) for (let k = 0; k < CS; k++) {
    addC(si(s, j, k), si(s, j, k + 1));
    if (j + 1 < RS) {
      addC(si(s, j, k), si(s, j + 1, k));
      addC(si(s, j, k), si(s, j + 1, k + 1)); addC(si(s, j, k + 1), si(s, j + 1, k));
      idxs.push(si(s, j, k), si(s, j + 1, k), si(s, j, k + 1), si(s, j, k + 1), si(s, j + 1, k), si(s, j + 1, k + 1));
    }
    if (j + 2 < RS) addC(si(s, j, k), si(s, j + 2, k), 1);
  }
}
// 소매 시작 링 ↔ 몸판 "봉제선" 슬롯: 빌드 때마다 가장 가까운 몸판 꼭짓점과 이어 팔 구멍을 닫음
const WELD0 = ca.length;
for (let s = 0; s < 2; s++) for (let k = 0; k < CS; k++) addC(si(s, 0, k), si(s, 0, k));
const CA = Int32Array.from(ca), CBn = Int32Array.from(cb), NC = CA.length;
const CT = Uint8Array.from(cbd);
const CR = new Float32Array(NC);                // 설계(실측) 기준 길이 — 치수가 바뀔 때마다 갱신

const dist = (a, b) => Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
function setP(q, x, y, z, m) { pos.set([x * U, y * U, z * U], q * 3); prev.set([x * U, y * U, z * U], q * 3); invMass[q] = m; }

const NECK_DROP = 4.2;                          // 앞중심이 뒤목보다 내려가는 깊이(cm)
const NECK_MARGIN = 0.7;                        // 목선 링이 몸통 표면에서 떨어진 거리(cm)
const SHOULDER_D = 6.5;                         // 어깨선 위치(목 뒤 접힘선 아래 cm)
function garmentKeys() {
  const W = tee.chest, aC = W * 0.3688, bC = aC * 0.7;   // 둘레 = 2×가슴단면 인 타원 (앞뒤/좌우 = 0.7)
  const Gs = tee.shoulder / 2, L = tee.length;
  // 좁은 크루넥: 목둘레를 줄이고 앞중심만 더 내려 둥근 U 형태를 만듭니다.
  // 목에서 어깨로 퍼지는 구간도 완만하게 연결해 넓은 칼라/어깨 덮개처럼 보이는 면을 줄입니다.
  const d = [0.2, 1.8, 7.2, 14, 24, 24 + (L - 24) * 0.38, 24 + (L - 24) * 0.7, L];
  const a = [5.1, 6.0, Gs - 0.8, lerp(Gs - 0.8, aC, 0.6), aC, aC * 0.99, aC * 0.99, aC];
  const b = [5.1, 6.0, 8.4, lerp(8.4, bC, 0.6), bC, bC * 0.99, bC * 0.99, bC];
  return { d, a, b, L };
}

// 소매: 어깨선(팔 윗부분 꼭대기)에서 소매단까지가 "소매길이". 팔 축 기준 s0~s1 구간에 통을 배치
function sleeveSpec() {
  const W = tee.chest, s0 = -1.2, s1 = Math.max(s0 + 5, tee.sleeve - 4.7);
  return {
    s0, s1,
    r0: Math.max(0.127 * W, armRadius(0) + 1.3),
    r1: Math.max(0.108 * W, armRadius(Math.min(1, Math.max(0, s1) / ARM_LEN)) + 0.7),
  };
}

// 현재 치수로 옷을 "설계 형상"으로 배치 → 기준 길이 계산 → 몸에 겹친 부분은 밖으로 밀어냄
function buildCloth() {
  const g = garmentKeys();
  for (let r = 0; r < RB; r++) {
    const [k, t] = rowMap[r];
    const k2 = Math.min(k + 1, g.d.length - 1);
    const d = lerp(g.d[k], g.d[k2], t), a = lerp(g.a[k], g.a[k2], t), b = lerp(g.b[k], g.b[k2], t);
    for (let c = 0; c < CB; c++) {
      const th = 2 * Math.PI * c / CB;
      // 목둘레 앞쪽(+Z)을 조금 더 내려 둥근 U자 넥라인을 만듭니다.
      const front = Math.pow(Math.max(0, Math.cos(th)), 1.6);     // 지수>1 → 앞중심 쪽만 둥글게 내려가는 U자
      // 처짐은 목 링(d≤1.8)에서 최대, 아래로 갈수록 부드럽게 0으로 줄입니다(가슴 위 d=14cm에서 0).
      // 일정하게 주다가 갑자기 끊으면 앞중심에서 천의 줄 순서가 뒤집혀 가로 주름이 생깁니다.
      const tw = Math.min(1, Math.max(0, (d - 1.8) / (14 - 1.8)));
      const neckDrop = front * NECK_DROP * (1 - tw * tw * (3 - 2 * tw));
      const localD = d + neckDrop;
      const vTop = (localD - SHOULDER_D) / (g.L - SHOULDER_D);
      if (r < PIN_ROWS && TFN) {
        // 고정된 목 링(목선): 같은 높이의 몸통 단면 바로 바깥(NECK_MARGIN)에 붙입니다.
        // 예전처럼 목 반지름(5~6cm)으로 만들면 링이 몸통 어깨 경사 '안쪽'에 묻혀서,
        // 화면에 보이는 목선이 몸통이 넓어지는 지점(어깨 쪽)으로 밀려 넓은 네모 목선이 됐습니다.
        const y = Y_NECK - localD;
        setP(bi(r, c), (TFN.A(y) + NECK_MARGIN) * Math.sin(th), y, TFN.Z(y) + (TFN.B(y) + NECK_MARGIN) * Math.cos(th), 0);
      } else {
        setP(bi(r, c), a * Math.sin(th), Y_NECK - localD, b * Math.cos(th), r < PIN_ROWS ? 0 : 1);
      }
      restA.set([Math.sin(th), vTop, Math.cos(th), 0], bi(r, c) * 4);
    }
  }
  const sl = sleeveSpec();
  for (let s = 0; s < 2; s++) {
    const { p0, dir, sg } = ARMS[s];
    const n1 = V3(sg * Math.cos(ARM_ANG), Math.sin(ARM_ANG), 0), n2 = V3(0, 0, 1);
    for (let j = 0; j < RS; j++) {
      const f = j / (RS - 1), rad = lerp(sl.r0, sl.r1, f);
      const ctr = p0.clone().addScaledVector(dir, lerp(sl.s0, sl.s1, f));
      for (let k = 0; k < CS; k++) {
        const ph = 2 * Math.PI * k / CS;
        const p = ctr.clone().addScaledVector(n1, rad * Math.cos(ph)).addScaledVector(n2, rad * Math.sin(ph));
        setP(si(s, j, k), p.x, p.y, p.z, j === 0 ? 0 : 1);
        // 소매 텍스처 좌표: f = 어깨(0)→소매끝(1), v = 윗선(0)→아랫선(1), z = 앞쪽(+)/뒤쪽(-), w = 1 왼쪽 / 2 오른쪽 소매
        restA.set([f, (1 - Math.cos(ph)) / 2, Math.sin(ph), sg > 0 ? 2 : 1], si(s, j, k) * 4);
      }
    }
  }
  for (let s = 0; s < NC; s++) CR[s] = dist(CA[s], CBn[s]);   // 실측 기준 길이
  for (let w = 0; w < 2 * CS; w++) {                           // 소매 ↔ 몸판 봉제
    const q = CA[WELD0 + w];
    let best = q, bd = (4 * U) ** 2;
    for (let r = PIN_ROWS; r < RB; r++) for (let c = 0; c < CB; c++) {
      const v = bi(r, c), dx = pos[v * 3] - pos[q * 3], dy = pos[v * 3 + 1] - pos[q * 3 + 1], dz = pos[v * 3 + 2] - pos[q * 3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bd) { bd = d2; best = v; }
    }
    CBn[WELD0 + w] = best; CR[WELD0 + w] = 0;
  }
  geometry.attributes.aRest.needsUpdate = true;
  // 몸보다 작은 옷은 처음부터 몸 바깥으로 밀어 놓고(기준 길이는 그대로 → 당겨짐), 이후 시뮬레이션이 정리
  // 큰 체형에서 천이 몸 안쪽에 남지 않도록 초기 배치 때도 반복 투영합니다.
  for (let it = 0; it < 10; it++) {
    for (let q = 0; q < N; q++) if (invMass[q] !== 0) {
      collide(q);
      collide(q);
    }
  }
  prev.set(pos);
}

// 소매 시작 링: 체형(어깨너비)이 바뀌어도 팔 위치를 따라가도록 고정점만 갱신
function repinSleeves() {
  const sl = sleeveSpec();
  for (let s = 0; s < 2; s++) {
    const { p0, dir, sg } = ARMS[s];
    const n1 = V3(sg * Math.cos(ARM_ANG), Math.sin(ARM_ANG), 0), n2 = V3(0, 0, 1);
    const c0 = p0.clone().addScaledVector(dir, sl.s0);
    for (let k = 0; k < CS; k++) {
      const ph = 2 * Math.PI * k / CS;
      const p = c0.clone().addScaledVector(n1, sl.r0 * Math.cos(ph)).addScaledVector(n2, sl.r0 * Math.sin(ph));
      const q = si(s, 0, k);
      pos.set([p.x * U, p.y * U, p.z * U], q * 3); prev.set([p.x * U, p.y * U, p.z * U], q * 3);
    }
  }
}

// ───────────────────────── 메시 + 텍스처 셰이더 ─────────────────────────
const geometry = new THREE.BufferGeometry();
const posAttr = new THREE.BufferAttribute(pos, 3);
posAttr.setUsage(THREE.DynamicDrawUsage);
geometry.setAttribute('position', posAttr);
geometry.setAttribute('aRest', new THREE.BufferAttribute(restA, 4));
geometry.setIndex(idxs);

const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1);
blank.needsUpdate = true;
const uni = {
  uTex: { value: blank },
  uHas: { value: 0 },
  uBase: { value: new THREE.Color().setRGB(0.77, 0.78, 0.79, THREE.SRGBColorSpace) },
  uHasSl: { value: 0 },                                      // 소매 텍스처 사용 여부
  uSlTex: { value: blank },                                  // 왼쪽 절반=사진 왼쪽 소매, 오른쪽 절반=오른쪽 소매
  uSlBaseL: { value: new THREE.Color().setRGB(0.77, 0.78, 0.79, THREE.SRGBColorSpace) },   // 소매 뒤쪽 색
  uSlBaseR: { value: new THREE.Color().setRGB(0.77, 0.78, 0.79, THREE.SRGBColorSpace) },
  uFit: { value: new THREE.Vector4(0.5, 0.3, 0, 1) },        // 텍스처 안의 몸판 중심x, 반폭, 위, 아래
  uAdj: { value: new THREE.Vector3(1, 0, 0) },               // 확대, 가로 이동, 세로 이동
};
const shirtMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.9 });
shirtMat.customProgramCacheKey = () => 'tee-photo-v3';
shirtMat.onBeforeCompile = (sh) => {
  Object.assign(sh.uniforms, uni);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 aRest;\nvarying vec4 vRest;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = aRest;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
      varying vec4 vRest;
      uniform sampler2D uTex;
      uniform float uHas;
      uniform vec3 uBase;
      uniform float uHasSl;
      uniform sampler2D uSlTex;
      uniform vec3 uSlBaseL;
      uniform vec3 uSlBaseR;
      uniform vec4 uFit;
      uniform vec3 uAdj;`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      vec3 shirtCol = uBase;
      // 앞판(정지 상태 z>=0)에는 사진을 그대로, 뒷판은 기본색. vRest.y = 어깨선(0)→밑단(1) 텍스처 세로 위치
      // 소매(vRest.w>=1): 앞쪽 절반엔 사진의 소매 영역을, 뒤쪽 절반엔 소매 대표색을 입힙니다.
      if (vRest.w > 0.5) {
        float right = step(1.5, vRest.w);
        shirtCol = mix(uSlBaseL, uSlBaseR, right);
        if (uHasSl > 0.5 && vRest.z >= 0.0) {
          vec2 suv = vec2((clamp(vRest.x, 0.004, 0.996) + right) * 0.5, clamp(vRest.y, 0.004, 0.996));
          shirtCol = texture2D(uSlTex, suv).rgb;
        }
      } else if (uHas > 0.5 && vRest.z >= 0.0) {
        float vTop = vRest.y;
        vec2 uv = vec2(uFit.x + vRest.x * uFit.y, uFit.z + vTop * (uFit.w - uFit.z));
        vec2 ctr = vec2(uFit.x, uFit.z + 0.30 * (uFit.w - uFit.z));
        uv = (uv - ctr) / uAdj.x + ctr + uAdj.yz;
        if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
          vec4 t = texture2D(uTex, uv);
          shirtCol = mix(shirtCol, t.rgb, t.a);
        }
      }
      diffuseColor.rgb = shirtCol;`);
};
const shirt = new THREE.Mesh(geometry, shirtMat);
shirt.castShadow = true; shirt.receiveShadow = true; shirt.frustumCulled = false;
scene.add(shirt);

// ───────────────────────── 물리 ─────────────────────────
function collide(q) {
  const caps = kind[q] ? SLEEVE_CAPS : BODY_CAPS;
  let x = pos[q * 3], y = pos[q * 3 + 1], z = pos[q * 3 + 2];
  // 몸통: 높이별 타원 단면
  const fi = (y / U - T_Y0) / T_STEP;
  if (fi >= 0 && fi < TORSO.n - 1) {
    const i = fi | 0, f = fi - i;
    const a = TORSO.a[i] + (TORSO.a[i + 1] - TORSO.a[i]) * f;
    const b = TORSO.b[i] + (TORSO.b[i + 1] - TORSO.b[i]) * f;
    const zc = TORSO.z[i] + (TORSO.z[i + 1] - TORSO.z[i]) * f;
    const nx = x / a, nz = (z - zc) / b, d2 = nx * nx + nz * nz;
    if (d2 < 1) { const d = Math.sqrt(d2) || 1e-6; x = nx / d * a; z = zc + nz / d * b; }
  }
  // 팔·다리·목·머리: 테이퍼 캡슐
  for (const c of caps) {
    if (y < c.y0 || y > c.y1) continue;
    if (c.top && y <= c.ay) continue;
    let t = 0;
    if (c.len2 > 0) {
      t = ((x - c.ax) * c.bx + (y - c.ay) * c.by + (z - c.az) * c.bz) / c.len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const cx = c.ax + c.bx * t, cy = c.ay + c.by * t, cz = c.az + c.bz * t, r = c.ra + (c.rb - c.ra) * t;
    const dx = x - cx, dy = y - cy, dz = z - cz, d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < r * r) {
      const f = r / (Math.sqrt(d2) || 1e-6);
      x = cx + dx * f; y = cy + dy * f; z = cz + dz * f;
    }
  }
  pos[q * 3] = x; pos[q * 3 + 1] = y; pos[q * 3 + 2] = z;
}

function step(dt, t, wind) {
  const dt2 = dt * dt;
  for (let k = 0; k < N; k++) {
    if (invMass[k] === 0) continue;
    const ix = k * 3, iy = ix + 1, iz = ix + 2;
    const vx = (pos[ix] - prev[ix]) * DAMPING, vy = (pos[iy] - prev[iy]) * DAMPING, vz = (pos[iz] - prev[iz]) * DAMPING;
    let ax = 0, az = 0;
    if (wind) { az = 0.8 + Math.sin(t * 1.3) * 0.5; ax = Math.sin(t * 2 + pos[iy] * 2) * 0.2; }
    prev[ix] = pos[ix]; prev[iy] = pos[iy]; prev[iz] = pos[iz];
    pos[ix] += vx + ax * dt2; pos[iy] += vy + GRAVITY * GMUL * dt2; pos[iz] += vz + az * dt2;
  }
  for (let it = 0; it < ITER; it++) {
    for (let s = 0; s < NC; s++) {
      const a = CA[s], b = CBn[s], wa = invMass[a], wb = invMass[b], ws = wa + wb;
      if (ws === 0) continue;
      const ax = a * 3, bx = b * 3;
      const dx = pos[bx] - pos[ax], dy = pos[bx + 1] - pos[ax + 1], dz = pos[bx + 2] - pos[ax + 2];
      const len = Math.hypot(dx, dy, dz) || 1e-6, diff = (len - CR[s]) / len;
      const kk = CT[s] ? BEND : STRETCH;
      const cA = wa / ws * diff * kk, cB = wb / ws * diff * kk;
      pos[ax] += dx * cA; pos[ax + 1] += dy * cA; pos[ax + 2] += dz * cA;
      pos[bx] -= dx * cB; pos[bx + 1] -= dy * cB; pos[bx + 2] -= dz * cB;
    }
    // 제약 조건 보정 직후 충돌을 두 번 적용해 큰 체형에서도 천이 몸을 관통하지 않게 합니다.
    for (let q = 0; q < N; q++) if (invMass[q] !== 0) {
      collide(q);
      collide(q);
    }
  }
}
const settle = (n) => {
  // 정착 단계에서는 바람을 끄고 중력만 적용해 밑단이 아래로 안정되도록 합니다.
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < SUBSTEPS; s++) step(1 / 60 / SUBSTEPS, 0, false);
  }
};

// ───────────────────────── 옷감 프리셋 ─────────────────────────
const FABRIC = {
  cotton: { label: '면', iter: 12, sub: 3, damp: 0.985, stretch: 0.78, bend: 0.10, gmul: 1 },
  knit:   { label: '니트', iter: 10, sub: 3, damp: 0.982, stretch: 0.62, bend: 0.045, gmul: 1 },
  denim:  { label: '데님', iter: 14, sub: 3, damp: 0.988, stretch: 0.92, bend: 0.32, gmul: 1.15 },
  silk:   { label: '실크', iter: 10, sub: 3, damp: 0.992, stretch: 0.72, bend: 0.018, gmul: 0.78 },
};
function applyFabric(name) {
  const f = FABRIC[name]; if (!f) return;
  ITER = f.iter; SUBSTEPS = f.sub; DAMPING = f.damp; STRETCH = f.stretch; BEND = f.bend; GMUL = f.gmul;
  $('#fabric').value = name;
}
$('#fabric').addEventListener('change', (e) => applyFabric(e.target.value));
applyFabric('cotton');

// ───────────────────────── 슬라이더: 마네킹 체형 / 옷 사이즈 ─────────────────────────
const BODY_KEYS = ['shoulder', 'chest', 'waist', 'hip'];
const TEE_KEYS = ['shoulder', 'chest', 'length', 'sleeve'];
const fmt = (v) => (Math.round(v * 10) / 10).toString();

function syncBodyUI() {
  for (const k of BODY_KEYS) { $(`#b-${k}`).value = body[k]; $(`#o-b-${k}`).textContent = `${fmt(body[k])} cm`; }
}
function syncTeeUI() {
  for (const k of TEE_KEYS) { $(`#t-${k}`).value = tee[k]; $(`#o-t-${k}`).textContent = `${fmt(tee[k])} cm`; }
}
function sizeLabel(s, custom) {
  const i = Math.round(s), name = SIZE_NAMES[Math.max(0, Math.min(5, i + 2))];
  return custom ? '직접 조정' : `${name}${Math.abs(s - i) > 0.15 ? ' 근처' : ''}`;
}
function updateFit() {
  const chestEase = 2 * tee.chest - body.chest;
  const shDiff = tee.shoulder - body.shoulder;
  const waistEase = 2 * tee.chest * 0.99 - body.waist;
  const verdict = chestEase < 0 ? '몸보다 작아서 당겨져요'
    : chestEase < 6 ? '타이트 핏' : chestEase < 14 ? '레귤러 핏' : chestEase < 24 ? '루즈 핏' : '오버사이즈 핏';
  const sg = (v) => (v >= 0 ? '+' : '') + fmt(v);
  $('#fit-note').innerHTML = `<b>${verdict}</b><br>가슴 여유 ${sg(chestEase)}cm · 어깨 ${sg(shDiff)}cm · 허리 여유 ${sg(waistEase)}cm`;
}

let bodyDirty = false, teeDirty = false, rafPending = false;
function requestRefit() {
  if (rafPending) return; rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (bodyDirty) {
      // 체형 변경 시 옷도 새 몸 기준으로 다시 걸쳐 천이 몸을 뚫거나 뭉치는 현상을 방지
      buildMannequin();
      repinSleeves();
      buildCloth();
      settle(60);
    } else if (teeDirty) {
      buildCloth();
      settle(42);
    }
    bodyDirty = teeDirty = false;
    updateFit();
  });
}
function setBody(patch) { Object.assign(body, patch); syncBodyUI(); bodyDirty = true; requestRefit(); }
function setTee(patch, sizeStep) {
  Object.assign(tee, patch); syncTeeUI();
  const slider = $('#t-size');
  if (sizeStep === undefined) { $('#o-t-size').textContent = sizeLabel(+slider.value, true); }
  else { slider.value = sizeStep; $('#o-t-size').textContent = sizeLabel(sizeStep, false); }
  teeDirty = true; requestRefit();
}
BODY_KEYS.forEach((k) => $(`#b-${k}`).addEventListener('input', (e) => setBody({ [k]: +e.target.value })));
TEE_KEYS.forEach((k) => $(`#t-${k}`).addEventListener('input', (e) => setTee({ [k]: +e.target.value })));
$('#t-size').addEventListener('input', (e) => { const s = +e.target.value; setTee(grade(s), s); });
const BODY_PRESETS = {
  slim: { shoulder: 41, chest: 88, waist: 72, hip: 90 },
  regular: { ...BODY0 },
  broad: { shoulder: 49, chest: 106, waist: 92, hip: 104 },
};
document.querySelectorAll('[data-body]').forEach((b) => b.addEventListener('click', () => setBody(BODY_PRESETS[b.dataset.body])));
document.querySelectorAll('.tryon input[type=range]').forEach((el) => el.addEventListener('change', () => settle(36)));
$('#body-reset').addEventListener('click', () => setBody({ ...BODY0 }));
$('#tee-reset').addEventListener('click', () => setTee(grade(0), 0));

// ───────────────────────── 드래그로 천 잡아당기기 ─────────────────────────
const raycaster = new THREE.Raycaster(), mouse = new THREE.Vector2();
const dragPlane = new THREE.Plane(), hitPoint = new THREE.Vector3(), tmpV = new THREE.Vector3();
let dragging = -1;
const canvas = renderer.domElement;
const setMouse = (e) => {
  const r = canvas.getBoundingClientRect();
  mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
};
function nearestFree() {
  let best = -1, bd = 0.2;
  for (let k = 0; k < N; k++) {
    if (invMass[k] === 0) continue;
    tmpV.set(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
    const d = raycaster.ray.distanceToPoint(tmpV);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}
canvas.addEventListener('pointerdown', (e) => {
  setMouse(e);
  const k = nearestFree();
  if (k < 0) return;
  dragging = k; controls.enabled = false;
  const n = new THREE.Vector3(); camera.getWorldDirection(n);
  dragPlane.setFromNormalAndCoplanarPoint(n, tmpV.set(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]));
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (dragging < 0) return;
  setMouse(e);
  if (raycaster.ray.intersectPlane(dragPlane, hitPoint)) {
    pos.set([hitPoint.x, hitPoint.y, hitPoint.z], dragging * 3);
    prev.set([hitPoint.x, hitPoint.y, hitPoint.z], dragging * 3);
  }
});
const endDrag = (e) => {
  if (dragging < 0) return;
  dragging = -1; controls.enabled = true;
  canvas.releasePointerCapture?.(e.pointerId);
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

function dress(withSettle) { buildCloth(); if (withSettle) settle(36); }
$('#reset').addEventListener('click', () => { dress(false); dragging = -1; controls.enabled = true; });
$('#spin').addEventListener('change', (e) => { controls.autoRotate = e.target.checked; });
const VIEWS = { front: [0, 2.45, 5.6], back: [0, 2.45, -5.6], side: [5.6, 2.45, 0] };
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  camera.position.set(...VIEWS[b.dataset.view]); controls.update();
}));

// ───────────────────────── 사진 → 텍스처 ─────────────────────────
const MAX_SIDE = 1024;
let srcData = null;       // 업로드한 사진의 RGBA (최대 1024px)
let cached = null;        // 누끼 결과
let texture = null;

function setStatus(msg) { const el = $('#status'); el.textContent = msg; }
function setError(msg) { const el = $('#error'); el.textContent = msg || ''; el.hidden = !msg; }

async function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) return setError('이미지 파일(JPG, PNG, WEBP)을 올려 주세요.');
  if (file.size > 15 * 1024 * 1024) return setError('15MB 이하의 사진을 올려 주세요.');
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(2, Math.round(bmp.width * k)), h = Math.max(2, Math.round(bmp.height * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);          // 투명 PNG는 흰 배경으로 합성
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    srcData = ctx.getImageData(0, 0, w, h);
    srcCanvas = c;
    setError('');
    runExtract();
    $('#ai-run').disabled = false;
  } catch {
    setError('사진을 읽지 못했어요. 다른 파일로 다시 시도해 주세요.');
  }
}
let srcCanvas = null;

function runExtract() {
  if (!srcData) return;
  const t0 = performance.now();
  const res = extractTee(srcData.data, srcData.width, srcData.height, { tol: +$('#tol').value });
  if (!res.ok) { cached = null; uni.uHas.value = 0; uni.uHasSl.value = 0; return setError(res.reason); }
  cached = res;
  setError(res.warnings.join('\n'));
  renderShading();
  const [r, g, b] = res.base;
  $('#swatch').style.background = `rgb(${r},${g},${b})`;
  setStatus(`누끼 완료 (${Math.round(performance.now() - t0)}ms) · 기본색 rgb(${r}, ${g}, ${b})`
    + (res.info.sleeveRatio < 1.12 ? ' · 소매가 거의 안 보여요(민소매/접은 사진?)' : ''));
}

function renderShading() {
  if (!cached) return;
  const out = flattenShading(cached.rgba, cached.w, cached.h, cached.base, +$('#flat').value / 100);
  const pv = $('#cutout');
  pv.width = cached.w; pv.height = cached.h;
  pv.getContext('2d').putImageData(new ImageData(out, cached.w, cached.h), 0, 0);

  // 어깨·목은 사진 윗가장자리보다 위까지 올라가므로, 윗단 색을 위로 이어 붙인 텍스처를 씁니다.
  const P = Math.round(cached.h * 0.18), ext = extendTop(out, cached.w, cached.h, P);
  if (texture) texture.dispose();
  texture = new THREE.DataTexture(new Uint8Array(ext.buffer), cached.w, cached.h + P, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;                       // 데이터 첫 행 = 사진 맨 위
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;

  uni.uTex.value = texture;
  uni.uHas.value = 1;
  setSleeves();
  uni.uBase.value.setRGB(cached.base[0] / 255, cached.base[1] / 255, cached.base[2] / 255, THREE.SRGBColorSpace);
  uni.uFit.value.set(cached.fit.cx, cached.fit.halfW, P / (cached.h + P), 1);
  applyAdjust();
}

// 소매: 사진의 소매 영역(래글런 소매색·줄무늬·프린트)을 3D 소매에 입힙니다. 소매가 안 보이는 사진이면 기본색.
let slTexture = null;
function setSleeves() {
  const sl = cached && cached.sleeves;
  const toCol = (c, t) => t.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
  if (!sl) {
    uni.uHasSl.value = 0;
    toCol(cached.base, uni.uSlBaseL.value); toCol(cached.base, uni.uSlBaseR.value);
    return;
  }
  const SW = 256, SH = 256;
  const data = buildSleeveTexture(cached.rgba, cached.w, cached.h, sl, +$('#flat').value / 100, SW, SH);
  if (slTexture) slTexture.dispose();
  slTexture = new THREE.DataTexture(new Uint8Array(data.buffer), 2 * SW, SH, THREE.RGBAFormat);
  slTexture.colorSpace = THREE.SRGBColorSpace;
  slTexture.flipY = false;
  slTexture.generateMipmaps = false;
  slTexture.minFilter = slTexture.magFilter = THREE.LinearFilter;
  slTexture.needsUpdate = true;
  uni.uSlTex.value = slTexture;
  uni.uHasSl.value = 1;
  toCol(sl.colorL, uni.uSlBaseL.value); toCol(sl.colorR, uni.uSlBaseR.value);
}

function applyAdjust() {
  const s = +$('#adj-scale').value / 100;
  // 슬라이더는 "디자인이 움직이는 방향" 기준이라 샘플링 좌표는 반대로 이동
  uni.uAdj.value.set(s, -(+$('#adj-x').value) / 100, -(+$('#adj-y').value) / 100);
}

let tolTimer = 0;
$('#tol').addEventListener('input', () => { clearTimeout(tolTimer); tolTimer = setTimeout(runExtract, 120); });
let flatTimer = 0;
$('#flat').addEventListener('input', () => { clearTimeout(flatTimer); flatTimer = setTimeout(renderShading, 60); });
['#adj-scale', '#adj-x', '#adj-y'].forEach((id) => $(id).addEventListener('input', applyAdjust));
$('#adj-reset').addEventListener('click', () => {
  $('#adj-scale').value = 100; $('#adj-x').value = 0; $('#adj-y').value = 0; applyAdjust();
});

$('#file').addEventListener('change', (e) => loadFile(e.target.files[0]));
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

// ───────────────────────── AI 분석 (서버 경유 Gemini) ─────────────────────────
$('#ai-run').addEventListener('click', async () => {
  if (!srcCanvas) return;
  const key = $('#api-key').value.trim();
  const box = $('#ai-result');
  if (!key) { box.textContent = 'Gemini API 키를 입력해 주세요.'; return; }
  const k = Math.min(1, 384 / Math.max(srcCanvas.width, srcCanvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(srcCanvas.width * k); c.height = Math.round(srcCanvas.height * k);
  c.getContext('2d').drawImage(srcCanvas, 0, 0, c.width, c.height);
  const b64 = c.toDataURL('image/jpeg', 0.8).split(',')[1];
  $('#ai-run').disabled = true; box.textContent = '분석 중…';
  try {
    const resp = await fetch('/api/tee-analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Page-Token': document.querySelector('meta[name="page-token"]').content },
      body: JSON.stringify({ api_key: key, image_base64: b64 }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '분석에 실패했어요.');
    const notes = [];
    if (!data.is_tshirt) notes.push('티셔츠가 아닌 것 같아요. 결과가 어색할 수 있어요.');
    if (data.view === 'back') notes.push('뒷면 사진 같아요. 이 버전은 앞면 사진만 정확히 입힙니다.');
    if (data.sleeve === 'long' || data.sleeve === 'sleeveless') notes.push('3D 모델은 반팔 기준이라 소매 모양은 실제와 달라요.');
    if (!data.plain_background) notes.push('배경이 단색이 아닌 것 같아요. 누끼가 거칠 수 있어요.');
    if (data.fabric in FABRIC) applyFabric(data.fabric);
    box.textContent = `AI 추정 소재: ${FABRIC[data.fabric]?.label ?? '알 수 없음'} (옷감 프리셋에 반영)`
      + (data.note ? `\n${data.note}` : '') + (notes.length ? '\n⚠ ' + notes.join('\n⚠ ') : '');
  } catch (err) {
    box.textContent = err.message;
  } finally {
    $('#ai-run').disabled = false;
  }
});

// ───────────────────────── 상품 링크로 사진 가져오기 ─────────────────────────
// 서버가 상품 페이지의 이미지들을 모아 Gemini로 정면 티셔츠 사진을 고르면, 첫 번째 사진을 바로 입히고 나머지는 후보로 보여 줍니다.
function b64ToFile(b64, mime, name) {
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new File([u8], name, { type: mime });
}
$('#url-run').addEventListener('click', async () => {
  const status = $('#url-status'), alts = $('#url-alts'), btn = $('#url-run');
  const url = $('#tee-url').value.trim(), key = $('#api-key').value.trim();
  alts.hidden = true; alts.replaceChildren();
  if (!url) { status.textContent = '무신사 상품 링크를 입력해 주세요.'; return; }
  if (!key) { status.textContent = '아래 06 AI 분석에 Gemini API 키를 먼저 입력해 주세요.'; return; }
  btn.disabled = true; status.textContent = '상품 사진을 찾고 AI가 고르는 중… (10~30초)';
  try {
    const resp = await fetch('/api/tee-find-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Page-Token': document.querySelector('meta[name="page-token"]').content },
      body: JSON.stringify({ url, api_key: key }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '사진을 가져오지 못했어요.');
    const files = data.images.map((im, i) => b64ToFile(im.data, im.mime, `product-${i + 1}.${im.mime.split('/')[1]}`));
    const pick = async (i) => {
      await loadFile(files[i]);
      [...alts.children].forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
    };
    data.images.forEach((im, i) => {
      const b = document.createElement('button'), img = document.createElement('img');
      b.type = 'button'; b.title = i === 0 ? 'AI가 고른 사진' : `다른 후보 ${i}`;
      img.src = `data:${im.mime};base64,${im.data}`; img.alt = b.title;
      b.append(img); b.addEventListener('click', () => pick(i)); alts.append(b);
    });
    alts.hidden = data.images.length < 2;
    await pick(0);
    status.textContent = `사진 ${data.checked}장 중 AI가 골랐어요: ${data.reason}` + (data.images.length > 1 ? ' (아래 썸네일로 다른 후보도 써 볼 수 있어요)' : '');
  } catch (err) {
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
$('#tee-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#url-run').click(); });

// ───────────────────────── 시작 / 루프 ─────────────────────────
buildMannequin();
syncBodyUI(); syncTeeUI(); updateFit();
$('#o-t-size').textContent = sizeLabel(0, false);
dress(true);

const clock = new THREE.Clock();
let tt = 0;
function animate() {
  requestAnimationFrame(animate);
  const fd = Math.min(clock.getDelta(), 1 / 30);
  tt += fd;
  const wind = $('#wind').checked;
  for (let s = 0; s < SUBSTEPS; s++) step(fd / SUBSTEPS, tt, wind);
  posAttr.needsUpdate = true;
  geometry.computeVertexNormals();
  controls.update();
  renderer.render(scene, camera);
}
animate();
// 테스트/디버그용
window.__tryon = { body, tee, setBody, setTee, grade, settle, dress, THREE, camera, controls, uni };
