/**
 * 外観の自己点検（3D を作るたびに、読み取りの崩れを数で出す）。
 * 目で見て気づく「外壁が抜けて室内が見える」「屋根に穴」を光線で調べる。アプリ（3D を作った直後の通知）と
 * 一括点検（scripts/audit）の両方で使う。
 */
import * as THREE from 'three';
import type { Viewer } from './viewer';
import type { BuildingModel } from '../core/types';

export interface EnvelopeAudit {
  wallSamples: number;
  roofSamples: number;
  /** 外壁の抜け（連続した区間ごと。len は m、at は図面座標 mm） */
  walls: { level: number; len: number; at: number[]; hit: string; room: string }[];
  /** 屋根の穴（当たった面ごとの点数） */
  roofs: { level: number; n: number; at: number[]; hit: string }[];
}

/**
 * 点検用: 出来上がった 3D の外皮を光線で調べる（目で見て気づく崩れを数で出す）。
 * - 外壁: 各階の外形の辺に沿って 0.4m ごと、外から壁の中ほど（床 +1.2m）へ水平に光線を当て、最初に当たるのが外装（ext.*）か。
 *   室内の面（int.*）・家具に当たる／何にも当たらない所は「外壁が抜けている」。
 * - 屋根: 上の階が載らない範囲を 0.5m 格子で上から下へ光線を当て、最初に当たるのが屋根・外装か。床や天井に当たる所は「屋根の穴」。
 * 返す span は連続した抜けを 1 か所にまとめたもの（長さ m・階・中の部屋）
 */
export function auditEnvelope(viewer: Viewer): EnvelopeAudit {
  const v = viewer as unknown as { state: { model: BuildingModel } | null; groups: Record<string, THREE.Group> };
  if (!v.state) return { wallSamples: 0, roofSamples: 0, walls: [], roofs: [] };
  const model = v.state.model;
  const targets: THREE.Object3D[] = [];
  for (const k of ['building', 'roof']) v.groups[k].traverse((o) => (o as THREE.Mesh).isMesh && o.visible && targets.push(o));
  const rc = new THREE.Raycaster();
  const keyOf = (hit: THREE.Intersection | undefined) => {
    if (!hit) return '';
    const m = (hit.object as THREE.Mesh).material as THREE.Material | THREE.Material[];
    const mm = Array.isArray(m) ? m[hit.face?.materialIndex ?? 0] : m;
    return mm?.name || hit.object.name || '?';
  };
  const cast = (o: THREE.Vector3, d: THREE.Vector3, far: number) => {
    rc.set(o, d);
    rc.far = far;
    return rc.intersectObjects(targets, false).find((h) => (h.object as THREE.Mesh).visible);
  };
  const MMv = 0.001;
  const inLoop = (p: { x: number; y: number }, l: { x: number; y: number }[]) => {
    let c = false;
    for (let i = 0, j = l.length - 1; i < l.length; j = i++) if (l[i].y > p.y !== l[j].y > p.y && p.x < ((l[j].x - l[i].x) * (p.y - l[i].y)) / (l[j].y - l[i].y) + l[i].x) c = !c;
    return c;
  };
  const inOutline = (p: { x: number; y: number }, loops: { x: number; y: number }[][]) => loops.filter((l) => l.length >= 3 && inLoop(p, l)).length % 2 === 1;
  const roomAt = (f: BuildingModel['floors'][number], p: { x: number; y: number }) => f.rooms.find((r) => inLoop(p, r.polygon));
  // 車庫・カーポート・ポーチ・バルコニー（手すりは床 +1.2m より低い）は外に開いているのが正しい
  const OPEN = new Set(['garage', 'carport', 'parking', 'porch', 'deck', 'terrace', 'balcony']);
  const walls: { level: number; len: number; at: number[]; hit: string; room: string }[] = [];
  const roofs: { level: number; n: number; at: number[]; hit: string }[] = [];
  let wallSamples = 0;
  let roofSamples = 0;
  for (const f of model.floors) {
    const y = (f.elevation + 1200) * MMv;
    for (const loop of f.outline) {
      if (loop.length < 3) continue;
      let run: { len: number; at: number[]; hit: string; room: string } | null = null;
      const flush = () => {
        if (run && run.len >= 0.6) walls.push({ level: f.level, ...run, len: Math.round(run.len * 10) / 10 });
        run = null;
      };
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        if (L < 500) continue;
        const ux = (b.x - a.x) / L;
        const uy = (b.y - a.y) / L;
        // 外向き: 辺の中点から少し外へ出た点が外形の外なら +n
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        let nx = uy;
        let ny = -ux;
        if (inOutline({ x: mid.x + nx * 200, y: mid.y + ny * 200 }, f.outline)) [nx, ny] = [-nx, -ny];
        for (let t = 250; t < L - 250; t += 400) {
          const p = { x: a.x + ux * t, y: a.y + uy * t };
          wallSamples++;
          const o = new THREE.Vector3((p.x + nx * 1500) * MMv, y, (p.y + ny * 1500) * MMv);
          const hit = cast(o, new THREE.Vector3(-nx, 0, -ny), 2.2);
          const k = keyOf(hit);
          const ok = k.startsWith('ext.') || k.startsWith('mat.ext') || /glass|frame|door|shutter|sash|canopy|balcony|terrace/i.test(k);
          if (ok) {
            flush();
            continue;
          }
          const rm = roomAt(f, { x: p.x - nx * 400, y: p.y - ny * 400 });
          if (rm && OPEN.has(rm.type)) {
            flush();
            continue;
          }
          if (!run) run = { len: 0, at: [Math.round(p.x), Math.round(p.y)], hit: k || '(なし)', room: rm?.name ?? '' };
          run.len += 0.4;
        }
        flush();
      }
    }
    // 屋根: この階の範囲のうち上の階が載らない所
    const higher = model.floors.filter((x) => x.level > f.level);
    const pts = f.outline.flat();
    if (!pts.length) continue;
    const x0 = Math.min(...pts.map((p) => p.x));
    const x1 = Math.max(...pts.map((p) => p.x));
    const y0 = Math.min(...pts.map((p) => p.y));
    const y1 = Math.max(...pts.map((p) => p.y));
    const bad = new Map<string, { n: number; at: number[] }>();
    for (let x = x0 + 350; x < x1; x += 700)
      for (let yy = y0 + 350; yy < y1; yy += 700) {
        const p = { x, y: yy };
        if (!inOutline(p, f.outline) || higher.some((h) => inOutline(p, h.outline))) continue;
        roofSamples++;
        const hit = cast(new THREE.Vector3(x * MMv, 40, yy * MMv), new THREE.Vector3(0, -1, 0), 60);
        const k = keyOf(hit);
        if (k.startsWith('ext.') || /terrace|balcony|deck/i.test(k)) continue;
        const g = bad.get(k || '(なし)') ?? { n: 0, at: [x, yy] };
        g.n++;
        bad.set(k || '(なし)', g);
      }
    for (const [hit, g] of bad) roofs.push({ level: f.level, n: g.n, at: g.at, hit });
  }
  return { wallSamples, roofSamples, walls, roofs };
}
