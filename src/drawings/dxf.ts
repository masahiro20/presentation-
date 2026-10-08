/**
 * 読み取った間取りを DXF（R12 ASCII）で書き出す。CAD（JW_CAD・AutoCAD・ARCHITREND など）で開いて下図に使える。
 *  - 階ごとに横に並べ、レイヤは「1F_WALL」「1F_OPENING」「1F_TEXT」「1F_STAIR」「1F_OUTLINE」
 *  - 単位 mm、Y は上向き（図面の y は下向きなので反転）
 */
import type { BuildingModel, Floor } from '../core/types';
import { openingSchedule } from './plan';

function pair(code: number, value: string | number) {
  return `${code}\n${value}\n`;
}

function line(layer: string, x1: number, y1: number, x2: number, y2: number) {
  return pair(0, 'LINE') + pair(8, layer) + pair(10, x1.toFixed(1)) + pair(20, y1.toFixed(1)) + pair(30, 0) + pair(11, x2.toFixed(1)) + pair(21, y2.toFixed(1)) + pair(31, 0);
}

function text(layer: string, x: number, y: number, h: number, str: string, align: 'left' | 'center' = 'center') {
  let s = pair(0, 'TEXT') + pair(8, layer) + pair(10, x.toFixed(1)) + pair(20, y.toFixed(1)) + pair(30, 0) + pair(40, h) + pair(1, str.replace(/[\r\n]/g, ' '));
  if (align === 'center') s += pair(72, 1) + pair(11, x.toFixed(1)) + pair(21, y.toFixed(1)) + pair(31, 0);
  return s;
}

function floorEntities(f: Floor, ox: number): string {
  const L = `${f.level}F`;
  const Y = (y: number) => -y; // 図面 y 下向き → CAD y 上向き
  let s = '';
  for (const w of f.walls) {
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (len < 1) continue;
    const ux = (w.b.x - w.a.x) / len;
    const uy = (w.b.y - w.a.y) / len;
    const nx = -uy;
    const ny = ux;
    const h = w.thickness / 2;
    const P = (t: number, sgn: number) => [ox + w.a.x + ux * t + nx * h * sgn, Y(w.a.y + uy * t + ny * h * sgn)] as const;
    const ops = f.openings.filter((o) => o.wallId === w.id).sort((a, b) => a.t0 - b.t0);
    // 壁面（開口部は抜く）
    const solid: [number, number][] = [];
    let cur = 0;
    for (const o of ops) {
      if (o.t0 > cur) solid.push([cur, o.t0]);
      cur = Math.max(cur, o.t1);
    }
    if (cur < len) solid.push([cur, len]);
    for (const [t0, t1] of solid) {
      const a1 = P(t0, 1);
      const b1 = P(t1, 1);
      const a2 = P(t0, -1);
      const b2 = P(t1, -1);
      s += line(`${L}_WALL`, a1[0], a1[1], b1[0], b1[1]);
      s += line(`${L}_WALL`, a2[0], a2[1], b2[0], b2[1]);
      // 端部（開口の小口・壁の端）
      s += line(`${L}_WALL`, a1[0], a1[1], a2[0], a2[1]);
      s += line(`${L}_WALL`, b1[0], b1[1], b2[0], b2[1]);
    }
    // 建具
    for (const o of ops) {
      const a = P(o.t0, 0);
      const b = P(o.t1, 0);
      if (o.kind === 'window') {
        for (const k of [-1, 1]) {
          const p0 = P(o.t0, k);
          const p1 = P(o.t1, k);
          s += line(`${L}_OPENING`, p0[0], p0[1], p1[0], p1[1]);
        }
        s += line(`${L}_OPENING`, a[0], a[1], b[0], b[1]);
      } else {
        s += line(`${L}_OPENING`, a[0], a[1], b[0], b[1]);
        if (o.kind === 'door' || o.kind === 'entrance') {
          // 扉と軌跡（円弧は 12 分割の線で）
          const hingeStart = o.hingeAtStart !== false;
          const hinge = hingeStart ? P(o.t0, 0) : P(o.t1, 0);
          const side = (o.swingSide ?? 1) * (hingeStart ? 1 : 1);
          const len2 = o.t1 - o.t0;
          const tipX = hinge[0] + nx * len2 * side;
          const tipY = hinge[1] - ny * len2 * side;
          s += line(`${L}_OPENING`, hinge[0], hinge[1], tipX, tipY);
          const a0 = Math.atan2(tipY - hinge[1], tipX - hinge[0]);
          const strike = hingeStart ? P(o.t1, 0) : P(o.t0, 0);
          const a1 = Math.atan2(strike[1] - hinge[1], strike[0] - hinge[0]);
          let da = a1 - a0;
          while (da > Math.PI) da -= 2 * Math.PI;
          while (da < -Math.PI) da += 2 * Math.PI;
          let px = tipX;
          let py = tipY;
          for (let i = 1; i <= 12; i++) {
            const ang = a0 + (da * i) / 12;
            const qx = hinge[0] + Math.cos(ang) * len2;
            const qy = hinge[1] + Math.sin(ang) * len2;
            s += line(`${L}_OPENING`, px, py, qx, qy);
            px = qx;
            py = qy;
          }
        }
      }
    }
  }
  // 部屋名・帖数
  for (const r of f.rooms) {
    if (r.type === 'void') continue;
    const tat = r.labeledTatami ?? r.area / 1.62;
    s += text(`${L}_TEXT`, ox + r.labelPos.x, Y(r.labelPos.y) + 80, 250, r.name);
    s += text(`${L}_TEXT`, ox + r.labelPos.x, Y(r.labelPos.y) - 260, 180, `${tat.toFixed(1)}帖`);
  }
  // 建具記号
  for (const e of openingSchedule(f)) s += text(`${L}_TEXT`, ox + e.x, Y(e.y), 150, e.tag);
  // 階段
  for (const st of f.stairs) {
    const c = [
      [st.minX, st.minY],
      [st.maxX, st.minY],
      [st.maxX, st.maxY],
      [st.minX, st.maxY],
    ];
    for (let i = 0; i < 4; i++) {
      const a = c[i];
      const b = c[(i + 1) % 4];
      s += line(`${L}_STAIR`, ox + a[0], Y(a[1]), ox + b[0], Y(b[1]));
    }
  }
  // 外形
  for (const loop of f.outline)
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      s += line(`${L}_OUTLINE`, ox + a.x, Y(a.y), ox + b.x, Y(b.y));
    }
  // 階名
  const xs = f.walls.flatMap((w) => [w.a.x, w.b.x]);
  const ys = f.walls.flatMap((w) => [w.a.y, w.b.y]);
  if (xs.length) s += text(`${L}_TEXT`, ox + (Math.min(...xs) + Math.max(...xs)) / 2, Y(Math.max(...ys)) - 1200, 400, `${f.level}階平面図`);
  return s;
}

export function modelToDxf(model: BuildingModel): string {
  const layers: string[] = [];
  for (const f of model.floors) for (const k of ['WALL', 'OPENING', 'TEXT', 'STAIR', 'OUTLINE']) layers.push(`${f.level}F_${k}`);
  const colors: Record<string, number> = { WALL: 7, OPENING: 4, TEXT: 3, STAIR: 6, OUTLINE: 8 };
  let s = '';
  s += pair(0, 'SECTION') + pair(2, 'HEADER') + pair(9, '$ACADVER') + pair(1, 'AC1009') + pair(9, '$INSUNITS') + pair(70, 4) + pair(0, 'ENDSEC');
  s += pair(0, 'SECTION') + pair(2, 'TABLES') + pair(0, 'TABLE') + pair(2, 'LAYER') + pair(70, layers.length);
  for (const l of layers) s += pair(0, 'LAYER') + pair(2, l) + pair(70, 0) + pair(62, colors[l.split('_')[1]] ?? 7) + pair(6, 'CONTINUOUS');
  s += pair(0, 'ENDTAB') + pair(0, 'ENDSEC');
  s += pair(0, 'SECTION') + pair(2, 'ENTITIES');
  let ox = 0;
  for (const f of model.floors) {
    s += floorEntities(f, ox);
    const xs = f.walls.flatMap((w) => [w.a.x, w.b.x]).concat(f.outline.flat().map((p) => p.x));
    const w = xs.length ? Math.max(...xs) - Math.min(...xs) : 10000;
    ox += w + 6000;
  }
  s += pair(0, 'ENDSEC') + pair(0, 'EOF');
  return s;
}
