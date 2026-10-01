/**
 * 屋根の自動生成
 *  - 最上階の外形を極大矩形で被覆し、矩形ごとに屋根をかける（L字では屋根同士が交差して谷ができる）
 *  - 下階のうち上階が載らない部分には下屋（片流れ）をかける
 *  - 切妻 / 寄棟 / 片流れ / 陸屋根（パラペット）
 */
import * as THREE from 'three';
import type { BuildingModel } from '../core/types';
import { insideLoops } from '../core/geometry';
import { maximalRectCoverMask, type Rect } from '../core/rects';
import { MeshBuilder, V } from './meshBuilder';
import { MM, wallTopOf } from './building';
import type { ExteriorStyle, RoofType } from '../styles/presets';

type V3 = THREE.Vector3;

interface RoofCtx {
  mb: MeshBuilder;
  T: number; // 屋根厚
  eaves: number;
  verge: number;
  slope: number;
  wallT: number;
  gableKey: string;
  gutter: boolean;
  /** 外周上の辺か判定（mm 座標系の外形） */
  onBoundary: (x0: number, z0: number, x1: number, z1: number) => boolean;
}

export interface RoofInfo {
  /** 屋根の最高高さ (m) */
  maxY: number;
  /** 立面図用: 軒高 */
  eaveY: number;
}

export function buildRoofs(model: BuildingModel, style: ExteriorStyle, typeOverride?: RoofType): { mb: MeshBuilder; info: RoofInfo } {
  const mb = new MeshBuilder();
  const type = typeOverride ?? style.roof.type;
  const info: RoofInfo = { maxY: 0, eaveY: 0 };
  const floors = model.floors;
  if (!floors.length) return { mb, info };
  const extT = Math.max(120, ...floors.flatMap((f) => f.walls.filter((w) => w.exterior).map((w) => w.thickness))) * MM;

  // 真北方向（平面座標）: 片流れの向きに使う
  const na = (model.northAngleDeg * Math.PI) / 180;
  const north = { x: Math.sin(na), y: -Math.cos(na) };

  for (let k = floors.length - 1; k >= 0; k--) {
    const f = floors[k];
    const higher = floors.slice(k + 1);
    const polys = f.outline;
    if (!polys.length) continue;
    // 座標圧縮グリッド
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
    const mask = new Uint8Array(nx * nz);
    const maskUpper = new Uint8Array(nx * nz);
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const c = { x: (xs[i] + xs[i + 1]) / 2, y: (zs[j] + zs[j + 1]) / 2 };
        const inThis = insideLoops(c, polys);
        const inUpper = higher.some((h) => insideLoops(c, h.outline));
        mask[j * nx + i] = inThis && !inUpper ? 1 : 0;
        maskUpper[j * nx + i] = inUpper ? 1 : 0;
      }
    const rects = maximalRectCoverMask(xs, zs, mask);
    if (!rects.length) continue;
    const H = wallTopOf(model, f) * MM;
    const isTop = k === floors.length - 1;
    const upperAccent = style.accent && style.accentRule === 'upper' && f.level >= 2;
    const ctx: RoofCtx = {
      mb,
      T: 0.16,
      eaves: style.roof.eaves * MM,
      verge: style.roof.verge * MM,
      slope: style.roof.pitch / 10,
      wallT: extT,
      gableKey: upperAccent ? 'ext.accent' : 'ext.wall',
      gutter: style.roof.gutter,
      onBoundary: (x0, z0, x1, z1) => {
        // 辺の中点の両側を調べ、片側が外（この階の範囲外）なら外周
        const mx = (x0 + x1) / 2 / MM;
        const mz = (z0 + z1) / 2 / MM;
        const dx = (x1 - x0) / MM;
        const dz = (z1 - z0) / MM;
        const L = Math.hypot(dx, dz) || 1;
        const nxp = -dz / L;
        const nzp = dx / L;
        const inA = insideLoops({ x: mx + nxp * 60, y: mz + nzp * 60 }, polys);
        const inB = insideLoops({ x: mx - nxp * 60, y: mz - nzp * 60 }, polys);
        return inA !== inB;
      },
    };
    const cellIn = (m: Uint8Array, x: number, z: number) => {
      let i = xs.findIndex((v, idx) => idx < nx && x >= v && x < xs[idx + 1]);
      let j = zs.findIndex((v, idx) => idx < nz && z >= v && z < zs[idx + 1]);
      if (i < 0 || j < 0) return false;
      return !!m[j * nx + i];
    };
    for (const r of rects) {
      const R = { minX: r.minX * MM, maxX: r.maxX * MM, minZ: r.minY * MM, maxZ: r.maxY * MM };
      if (type === 'flat') {
        flatRoof(ctx, R, H);
        info.maxY = Math.max(info.maxY, H + 0.5);
        info.eaveY = Math.max(info.eaveY, H + 0.5);
        continue;
      }
      if (!isTop) {
        // 上階に接する辺を探す（下屋）
        const probe = 150;
        const sideTouch = (side: 'n' | 's' | 'e' | 'w') => {
          let hits = 0;
          const N = 6;
          for (let q = 1; q < N; q++) {
            const fq = q / N;
            let x = 0;
            let z = 0;
            if (side === 'n') [x, z] = [r.minX + (r.maxX - r.minX) * fq, r.minY - probe];
            if (side === 's') [x, z] = [r.minX + (r.maxX - r.minX) * fq, r.maxY + probe];
            if (side === 'w') [x, z] = [r.minX - probe, r.minY + (r.maxY - r.minY) * fq];
            if (side === 'e') [x, z] = [r.maxX + probe, r.minY + (r.maxY - r.minY) * fq];
            if (cellIn(maskUpper, x, z)) hits++;
          }
          return hits / (N - 1);
        };
        const touches = (['n', 's', 'e', 'w'] as const).map((s) => ({ s, v: sideTouch(s) })).sort((a, b) => b.v - a.v);
        if (touches[0].v > 0.3) {
          const lowSlope = Math.min(ctx.slope, 0.3);
          const y = shedRoof({ ...ctx, slope: lowSlope, gableKey: 'ext.wall' }, R, H, touches[0].s, true);
          info.maxY = Math.max(info.maxY, y);
          continue;
        }
      }
      let y = 0;
      if (type === 'gable') y = gableRoof(ctx, R, H);
      else if (type === 'hip') y = hipRoof(ctx, R, H);
      else {
        // 片流れ: 北側を高く（南面に屋根面を向ける）
        const high: 'n' | 's' | 'e' | 'w' =
          Math.abs(north.y) >= Math.abs(north.x) ? (north.y < 0 ? 'n' : 's') : north.x > 0 ? 'e' : 'w';
        y = shedRoof(ctx, R, H, high, false);
      }
      info.maxY = Math.max(info.maxY, y);
      if (isTop) info.eaveY = Math.max(info.eaveY, H);
    }
  }
  return { mb, info };
}

/** 屋根面（上面・下面・外周の鼻隠し） */
function roofPlane(ctx: RoofCtx, top: V3[], eaveEdges: number[], downhill: V3) {
  const { mb, T } = ctx;
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
function prism(mb: MeshBuilder, key: string, pts: V3[], normal: V3, t: number) {
  const off = normal.clone().multiplyScalar(t / 2);
  const front = pts.map((p) => p.clone().add(off));
  const back = pts.map((p) => p.clone().sub(off));
  const uA = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), normal).normalize();
  const vA = new THREE.Vector3(0, 1, 0);
  mb.polygon(key, front, normal, uA, vA);
  mb.polygon(key, back.slice().reverse(), normal.clone().negate(), uA, vA);
  const cen = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  for (let i = 0; i < pts.length; i++) {
    const a = front[i];
    const b = front[(i + 1) % pts.length];
    const c = back[(i + 1) % pts.length];
    const d = back[i];
    const out = new THREE.Vector3().addVectors(pts[i], pts[(i + 1) % pts.length]).multiplyScalar(0.5).sub(cen);
    const qn = new THREE.Vector3().subVectors(d, a).cross(new THREE.Vector3().subVectors(c, a));
    if (qn.dot(out) >= 0) mb.quad(key, a, d, c, b);
    else mb.quad(key, a, b, c, d);
  }
}

function gutter(ctx: RoofCtx, a: V3, b: V3, outward: V3) {
  if (!ctx.gutter) return;
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  dir.normalize();
  const c = a.clone().add(b).multiplyScalar(0.5).addScaledVector(outward, 0.06);
  ctx.mb.box('ext.gutter', c.setY(a.y - ctx.T - 0.02), dir, len, 0.09, 0.11);
}

function gableRoof(ctx: RoofCtx, R: { minX: number; maxX: number; minZ: number; maxZ: number }, H: number): number {
  const { slope, eaves: e, verge: g, T } = ctx;
  const alongX = R.maxX - R.minX >= R.maxZ - R.minZ;
  const base = H + 0.04 + T;
  if (alongX) {
    const zc = (R.minZ + R.maxZ) / 2;
    const hs = (R.maxZ - R.minZ) / 2;
    const yR = base + hs * slope;
    const yE = base - e * slope;
    const x0 = R.minX - g;
    const x1 = R.maxX + g;
    // 北側（-Z）
    roofPlane(ctx, [V(x0, yE, R.minZ - e), V(x1, yE, R.minZ - e), V(x1, yR, zc), V(x0, yR, zc)], [0, 1, 3], V(0, -slope, -1));
    roofPlane(ctx, [V(x1, yE, R.maxZ + e), V(x0, yE, R.maxZ + e), V(x0, yR, zc), V(x1, yR, zc)], [0, 1, 3], V(0, -slope, 1));
    ctx.mb.box('ext.fascia', V((x0 + x1) / 2, yR - 0.02, zc), V(1, 0, 0), x1 - x0, 0.07, 0.2);
    gutter(ctx, V(x0, yE, R.minZ - e), V(x1, yE, R.minZ - e), V(0, 0, -1));
    gutter(ctx, V(x0, yE, R.maxZ + e), V(x1, yE, R.maxZ + e), V(0, 0, 1));
    // 妻壁
    for (const x of [R.minX, R.maxX]) {
      if (!ctx.onBoundary(x, R.minZ, x, R.maxZ)) continue;
      prism(ctx.mb, ctx.gableKey, [V(x, H - 0.01, R.minZ - ctx.wallT / 2), V(x, H - 0.01, R.maxZ + ctx.wallT / 2), V(x, yR - T + 0.01, zc)], V(1, 0, 0), ctx.wallT);
    }
    return yR;
  } else {
    const xc = (R.minX + R.maxX) / 2;
    const hs = (R.maxX - R.minX) / 2;
    const yR = base + hs * slope;
    const yE = base - e * slope;
    const z0 = R.minZ - g;
    const z1 = R.maxZ + g;
    roofPlane(ctx, [V(R.minX - e, yE, z1), V(R.minX - e, yE, z0), V(xc, yR, z0), V(xc, yR, z1)], [0, 1, 3], V(-1, -slope, 0));
    roofPlane(ctx, [V(R.maxX + e, yE, z0), V(R.maxX + e, yE, z1), V(xc, yR, z1), V(xc, yR, z0)], [0, 1, 3], V(1, -slope, 0));
    ctx.mb.box('ext.fascia', V(xc, yR - 0.02, (z0 + z1) / 2), V(0, 0, 1), z1 - z0, 0.07, 0.2);
    gutter(ctx, V(R.minX - e, yE, z0), V(R.minX - e, yE, z1), V(-1, 0, 0));
    gutter(ctx, V(R.maxX + e, yE, z0), V(R.maxX + e, yE, z1), V(1, 0, 0));
    for (const z of [R.minZ, R.maxZ]) {
      if (!ctx.onBoundary(R.minX, z, R.maxX, z)) continue;
      prism(ctx.mb, ctx.gableKey, [V(R.minX - ctx.wallT / 2, H - 0.01, z), V(xc, yR - T + 0.01, z), V(R.maxX + ctx.wallT / 2, H - 0.01, z)], V(0, 0, 1), ctx.wallT);
    }
    return yR;
  }
}

function hipRoof(ctx: RoofCtx, R: { minX: number; maxX: number; minZ: number; maxZ: number }, H: number): number {
  const { slope, eaves: e, T } = ctx;
  const X0 = R.minX - e;
  const X1 = R.maxX + e;
  const Z0 = R.minZ - e;
  const Z1 = R.maxZ + e;
  const base = H + 0.04 + T;
  const yE = base - e * slope;
  const alongX = X1 - X0 >= Z1 - Z0;
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
      prism(ctx.mb, ctx.gableKey, high === 'n' ? pts.reverse() : pts, V(1, 0, 0), t);
    }
    if (!attached && ctx.onBoundary(R.minX, zHigh, R.maxX, zHigh)) {
      const c = V((R.minX + R.maxX) / 2, H - 0.01, zHigh);
      ctx.mb.box(ctx.gableKey, c, V(1, 0, 0), R.maxX - R.minX + t, yAt(span) - H, t);
    }
  } else {
    const xHigh = high === 'w' ? R.minX : R.maxX;
    const xLow = high === 'w' ? R.maxX : R.minX;
    for (const z of [R.minZ, R.maxZ]) {
      if (!ctx.onBoundary(R.minX, z, R.maxX, z)) continue;
      const pts = [V(xLow, H - 0.01, z), V(xHigh, H - 0.01, z), V(xHigh, yAt(span) - 0.005, z), V(xLow, H + 0.03, z)];
      prism(ctx.mb, ctx.gableKey, pts, V(0, 0, 1), t);
    }
    if (!attached && ctx.onBoundary(xHigh, R.minZ, xHigh, R.maxZ)) {
      const c = V(xHigh, H - 0.01, (R.minZ + R.maxZ) / 2);
      ctx.mb.box(ctx.gableKey, c, V(0, 0, 1), R.maxZ - R.minZ + t, yAt(span) - H, t);
    }
  }
  return yHigh;
}

function flatRoof(ctx: RoofCtx, R: { minX: number; maxX: number; minZ: number; maxZ: number }, H: number) {
  const t = ctx.wallT;
  const para = 0.55;
  // 屋上スラブ
  const y = H + 0.12;
  ctx.mb.aabb('ext.roof', V(R.minX - t / 2 + 0.001, H - 0.01, R.minZ - t / 2 + 0.001), V(R.maxX + t / 2 - 0.001, y, R.maxZ + t / 2 - 0.001));
  // パラペット
  const edges: [number, number, number, number][] = [
    [R.minX, R.minZ, R.maxX, R.minZ],
    [R.maxX, R.minZ, R.maxX, R.maxZ],
    [R.maxX, R.maxZ, R.minX, R.maxZ],
    [R.minX, R.maxZ, R.minX, R.minZ],
  ];
  for (const [x0, z0, x1, z1] of edges) {
    if (!ctx.onBoundary(x0, z0, x1, z1)) continue;
    const dir = V(x1 - x0, 0, z1 - z0);
    const L = dir.length();
    dir.normalize();
    const c = V((x0 + x1) / 2, H - 0.01, (z0 + z1) / 2);
    ctx.mb.box(ctx.gableKey, c, dir, L + t, para + 0.01, t);
    ctx.mb.box('ext.fascia', c.clone().setY(H + para), dir, L + t + 0.02, 0.04, t + 0.03);
  }
}

export type { Rect };
