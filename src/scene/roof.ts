/**
 * 屋根の自動生成
 *  - 最上階の外形を極大矩形で被覆し、矩形ごとに屋根をかける（L字では屋根同士が交差して谷ができる）
 *  - 下階のうち上階が載らない部分には下屋（片流れ）をかける
 *  - 切妻 / 寄棟 / 片流れ / 陸屋根（パラペット）
 */
import * as THREE from 'three';
import { OUTDOOR_TYPES, type BuildingModel, type RoofHigh, type RoofKind, type RoofPatch, type Vec2 } from '../core/types';
import { insideLoops } from '../core/geometry';
import { maximalRectCoverMask, type Rect } from '../core/rects';
import { MeshBuilder, type ClipPlane, V } from './meshBuilder';
import { MM, wallTopOf } from './building';
import type { ExteriorStyle, RoofType } from '../styles/presets';

type V3 = THREE.Vector3;

/** 屋根の塊（上の階が載らない範囲のつながった所）。3D の「屋根」の道具で選ぶ単位 */
export interface RoofMass {
  level: number;
  isTop: boolean;
  /** 重ならない四角形（図面座標 mm） */
  rects: Rect[];
  bbox: Rect;
  /** 塊の中の点（いちばん大きい四角形の中心。手直しの目印に使う） */
  center: Vec2;
  /** この塊の手直し（あれば） */
  patch?: RoofPatch;
  /** 実際の掛け方（手直し、無ければ全体の設定） */
  kind: RoofKind;
  /** 片流れの高い側（実際） */
  high: RoofHigh;
  /** 下屋が上の階に接している辺 */
  attached: RoofHigh[];
}

/**
 * 屋根を架ける範囲の輪郭。外形が読めていない階（壁に隙間があって外形が追えなかった・画像の図面）は、
 * 屋根が丸ごと出ない（「屋根が表示されない」）ので、屋内の部屋の区画を代わりに使う
 */
function roofLoops(f: BuildingModel['floors'][number]): Vec2[][] {
  const loops = f.outline.filter((l) => l.length >= 3);
  if (loops.length) return loops;
  return f.rooms.filter((r) => r.polygon.length >= 3 && !OUTDOOR_TYPES.includes(r.type)).map((r) => r.polygon);
}

/** 階 k の屋根の格子: 外形の頂点で座標を圧縮し、この階の範囲（上の階が載らない所）と上の階の範囲をマスクにする */
function floorGrid(floors: BuildingModel['floors'], k: number) {
  const f = floors[k];
  const higher = floors.slice(k + 1).map((h) => ({ ...h, outline: roofLoops(h) }));
  const polys = roofLoops(f);
  const all = [...polys, ...higher.flatMap((h) => h.outline)].flat();
  const uniq = (vals: number[]) => {
    const s = vals.slice().sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of s) if (!out.length || v - out[out.length - 1] > 20) out.push(v);
    return out;
  };
  const xs = uniq(all.map((p) => p.x));
  const zs = uniq(all.map((p) => p.y));
  const nx = xs.length - 1;
  const nz = zs.length - 1;
  const mask = new Uint8Array(Math.max(0, nx * nz));
  const maskUpper = new Uint8Array(Math.max(0, nx * nz));
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const c = { x: (xs[i] + xs[i + 1]) / 2, y: (zs[j] + zs[j + 1]) / 2 };
      const inThis = insideLoops(c, polys);
      const inUpper = higher.some((h) => insideLoops(c, h.outline));
      mask[j * nx + i] = inThis && !inUpper ? 1 : 0;
      maskUpper[j * nx + i] = inUpper ? 1 : 0;
    }
  return { f, higher, polys, xs, zs, nx, nz, mask, maskUpper };
}

/** 格子の座標 v が入る区間の番号（無ければ -1） */
function cellIndex(axis: number[], v: number): number {
  for (let i = 0; i + 1 < axis.length; i++) if (v >= axis[i] && v < axis[i + 1]) return i;
  return -1;
}

/** この塊に当たる手直し（at がその塊の格子の中にある物） */
function patchFor(patches: RoofPatch[] | undefined, level: number, comp: { cells: Set<number> }, xs: number[], zs: number[], nx: number): RoofPatch | undefined {
  if (!patches) return undefined;
  for (const p of patches) {
    if (p.level !== level) continue;
    const i = cellIndex(xs, p.at.x);
    const j = cellIndex(zs, p.at.y);
    if (i >= 0 && j >= 0 && comp.cells.has(j * nx + i)) return p;
  }
  return undefined;
}

/** 下屋の塊が上の階に接している辺（接する格子の辺が 1 つでもあれば） */
function touchingSides(comp: { cells: Set<number> }, nx: number, nz: number, maskUpper: Uint8Array): RoofHigh[] {
  const hit = new Set<RoofHigh>();
  for (const c of comp.cells) {
    const i = c % nx;
    const j = (c - i) / nx;
    if (j > 0 && maskUpper[(j - 1) * nx + i]) hit.add('n');
    if (j + 1 < nz && maskUpper[(j + 1) * nx + i]) hit.add('s');
    if (i > 0 && maskUpper[j * nx + i - 1]) hit.add('w');
    if (i + 1 < nx && maskUpper[j * nx + i + 1]) hit.add('e');
  }
  return [...hit];
}

/** 四角形（格子座標 mm）の辺のうち、そのすぐ外が上の階の範囲（軒・けらばを出さず、上の階の壁に取り付く辺） */
function rectAttached(r: Rect, xs: number[], zs: number[], nx: number, nz: number, maskUpper: Uint8Array): Set<RoofHigh> {
  const out = new Set<RoofHigh>();
  const i0 = cellIndex(xs, r.minX + 1);
  const i1 = cellIndex(xs, r.maxX - 1);
  const j0 = cellIndex(zs, r.minY + 1);
  const j1 = cellIndex(zs, r.maxY - 1);
  if (i0 < 0 || i1 < 0 || j0 < 0 || j1 < 0) return out;
  const up = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < nz && maskUpper[j * nx + i] === 1;
  for (let i = i0; i <= i1; i++) {
    if (up(i, j0 - 1)) out.add('n');
    if (up(i, j1 + 1)) out.add('s');
  }
  for (let j = j0; j <= j1; j++) {
    if (up(i0 - 1, j)) out.add('w');
    if (up(i1 + 1, j)) out.add('e');
  }
  return out;
}

interface RoofCtx {
  mb: MeshBuilder;
  T: number; // 屋根厚
  eaves: number;
  verge: number;
  /** 辺ごとの軒の出 (m)。屋根を片側だけ伸ばすとき。無い辺は eaves（軒側）／verge（けらば側） */
  eavesBy?: Partial<Record<RoofHigh, number>>;
  slope: number;
  wallT: number;
  gableKey: string;
  /** この妻壁（面の中点 x,z・外向き法線）の下の外壁がアクセント仕上げか。無ければ gableKey */
  gableKeyAt?: (x: number, z: number, nx: number, nz: number) => string;
  gutter: boolean;
  /** 外周上の辺か判定（mm 座標系の外形） */
  onBoundary: (x0: number, z0: number, x1: number, z1: number) => boolean;
  /**
   * 辺（m）のうち外周に乗っている区間（辺の始点からの割合 0..1）。
   * 極大矩形の辺は一部だけ外周に乗ることがあり、辺の全長に妻壁・パラペットを立てると屋根の上に壁が出ていた
   */
  boundaryParts: (x0: number, z0: number, x1: number, z1: number) => [number, number][];
  /**
   * 斜めの外壁（隅切り・振れた壁）で屋根面を切り落とす半平面（m）。nx·x + nz·z >= d の側を残す。
   * 屋根は外形を四角形で覆って架けるので、斜めの壁の外に屋根の角がはみ出す（その下に壁が無く、外から屋根裏が見える）
   */
  clips?: { nx: number; nz: number; d: number }[];
  /** 今の四角形の壁の上端（m）。斜めの壁の上の立ち上がりに使う */
  wallTopY?: number;
}

export interface RoofInfo {
  /** 屋根の最高高さ (m) */
  maxY: number;
  /** 立面図用: 軒高 */
  eaveY: number;
}

export function buildRoofs(model: BuildingModel, style: ExteriorStyle, typeOverride?: RoofType, pitchOverride?: number, clip: ClipPlane | null = null): { mb: MeshBuilder; info: RoofInfo } {
  seq = 0;
  const mb = new MeshBuilder();
  // 輪切り（模型）: 切断面より上の屋根は作らない（下屋など低い屋根は残る）
  mb.clip = clip;
  const type = typeOverride ?? style.roof.type;
  const info: RoofInfo = { maxY: 0, eaveY: 0 };
  const floors = model.floors;
  if (!floors.length) return { mb, info };
  const extT = Math.max(120, ...floors.flatMap((f) => f.walls.filter((w) => w.exterior).map((w) => w.thickness))) * MM;
  // 玄関まわりのアクセント帯（建物側と同じ判定）: 妻壁・壁の立ち上がりも下の外壁と同じ仕上げにする（三角だけ色が変わらないように）
  const entranceLines: { a: THREE.Vector2; b: THREE.Vector2 }[] = [];
  if (style.accent && style.accentRule === 'entrance')
    for (const f of floors)
      for (const o of f.openings)
        if (o.kind === 'entrance') {
          const w = f.walls.find((x) => x.id === o.wallId);
          if (w) entranceLines.push({ a: new THREE.Vector2(w.a.x, w.a.y), b: new THREE.Vector2(w.b.x, w.b.y) });
        }
  const gableKeyAt = (x: number, z: number, nx: number, nz: number): string => {
    if (!style.accent || style.accentRule !== 'entrance') return 'ext.wall';
    // 面の中点（mm）が玄関の壁の線上（120mm 以内）にあればアクセント
    const px = x / MM;
    const pz = z / MM;
    for (const l of entranceLines) {
      const d = new THREE.Vector2().subVectors(l.b, l.a);
      const L = d.length() || 1;
      const t = ((px - l.a.x) * d.x + (pz - l.a.y) * d.y) / (L * L);
      const dist = Math.abs((px - l.a.x) * d.y - (pz - l.a.y) * d.x) / L;
      // 壁の線に平行で近い（法線が線と直交）
      const par = Math.abs(nx * d.x + nz * d.y) / L;
      if (dist < 160 && par < 0.3 && t > -0.05 && t < 1.05) return 'ext.accent';
    }
    return 'ext.wall';
  };

  // 真北方向（平面座標）: 片流れの向きに使う
  const na = (model.northAngleDeg * Math.PI) / 180;
  const north = { x: Math.sin(na), y: -Math.cos(na) };

  for (let k = floors.length - 1; k >= 0; k--) {
    const { f, polys, xs, zs, nx, nz, mask, maskUpper } = floorGrid(floors, k);
    if (!polys.length || nx <= 0 || nz <= 0) continue;
    const comps = maskComponents(xs, zs, mask);
    if (!comps.length) continue;
    const H = wallTopOf(model, f) * MM;
    const isTop = k === floors.length - 1;
    const upperAccent = style.accent && style.accentRule === 'upper' && f.level >= 2;
    const ctx: RoofCtx = {
      mb,
      T: 0.16,
      eaves: style.roof.eaves * MM,
      verge: style.roof.verge * MM,
      slope: (pitchOverride ?? style.roof.pitch) / 10,
      wallT: extT,
      gableKey: upperAccent ? 'ext.accent' : 'ext.wall',
      gableKeyAt: upperAccent ? undefined : gableKeyAt,
      gutter: style.roof.gutter,
      onBoundary: (x0, z0, x1, z1) => {
        // 辺に沿って数点、両側を調べ、どこかで片側が外（この階の範囲外）なら外周
        // （中点だけだと、辺の一部が隣の四角形に接する L 字形の外周で妻壁が抜け、屋根の裏が見えていた）
        const dx = (x1 - x0) / MM;
        const dz = (z1 - z0) / MM;
        const L = Math.hypot(dx, dz) || 1;
        const nxp = -dz / L;
        const nzp = dx / L;
        for (const f of [0.5, 0.15, 0.85, 0.35, 0.65]) {
          const mx = (x0 + (x1 - x0) * f) / MM;
          const mz = (z0 + (z1 - z0) * f) / MM;
          const inA = insideLoops({ x: mx + nxp * 60, y: mz + nzp * 60 }, polys);
          const inB = insideLoops({ x: mx - nxp * 60, y: mz - nzp * 60 }, polys);
          if (inA !== inB) return true;
        }
        return false;
      },
      boundaryParts: (x0, z0, x1, z1) => {
        const dx = x1 - x0;
        const dz = z1 - z0;
        const L = Math.hypot(dx, dz) || 1;
        const nxp = -dz / L;
        const nzp = dx / L;
        // 外形の頂点の座標（圧縮格子）で辺を分け、区間ごとに外周か調べる
        const alongX = Math.abs(dx) >= Math.abs(dz);
        const lines = (alongX ? xs : zs).map((v) => v * MM);
        const a0 = alongX ? x0 : z0;
        const a1 = alongX ? x1 : z1;
        const lo = Math.min(a0, a1);
        const hi = Math.max(a0, a1);
        const cuts = [0, ...lines.filter((v) => v > lo + 0.01 && v < hi - 0.01).map((v) => Math.abs(v - a0) / L), 1].sort((p, q) => p - q);
        const flags: boolean[] = [];
        for (let i = 0; i + 1 < cuts.length; i++) {
          const f = (cuts[i] + cuts[i + 1]) / 2;
          const mx = x0 + dx * f;
          const mz = z0 + dz * f;
          const inA = insideLoops({ x: mx / MM + nxp * 60, y: mz / MM + nzp * 60 }, polys);
          const inB = insideLoops({ x: mx / MM - nxp * 60, y: mz / MM - nzp * 60 }, polys);
          flags.push(inA !== inB);
        }
        // 壁厚ほどの短い端の区間（角の延長）は、隣が外周ならつなげる
        for (let i = 0; i < flags.length; i++) {
          const len = (cuts[i + 1] - cuts[i]) * L;
          if (!flags[i] && len <= extT * 1.1 && ((i > 0 && flags[i - 1]) || (i + 1 < flags.length && flags[i + 1]))) flags[i] = true;
        }
        const parts: [number, number][] = [];
        for (let i = 0; i < flags.length; i++) {
          if (!flags[i]) continue;
          const last = parts[parts.length - 1];
          if (last && Math.abs(last[1] - cuts[i]) < 1e-9) last[1] = cuts[i + 1];
          else parts.push([cuts[i], cuts[i + 1]]);
        }
        return parts;
      },
    };
    // 斜めの外形の辺: 四角形の中を通るものだけ、その辺から軒の出だけ外の線で屋根を切る
    const diag: { a: { x: number; y: number }; b: { x: number; y: number }; nx: number; ny: number }[] = [];
    for (const l of polys)
      for (let i = 0; i < l.length; i++) {
        const a = l[i];
        const b = l[(i + 1) % l.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const L = Math.hypot(dx, dy);
        if (L < 300 || Math.abs(dx) < 30 || Math.abs(dy) < 30) continue;
        let nx = -dy / L;
        let ny = dx / L;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        if (!insideLoops({ x: mx + nx * 80, y: my + ny * 80 }, polys)) [nx, ny] = [-nx, -ny];
        diag.push({ a, b, nx, ny });
      }
    const clipsFor = (r: Rect) => {
      const out: { nx: number; nz: number; d: number }[] = [];
      for (const e of diag) {
        if (Math.max(e.a.x, e.b.x) < r.minX - 50 || Math.min(e.a.x, e.b.x) > r.maxX + 50 || Math.max(e.a.y, e.b.y) < r.minY - 50 || Math.min(e.a.y, e.b.y) > r.maxY + 50) continue;
        // 切り落とす側（四角形の中で斜めの線より外）が全部建物の外のときだけ切る。
        // 外形がギザギザの図面では短い斜めの辺がいくつもあり、線を延ばした半平面で切ると建物の上の屋根まで欠ける
        let cut = 0;
        let bad = false;
        for (let a = 0; a <= 8 && !bad; a++)
          for (let b = 0; b <= 8; b++) {
            const p = { x: r.minX + ((r.maxX - r.minX) * a) / 8, y: r.minY + ((r.maxY - r.minY) * b) / 8 };
            if ((p.x - e.a.x) * e.nx + (p.y - e.a.y) * e.ny >= -60) continue;
            cut++;
            if (insideLoops(p, polys)) {
              bad = true;
              break;
            }
          }
        if (!cut || bad) continue;
        const off = (style.roof.eaves + extT / MM / 2) * MM;
        out.push({ nx: e.nx, nz: e.ny, d: (e.a.x * e.nx + e.a.y * e.ny) * MM - off });
      }
      return out;
    };
    // 塊（上の階が載らない範囲のつながった所）ごとに掛ける。塊ごとの手直し（model.roofPatches）があればそれを優先。
    // 最上階は全体の掛け方、下屋は緩い片流れ（全体が陸屋根なら下屋も陸屋根）
    const defaultKind: RoofKind = type === 'flat' ? 'flat' : isTop ? type : 'shed';
    for (const comp of comps) {
      const patch = patchFor(model.roofPatches, f.level, comp, xs, zs, nx);
      const kind: RoofKind = patch?.kind ?? defaultKind;
      const cmask = new Uint8Array(nx * nz);
      for (const c of comp.cells) cmask[c] = 1;
      const eavesMm = patch?.eaves ?? style.roof.eaves;
      const eavesBy = patch?.eavesBy ? Object.fromEntries(Object.entries(patch.eavesBy).filter(([, v]) => v != null).map(([k, v]) => [k, v! * MM])) : undefined;
      const cctx: RoofCtx = {
        ...ctx,
        eaves: eavesMm * MM,
        verge: (patch?.eaves != null ? Math.min(style.roof.verge, patch.eaves) : style.roof.verge) * MM,
        eavesBy: eavesBy && Object.keys(eavesBy).length ? eavesBy : undefined,
        slope: (patch?.pitch ?? pitchOverride ?? style.roof.pitch) / 10,
        gableKey: isTop ? ctx.gableKey : 'ext.wall',
        gableKeyAt: isTop ? ctx.gableKeyAt : undefined,
      };
      if (kind === 'flat') {
        // 陸屋根は四角形ごとではなく塊全体に 1 枚（四角形ごとに架けると重なった所で屋上が二重になり、屋根の上に壁が出ていた）
        const para = (patch?.parapet ?? 550) * MM;
        cctx.clips = [];
        cctx.wallTopY = H;
        flatRoofMask(cctx, xs, zs, cmask, maskUpper, H, para);
        info.maxY = Math.max(info.maxY, H + para);
        info.eaveY = Math.max(info.eaveY, H + para);
        continue;
      }
      if (kind === 'shed') {
        // 片流れ: 塊ごとに 1 枚の屋根面を、重ならない四角形に分けて張る（極大矩形は重なり合うので二重に描かれてちらついていた）
        const G = { minX: comp.bbox.minX * MM, maxX: comp.bbox.maxX * MM, minZ: comp.bbox.minY * MM, maxZ: comp.bbox.maxY * MM };
        // 下屋は上階に接する辺を高い側に（接する辺が無ければ御社の定番の向き）。最上階は南流し（北が高い）か東流し（西が高い）
        const touch = isTop ? null : touchingSide(comp, nx, nz, maskUpper);
        const high = patch?.high ?? touch ?? preferredHigh(G, north);
        const alongZ = high === 'n' || high === 's';
        const span = alongZ ? G.maxZ - G.minZ : G.maxX - G.minX;
        // 下屋は 0.5〜1 寸の緩い片流れ。最上階は高い側の壁の立ち上がりが 2.4m を超えない勾配まで（手直しで勾配を決めたときはそのまま）
        const slope = patch?.pitch != null ? patch.pitch / 10 : isTop ? Math.min(cctx.slope, 2.4 / Math.max(0.5, span)) : Math.min(cctx.slope, 0.1);
        const sub: RoofCtx = { ...cctx, slope };
        for (const r of comp.rects) {
          const R = { minX: r.minX * MM, maxX: r.maxX * MM, minZ: r.minY * MM, maxZ: r.maxY * MM };
          sub.clips = clipsFor(r);
          sub.wallTopY = H;
          const y = shedRoofPlane(sub, R, H, high, G);
          info.maxY = Math.max(info.maxY, y);
        }
        if (isTop) info.eaveY = Math.max(info.eaveY, H);
        continue;
      }
      // 切妻・寄棟: 塊を覆う極大矩形ごとに架ける（L 字では屋根どうしが交差して谷ができる）。下屋では上の階に接する辺に軒・けらばを出さない
      for (const r of maximalRectCoverMask(xs, zs, cmask)) {
        const R = { minX: r.minX * MM, maxX: r.maxX * MM, minZ: r.minY * MM, maxZ: r.maxY * MM };
        cctx.clips = clipsFor(r);
        cctx.wallTopY = H;
        const attached = isTop ? new Set<RoofHigh>() : rectAttached(r, xs, zs, nx, nz, maskUpper);
        const y = kind === 'gable' ? gableRoof(cctx, R, H, patch?.ridge, attached) : hipRoof(cctx, R, H, patch?.ridge);
        info.maxY = Math.max(info.maxY, y);
        info.eaveY = Math.max(info.eaveY, H);
      }
    }
  }
  return { mb, info };
}

/**
 * 屋根の塊の一覧（3D の「屋根」の道具用）。buildRoofs と同じ分け方で、塊ごとの実際の掛け方・向きと手直しを返す
 */
export function roofMasses(model: BuildingModel, style: ExteriorStyle, typeOverride?: RoofType): RoofMass[] {
  const type = typeOverride ?? style.roof.type;
  const floors = model.floors;
  const na = (model.northAngleDeg * Math.PI) / 180;
  const north = { x: Math.sin(na), y: -Math.cos(na) };
  const out: RoofMass[] = [];
  for (let k = floors.length - 1; k >= 0; k--) {
    const { f, polys, xs, zs, nx, nz, mask, maskUpper } = floorGrid(floors, k);
    if (!polys.length || nx <= 0 || nz <= 0) continue;
    const isTop = k === floors.length - 1;
    const defaultKind: RoofKind = type === 'flat' ? 'flat' : isTop ? type : 'shed';
    for (const comp of maskComponents(xs, zs, mask)) {
      const patch = patchFor(model.roofPatches, f.level, comp, xs, zs, nx);
      const kind = patch?.kind ?? defaultKind;
      const G = { minX: comp.bbox.minX * MM, maxX: comp.bbox.maxX * MM, minZ: comp.bbox.minY * MM, maxZ: comp.bbox.maxY * MM };
      const touch = isTop ? null : touchingSide(comp, nx, nz, maskUpper);
      const high = patch?.high ?? touch ?? preferredHigh(G, north);
      const big = comp.rects.slice().sort((a, b) => (b.maxX - b.minX) * (b.maxY - b.minY) - (a.maxX - a.minX) * (a.maxY - a.minY))[0];
      const center = { x: (big.minX + big.maxX) / 2, y: (big.minY + big.maxY) / 2 };
      out.push({ level: f.level, isTop, rects: comp.rects, bbox: comp.bbox, center, patch, kind, high, attached: isTop ? [] : touchingSides(comp, nx, nz, maskUpper) });
    }
  }
  return out;
}

/** 点（図面座標 mm）の下にある屋根の塊。軒の出のぶん外側（marginMm）まで当たりにする。上の階の屋根を優先 */
export function roofMassAt(masses: RoofMass[], p: Vec2, marginMm = 700): RoofMass | null {
  const inRect = (r: Rect, m: number) => p.x >= r.minX - m && p.x <= r.maxX + m && p.y >= r.minY - m && p.y <= r.maxY + m;
  const sorted = masses.slice().sort((a, b) => b.level - a.level);
  for (const m of [0, marginMm]) for (const ms of sorted) if (ms.rects.some((r) => inRect(r, m))) return ms;
  return null;
}


/** マスク（格子）のつながった範囲（4 近傍）。rects は重ならない四角形（行ごとの連続区間を、同じ区間が続く行でまとめたもの） */
function maskComponents(xs: number[], zs: number[], mask: Uint8Array): { cells: Set<number>; rects: Rect[]; bbox: Rect }[] {
  const nx = xs.length - 1;
  const nz = zs.length - 1;
  const seen = new Uint8Array(nx * nz);
  const out: { cells: Set<number>; rects: Rect[]; bbox: Rect }[] = [];
  for (let start = 0; start < nx * nz; start++) {
    if (!mask[start] || seen[start]) continue;
    const cells = new Set<number>();
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      cells.add(c);
      const i = c % nx;
      const j = (c - i) / nx;
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const k = jj * nx + ii;
        if (mask[k] && !seen[k]) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    // 行ごとの連続区間 → 同じ区間が続く行をまとめる
    const runs: { j0: number; j1: number; i0: number; i1: number }[] = [];
    for (let j = 0; j < nz; j++) {
      let i = 0;
      while (i < nx) {
        if (!cells.has(j * nx + i)) {
          i++;
          continue;
        }
        let k = i;
        while (k + 1 < nx && cells.has(j * nx + k + 1)) k++;
        const prev = runs.find((r) => r.j1 === j - 1 && r.i0 === i && r.i1 === k);
        if (prev) prev.j1 = j;
        else runs.push({ j0: j, j1: j, i0: i, i1: k });
        i = k + 1;
      }
    }
    const rects = runs.map((r) => ({ minX: xs[r.i0], maxX: xs[r.i1 + 1], minY: zs[r.j0], maxY: zs[r.j1 + 1] }));
    const bbox = { minX: Math.min(...rects.map((r) => r.minX)), maxX: Math.max(...rects.map((r) => r.maxX)), minY: Math.min(...rects.map((r) => r.minY)), maxY: Math.max(...rects.map((r) => r.maxY)) };
    out.push({ cells, rects, bbox });
  }
  return out;
}

/** 下屋の範囲が上階に接する辺（接する格子の辺の長さがいちばん長い向き）。接していなければ null */
function touchingSide(comp: { cells: Set<number> }, nx: number, nz: number, maskUpper: Uint8Array): 'n' | 's' | 'e' | 'w' | null {
  const len: Record<'n' | 's' | 'e' | 'w', number> = { n: 0, s: 0, e: 0, w: 0 };
  for (const c of comp.cells) {
    const i = c % nx;
    const j = (c - i) / nx;
    if (j > 0 && maskUpper[(j - 1) * nx + i]) len.n++;
    if (j + 1 < nz && maskUpper[(j + 1) * nx + i]) len.s++;
    if (i > 0 && maskUpper[j * nx + i - 1]) len.w++;
    if (i + 1 < nx && maskUpper[j * nx + i + 1]) len.e++;
  }
  const best = (Object.keys(len) as ('n' | 's' | 'e' | 'w')[]).sort((a, b) => len[b] - len[a])[0];
  return len[best] > 0 ? best : null;
}

/**
 * 片流れの高い側（御社の定番: 南流し = 北が高い。南北に長い建物は東流し = 西が高い）。
 * north は平面座標の真北の向き。辺の外向き（n: (0,-1) s: (0,1) e: (1,0) w: (-1,0)）と真北・真西の内積で決める
 */
function preferredHigh(G: { minX: number; maxX: number; minZ: number; maxZ: number }, north: { x: number; y: number }): 'n' | 's' | 'e' | 'w' {
  const west = { x: north.y, y: -north.x };
  const sides: { s: 'n' | 's' | 'e' | 'w'; n: { x: number; y: number } }[] = [
    { s: 'n', n: { x: 0, y: -1 } },
    { s: 's', n: { x: 0, y: 1 } },
    { s: 'e', n: { x: 1, y: 0 } },
    { s: 'w', n: { x: -1, y: 0 } },
  ];
  const pick = (dir: { x: number; y: number }) => sides.slice().sort((a, b) => b.n.x * dir.x + b.n.y * dir.y - (a.n.x * dir.x + a.n.y * dir.y))[0].s;
  const toNorth = pick(north);
  // 真北方向の長さと、それと直交する方向の長さ。南北に 15% 以上長ければ東流し
  const w = G.maxX - G.minX;
  const d = G.maxZ - G.minZ;
  const nsSpan = Math.abs(north.x) * w + Math.abs(north.y) * d;
  const ewSpan = Math.abs(west.x) * w + Math.abs(west.y) * d;
  return nsSpan > ewSpan * 1.15 ? pick(west) : toNorth;
}

/** 屋根面（上面・下面・外周の鼻隠し） */
/** 屋根面（凸多角形）を半平面で切る。辺ごとに元の辺の番号（切り口は -1）を返す */
function clipRoof(top: V3[], clips: { nx: number; nz: number; d: number }[]): { pts: V3[]; src: number[] } {
  let pts = top.map((p) => p.clone());
  let src = top.map((_, i) => i);
  // 屋根面の高さは元の平面から求め直す
  const n = new THREE.Vector3().subVectors(top[1], top[0]).cross(new THREE.Vector3().subVectors(top[2], top[0]));
  const yAt = (x: number, z: number) => (Math.abs(n.y) < 1e-9 ? top[0].y : top[0].y - (n.x * (x - top[0].x) + n.z * (z - top[0].z)) / n.y);
  for (const c of clips) {
    const f = (p: V3) => c.nx * p.x + c.nz * p.z - c.d;
    if (pts.every((p) => f(p) >= -1e-6)) continue;
    const outP: V3[] = [];
    const outS: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const fa = f(a);
      const fb = f(b);
      if (fa >= 0) {
        outP.push(a);
        outS.push(fb >= 0 ? src[i] : src[i]);
      }
      if ((fa >= 0) !== (fb >= 0)) {
        const t = fa / (fa - fb);
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        outP.push(new THREE.Vector3(x, yAt(x, z), z));
        // 入る点から先は元の辺、出る点から先は切り口
        outS.push(fa >= 0 ? -1 : src[i]);
      }
    }
    pts = outP;
    src = outS;
    if (pts.length < 3) break;
  }
  return { pts, src };
}

function roofPlane(ctx: RoofCtx, topIn: V3[], eaveEdgesIn: number[], downhill: V3) {
  const { mb, T } = ctx;
  let top = topIn;
  let eaveEdges = eaveEdgesIn;
  if (ctx.clips?.length) {
    const c = clipRoof(topIn, ctx.clips);
    if (c.pts.length < 3) return;
    if (c.pts.length !== topIn.length || c.src.some((s, i) => s !== i)) {
      top = c.pts;
      eaveEdges = c.src.map((s, i) => (s === -1 || eaveEdgesIn.includes(s) ? i : -1)).filter((i) => i >= 0);
    }
  }
  // 斜めの壁で切った辺の下: 壁の上端から屋根の下面まで壁を立ち上げる（隙間から屋根裏・天井が見えないように）
  if (top !== topIn && ctx.wallTopY != null && ctx.clips) {
    const pn = new THREE.Vector3().subVectors(top[1], top[0]).cross(new THREE.Vector3().subVectors(top[2], top[0]));
    const yAt = (x: number, z: number) => (Math.abs(pn.y) < 1e-9 ? top[0].y : top[0].y - (pn.x * (x - top[0].x) + pn.z * (z - top[0].z)) / pn.y);
    const off = ctx.eaves + ctx.wallT / 2;
    for (let i = 0; i < top.length; i++) {
      const a = top[i];
      const b = top[(i + 1) % top.length];
      const c = ctx.clips.find((q) => Math.abs(q.nx * a.x + q.nz * a.z - q.d) < 1e-3 && Math.abs(q.nx * b.x + q.nz * b.z - q.d) < 1e-3);
      if (!c || a.distanceTo(b) < 0.05) continue;
      // 壁芯の線（切り口から軒の出＋壁厚の半分だけ内側）
      const ax = a.x + c.nx * off;
      const az = a.z + c.nz * off;
      const bx = b.x + c.nx * off;
      const bz = b.z + c.nz * off;
      const H = ctx.wallTopY;
      const ya = yAt(ax, az) - ctx.T + 0.01;
      const yb = yAt(bx, bz) - ctx.T + 0.01;
      if (Math.max(ya, yb) - H < 0.02) continue;
      prism(mb, ctx.gableKey, [V(ax, H - 0.01, az), V(bx, H - 0.01, bz), V(bx, Math.max(H, yb), bz), V(ax, Math.max(H, ya), az)], V(-c.nx, 0, -c.nz), ctx.wallT - inset(), true);
    }
  }
  const n = new THREE.Vector3().subVectors(top[1], top[0]).cross(new THREE.Vector3().subVectors(top[2], top[0])).normalize();
  const normal = n.y < 0 ? n.negate() : n;
  const pts = n.y < 0 ? top.slice().reverse() : top;
  const uAxis = new THREE.Vector3().crossVectors(downhill, new THREE.Vector3(0, 1, 0)).normalize();
  const vAxis = downhill.clone().normalize();
  mb.polygon('ext.roof', pts, normal, uAxis, vAxis);
  const bottom = top.map((p) => p.clone().setY(p.y - T));
  mb.polygon('ext.soffit', bottom.slice().reverse().map((p) => p), normal.clone().negate(), uAxis, vAxis);
  // 外周の小口
  for (const i of eaveEdges) {
    const a = top[i];
    const b = top[(i + 1) % top.length];
    const a2 = bottom[i];
    const b2 = bottom[(i + 1) % top.length];
    // 外向きに表
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const cen = top.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / top.length);
    const out = mid.clone().sub(cen).setY(0);
    const qn = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(a2, a));
    if (qn.dot(out) >= 0) mb.quad('ext.fascia', a, b, b2, a2);
    else mb.quad('ext.fascia', b, a, a2, b2);
  }
}

/** 鉛直面内の多角形を厚み t で押し出す（妻壁など） */
function prism(mb: MeshBuilder, key: string, pts: V3[], normal: V3, t: number, skipBottom = false) {
  const off = normal.clone().multiplyScalar(t / 2);
  const front = pts.map((p) => p.clone().add(off));
  const back = pts.map((p) => p.clone().sub(off));
  // 外壁と同じ向きのテクスチャ座標（外壁の面と柄・色がそろうように）
  mb.polygon(key, front, normal);
  mb.polygon(key, back.slice().reverse(), normal.clone().negate());
  const cen = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  for (let i = 0; i < pts.length; i++) {
    const a = front[i];
    const b = front[(i + 1) % pts.length];
    const c = back[(i + 1) % pts.length];
    const d = back[i];
    const out = new THREE.Vector3().addVectors(pts[i], pts[(i + 1) % pts.length]).multiplyScalar(0.5).sub(cen);
    // 外壁の天端に乗る下の面は作らない（継ぎ目に点線のように透けるため）
    if (skipBottom && Math.abs(pts[i].y - pts[(i + 1) % pts.length].y) < 1e-4 && out.y < 0) continue;
    const qn = new THREE.Vector3().subVectors(d, a).cross(new THREE.Vector3().subVectors(c, a));
    if (qn.dot(out) >= 0) mb.quad(key, a, d, c, b);
    else mb.quad(key, a, b, c, d);
  }
}

type Region = { minX: number; maxX: number; minZ: number; maxZ: number };
/**
 * 妻壁（片流れ・切妻の三角形・台形）。外側の面を下の外壁の面にぴったりそろえ、薄くする分は内側に逃がす
 * （外壁の面から引っ込むと、継ぎ目の線と、そこだけ色の違う三角形が見えるため）
 */
function gablePrism(ctx: RoofCtx, R: Region, pts: V3[], normal: V3) {
  const t = ctx.wallT - inset();
  const cen = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  const out = Math.sign(cen.x * normal.x + cen.z * normal.z - (((R.minX + R.maxX) / 2) * normal.x + ((R.minZ + R.maxZ) / 2) * normal.z)) || 1;
  const sh = normal.clone().multiplyScalar((out * (ctx.wallT - t)) / 2);
  const key = ctx.gableKeyAt ? ctx.gableKeyAt(cen.x, cen.z, normal.x * out, normal.z * out) : ctx.gableKey;
  // 辺の一部だけが外周のときは、その区間だけに壁を立てる（全長に立てると屋根の上に壁が出る）
  const d = V(-normal.z, 0, normal.x).normalize();
  const sOf = (p: V3) => p.x * d.x + p.z * d.z;
  const ss = pts.map(sOf);
  const sMin = Math.min(...ss);
  const sMax = Math.max(...ss);
  const base = pts[0];
  const A = base.clone().addScaledVector(d, sMin - sOf(base));
  const B = base.clone().addScaledVector(d, sMax - sOf(base));
  const parts = ctx.boundaryParts(A.x, A.z, B.x, B.z);
  const whole = parts.length === 1 && parts[0][0] < 1e-6 && parts[0][1] > 1 - 1e-6;
  if (whole || !parts.length) {
    if (whole) prism(ctx.mb, key, pts.map((p) => p.clone().add(sh)), normal, t, true);
    return;
  }
  for (const [f0, f1] of parts) {
    const sub = clipVertical(pts, d, sMin + (sMax - sMin) * f0, sMin + (sMax - sMin) * f1);
    if (sub.length >= 3) prism(ctx.mb, key, sub.map((p) => p.clone().add(sh)), normal, t, true);
  }
}

/** 鉛直面の多角形を、面内の水平方向 d に沿う区間 [s0, s1] で切る（Sutherland–Hodgman） */
function clipVertical(pts: V3[], d: V3, s0: number, s1: number): V3[] {
  const sOf = (p: V3) => p.x * d.x + p.z * d.z;
  const clip = (input: V3[], keep: (s: number) => boolean, at: number) => {
    const out: V3[] = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i];
      const b = input[(i + 1) % input.length];
      const ka = keep(sOf(a));
      const kb = keep(sOf(b));
      if (ka) out.push(a.clone());
      if (ka !== kb) {
        const t = (at - sOf(a)) / (sOf(b) - sOf(a) || 1e-9);
        out.push(a.clone().lerp(b, t));
      }
    }
    return out;
  };
  const a = clip(pts, (s) => s >= s0 - 1e-6, s0);
  return a.length ? clip(a, (s) => s <= s1 + 1e-6, s1) : [];
}
/**
 * 壁の立ち上がり（箱）。同じく外側の面を外壁の面にそろえ、外壁と同じ向きのテクスチャ座標で張る。
 * 下の面は作らない（外壁の天端と重なる見えない面が、継ぎ目に点線のように透けて見えるため）
 */
function gableBox(ctx: RoofCtx, R: Region, c: V3, dir: V3, len: number, h: number) {
  const u0 = dir.clone().setY(0).normalize();
  const A0 = c.clone().addScaledVector(u0, -len / 2);
  const B0 = c.clone().addScaledVector(u0, len / 2);
  const parts = ctx.boundaryParts(A0.x, A0.z, B0.x, B0.z);
  if (!parts.length) return;
  const whole = parts.length === 1 && parts[0][0] < 1e-6 && parts[0][1] > 1 - 1e-6;
  if (!whole) {
    // 外周の区間ごとに箱を分ける
    for (const [f0, f1] of parts) {
      const cc = A0.clone().lerp(B0, (f0 + f1) / 2);
      gableBoxWhole(ctx, R, cc, dir, (f1 - f0) * len, h);
    }
    return;
  }
  gableBoxWhole(ctx, R, c, dir, len, h);
}

function gableBoxWhole(ctx: RoofCtx, R: Region, c: V3, dir: V3, len: number, h: number) {
  const t = ctx.wallT - boxT();
  const u = dir.clone().setY(0).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const n = new THREE.Vector3().crossVectors(u, up).normalize();
  const out = Math.sign((c.x - (R.minX + R.maxX) / 2) * n.x + (c.z - (R.minZ + R.maxZ) / 2) * n.z) || 1;
  const b = c.clone().addScaledVector(n, (out * (ctx.wallT - t)) / 2);
  const P = (s: number, y: number, d: number) => b.clone().addScaledVector(u, s).addScaledVector(up, y).addScaledVector(n, d);
  const hl = len / 2;
  const hd = t / 2;
  const k = ctx.gableKeyAt ? ctx.gableKeyAt(c.x, c.z, n.x * out, n.z * out) : ctx.gableKey;
  const mb = ctx.mb;
  mb.quad(k, P(-hl, 0, hd), P(hl, 0, hd), P(hl, h, hd), P(-hl, h, hd)); // +n
  mb.quad(k, P(hl, 0, -hd), P(-hl, 0, -hd), P(-hl, h, -hd), P(hl, h, -hd)); // -n
  mb.quad(k, P(-hl, h, -hd), P(-hl, h, hd), P(hl, h, hd), P(hl, h, -hd)); // 上
  mb.quad(k, P(-hl, 0, -hd), P(-hl, 0, hd), P(-hl, h, hd), P(-hl, h, -hd)); // 始端
  mb.quad(k, P(hl, 0, hd), P(hl, 0, -hd), P(hl, h, -hd), P(hl, h, hd)); // 終端
}

function gutter(ctx: RoofCtx, a: V3, b: V3, outward: V3) {
  if (!ctx.gutter) return;
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  dir.normalize();
  const c = a.clone().add(b).multiplyScalar(0.5).addScaledVector(outward, 0.06);
  const gy = a.y - ctx.T - 0.02;
  ctx.mb.box('ext.gutter', c.setY(gy), dir, len, 0.09, 0.11);
  // 竪樋（φ60）: 軒樋の端から呼び樋で壁ぎわへ落とし、GL+0.25 まで。2m 未満の短い軒樋には付けない（写真の立面で必ず見える部材）
  if (len < 2) return;
  const ends = len >= 9 ? [a.clone().addScaledVector(dir, 0.35), b.clone().addScaledVector(dir, -0.35)] : [b.clone().addScaledVector(dir, -0.35)];
  for (const p of ends) {
    const wall = p.clone().addScaledVector(outward, -(ctx.eaves - 0.06));
    const elbowY = gy - 0.12;
    // 呼び樋（軒樋の底から壁ぎわへ）
    const mid = p.clone().addScaledVector(outward, 0.06).add(wall).multiplyScalar(0.5).setY(elbowY);
    ctx.mb.box('ext.gutter', mid, outward, Math.max(0.08, ctx.eaves), 0.06, 0.06);
    // 竪樋
    ctx.mb.cylinder('ext.gutter', wall.clone().setY(0.25), 0.03, elbowY - 0.25, 12, false);
    // 支持金物（2.0m ごとの帯）
    for (let y = 1.0; y < elbowY - 0.3; y += 2.0) ctx.mb.cylinder('ext.frame', wall.clone().setY(y), 0.037, 0.03, 12, false);
  }
}

/**
 * 切妻。ridge = 棟の向き（x: 横に棟 = 南北に流れる、z: 縦に棟）。省略時は長い辺に沿う。
 * attached = 上の階の壁に取り付く辺（下屋）。その辺には軒・けらばを出さず、壁の面で止める
 */
function gableRoof(ctx: RoofCtx, R: { minX: number; maxX: number; minZ: number; maxZ: number }, H: number, ridge?: 'x' | 'z', attached?: Set<RoofHigh>): number {
  const { slope, eaves: e, verge: g, T } = ctx;
  const alongX = ridge ? ridge === 'x' : R.maxX - R.minX >= R.maxZ - R.minZ;
  const base = H + 0.04 + T;
  // 辺ごとの出（屋根を片側だけ伸ばす）。上の階に取り付く辺は壁の面で止める
  const o = (s: RoofHigh, v: number) => (attached?.has(s) ? -ctx.wallT / 2 : (ctx.eavesBy?.[s] ?? v));
  if (alongX) {
    const eN = o('n', e);
    const eS = o('s', e);
    const zc = (R.minZ + R.maxZ) / 2;
    const hs = (R.maxZ - R.minZ) / 2;
    const yR = base + hs * slope;
    const yN = base - eN * slope;
    const yS = base - eS * slope;
    const x0 = R.minX - o('w', g);
    const x1 = R.maxX + o('e', g);
    // 北側（-Z）
    roofPlane(ctx, [V(x0, yN, R.minZ - eN), V(x1, yN, R.minZ - eN), V(x1, yR, zc), V(x0, yR, zc)], [0, 1, 3], V(0, -slope, -1));
    roofPlane(ctx, [V(x1, yS, R.maxZ + eS), V(x0, yS, R.maxZ + eS), V(x0, yR, zc), V(x1, yR, zc)], [0, 1, 3], V(0, -slope, 1));
    ctx.mb.box('ext.fascia', V((x0 + x1) / 2, yR - 0.02, zc), V(1, 0, 0), x1 - x0, 0.07, 0.2);
    if (!attached?.has('n')) gutter(ctx, V(x0, yN, R.minZ - eN), V(x1, yN, R.minZ - eN), V(0, 0, -1));
    if (!attached?.has('s')) gutter(ctx, V(x0, yS, R.maxZ + eS), V(x1, yS, R.maxZ + eS), V(0, 0, 1));
    // 妻壁
    for (const x of [R.minX, R.maxX]) {
      if (!ctx.onBoundary(x, R.minZ, x, R.maxZ)) continue;
      gablePrism(ctx, R, [V(x, H - 0.01, R.minZ - ctx.wallT / 2), V(x, H - 0.01, R.maxZ + ctx.wallT / 2), V(x, yR - T + 0.01, zc)], V(1, 0, 0));
    }
    return yR;
  } else {
    const eW = o('w', e);
    const eE = o('e', e);
    const xc = (R.minX + R.maxX) / 2;
    const hs = (R.maxX - R.minX) / 2;
    const yR = base + hs * slope;
    const yW = base - eW * slope;
    const yE2 = base - eE * slope;
    const z0 = R.minZ - o('n', g);
    const z1 = R.maxZ + o('s', g);
    roofPlane(ctx, [V(R.minX - eW, yW, z1), V(R.minX - eW, yW, z0), V(xc, yR, z0), V(xc, yR, z1)], [0, 1, 3], V(-1, -slope, 0));
    roofPlane(ctx, [V(R.maxX + eE, yE2, z0), V(R.maxX + eE, yE2, z1), V(xc, yR, z1), V(xc, yR, z0)], [0, 1, 3], V(1, -slope, 0));
    ctx.mb.box('ext.fascia', V(xc, yR - 0.02, (z0 + z1) / 2), V(0, 0, 1), z1 - z0, 0.07, 0.2);
    if (!attached?.has('w')) gutter(ctx, V(R.minX - eW, yW, z0), V(R.minX - eW, yW, z1), V(-1, 0, 0));
    if (!attached?.has('e')) gutter(ctx, V(R.maxX + eE, yE2, z0), V(R.maxX + eE, yE2, z1), V(1, 0, 0));
    for (const z of [R.minZ, R.maxZ]) {
      if (!ctx.onBoundary(R.minX, z, R.maxX, z)) continue;
      gablePrism(ctx, R, [V(R.minX - ctx.wallT / 2, H - 0.01, z), V(xc, yR - T + 0.01, z), V(R.maxX + ctx.wallT / 2, H - 0.01, z)], V(0, 0, 1));
    }
    return yR;
  }
}

/** 寄棟。ridge = 棟の向き（省略時は長い辺に沿う）。軒は 4 辺とも同じ出（隅で面が合うため） */
function hipRoof(ctx: RoofCtx, R: { minX: number; maxX: number; minZ: number; maxZ: number }, H: number, ridge?: 'x' | 'z'): number {
  const { slope, eaves: e, T } = ctx;
  const X0 = R.minX - e;
  const X1 = R.maxX + e;
  const Z0 = R.minZ - e;
  const Z1 = R.maxZ + e;
  const base = H + 0.04 + T;
  const yE = base - e * slope;
  const alongX = ridge ? ridge === 'x' : X1 - X0 >= Z1 - Z0;
  if (alongX) {
    const hsE = (Z1 - Z0) / 2;
    const zc = (Z0 + Z1) / 2;
    const yR = yE + hsE * slope;
    const ra = V(X0 + hsE, yR, zc);
    const rb = V(X1 - hsE, yR, zc);
    roofPlane(ctx, [V(X0, yE, Z0), V(X1, yE, Z0), rb, ra], [0], V(0, -slope, -1));
    roofPlane(ctx, [V(X1, yE, Z1), V(X0, yE, Z1), ra, rb], [0], V(0, -slope, 1));
    roofPlane(ctx, [V(X0, yE, Z1), V(X0, yE, Z0), ra], [0], V(-1, -slope, 0));
    roofPlane(ctx, [V(X1, yE, Z0), V(X1, yE, Z1), rb], [0], V(1, -slope, 0));
    if (rb.x - ra.x > 0.01) ctx.mb.box('ext.fascia', V((ra.x + rb.x) / 2, yR - 0.02, zc), V(1, 0, 0), rb.x - ra.x, 0.07, 0.2);
    gutter(ctx, V(X0, yE, Z0), V(X1, yE, Z0), V(0, 0, -1));
    gutter(ctx, V(X0, yE, Z1), V(X1, yE, Z1), V(0, 0, 1));
    gutter(ctx, V(X0, yE, Z0), V(X0, yE, Z1), V(-1, 0, 0));
    gutter(ctx, V(X1, yE, Z0), V(X1, yE, Z1), V(1, 0, 0));
    return yR;
  } else {
    const hsE = (X1 - X0) / 2;
    const xc = (X0 + X1) / 2;
    const yR = yE + hsE * slope;
    const ra = V(xc, yR, Z0 + hsE);
    const rb = V(xc, yR, Z1 - hsE);
    roofPlane(ctx, [V(X0, yE, Z1), V(X0, yE, Z0), ra, rb], [0], V(-1, -slope, 0));
    roofPlane(ctx, [V(X1, yE, Z0), V(X1, yE, Z1), rb, ra], [0], V(1, -slope, 0));
    roofPlane(ctx, [V(X0, yE, Z0), V(X1, yE, Z0), ra], [0], V(0, -slope, -1));
    roofPlane(ctx, [V(X1, yE, Z1), V(X0, yE, Z1), rb], [0], V(0, -slope, 1));
    if (rb.z - ra.z > 0.01) ctx.mb.box('ext.fascia', V(xc, yR - 0.02, (ra.z + rb.z) / 2), V(0, 0, 1), rb.z - ra.z, 0.07, 0.2);
    gutter(ctx, V(X0, yE, Z0), V(X1, yE, Z0), V(0, 0, -1));
    gutter(ctx, V(X0, yE, Z1), V(X1, yE, Z1), V(0, 0, 1));
    gutter(ctx, V(X0, yE, Z0), V(X0, yE, Z1), V(-1, 0, 0));
    gutter(ctx, V(X1, yE, Z0), V(X1, yE, Z1), V(1, 0, 0));
    return yR;
  }
}

/**
 * 片流れ。high = 高い側の辺。attached = 上階の壁に取り付く下屋（高い側に軒を出さない）
 */
function shedRoof(ctx: RoofCtx, R: { minX: number; maxX: number; minZ: number; maxZ: number }, H: number, high: 'n' | 's' | 'e' | 'w', attached: boolean): number {
  const { slope, eaves: e, verge: g, T } = ctx;
  const base = H + 0.04 + T;
  const eh = attached ? -ctx.wallT / 2 : e; // 高い側の出
  const alongZ = high === 'n' || high === 's';
  const span = alongZ ? R.maxZ - R.minZ : R.maxX - R.minX;
  const yLow = base - e * slope;
  const yHigh = base + (span + eh) * slope;
  let top: V3[];
  let downhill: V3;
  let lowEdge: [V3, V3];
  let lowOut: V3;
  if (high === 'n') {
    top = [V(R.minX - g, yHigh, R.minZ - eh), V(R.minX - g, yLow, R.maxZ + e), V(R.maxX + g, yLow, R.maxZ + e), V(R.maxX + g, yHigh, R.minZ - eh)];
    downhill = V(0, -slope, 1);
    lowEdge = [top[1], top[2]];
    lowOut = V(0, 0, 1);
  } else if (high === 's') {
    top = [V(R.maxX + g, yHigh, R.maxZ + eh), V(R.maxX + g, yLow, R.minZ - e), V(R.minX - g, yLow, R.minZ - e), V(R.minX - g, yHigh, R.maxZ + eh)];
    downhill = V(0, -slope, -1);
    lowEdge = [top[1], top[2]];
    lowOut = V(0, 0, -1);
  } else if (high === 'w') {
    top = [V(R.minX - eh, yHigh, R.maxZ + g), V(R.maxX + e, yLow, R.maxZ + g), V(R.maxX + e, yLow, R.minZ - g), V(R.minX - eh, yHigh, R.minZ - g)];
    downhill = V(1, -slope, 0);
    lowEdge = [top[1], top[2]];
    lowOut = V(1, 0, 0);
  } else {
    top = [V(R.maxX + eh, yHigh, R.minZ - g), V(R.minX - e, yLow, R.minZ - g), V(R.minX - e, yLow, R.maxZ + g), V(R.maxX + eh, yHigh, R.maxZ + g)];
    downhill = V(-1, -slope, 0);
    lowEdge = [top[1], top[2]];
    lowOut = V(-1, 0, 0);
  }
  roofPlane(ctx, top, attached ? [0, 1, 2] : [0, 1, 2, 3], downhill);
  gutter(ctx, lowEdge[0], lowEdge[1], lowOut);
  const t = ctx.wallT;
  const yAt = (d: number) => H + 0.04 + d * slope; // 高い側からの距離 d での下端高さ（壁芯）
  // 側面（台形）と高い側の壁の立ち上がり
  if (alongZ) {
    const zHigh = high === 'n' ? R.minZ : R.maxZ;
    const zLow = high === 'n' ? R.maxZ : R.minZ;
    for (const x of [R.minX, R.maxX]) {
      if (!ctx.onBoundary(x, R.minZ, x, R.maxZ)) continue;
      const pts = [V(x, H - 0.01, zLow), V(x, H - 0.01, zHigh), V(x, yAt(span) - 0.005, zHigh), V(x, H + 0.03, zLow)];
      gablePrism(ctx, R, high === 'n' ? pts.reverse() : pts, V(1, 0, 0));
    }
    if (!attached && ctx.onBoundary(R.minX, zHigh, R.maxX, zHigh)) {
      const c = V((R.minX + R.maxX) / 2, H - 0.01, zHigh);
      gableBox(ctx, R, c, V(1, 0, 0), R.maxX - R.minX + t - boxLen(), yAt(span) - H);
    }
  } else {
    const xHigh = high === 'w' ? R.minX : R.maxX;
    const xLow = high === 'w' ? R.maxX : R.minX;
    for (const z of [R.minZ, R.maxZ]) {
      if (!ctx.onBoundary(R.minX, z, R.maxX, z)) continue;
      const pts = [V(xLow, H - 0.01, z), V(xHigh, H - 0.01, z), V(xHigh, yAt(span) - 0.005, z), V(xLow, H + 0.03, z)];
      gablePrism(ctx, R, pts, V(0, 0, 1));
    }
    if (!attached && ctx.onBoundary(xHigh, R.minZ, xHigh, R.maxZ)) {
      const c = V(xHigh, H - 0.01, (R.minZ + R.maxZ) / 2);
      gableBox(ctx, R, c, V(0, 0, 1), R.maxZ - R.minZ + t - boxLen(), yAt(span) - H);
    }
  }
  return yHigh;
}

/**
 * 片流れ屋根を、建物全体で共通の1枚の屋根面の一部として架ける。
 * 隣の四角形と接する辺は軒・けらばを出さず（同じ面で連続する）、外周の辺だけに軒・鼻隠し・壁の立ち上がりを付ける。
 */
function shedRoofPlane(
  ctx: RoofCtx,
  R: { minX: number; maxX: number; minZ: number; maxZ: number },
  H: number,
  high: 'n' | 's' | 'e' | 'w',
  G: { minX: number; maxX: number; minZ: number; maxZ: number },
): number {
  const { slope, eaves: e, verge: g, T } = ctx;
  const base = H + 0.04 + T;
  const alongZ = high === 'n' || high === 's';
  const S = alongZ ? G.maxZ - G.minZ : G.maxX - G.minX;
  // 局所座標: s = 高い側の壁芯（全体）からの距離、w = 直交方向
  const hiC = high === 'n' ? G.minZ : high === 's' ? G.maxZ : high === 'w' ? G.minX : G.maxX;
  const sgn = high === 'n' || high === 'w' ? 1 : -1;
  const toS = (c: number) => (c - hiC) * sgn;
  const sA = toS(alongZ ? (sgn > 0 ? R.minZ : R.maxZ) : sgn > 0 ? R.minX : R.maxX);
  const sB = toS(alongZ ? (sgn > 0 ? R.maxZ : R.minZ) : sgn > 0 ? R.maxX : R.minX);
  const w0 = alongZ ? R.minX : R.minZ;
  const w1 = alongZ ? R.maxX : R.maxZ;
  const W = (sv: number, wv: number, y: number) => {
    const c = hiC + sv * sgn;
    return alongZ ? V(wv, y, c) : V(c, y, wv);
  };
  const yTop = (sv: number) => base + (S - sv) * slope;
  const under = (sv: number) => H + 0.04 + (S - sv) * slope;
  // 辺が外周か（壁芯の線で判定）
  const edge = (sa: number, wa: number, sb: number, wb: number) => {
    const a = W(sa, wa, 0);
    const b = W(sb, wb, 0);
    return ctx.onBoundary(a.x, a.z, b.x, b.z);
  };
  const bW0 = edge(sA, w0, sB, w0);
  const bLow = edge(sB, w0, sB, w1);
  const bW1 = edge(sA, w1, sB, w1);
  const bHi = edge(sA, w0, sA, w1);
  // 辺ごとの出（屋根を片側だけ伸ばす）: 高い側・低い側は軒、横は けらば
  const lowSide: RoofHigh = high === 'n' ? 's' : high === 's' ? 'n' : high === 'w' ? 'e' : 'w';
  const w0Side: RoofHigh = alongZ ? 'w' : 'n';
  const w1Side: RoofHigh = alongZ ? 'e' : 's';
  const oHi = bHi ? (ctx.eavesBy?.[high] ?? e) : 0;
  const oLow = bLow ? (ctx.eavesBy?.[lowSide] ?? e) : 0;
  const oW0 = bW0 ? (ctx.eavesBy?.[w0Side] ?? g) : 0;
  const oW1 = bW1 ? (ctx.eavesBy?.[w1Side] ?? g) : 0;
  const s0 = sA - oHi;
  const s1 = sB + oLow;
  const top = [W(s0, w0 - oW0, yTop(s0)), W(s1, w0 - oW0, yTop(s1)), W(s1, w1 + oW1, yTop(s1)), W(s0, w1 + oW1, yTop(s0))];
  const dh = W(1, 0, 0).sub(W(0, 0, 0));
  const fasciaEdges = [bW0 ? 0 : -1, bLow ? 1 : -1, bW1 ? 2 : -1, bHi ? 3 : -1].filter((i) => i >= 0);
  roofPlane(ctx, top, fasciaEdges, V(dh.x, -slope, dh.z));
  if (bLow) gutter(ctx, top[1], top[2], dh.clone().normalize());
  const t = ctx.wallT;
  const wn = alongZ ? V(1, 0, 0) : V(0, 0, 1);
  // 側面（台形）
  for (const [wv, b] of [
    [w0, bW0],
    [w1, bW1],
  ] as const) {
    if (!b) continue;
    gablePrism(ctx, R, [W(sA, wv, H - 0.01), W(sB, wv, H - 0.01), W(sB, wv, under(sB) - 0.005), W(sA, wv, under(sA) - 0.005)], wn);
  }
  // 高い側・低い側の壁の立ち上がり
  for (const [sv, b] of [
    [sA, bHi],
    [sB, bLow],
  ] as const) {
    const h = under(sv) - H;
    if (!b || h < 0.06) continue;
    const c = W(sv, (w0 + w1) / 2, H - 0.01);
    gableBox(ctx, R, c, alongZ ? V(1, 0, 0) : V(0, 0, 1), w1 - w0 + t - boxLen(), h + 0.005);
  }
  return yTop(s0);
}

/**
 * 陸屋根（パラペット）: この階の範囲（上階の載らない所）に、重ならない四角形で屋上を張り、
 * 外形の外周に当たる格子の辺だけにパラペットを立てる（四角形ごとに架けていた頃の二重の屋上・屋根の上の壁を無くす）
 */
function flatRoofMask(ctx: RoofCtx, xs: number[], zs: number[], mask: Uint8Array, maskUpper: Uint8Array, H: number, para = 0.55) {
  const t = ctx.wallT;
  const nx = xs.length - 1;
  const nz = zs.length - 1;
  const y = H + 0.12;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= nz ? 0 : mask[j * nx + i]);
  const upperAt = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= nz ? 0 : maskUpper[j * nx + i]);
  // 屋上スラブ: 行ごとの連続区間を四角形に（重ならない）。外周側だけ壁厚の半分だけ広げる
  for (let j = 0; j < nz; j++) {
    let i = 0;
    while (i < nx) {
      if (!at(i, j)) {
        i++;
        continue;
      }
      let k = i;
      while (k + 1 < nx && at(k + 1, j)) k++;
      const x0 = xs[i] * MM - (at(i - 1, j) || upperAt(i - 1, j) ? 0 : t / 2 - 0.001);
      const x1 = xs[k + 1] * MM + (at(k + 1, j) || upperAt(k + 1, j) ? 0 : t / 2 - 0.001);
      // 上下（z）方向は、この行の全セルで隣が同じでないので、行ごとにセル単位で外周側だけ広げる
      const z0 = zs[j] * MM;
      const z1 = zs[j + 1] * MM;
      ctx.mb.aabb('ext.roof', V(x0, H - 0.01, z0 - (anyOutsideRow(i, k, j - 1) ? t / 2 - 0.001 : 0)), V(x1, y, z1 + (anyOutsideRow(i, k, j + 1) ? t / 2 - 0.001 : 0)));
      i = k + 1;
    }
  }
  function anyOutsideRow(i0: number, i1: number, j: number) {
    for (let i = i0; i <= i1; i++) if (!at(i, j) && !upperAt(i, j)) return true;
    return false;
  }
  // パラペット: 外周（外に面する格子の辺）を向きごとにつなげて箱に
  const edge = (x0: number, z0: number, x1: number, z1: number) => {
    const dir = V(x1 - x0, 0, z1 - z0);
    const L = dir.length();
    dir.normalize();
    const c = V((x0 + x1) / 2, H - 0.01, (z0 + z1) / 2);
    const R = { minX: Math.min(x0, x1) - 1, maxX: Math.max(x0, x1) + 1, minZ: Math.min(z0, z1) - 1, maxZ: Math.max(z0, z1) + 1 };
    gableBoxWhole(ctx, R, c, dir, L + t - boxLen(), para + 0.01);
    ctx.mb.box('ext.fascia', c.clone().setY(H + para), dir, L + t + 0.02, 0.04, t + 0.03);
  };
  // 北辺・南辺（行ごとに x 方向へつなげる）
  for (let j = 0; j < nz; j++)
    for (const side of [-1, 1]) {
      let i = 0;
      while (i < nx) {
        const open = (ii: number) => at(ii, j) && !at(ii, j + side) && !upperAt(ii, j + side);
        if (!open(i)) {
          i++;
          continue;
        }
        let k = i;
        while (k + 1 < nx && open(k + 1)) k++;
        const z = (side < 0 ? zs[j] : zs[j + 1]) * MM;
        edge(xs[i] * MM, z, xs[k + 1] * MM, z);
        i = k + 1;
      }
    }
  // 東辺・西辺（列ごとに z 方向へつなげる）
  for (let i = 0; i < nx; i++)
    for (const side of [-1, 1]) {
      let j = 0;
      while (j < nz) {
        const open = (jj: number) => at(i, jj) && !at(i + side, jj) && !upperAt(i + side, jj);
        if (!open(j)) {
          j++;
          continue;
        }
        let k = j;
        while (k + 1 < nz && open(k + 1)) k++;
        const x = (side < 0 ? xs[i] : xs[i + 1]) * MM;
        edge(x, zs[j] * MM, x, zs[k + 1] * MM);
        j = k + 1;
      }
    }
}

/**
 * 妻壁・壁の立ち上がりは外壁よりわずかに薄くする。外壁や隣の立ち上がりと同じ平面に面が重なると、
 * 光の計算（パストレーシング）で互いに影を落として真っ黒になるため（見た目の差は数 mm で分からない）。
 * 屋根を区画に分けると同じ外壁線の上に複数の区画の壁ができるので、部材ごとに 0.5mm ずつ厚みを変えて
 * 重ならないようにする。立ち上がりの箱は妻壁よりさらに薄く、角では隣の箱の側面より内側で止める
 */
const INSET = 0.004;
let seq = 0;
const jitter = () => 0.0005 * (seq++ % 8);
const inset = () => INSET + jitter();
const boxT = () => INSET * 3 + jitter();
const boxLen = () => INSET * 5 + 0.0005 * (seq % 8);

export type { Rect };
