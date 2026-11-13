/**
 * 想定の街並み（パースの背景）
 *
 * 外観を立ち上げたとき、家のまわりが「何もない地面」か「白い箱」だと、絵が冷たく見える。
 * 敷地のまわりに、住宅地らしい区画（家・駐車場・低い塀・生垣・庭木）を並べる:
 *  - 同じ並びの両隣、裏の並び、道路の向かいの並び、その奥の並び（遠くはかすみに溶ける）
 *  - 家は屋根の形（切妻・寄棟・片流れ・陸屋根）と窓のある形。色は主役を引き立てる淡い色に抑える
 *  - 区画ごとに 1 つのまとまり（houses）。カメラと建物の間に入る区画は viewer が丸ごと隠す
 *
 * 実際の周辺建物（日照の画面で取得したもの）とは別物。実際の街を出すときは viewer.setTownVisible(false) で消す
 */
import * as THREE from 'three';
import { MeshBuilder, V } from './meshBuilder';
import { plannedHouseTriangles, type PlannedHouse, type RoofType } from '../sun/plannedHouse';
import { mulberry32 } from '../styles/noise';

export interface TownFrame {
  /** a = 道路に沿う向き、q = 道路境界から敷地の奥へ（m）、y = 高さ → ワールド */
  toWorld: (a: number, q: number, y: number) => THREE.Vector3;
  /** 敷地の間口の範囲（a） */
  a0: number;
  a1: number;
  /** 敷地の奥行（q = 0 が道路境界、depth が裏の境界） */
  depth: number;
  /** 道路の幅と路面の高さ。道路は q = -curb から -(curb + roadW) */
  roadW: number;
  roadY: number;
  /** 道路境界から路面の端まで（縁石の幅） */
  curb: number;
  /** 隣地の地盤の高さ（左 = a の小さい側・右・裏） */
  levelLeft: number;
  levelRight: number;
  levelBack: number;
  /**
   * 角地・二方道路: 敷地の左（a の小さい側）・右・裏にも道路が接しているときの、その道路の幅 (m)。
   * その側は隣家を並べず、敷地のすぐ外に道路を敷く（道路の向こうに並びが続く）
   */
  roadLeft?: number;
  roadRight?: number;
  roadBack?: number;
  /** 軽い表示（スマホ・タブレット）: 並びを減らし、木を省く */
  light?: boolean;
}

export interface TownLot {
  /** 影を落とす物（家・塀・生垣・木・車） */
  mb: MeshBuilder;
  /** 平らな物（区画の地面・駐車場の舗装）。影は落とさない */
  flat: MeshBuilder;
  /** 区画の範囲（× 家の高さ）。カメラがこの中に入ったら、区画の物を隠す */
  box: THREE.Box3;
  /** 家の範囲（軒の出まで）。視線を遮るかどうかの判定に使う。家の無い区画は null */
  solid: THREE.Box3 | null;
}

export interface Town {
  lots: TownLot[];
  /** 道路（裏の道・横の道・向かいの縁石） */
  roads: MeshBuilder;
}

const UP = new THREE.Vector3(0, 1, 0);
const WALL_KEYS = ['l.nbWallA', 'l.nbWallB', 'l.nbWallC', 'l.nbWallD', 'l.nbWallE'];
const ROOF_KEYS = ['l.nbRoofA', 'l.nbRoofB', 'l.nbRoofC'];

/** 外向きの面に貼る板（c は板の下辺の中央。off は壁からの浮き） */
function panel(mb: MeshBuilder, key: string, c: THREE.Vector3, out: THREE.Vector3, w: number, h: number, off: number) {
  const t = new THREE.Vector3().crossVectors(UP, out).normalize();
  const b = c.clone().addScaledVector(out, off);
  const p0 = b.clone().addScaledVector(t, -w / 2);
  const p1 = b.clone().addScaledVector(t, w / 2);
  mb.quad(key, p0, p1, p1.clone().addScaledVector(UP, h), p0.clone().addScaledVector(UP, h), t, UP);
}

interface HouseSpec {
  /** 足元の中心（y = 地盤） */
  c: THREE.Vector3;
  /** 棟の向き（水平の単位ベクトル） */
  u: THREE.Vector3;
  /** 棟の向きの長さ・奥行 */
  w: number;
  d: number;
  stories: 1 | 2;
  roof: RoofType;
  /** 玄関のある面の向き（道路側。水平の単位ベクトル） */
  front: THREE.Vector3;
  wallKey: string;
  roofKey: string;
}

/** 家 1 軒（壁・屋根・窓・玄関・基礎の帯・バルコニー）。戻り値は最高高さ */
function addHouse(mb: MeshBuilder, s: HouseSpec, rnd: () => number): number {
  const eave = s.stories === 2 ? 5.75 + rnd() * 0.35 : 3.05 + rnd() * 0.25;
  const rise = s.roof === 'gable' ? (s.d / 2) * (0.38 + rnd() * 0.12) : s.roof === 'hip' ? (s.d / 2) * (0.34 + rnd() * 0.1) : s.roof === 'shed' ? (s.d + 0.45) * (0.14 + rnd() * 0.08) : 0;
  const ridge = eave + rise;
  // 片流れの高い側は道路側か裏側か（半々）。棟の向きを裏返すと奥行の向きも裏返る
  const u = s.u.clone();
  if (rnd() < 0.5) u.negate();
  const v = V(u.z, 0, -u.x);
  const house: PlannedHouse = { id: 'nb', ce: 0, cn: 0, width: s.w, depth: s.d, rotDeg: 0, eaveHeight: eave, ridgeHeight: ridge, roof: s.roof };
  const tris = plannedHouseTriangles(house, { eaves: true });
  const world = (p: { u: number; v: number; z: number }) => s.c.clone().addScaledVector(u, p.u).addScaledVector(v, p.v).addScaledVector(UP, p.z);
  const put = (key: string, pts: { u: number; v: number; z: number }[]) => {
    for (let i = 0; i + 2 < pts.length; i += 3) mb.tri(key, world(pts[i]), world(pts[i + 1]), world(pts[i + 2]), u, UP);
  };
  put(s.wallKey, tris.wall);
  put(s.roofKey, tris.roof);
  if (s.roof === 'flat') {
    // 陸屋根: 笠木の細い線（箱の上の縁）
    mb.box(s.roofKey, s.c.clone().setY(s.c.y + eave), u, s.w + 0.06, 0.07, s.d + 0.06);
  }

  // 面（外向き・長さ）: 窓と玄関を並べる
  const sides: { out: THREE.Vector3; len: number; half: number }[] = [
    { out: v.clone(), len: s.w, half: s.d / 2 },
    { out: v.clone().negate(), len: s.w, half: s.d / 2 },
    { out: u.clone(), len: s.d, half: s.w / 2 },
    { out: u.clone().negate(), len: s.d, half: s.w / 2 },
  ];
  const floorY = (k: number) => s.c.y + 0.5 + k * 2.85;
  const frontIdx = sides.reduce((bi, sd, i) => (sd.out.dot(s.front) > sides[bi].out.dot(s.front) ? i : bi), 0);
  // 基礎の帯（明るいコンクリート色）
  for (const sd of sides) panel(mb, 'l.nbBase', s.c.clone().addScaledVector(sd.out, sd.half), sd.out, sd.len + 0.02, 0.42, 0.012);
  sides.forEach((sd, si) => {
    const face = s.c.clone().addScaledVector(sd.out, sd.half);
    const t = new THREE.Vector3().crossVectors(UP, sd.out).normalize();
    const isFront = si === frontIdx;
    const isBack = sd.out.dot(s.front) < -0.9;
    const nBay = Math.max(1, Math.min(3, Math.round(sd.len / 3.1)));
    const doorBay = isFront ? Math.floor(rnd() * nBay) : -1;
    for (let k = 0; k < s.stories; k++) {
      for (let b = 0; b < nBay; b++) {
        const pos = ((b + 0.5) / nBay - 0.5) * sd.len + (rnd() - 0.5) * 0.4;
        const at = (dy: number) => face.clone().addScaledVector(t, pos).setY(floorY(k) + dy);
        if (k === 0 && b === doorBay) {
          // 玄関: 戸・ポーチの段・小さな庇
          panel(mb, 'l.nbDoor', at(0), sd.out, 0.92, 2.15, 0.02);
          mb.box('l.nbBase', face.clone().addScaledVector(t, pos).addScaledVector(sd.out, 0.6).setY(s.c.y), t, 1.7, 0.38, 1.2);
          mb.box(s.roofKey, face.clone().addScaledVector(t, pos).addScaledVector(sd.out, 0.45).setY(floorY(0) + 2.4), t, 1.8, 0.07, 0.9);
          continue;
        }
        if (rnd() < (isFront || isBack ? 0.12 : 0.34)) continue;
        // 窓の種類: 引違い（腰窓）／掃き出し（1 階の庭側・道路側）／縦すべり（妻側に多い）
        const tall = k === 0 && (isBack || isFront) && rnd() < 0.5;
        const slim = !tall && rnd() < (isFront || isBack ? 0.25 : 0.6);
        const ww = slim ? 0.62 : 1.66;
        const wh = tall ? 2.0 : slim ? 1.15 : 1.08;
        const sill = tall ? 0.12 : slim ? 0.95 : 0.92;
        if (pos - ww / 2 < -sd.len / 2 + 0.35 || pos + ww / 2 > sd.len / 2 - 0.35) continue;
        panel(mb, 'l.nbFrame', at(sill - 0.045), sd.out, ww + 0.09, wh + 0.09, 0.016);
        // 3 割の窓は、夕景・夜景で明かりが点く
        panel(mb, rnd() < 0.3 ? 'l.nbGlassLit' : 'l.nbGlass', at(sill), sd.out, ww, wh, 0.026);
      }
    }
  });
  // バルコニー（2 階建ての 4 割。道路側か庭側の面に、壁と同じ色の箱）
  if (s.stories === 2 && rnd() < 0.4) {
    const sd = sides[rnd() < 0.5 ? frontIdx : sides.findIndex((x) => x.out.dot(s.front) < -0.9)];
    if (sd && sd.len > 5) {
      const t = new THREE.Vector3().crossVectors(UP, sd.out).normalize();
      const len = Math.min(sd.len - 1.2, 3.6 + rnd() * 1.4);
      const pos = (rnd() - 0.5) * (sd.len - len - 0.6);
      const base = s.c.clone().addScaledVector(sd.out, sd.half + 0.55).addScaledVector(t, pos).setY(floorY(1) - 0.12);
      mb.box(s.wallKey, base, t, len, 1.2, 1.1);
    }
  }
  return ridge;
}

/** 庭木（背景用の軽い作り: 幹と枝、葉のカードの樹冠） */
function addTree(mb: MeshBuilder, p: THREE.Vector3, h: number, rnd: () => number, leafKey: string) {
  const top = p.clone().setY(p.y + h * 0.52);
  mb.tube('l.trunk', p, top, 0.035 * h + 0.03, 0.02 * h + 0.015, 6);
  const crown = p.clone().setY(p.y + h * 0.68);
  const rx = h * 0.3;
  const ry = h * 0.3;
  for (let i = 0; i < 3; i++) {
    const az = (i / 3) * Math.PI * 2 + rnd() * 1.2;
    const tip = crown.clone().add(V(Math.cos(az) * rx * 0.55, (rnd() - 0.2) * ry * 0.5, Math.sin(az) * rx * 0.55));
    mb.tube('l.trunk', top.clone().setY(top.y - 0.25 * rnd()), tip, 0.014 * h + 0.012, 0.008 * h + 0.006, 5);
  }
  const n = 16;
  for (let i = 0; i < n; i++) {
    // 樹冠は楕円体の表面寄りに（中が詰まりすぎない）
    const az = rnd() * Math.PI * 2;
    const el = (rnd() - 0.35) * Math.PI * 0.9;
    const r = 0.55 + rnd() * 0.45;
    const q = crown.clone().add(V(Math.cos(az) * Math.cos(el) * rx * r, Math.sin(el) * ry * r, Math.sin(az) * Math.cos(el) * rx * r));
    mb.card(leafKey, q, h * (0.26 + rnd() * 0.12), new THREE.Euler((rnd() - 0.5) * 1.6, rnd() * Math.PI * 2, (rnd() - 0.5) * 1.6));
  }
}

/** 生垣（a → b。高さ h） */
function addHedge(mb: MeshBuilder, a: THREE.Vector3, b: THREE.Vector3, h: number, rnd: () => number) {
  const L = a.distanceTo(b);
  if (L < 0.3) return;
  const dir = b.clone().sub(a).normalize();
  // 芯: 角を丸めた濃い緑のかたまり（刈り込んだ生垣の形）。表面に葉のカードを散らして輪郭をやわらげる
  mb.roundedBox('l.hedge', a.clone().lerp(b, 0.5), dir, L, h * 0.92, 0.5, 0.16, 2);
  const side = V(dir.z, 0, -dir.x);
  const n = Math.max(2, Math.round(L / 0.3));
  for (let i = 0; i < n; i++) {
    const p = a.clone().lerp(b, (i + rnd()) / n);
    for (let k = 0; k < 3; k++) {
      // 上の面と両側の面に沿って
      const face = k === 0 ? 0 : k === 1 ? 1 : -1;
      const q = p.clone().addScaledVector(side, face * 0.24).setY(a.y + (face === 0 ? h * 0.93 : h * (0.25 + rnd() * 0.6)));
      mb.card('l.leafCardDark', q, 0.42 + rnd() * 0.16, new THREE.Euler(face === 0 ? -Math.PI / 2 + (rnd() - 0.5) * 0.9 : (rnd() - 0.5) * 0.7, Math.atan2(dir.x, dir.z) + Math.PI / 2 + (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.9));
    }
  }
}

/** 低木のひと株 */
function addShrub(mb: MeshBuilder, p: THREE.Vector3, s: number, rnd: () => number) {
  for (let i = 0; i < 5; i++) {
    const q = p.clone().add(V((rnd() - 0.5) * s * 1.2, s * (0.3 + rnd() * 0.5), (rnd() - 0.5) * s * 1.2));
    mb.card('l.leafCardDark', q, s * (0.9 + rnd() * 0.5), new THREE.Euler(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI));
  }
}

/** 駐車場の車（背景用の簡単な形。前後の向き dir） */
function addCar(mb: MeshBuilder, c: THREE.Vector3, dir: THREE.Vector3, rnd: () => number) {
  const body = rnd() < 0.4 ? 'l.nbCarLight' : rnd() < 0.5 ? 'l.nbCarDark' : 'l.nbCarGrey';
  const small = rnd() < 0.4;
  const L = small ? 3.4 : 4.5;
  const W = small ? 1.48 : 1.78;
  const H = small ? 1.55 : 1.5;
  mb.roundedBox(body, c.clone().setY(c.y + 0.22), dir, L, 0.62, W, 0.14, 2);
  mb.roundedBox(body, c.clone().addScaledVector(dir, -L * 0.06).setY(c.y + 0.8), dir, L * (small ? 0.72 : 0.56), H - 0.84, W - 0.1, 0.16, 2);
  mb.box('l.nbGlass', c.clone().addScaledVector(dir, -L * 0.06).setY(c.y + 0.9), dir, L * (small ? 0.74 : 0.58), H - 1.12, W - 0.16);
  const side = V(dir.z, 0, -dir.x);
  for (const du of [-L * 0.31, L * 0.31]) for (const dv of [-W / 2 + 0.1, W / 2 - 0.1]) mb.box('x.tire', c.clone().addScaledVector(dir, du).addScaledVector(side, dv).setY(c.y), dir, 0.62, 0.62, 0.2);
}

interface LotSpec {
  /** 区画の範囲（a・q）と地盤の高さ */
  a0: number;
  a1: number;
  q0: number;
  q1: number;
  y: number;
  /** 間口の側: q0 の側（-1）か q1 の側（+1）か */
  frontSign: 1 | -1;
  /** 両脇・裏の境界に低い塀を作るか（敷地と接する辺は敷地側の塀があるので作らない） */
  wallA0: boolean;
  wallA1: boolean;
  wallBack: boolean;
}

function addLot(town: Town, f: TownFrame, L: LotSpec, rnd: () => number) {
  const mb = new MeshBuilder();
  const flat = new MeshBuilder();
  const W = L.a1 - L.a0;
  const D = L.q1 - L.q0;
  const y = L.y;
  const P = (a: number, q: number, yy = y) => f.toWorld(a, q, yy);
  const dirA = P(1, 0).sub(P(0, 0)).normalize();
  const dirQ = P(0, 1).sub(P(0, 0)).normalize();
  /** 間口からの奥行 t（0 = 道路際）→ q */
  const fq = (t: number) => (L.frontSign < 0 ? L.q0 + t : L.q1 - t);
  const front = dirQ.clone().multiplyScalar(L.frontSign);
  const quadUp = (m: MeshBuilder, key: string, a0: number, a1: number, t0: number, t1: number, yy: number) => {
    const p = [P(a0, fq(t0), yy), P(a1, fq(t0), yy), P(a1, fq(t1), yy), P(a0, fq(t1), yy)];
    const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
    if (n.y < 0) m.quad(key, p[0], p[3], p[2], p[1], V(1, 0, 0), V(0, 0, 1));
    else m.quad(key, p[0], p[1], p[2], p[3], V(1, 0, 0), V(0, 0, 1));
  };
  // 区画の地面（砂利・土の落ち着いた色。3 種）
  quadUp(flat, rnd() < 0.5 ? 'l.nbLotA' : rnd() < 0.5 ? 'l.nbLotB' : 'l.nbLotC', L.a0, L.a1, 0, D, y + 0.004);

  // 駐車場（間口の左右どちらか）と、家の位置
  const twoCars = W > 10.5 && rnd() < 0.6;
  const parkW = Math.min(W - 4.5, twoCars ? 5.4 : 2.9);
  const parkLeft = rnd() < 0.5;
  const setback = D < 12.5 ? 1.6 + rnd() * 0.8 : 2.2 + rnd() * 3.2;
  const parkDepth = Math.min(D - 1, 5.4);
  const pa0 = parkLeft ? L.a0 + 0.4 : L.a1 - 0.4 - parkW;
  if (parkW > 2.4) quadUp(flat, 'l.nbPave', pa0, pa0 + parkW, 0, parkDepth, y + 0.012);
  // 家: 駐車場が家の前に食い込むなら、家はその分だけ横へ寄せる（奥行が浅い区画）か、後ろへ下げる
  const stories: 1 | 2 = D < 10 || rnd() < 0.14 ? 1 : 2;
  const houseT0 = Math.max(setback, parkW > 2.4 && D >= 13 ? Math.min(parkDepth + 0.6, D - 8.4) : setback);
  const side = 0.9 + rnd() * 0.5;
  let ha0 = L.a0 + side;
  let ha1 = L.a1 - side;
  if (parkW > 2.4 && houseT0 < parkDepth + 0.3) {
    if (parkLeft) ha0 = pa0 + parkW + 0.5;
    else ha1 = pa0 - 0.5;
  }
  const hw = Math.min(ha1 - ha0, stories === 1 ? 11 : 9.6);
  const hd = Math.min(D - houseT0 - (1.4 + rnd() * 1.6), stories === 1 ? 8.6 : 7.9);
  let ridge = 0;
  let solid: THREE.Box3 | null = null;
  if (hw >= 4.2 && hd >= 4.2) {
    const hc0 = ha0 + (ha1 - ha0 - hw) * (parkLeft ? 1 : 0) * 0.5 + (ha1 - ha0 - hw) * 0.25;
    const ca = hc0 + hw / 2;
    const cq = fq(houseT0 + hd / 2);
    const along = rnd() < 0.62 || hw < hd;
    const r = rnd();
    const roof: RoofType = r < 0.36 ? 'gable' : r < 0.6 ? 'hip' : r < 0.84 ? 'shed' : 'flat';
    ridge = addHouse(
      mb,
      {
        c: P(ca, cq),
        u: along ? dirA.clone() : dirQ.clone(),
        w: along ? hw : hd,
        d: along ? hd : hw,
        stories,
        roof,
        front,
        wallKey: WALL_KEYS[Math.floor(rnd() * WALL_KEYS.length)],
        roofKey: ROOF_KEYS[Math.floor(rnd() * ROOF_KEYS.length)],
      },
      rnd,
    );
    {
      const h0 = P(hc0 - 0.5, fq(houseT0 - 0.5));
      const h1 = P(hc0 + hw + 0.5, fq(houseT0 + hd + 0.5));
      solid = new THREE.Box3(V(Math.min(h0.x, h1.x), y, Math.min(h0.z, h1.z)), V(Math.max(h0.x, h1.x), y + ridge + 0.2, Math.max(h0.z, h1.z)));
    }
    // 庭木と低木: 家の裏の庭と、道路側の空いた所
    if (!f.light) {
      const rearT = houseT0 + hd + (D - houseT0 - hd) * 0.5;
      if (D - houseT0 - hd > 1.6 && rnd() < 0.7) addTree(mb, P(L.a0 + 1.2 + rnd() * (W - 2.4), fq(rearT)), 3.2 + rnd() * 1.8, rnd, rnd() < 0.5 ? 'l.leafCardSoft' : 'l.leafCard');
      const freeA = parkLeft ? L.a1 - 1.3 : L.a0 + 1.3;
      if (houseT0 > 2.4 && rnd() < 0.55) addTree(mb, P(freeA, fq(Math.min(houseT0 - 1.0, 1.4 + rnd()))), 2.6 + rnd() * 1.4, rnd, 'l.leafCardSoft');
      for (let i = 0; i < 2; i++) addShrub(mb, P(L.a0 + 0.9 + rnd() * (W - 1.8), fq(rearT + (rnd() - 0.5))), 0.3 + rnd() * 0.25, rnd);
    }
    if (parkW > 2.4 && Math.abs(y) < 0.03 && rnd() < 0.5) addCar(mb, P(pa0 + (twoCars ? parkW * 0.27 : parkW / 2), fq(parkDepth / 2 + 0.2), y + 0.012), front, rnd);
  }

  // 間口の塀（駐車場の口は空ける）: 低いブロック。半分は上に生垣
  const frontWall = rnd();
  if (frontWall < 0.75) {
    const segs: [number, number][] = parkW > 2.4 ? (parkLeft ? [[pa0 + parkW + 0.1, L.a1]] : [[L.a0, pa0 - 0.1]]) : [[L.a0, L.a1]];
    for (const [s0, s1] of segs) {
      // 門の口（1.2 m）を、家の中央あたりに空ける
      const gate = s0 + (s1 - s0) * (0.35 + rnd() * 0.3);
      for (const [g0, g1] of [[s0, gate - 0.6], [gate + 0.6, s1]] as [number, number][]) {
        if (g1 - g0 < 0.6) continue;
        const mid = P((g0 + g1) / 2, fq(0.1));
        const hgt = 0.45 + (frontWall < 0.35 ? 0.35 : 0);
        mb.box('l.block', mid, dirA, g1 - g0, hgt, 0.12);
        if (frontWall >= 0.35 && !f.light) addHedge(mb, P(g0 + 0.1, fq(0.42), y), P(g1 - 0.1, fq(0.42), y), 1.05 + rnd() * 0.25, rnd);
      }
    }
  }
  // 両脇・裏の境界の低い塀
  const sideWall = (a: number) => mb.box('l.block', P(a, (L.q0 + L.q1) / 2), dirQ, D - 0.3, 0.5, 0.1);
  if (L.wallA0) sideWall(L.a0 + 0.06);
  if (L.wallA1) sideWall(L.a1 - 0.06);
  if (L.wallBack) mb.box('l.block', P((L.a0 + L.a1) / 2, fq(D - 0.06)), dirA, W - 0.2, 0.5, 0.1);

  const c0 = P(L.a0, L.q0);
  const c1 = P(L.a1, L.q1);
  const box = new THREE.Box3(V(Math.min(c0.x, c1.x), y, Math.min(c0.z, c1.z)), V(Math.max(c0.x, c1.x), y + Math.max(ridge, 2.2) + 0.3, Math.max(c0.z, c1.z)));
  town.lots.push({ mb, flat, box, solid });
}

/**
 * 敷地のまわりの街並みを作る。seed を変えると並びが変わる（同じ家は毎回同じ街並みにする）
 */
export function buildTown(f: TownFrame, seed = 7): Town {
  const rnd = mulberry32(seed);
  const town: Town = { lots: [], roads: new MeshBuilder() };
  const flatLand = Math.abs(f.levelLeft) < 0.03 && Math.abs(f.levelRight) < 0.03 && Math.abs(f.levelBack) < 0.03 && Math.abs(f.roadY) < 0.03;
  const reach = f.light ? 34 : 64;
  const center = (f.a0 + f.a1) / 2;
  const lotW = () => 9.6 + rnd() * 3.4;
  // 横の道: ふつうは左 2 区画・右 3 区画の先（高低差のある敷地・軽い表示では作らない: 段差のつなぎが要るため）。
  // 角地（敷地の横が道路）は、敷地のすぐ外に、図面の幅で必ず敷く
  const cornerL = f.roadLeft && f.roadLeft > 0 ? f.roadLeft : 0;
  const cornerR = f.roadRight && f.roadRight > 0 ? f.roadRight : 0;
  const backAdj = f.roadBack && f.roadBack > 0 ? f.roadBack : 0;
  const leftW = cornerL ? [] : [lotW(), lotW()];
  const rightW = cornerR ? [] : [lotW(), lotW(), lotW()];
  const sum = (ws: number[]) => ws.reduce((x, w) => x + w, 0);
  const useL = cornerL > 0 || (flatLand && !f.light);
  const useR = cornerR > 0 || (flatLand && !f.light);
  /** 横の道の幅（角地は縁石の分を含めて敷地の際から） */
  const cwL = cornerL ? cornerL + f.curb : 5;
  const cwR = cornerR ? cornerR + f.curb : 5;
  /** 横の道の、敷地に近い側の端 */
  const xL = f.a0 - sum(leftW);
  const xR = f.a1 + sum(rightW);
  /** 横の道の路面の高さ（角地はその側の地盤、ほかは表の道路） */
  const yL = cornerL ? f.levelLeft : f.roadY;
  const yR = cornerR ? f.levelRight : f.roadY;
  /** a の範囲 [lo, hi] から横の道を除いた区間 */
  const spansOf = (lo: number, hi: number): [number, number][] => {
    const out: [number, number][] = [];
    let t = lo;
    for (const [c0, c1] of [...(useL ? [[xL - cwL, xL]] : []), ...(useR ? [[xR, xR + cwR]] : [])] as [number, number][]) {
      if (c0 > t) out.push([t, Math.min(c0, hi)]);
      t = Math.max(t, c1);
    }
    if (hi > t) out.push([t, hi]);
    return out.filter(([s0, s1]) => s1 > s0);
  };
  /** a の範囲 [s0, s1] を区画に割る（幅 9.6〜13 m） */
  const split = (s0: number, s1: number): [number, number][] => {
    const n = Math.max(1, Math.round((s1 - s0) / 11.2));
    const out: [number, number][] = [];
    const ws = Array.from({ length: n }, () => 0.85 + rnd() * 0.3);
    const total = sum(ws);
    let t = s0;
    for (const w of ws) {
      const e = t + ((s1 - s0) * w) / total;
      out.push([t, e]);
      t = e;
    }
    return out;
  };
  /** 並び 1 本分の区画の範囲（横の道をよける） */
  const blocks = (): [number, number][] =>
    spansOf(center - reach, center + reach)
      .filter(([s0, s1]) => s1 - s0 > 7)
      .flatMap(([s0, s1]) => split(s0, s1));

  // --- 同じ並びの両隣（敷地の左・右。角地の側は道路の向こうから） ---
  {
    let a = f.a0;
    const ws = useL ? leftW : split(center - reach, f.a0).map(([s0, s1]) => s1 - s0).reverse();
    ws.forEach((w) => {
      addLot(town, f, { a0: a - w, a1: a, q0: 0, q1: f.depth, y: f.levelLeft, frontSign: -1, wallA0: true, wallA1: false, wallBack: true }, rnd);
      a -= w;
    });
    if (useL && xL - cwL - (center - reach) > 7) for (const [s0, s1] of split(center - reach, xL - cwL)) addLot(town, f, { a0: s0, a1: s1, q0: 0, q1: f.depth, y: f.levelLeft, frontSign: -1, wallA0: true, wallA1: false, wallBack: true }, rnd);
    a = f.a1;
    const wr = useR ? rightW : split(f.a1, center + reach).map(([s0, s1]) => s1 - s0);
    wr.forEach((w) => {
      addLot(town, f, { a0: a, a1: a + w, q0: 0, q1: f.depth, y: f.levelRight, frontSign: -1, wallA0: false, wallA1: true, wallBack: true }, rnd);
      a += w;
    });
    if (useR && center + reach - (xR + cwR) > 7) for (const [s0, s1] of split(xR + cwR, center + reach)) addLot(town, f, { a0: s0, a1: s1, q0: 0, q1: f.depth, y: f.levelRight, frontSign: -1, wallA0: false, wallA1: true, wallBack: true }, rnd);
  }

  // --- 裏の並び（敷地の裏。その先に裏の道、さらに奥の並び）。裏も道路の敷地は、その道路の向こうに並び ---
  const backD = 14.5 + rnd() * 2.5;
  const backRoadW = 5;
  const qB0 = backAdj ? f.depth + f.curb + backAdj + f.curb : f.depth;
  const qB1 = qB0 + backD;
  for (const [s0, s1] of blocks()) addLot(town, f, { a0: s0, a1: s1, q0: qB0, q1: qB1, y: f.levelBack, frontSign: backAdj ? -1 : 1, wallA0: true, wallA1: false, wallBack: !!backAdj }, rnd);
  /** 裏の並びの先に裏の道を敷くか（裏がすぐ道路のときは、その道路があるので敷かない） */
  const farBackRoad = flatLand && !backAdj;
  if (!f.light && !backAdj) {
    const q2 = qB1 + backRoadW + 0.4;
    for (const [s0, s1] of blocks()) addLot(town, f, { a0: s0, a1: s1, q0: q2, q1: q2 + 15 + rnd() * 2, y: f.levelBack, frontSign: -1, wallA0: true, wallA1: false, wallBack: true }, rnd);
  }

  // --- 道路の向かいの並び（その奥にもう 1 列） ---
  const qO1 = -(f.curb + f.roadW + f.curb);
  const oppD = 14 + rnd() * 3;
  for (const [s0, s1] of blocks()) addLot(town, f, { a0: s0, a1: s1, q0: qO1 - oppD, q1: qO1, y: f.roadY, frontSign: 1, wallA0: true, wallA1: false, wallBack: true }, rnd);
  if (!f.light) for (const [s0, s1] of blocks()) addLot(town, f, { a0: s0, a1: s1, q0: qO1 - oppD - 15.5, q1: qO1 - oppD, y: f.roadY, frontSign: -1, wallA0: true, wallA1: false, wallBack: false }, rnd);

  // --- 道路: 向かいの縁石、裏の道、横の道 ---
  // 表の道路の路面（q = -(curb + roadW) 〜 0）は外構が敷く。ここでは、その帯と重ならないように敷く
  //（同じ高さの面が重なると、遠くで縞にちらつく）
  const R = town.roads;
  const P = f.toWorld;
  const dirA = P(1, 0, 0).sub(P(0, 0, 0)).normalize();
  const dirQ = P(0, 1, 0).sub(P(0, 0, 0)).normalize();
  const strip = (key: string, a0: number, a1: number, q0: number, q1: number, y: number) => {
    const p = [P(a0, q0, y), P(a1, q0, y), P(a1, q1, y), P(a0, q1, y)];
    const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
    if (n.y < 0) R.quad(key, p[0], p[3], p[2], p[1], V(1, 0, 0), V(0, 0, 1));
    else R.quad(key, p[0], p[1], p[2], p[3], V(1, 0, 0), V(0, 0, 1));
  };
  const far = reach + 80;
  // 道路に沿う向きの範囲（横の道の所は空ける）
  const alongSpans = spansOf(center - far, center + far);
  const qRoad0 = -(f.curb + f.roadW);
  for (const [s0, s1] of alongSpans) {
    // 縁石: 向かい側と、手前側（敷地の間口の分は外構が作るので、その両脇だけ）
    R.box('l.curb', P((s0 + s1) / 2, qRoad0 - f.curb / 2, f.roadY), dirA, s1 - s0, 0.12, f.curb);
    for (const [c0, c1] of [[s0, Math.min(s1, f.a0 - 0.2)], [Math.max(s0, f.a1 + 0.2), s1]] as [number, number][]) if (c1 - c0 > 0.1) R.box('l.curb', P((c0 + c1) / 2, -f.curb / 2, f.roadY), dirA, c1 - c0, 0.12, f.curb);
    // 両側の側溝の帯
    strip('l.gutter', s0, s1, -f.curb, -(f.curb + 0.45), f.roadY + 0.008);
    strip('l.gutter', s0, s1, qRoad0 + 0.45, qRoad0, f.roadY + 0.008);
  }
  const qBack0 = qB1 + 0.2;
  if (backAdj) {
    // 裏の道路（敷地の裏の境界のすぐ外）。敷地の裏の縁石は外構が作るので、その両脇と向こう側だけ
    for (const [s0, s1] of alongSpans) {
      strip('l.road', s0, s1, f.depth, f.depth + f.curb + backAdj, f.levelBack + 0.005);
      R.box('l.curb', P((s0 + s1) / 2, f.depth + f.curb + backAdj + f.curb / 2, f.levelBack), dirA, s1 - s0, 0.12, f.curb);
      for (const [c0, c1] of [[s0, Math.min(s1, f.a0 - 0.2)], [Math.max(s0, f.a1 + 0.2), s1]] as [number, number][]) if (c1 - c0 > 0.1) R.box('l.curb', P((c0 + c1) / 2, f.depth + f.curb / 2, f.levelBack), dirA, c1 - c0, 0.12, f.curb);
    }
  } else if (farBackRoad) {
    // 裏の道（横の道と重ねない）
    for (const [s0, s1] of alongSpans) {
      strip('l.road', s0, s1, qBack0, qBack0 + backRoadW, f.levelBack + 0.005);
      R.box('l.curb', P((s0 + s1) / 2, qB1 + 0.1, f.levelBack), dirA, s1 - s0, 0.12, 0.2);
      R.box('l.curb', P((s0 + s1) / 2, qB1 + 0.3 + backRoadW, f.levelBack), dirA, s1 - s0, 0.12, 0.2);
    }
  }
  if (useL || useR) {
    const qFar0 = qO1 - oppD - 15.5 - 30;
    const qFar1 = qB1 + backRoadW + 50;
    // 横の道は、表の道路の帯を避けて敷く
    const roadSpans: [number, number][] = [
      [qFar0, qRoad0],
      [0, qFar1],
    ];
    /** 縁石は、表の道路・裏の道路を横切らない（交差点を空ける）。site = 敷地に接する側（敷地の奥行の分は外構が作る） */
    const curbSpans = (site: boolean): [number, number][] => {
      const backGap: [number, number] | null = backAdj ? [f.depth, f.depth + f.curb + backAdj + f.curb] : farBackRoad ? [qB1, qBack0 + backRoadW + 0.2] : null;
      const inner: [number, number][] = backGap
        ? [
            [site ? f.depth : 0, backGap[0]],
            [backGap[1], qFar1],
          ]
        : [[site ? f.depth : 0, qFar1]];
      return [[qFar0, qRoad0 - f.curb] as [number, number], ...inner].filter(([s0, s1]) => s1 - s0 > 0.1);
    };
    const cross: { x: number; w: number; y: number; siteSide: -1 | 0 | 1 }[] = [];
    if (useL) cross.push({ x: xL - cwL, w: cwL, y: yL, siteSide: cornerL ? 1 : 0 });
    if (useR) cross.push({ x: xR, w: cwR, y: yR, siteSide: cornerR ? -1 : 0 });
    for (const c of cross) {
      for (const [s0, s1] of roadSpans) strip('l.road', c.x, c.x + c.w, s0, s1, c.y + 0.005);
      // 縁石: 道の両側。角地で敷地に接する側は、路面の内側（縁石の幅の分）に置く
      for (const [s0, s1] of curbSpans(c.siteSide === -1)) R.box('l.curb', P(c.siteSide === -1 ? c.x + 0.1 : c.x - 0.1, (s0 + s1) / 2, c.y), dirQ, s1 - s0, 0.12, 0.2);
      for (const [s0, s1] of curbSpans(c.siteSide === 1)) R.box('l.curb', P(c.siteSide === 1 ? c.x + c.w - 0.1 : c.x + c.w + 0.1, (s0 + s1) / 2, c.y), dirQ, s1 - s0, 0.12, 0.2);
    }
  }
  return town;
}
