/**
 * マテリアルキーごとに三角形を蓄積し、まとめて Mesh を作るビルダー。
 * UV はメートル単位（テクスチャ側で repeat = 1/tile）。
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

type V3 = THREE.Vector3;

interface Bucket {
  pos: number[];
  nor: number[];
  uv: number[];
}

/**
 * 切断面（模型・断面用）: p·n − d > 0 の側（n の向き）を取り除く。
 * 直方体・円柱は切り口を capKey の仕上げで閉じ、その他の三角形は平面で切る
 */
export interface ClipPlane {
  n: V3;
  d: number;
  capKey: string;
}

/** 水平に切る（この高さより上を取り除く） */
export function topClip(y: number, capKey = 'cut.face'): ClipPlane {
  return { n: new THREE.Vector3(0, 1, 0), d: y, capKey };
}

/** 鉛直の面で切る（n = (nx, 0, nz) の向きの側を取り除く。d = 面上の点·n） */
export function verticalClip(nx: number, nz: number, d: number, capKey = 'cut.face'): ClipPlane {
  const l = Math.hypot(nx, nz) || 1;
  return { n: new THREE.Vector3(nx / l, 0, nz / l), d, capKey };
}

const BOX_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

export class MeshBuilder {
  private buckets = new Map<string, Bucket>();
  /** 切断面（null = 切らない） */
  clip: ClipPlane | null = null;

  /** 切断面からの符号付き距離（正 = 取り除く側） */
  private cf(p: V3) {
    return p.dot(this.clip!.n) - this.clip!.d;
  }

  private pushTri(key: string, pts: V3[], n: V3, uAxis: V3, vAxis: V3) {
    const bk = this.bucket(key);
    for (const p of pts) {
      bk.pos.push(p.x, p.y, p.z);
      bk.nor.push(n.x, n.y, n.z);
      bk.uv.push(p.dot(uAxis), p.dot(vAxis));
    }
  }

  /** 多角形を切断面で切って、残った部分を押し込む */
  private pushClipped(key: string, pts: V3[], n: V3, uAxis: V3, vAxis: V3) {
    const out: V3[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const fa = this.cf(a);
      const fb = this.cf(b);
      const ia = fa <= 1e-6;
      const ib = fb <= 1e-6;
      if (ia) out.push(a);
      if (ia !== ib) out.push(a.clone().lerp(b, fa / (fa - fb)));
    }
    if (out.length < 3) return;
    for (let i = 1; i + 1 < out.length; i++) this.pushTri(key, [out[0], out[i], out[i + 1]], n, uAxis, vAxis);
  }

  /** 凸な立体（頂点と辺）の切り口を多角形で閉じる */
  private capPolygon(corners: V3[], edges: [number, number][]) {
    const clip = this.clip!;
    const fs = corners.map((c) => this.cf(c));
    const pts: V3[] = [];
    for (const [i, j] of edges) {
      const fi = fs[i];
      const fj = fs[j];
      if ((fi < 0 && fj > 0) || (fi > 0 && fj < 0)) pts.push(corners[i].clone().lerp(corners[j], fi / (fi - fj)));
    }
    if (pts.length < 3) return;
    const n = clip.n;
    const a = new THREE.Vector3().crossVectors(n, Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const b = new THREE.Vector3().crossVectors(n, a).normalize();
    const cen = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    const ang = (p: V3) => {
      const r = p.clone().sub(cen);
      return Math.atan2(r.dot(b), r.dot(a));
    };
    pts.sort((p, q) => ang(p) - ang(q));
    for (let i = 1; i + 1 < pts.length; i++) this.pushTri(clip.capKey, [pts[0], pts[i], pts[i + 1]], n, a, b);
  }

  /** 材料キーの差し替え（家具ごとの素材: 'f.wood' → 'f.wood@dark' など）。null で差し替え無し */
  keyMap: Record<string, string> | null = null;

  private bucket(key: string): Bucket {
    const k = this.keyMap?.[key] ?? key;
    let b = this.buckets.get(k);
    if (!b) {
      b = { pos: [], nor: [], uv: [] };
      this.buckets.set(k, b);
    }
    return b;
  }

  /** 三角形（反時計回りが表） */
  tri(key: string, a: V3, b: V3, c: V3, uAxis: V3, vAxis: V3, normal?: V3) {
    const n = normal ?? new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    if (this.clip) {
      const fa = this.cf(a);
      const fb = this.cf(b);
      const fc = this.cf(c);
      if (Math.min(fa, fb, fc) >= -1e-6) return;
      if (Math.max(fa, fb, fc) > 1e-6) {
        this.pushClipped(key, [a, b, c], n, uAxis, vAxis);
        return;
      }
    }
    this.pushTri(key, [a, b, c], n, uAxis, vAxis);
  }

  /** 四角形 p0→p1→p2→p3（反時計回りが表） */
  quad(key: string, p0: V3, p1: V3, p2: V3, p3: V3, uAxis?: V3, vAxis?: V3) {
    const n = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0)).normalize();
    if (n.lengthSq() < 0.5) {
      n.subVectors(p2, p1).cross(new THREE.Vector3().subVectors(p3, p1)).normalize();
    }
    const [u, v] = uAxis && vAxis ? [uAxis, vAxis] : autoAxes(n);
    this.tri(key, p0, p1, p2, u, v, n);
    this.tri(key, p0, p2, p3, u, v, n);
  }

  /**
   * 頂点ごとに法線を持つ四角形（曲面の帯: R 壁など）。p[0]→p[1]→p[2]→p[3] は表から見て反時計回り。uv は頂点ごと（m）。
   * 切断面にかかるときだけ、平均の法線の平らな面として切る
   */
  quadN(key: string, p: [V3, V3, V3, V3], n: [V3, V3, V3, V3], uv: [number, number][]) {
    if (this.clip) {
      const fs = p.map((q) => this.cf(q));
      if (Math.min(...fs) >= -1e-6) return;
      if (Math.max(...fs) > 1e-6) {
        const nm = n[0].clone().add(n[1]).add(n[2]).add(n[3]).normalize();
        const [u, v] = autoAxes(nm);
        this.pushClipped(key, [p[0], p[1], p[2]], nm, u, v);
        this.pushClipped(key, [p[0], p[2], p[3]], nm, u, v);
        return;
      }
    }
    const bk = this.bucket(key);
    for (const i of [0, 1, 2, 0, 2, 3]) {
      bk.pos.push(p[i].x, p[i].y, p[i].z);
      bk.nor.push(n[i].x, n[i].y, n[i].z);
      bk.uv.push(uv[i][0], uv[i][1]);
    }
  }

  /** 平面多角形（穴なし・凸/凹どちらも可）。pts は表から見て反時計回り */
  polygon(key: string, pts: V3[], normal: V3, uAxis?: V3, vAxis?: V3, holes: V3[][] = []) {
    const [u, v] = uAxis && vAxis ? [uAxis, vAxis] : autoAxes(normal);
    // 2D に投影して三角形分割
    const a = new THREE.Vector3().crossVectors(normal, Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const b = new THREE.Vector3().crossVectors(normal, a).normalize();
    const to2 = (p: V3) => new THREE.Vector2(p.dot(a), p.dot(b));
    const contour = pts.map(to2);
    const hs = holes.map((h) => h.map(to2));
    const tris = THREE.ShapeUtils.triangulateShape(contour, hs);
    const all = pts.concat(...holes);
    for (const [i, j, k] of tris) {
      const p = all[i];
      const q = all[j];
      const r = all[k];
      const n = new THREE.Vector3().subVectors(q, p).cross(new THREE.Vector3().subVectors(r, p));
      if (n.dot(normal) < 0) this.tri(key, p, r, q, u, v, normal);
      else this.tri(key, p, q, r, u, v, normal);
    }
  }

  /**
   * 向き付きの直方体。center は底面中心、dir は長手方向（水平）、size = [長さ, 高さ, 奥行]
   * faceKeys: [+n側, -n側, 上, 下, 始端, 終端]
   */
  box(keys: string | (string | null)[], base: V3, dir: V3, len: number, height: number, depth: number) {
    const k = typeof keys === 'string' ? [keys, keys, keys, keys, keys, keys] : [...keys];
    const u = dir.clone().setY(0).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const n = new THREE.Vector3().crossVectors(u, up).normalize(); // 右手側
    const hl = len / 2;
    const hd = depth / 2;
    const P = (s: number, h: number, t: number) =>
      base.clone().addScaledVector(u, s).addScaledVector(up, h).addScaledVector(n, t);
    const c = [
      P(-hl, 0, -hd),
      P(hl, 0, -hd),
      P(hl, 0, hd),
      P(-hl, 0, hd),
      P(-hl, height, -hd),
      P(hl, height, -hd),
      P(hl, height, hd),
      P(-hl, height, hd),
    ];
    let straddles = false;
    if (this.clip) {
      // 全部が取り除く側なら作らない。切断面をまたぐなら各面を切り、切り口を閉じる
      const fs = c.map((p) => this.cf(p));
      if (Math.min(...fs) >= -1e-6) return;
      straddles = Math.max(...fs) > 1e-6;
    }
    // 木の部材（家具・造作・踏板）は、面ごとに長い辺の向きを u にして、木目を部材の長さの向きに流す
    const grain = (key: string, a: V3, la: number, b: V3, lb: number): [V3, V3] | null => (GRAIN_KEY.test(key) ? (la >= lb ? [a, b] : [b, a]) : null);
    const side = (key: string): [V3, V3] => grain(key, u, len, up, height) ?? [u, up];
    const flat = (key: string): [V3 | undefined, V3 | undefined] => grain(key, u, len, n, depth) ?? [undefined, undefined];
    const end = (key: string): [V3, V3] => grain(key, n, depth, up, height) ?? [n, up];
    // +n 面
    if (k[0]) this.quad(k[0], c[3], c[2], c[6], c[7], ...side(k[0]));
    // -n 面
    if (k[1]) this.quad(k[1], c[1], c[0], c[4], c[5], ...side(k[1]));
    // 上
    if (k[2]) this.quad(k[2], c[4], c[7], c[6], c[5], ...flat(k[2]));
    // 下
    if (k[3]) this.quad(k[3], c[0], c[1], c[2], c[3], ...flat(k[3]));
    // 始端
    if (k[4]) this.quad(k[4], c[0], c[3], c[7], c[4], ...end(k[4]));
    // 終端
    if (k[5]) this.quad(k[5], c[2], c[1], c[5], c[6], ...end(k[5]));
    if (straddles) this.capPolygon(c, BOX_EDGES);
  }

  /** 軸平行の直方体（min/max 指定） */
  aabb(key: string, min: V3, max: V3) {
    const len = max.x - min.x;
    const depth = max.z - min.z;
    const base = new THREE.Vector3((min.x + max.x) / 2, min.y, (min.z + max.z) / 2);
    this.box(key, base, new THREE.Vector3(1, 0, 0), len, max.y - min.y, depth);
  }

  /** 円柱（側面＋上下） */
  cylinder(key: string, base: V3, radius: number, height: number, seg = 16, caps = true) {
    const up = new THREE.Vector3(0, 1, 0);
    const ring = (y: number) => Array.from({ length: seg }, (_, i) => {
      const a = (i / seg) * Math.PI * 2;
      return new THREE.Vector3(base.x + Math.cos(a) * radius, y, base.z + Math.sin(a) * radius);
    });
    const bot = ring(base.y);
    const top = ring(base.y + height);
    let straddles = false;
    if (this.clip) {
      const fs = [...bot, ...top].map((p) => this.cf(p));
      if (Math.min(...fs) >= -1e-6) return;
      straddles = Math.max(...fs) > 1e-6;
    }
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const n0 = new THREE.Vector3(Math.cos(a0), 0, Math.sin(a0));
      const n1 = new THREE.Vector3(Math.cos(a1), 0, Math.sin(a1));
      const u0 = a0 * radius;
      const u1 = a1 * radius;
      // 木の丸棒（脚・1 本脚）は、木目を軸の向きに流す（u = 高さ、v = 周）。それ以外は壁と同じ（u = 周、v = 高さ）
      const axial = GRAIN_KEY.test(key);
      const p0 = bot[i];
      const p1 = bot[j];
      const p2 = top[j];
      const p3 = top[i];
      // 側面（法線は頂点ごとに違うので、切る時だけ平均法線で妥協する）
      if (this.clip && straddles) {
        const nm = n0.clone().add(n1).normalize();
        this.pushClipped(key, [p0, p3, p2], nm, new THREE.Vector3(1, 0, 0), up);
        this.pushClipped(key, [p0, p2, p1], nm, new THREE.Vector3(1, 0, 0), up);
      } else {
        const bk = this.bucket(key);
        const push = (p: V3, n: V3, uu: number, vv: number) => {
          bk.pos.push(p.x, p.y, p.z);
          bk.nor.push(n.x, n.y, n.z);
          bk.uv.push(uu, vv);
        };
        const uv = (uu: number, vv: number): [number, number] => (axial ? [vv, uu] : [uu, vv]);
        push(p0, n0, ...uv(u0, base.y));
        push(p3, n0, ...uv(u0, base.y + height));
        push(p2, n1, ...uv(u1, base.y + height));
        push(p0, n0, ...uv(u0, base.y));
        push(p2, n1, ...uv(u1, base.y + height));
        push(p1, n1, ...uv(u1, base.y));
      }
      if (caps) {
        const ct = base.clone().setY(base.y + height);
        this.tri(key, ct, p2, p3, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), up);
        const cb = base.clone();
        this.tri(key, cb, p0, p1, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), up.clone().negate());
      }
    }
    if (straddles) {
      const edges: [number, number][] = [];
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        edges.push([i, j], [seg + i, seg + j], [i, seg + i]);
      }
      this.capPolygon([...bot, ...top], edges);
    }
  }

  /** 低ポリゴンの球（植栽・照明用） */
  sphere(key: string, c: V3, r: number, seg = 10, sy = 1) {
    const rings = Math.max(4, Math.floor(seg / 2));
    const pt = (i: number, j: number) => {
      const th = (j / rings) * Math.PI;
      const ph = (i / seg) * Math.PI * 2;
      return new THREE.Vector3(c.x + r * Math.sin(th) * Math.cos(ph), c.y + r * sy * Math.cos(th), c.z + r * Math.sin(th) * Math.sin(ph));
    };
    const ua = new THREE.Vector3(1, 0, 0);
    const va = new THREE.Vector3(0, 1, 0);
    for (let j = 0; j < rings; j++)
      for (let i = 0; i < seg; i++) {
        const a = pt(i, j);
        const b = pt(i + 1, j);
        const cc = pt(i + 1, j + 1);
        const d = pt(i, j + 1);
        if (this.clip) {
          const fs = [a, b, cc, d].map((p) => this.cf(p));
          if (Math.min(...fs) >= -1e-6) continue;
          if (Math.max(...fs) > 1e-6) {
            const n = a.clone().add(cc).multiplyScalar(0.5).sub(c).normalize();
            this.pushClipped(key, [a, b, cc], n, ua, va);
            this.pushClipped(key, [a, cc, d], n, ua, va);
            continue;
          }
        }
        const bk = this.bucket(key);
        for (const p of [a, b, cc, a, cc, d]) {
          const n = p.clone().sub(c).normalize();
          bk.pos.push(p.x, p.y, p.z);
          bk.nor.push(n.x, n.y, n.z);
          bk.uv.push(p.dot(ua), p.dot(va));
        }
      }
  }

  /** 任意のジオメトリを変換して追加（UV はメートル単位で再計算） */
  addGeometry(key: string, geo: THREE.BufferGeometry, matrix: THREE.Matrix4, keepUV = false) {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(matrix);
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uvA = g.getAttribute('uv');
    const bk = this.bucket(key);
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    if (this.clip) {
      // 三角形ごとに切断面で切る（UV は三平面投影）
      const tri: V3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      for (let i = 0; i + 2 < pos.count; i += 3) {
        for (let k = 0; k < 3; k++) tri[k].fromBufferAttribute(pos, i + k);
        const fs = tri.map((t) => this.cf(t));
        if (Math.min(...fs) >= -1e-6) continue;
        n.fromBufferAttribute(nor, i);
        const ax = Math.abs(n.x);
        const ay = Math.abs(n.y);
        const az = Math.abs(n.z);
        const [ua, va] = ay >= ax && ay >= az ? [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)] : ax >= az ? [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)] : [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
        if (Math.max(...fs) > 1e-6) {
          this.pushClipped(key, tri.map((t) => t.clone()), n.clone(), ua, va);
          continue;
        }
        for (const t of tri) {
          bk.pos.push(t.x, t.y, t.z);
          bk.nor.push(n.x, n.y, n.z);
          bk.uv.push(t.dot(ua), t.dot(va));
        }
      }
      g.dispose();
      return;
    }
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      n.fromBufferAttribute(nor, i);
      bk.pos.push(p.x, p.y, p.z);
      bk.nor.push(n.x, n.y, n.z);
      if (keepUV && uvA) {
        bk.uv.push(uvA.getX(i), uvA.getY(i));
        continue;
      }
      // 三平面投影の UV
      const ax = Math.abs(n.x);
      const ay = Math.abs(n.y);
      const az = Math.abs(n.z);
      if (ay >= ax && ay >= az) bk.uv.push(p.x, p.z);
      else if (ax >= az) bk.uv.push(p.z, p.y);
      else bk.uv.push(p.x, p.y);
    }
    g.dispose();
  }

  /** 角の丸い直方体（box と同じ向き・基準: base は底面中心） */
  roundedBox(key: string, base: V3, dir: V3, len: number, height: number, depth: number, radius: number, segments = 3) {
    const r = Math.min(radius, len / 2 - 0.001, height / 2 - 0.001, depth / 2 - 0.001);
    if (r <= 0.002) return this.box(key, base, dir, len, height, depth);
    const geo = new RoundedBoxGeometry(len, height, depth, segments, r);
    const u = dir.clone().setY(0).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const n = new THREE.Vector3().crossVectors(u, up).normalize();
    const m = new THREE.Matrix4().makeBasis(u, up, n);
    m.setPosition(base.clone().addScaledVector(up, height / 2));
    // UV: 面ごとに、その面の長い辺の向きを u にする（木目は部材の長さの向きに流れる。板脚・柱は縦、天板・框は長手）。
    // 以前は世界の軸に合わせた投影で、斜めに置いた食卓の木目が天板を斜めに横切っていた
    if (this.clip) {
      this.addGeometry(key, geo, m);
      geo.dispose();
      return;
    }
    const g = geo.toNonIndexed().applyMatrix4(m);
    geo.dispose();
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const bk = this.bucket(key);
    const p = new THREE.Vector3();
    const nn = new THREE.Vector3();
    const axes: [V3, number][] = [[u, len], [up, height], [n, depth]];
    for (let i = 0; i < pos.count; i += 3) {
      // 三角形の面の向き（3 頂点の法線の平均）で、どの面かを決める（角の丸みの途中で UV が飛ばないよう、三角形ごとに）
      nn.set(0, 0, 0);
      for (let k = 0; k < 3; k++) nn.add(p.fromBufferAttribute(nor, i + k));
      const d = axes.map(([a]) => Math.abs(nn.dot(a)));
      const face = d[0] >= d[1] && d[0] >= d[2] ? 0 : d[1] >= d[2] ? 1 : 2;
      const [pa, qa] = axes.filter((_, k) => k !== face);
      const [ua, va] = pa[1] >= qa[1] ? [pa[0], qa[0]] : [qa[0], pa[0]];
      for (let k = 0; k < 3; k++) {
        p.fromBufferAttribute(pos, i + k);
        bk.pos.push(p.x, p.y, p.z);
        bk.uv.push(p.dot(ua), p.dot(va));
        nn.fromBufferAttribute(nor, i + k);
        bk.nor.push(nn.x, nn.y, nn.z);
      }
    }
    g.dispose();
  }

  /**
   * ふくらみのあるクッション（ソファの座・背、置きクッション）。
   * 角の丸い直方体の各面を、中央がふくらむ形に押し出す（箱を並べただけのソファは、角が立って「CG の箱」に見える）。
   * 形は中心を原点に作る: x = 幅 w、y = 厚み t、z = 奥行 d。向きと位置は m（立てる・もたせ掛けるのも m で）。
   * 面どうしで頂点を共有し、法線はなめらかにつなぐ
   */
  cushion(key: string, m: THREE.Matrix4, w: number, t: number, d: number, o: CushionShape = {}) {
    const { pos, index } = cushionMesh(w, t, d, o);
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.length; i += 3) {
      p.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(m);
      pos[i] = p.x;
      pos[i + 1] = p.y;
      pos[i + 2] = p.z;
    }
    // 向き（鏡映の入る座標系でも、外から見て反時計回りに）: 三角形の向きを、中心から外へ向くようにそろえる
    const c = new THREE.Vector3().setFromMatrixPosition(m);
    const A = new THREE.Vector3();
    const B = new THREE.Vector3();
    const C = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i < index.length; i += 3) {
      A.fromArray(pos, index[i] * 3);
      B.fromArray(pos, index[i + 1] * 3);
      C.fromArray(pos, index[i + 2] * 3);
      n.crossVectors(B.clone().sub(A), C.clone().sub(A));
      if (n.dot(A.clone().add(B).add(C).multiplyScalar(1 / 3).sub(c)) < 0) {
        const k = index[i + 1];
        index[i + 1] = index[i + 2];
        index[i + 2] = k;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    this.addGeometry(key, geo, new THREE.Matrix4());
    geo.dispose();
  }

  /**
   * 掛け布（ブランケット）: 断面の折れ線 path（掛ける物の上をなぞる）に沿った、幅 width の薄い布。
   * 幅の向きに小さなうねり（たたみじわ）を付け、垂れた先ほど大きくする。両面を描く素材で使う
   */
  drape(key: string, path: V3[], widthDir: V3, width: number, o: { ripple?: number; skew?: number; seg?: number } = {}) {
    if (path.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(path, false, 'centripetal');
    const N = Math.max(8, Math.ceil(curve.getLength() / 0.035));
    const M = o.seg ?? 12;
    const ripple = o.ripple ?? 0.006;
    const wd = widthDir.clone().normalize();
    const pos: number[] = [];
    const index: number[] = [];
    const P = new THREE.Vector3();
    const T = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      const s = i / N;
      curve.getPointAt(s, P);
      curve.getTangentAt(s, T);
      nrm.crossVectors(wd, T).normalize();
      for (let j = 0; j <= M; j++) {
        const a = j / M - 0.5;
        // うねり: 幅の向きに 2 山半。垂れた先（s → 1）ほど深く、端は少しすぼまる
        const wave = Math.sin(a * Math.PI * 5 + s * 2.2) * ripple * (0.35 + 1.5 * s * s);
        const narrow = 1 - 0.07 * s * s;
        const q = P.clone()
          .addScaledVector(wd, a * width * narrow)
          .addScaledVector(nrm, wave)
          .addScaledVector(T, (o.skew ?? 0) * a * s);
        pos.push(q.x, q.y, q.z);
      }
    }
    for (let i = 0; i < N; i++)
      for (let j = 0; j < M; j++) {
        const a = i * (M + 1) + j;
        const b = a + 1;
        const c = a + M + 1;
        const d2 = c + 1;
        index.push(a, c, b, b, c, d2);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    this.addGeometry(key, geo, new THREE.Matrix4());
    geo.dispose();
  }

  /** 2点間の円柱（幹・枝・家具の丸棒） */
  tube(key: string, a: V3, b: V3, r0: number, r1 = r0, seg = 7) {
    const len = a.distanceTo(b);
    if (len < 1e-4) return;
    const geo = new THREE.CylinderGeometry(r1, r0, len, seg, 1, true);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    // 木の丸棒は、木目を軸の向きに流す（u = 長さ、v = 周）
    const axial = GRAIN_KEY.test(key) && !this.clip;
    if (axial) {
      const uv = geo.getAttribute('uv');
      const rm = (r0 + r1) / 2;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i) * len + a.x + a.z, uv.getX(i) * 2 * Math.PI * rm);
    }
    this.addGeometry(key, geo, m, axial);
    geo.dispose();
  }

  /**
   * 折れ線 pts をなめらかにつないだ丸棒（曲げ木の笠木・肘、丸い手すり）。短い円柱をつなぐと継ぎ目に節が見えるので、
   * 点を通る曲線に沿って 1 本の管として作る。両端は丸く閉じる。UV は u = 長さの向き、v = 周
   */
  tubePath(key: string, pts: V3[], r: number, seg = 8) {
    if (pts.length < 2) return;
    if (pts.length === 2) {
      this.tube(key, pts[0], pts[1], r, r, seg);
    } else {
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      const len = curve.getLength();
      const geo = new THREE.TubeGeometry(curve, Math.max(pts.length * 2, Math.ceil(len / 0.035)), r, seg, false);
      const uv = geo.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len + pts[0].x + pts[0].z, uv.getY(i) * 2 * Math.PI * r);
      this.addGeometry(key, geo, new THREE.Matrix4(), !this.clip);
      geo.dispose();
    }
    this.sphere(key, pts[0], r, 6);
    this.sphere(key, pts[pts.length - 1], r, 6);
  }

  /**
   * 光の面（間接照明が壁・床を照らす光。素材 f.coveGlow を加算で重ねる）:
   * 中心 c、幅の向き along（長さ w）、光源へ向かう向き toLight（長さ h）。UV の v = 0（光源から遠い側）→ 1（光源の側）。
   * uv を渡すと、絵のその範囲だけを貼る
   */
  glowPlane(key: string, c: V3, along: V3, toLight: V3, w: number, h: number, uv?: [number, number, number, number]) {
    if (w < 0.05 || h < 0.02) return;
    const x = along.clone().normalize();
    const y = toLight.clone().normalize();
    const z = new THREE.Vector3().crossVectors(x, y).normalize();
    const geo = new THREE.PlaneGeometry(w, h);
    if (uv) {
      // 絵の一部だけを貼る（[u0, v0, u1, v1]。壁の端・床で切れる光の面）
      const a = geo.getAttribute('uv');
      for (let i = 0; i < a.count; i++) a.setXY(i, uv[0] + (uv[2] - uv[0]) * a.getX(i), uv[1] + (uv[3] - uv[1]) * a.getY(i));
    }
    const m = new THREE.Matrix4().makeBasis(x, y, z);
    m.setPosition(c);
    this.addGeometry(key, geo, m, true);
    geo.dispose();
  }

  /** 葉のカード（アルファ付きテクスチャを貼る両面の板） */
  card(key: string, c: V3, size: number, rot: THREE.Euler) {
    const geo = new THREE.PlaneGeometry(size, size);
    const m = new THREE.Matrix4().compose(c, new THREE.Quaternion().setFromEuler(rot), new THREE.Vector3(1, 1, 1));
    this.addGeometry(key, geo, m, true);
    geo.dispose();
  }

  isEmpty() {
    return this.buckets.size === 0;
  }

  /** 今の頂点数の印（restore で、この後に足した形を取り消す） */
  mark(): Map<string, number> {
    const m = new Map<string, number>();
    for (const [k, b] of this.buckets) m.set(k, b.pos.length);
    return m;
  }

  restore(m: Map<string, number>) {
    for (const [k, b] of this.buckets) {
      const n = m.get(k);
      if (n == null) {
        this.buckets.delete(k);
        continue;
      }
      b.pos.length = n;
      b.nor.length = n;
      b.uv.length = (n / 3) * 2;
    }
  }

  /** Mesh 群を生成。マテリアルはキーから解決（userData.matKey に保存） */
  build(resolve: (key: string) => THREE.Material, opts: { castShadow?: boolean; receiveShadow?: boolean; name?: string } = {}): THREE.Group {
    const g = new THREE.Group();
    g.name = opts.name ?? 'built';
    for (const [key, b] of this.buckets) {
      if (!b.pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, resolve(key));
      m.name = key;
      m.userData.matKey = key;
      m.castShadow = opts.castShadow ?? true;
      m.receiveShadow = opts.receiveShadow ?? true;
      // 間接照明の光の帯（加算の薄い面）は物ではない: 影を落とさず、クリック・歩行の当たり判定にも掛からない
      if (key.startsWith('f.coveGlow')) {
        m.castShadow = false;
        m.receiveShadow = false;
        m.raycast = () => {};
        m.renderOrder = 2;
      }
      g.add(m);
    }
    return g;
  }
}

/**
 * 木目の向きを持つ素材（家具・造作の木、カウンター、収納の面材、踏板、窓の額縁・腰壁の笠木）。これらは面ごとに「長い辺の向き = u」で UV を作る
 * （戸・板張りの壁は、木目を縦に流す素材（MatSpec.grainV）を使うので含めない）
 */
const GRAIN_KEY = /^(f\.wood|f\.cabinet|f\.counter|int\.woodTrim|int\.stairs(?!Mass))/;

function autoAxes(n: V3): [V3, V3] {
  if (Math.abs(n.y) > 0.7) return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)];
  const u = new THREE.Vector3(-n.z, 0, n.x).normalize();
  return [u, new THREE.Vector3(0, 1, 0)];
}

export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * ダウンライトの光の形（スカラップ）の絵の範囲: 器具から壁までの距離 a を 1 として、横は ±u、下は z まで。
 * 絵（materials.ts）と光の面（building.ts）は、この比で大きさと UV を決める
 */
export const SCALLOP = { u: 2.2, z: 4.4 };

/** クッションの形（MeshBuilder.cushion） */
export interface CushionShape {
  /** 角の丸み (m)。既定 0.04 */
  r?: number;
  /** 上の面（+y）の中央のふくらみ (m) */
  crownTop?: number;
  /** 下の面（−y）のふくらみ (m)。既定 0 */
  crownBottom?: number;
  /** 側面のふくらみ (m) */
  crownSide?: number;
  /** 辺の中ほどのくびれ（置きクッション: 0.04〜0.08）。四隅が張って、辺が内へ入る */
  pinch?: number;
  /** 面の分割（幅・奥行の向き）。既定 6 */
  seg?: number;
}

/**
 * クッションの形を作る（中心が原点。x = 幅、y = 厚み、z = 奥行）。頂点は面どうしで共有する。
 * 角の丸みは、立方体の格子を「内側の箱 + 半径 r」へ射影して作る（丸みの所は 45° を 2 分割）。
 * ふくらみは、面の法線の向きへ (1 − s²)(1 − t²) で押し出す（縁で 0、中央で最大）
 */
export function cushionMesh(w: number, t: number, d: number, o: CushionShape = {}): { pos: number[]; index: number[] } {
  const hx = w / 2;
  const hy = t / 2;
  const hz = d / 2;
  const r = Math.max(0.003, Math.min(o.r ?? 0.04, hx - 0.002, hy - 0.002, hz - 0.002));
  const ARC = 2;
  const coords = (half: number, n: number) => {
    const inner = half - r;
    const out: number[] = [];
    for (let k = ARC; k >= 1; k--) out.push(-(inner + r * Math.tan(((k / ARC) * Math.PI) / 4)));
    for (let i = 0; i <= n; i++) out.push(-inner + (2 * inner * i) / n);
    for (let k = 1; k <= ARC; k++) out.push(inner + r * Math.tan(((k / ARC) * Math.PI) / 4));
    return out;
  };
  const seg = Math.max(2, o.seg ?? 6);
  const axes = [coords(hx, seg), coords(hy, 2), coords(hz, seg)];
  const half = [hx, hy, hz];
  const crownTop = o.crownTop ?? 0;
  const crownBottom = o.crownBottom ?? 0;
  const crownSide = o.crownSide ?? 0;
  const pinch = o.pinch ?? 0;
  const pos: number[] = [];
  const index: number[] = [];
  const ids = new Map<string, number>();
  const clamp = (v: number, a: number) => Math.max(-a, Math.min(a, v));
  const vert = (ix: number, iy: number, iz: number): number => {
    const key = `${ix},${iy},${iz}`;
    const got = ids.get(key);
    if (got != null) return got;
    const q = [axes[0][ix], axes[1][iy], axes[2][iz]];
    const inner = q.map((v, k) => clamp(v, half[k] - r));
    let n = q.map((v, k) => v - inner[k]);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map((v) => v / l);
    const p = inner.map((v, k) => v + n[k] * r);
    const sx = clamp(p[0] / hx, 1);
    const sy = clamp(p[1] / hy, 1);
    const sz = clamp(p[2] / hz, 1);
    const bx = 1 - sx * sx;
    const by = 1 - sy * sy;
    const bz = 1 - sz * sz;
    p[1] += (n[1] > 0 ? crownTop : crownBottom) * n[1] * bx * bz;
    p[0] += crownSide * n[0] * by * bz;
    p[2] += crownSide * n[2] * bx * by;
    if (pinch) {
      p[0] *= 1 - pinch * bz;
      p[2] *= 1 - pinch * bx;
    }
    const id = pos.length / 3;
    pos.push(p[0], p[1], p[2]);
    ids.set(key, id);
    return id;
  };
  // 6 面: 軸 a の両端の面を、残りの 2 軸の格子で張る
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3;
    const c = (a + 2) % 3;
    for (const end of [0, axes[a].length - 1]) {
      for (let i = 0; i < axes[b].length - 1; i++)
        for (let j = 0; j < axes[c].length - 1; j++) {
          const at = (ib: number, ic: number) => {
            const ix: number[] = [0, 0, 0];
            ix[a] = end;
            ix[b] = ib;
            ix[c] = ic;
            return vert(ix[0], ix[1], ix[2]);
          };
          const v00 = at(i, j);
          const v10 = at(i + 1, j);
          const v11 = at(i + 1, j + 1);
          const v01 = at(i, j + 1);
          index.push(v00, v10, v11, v00, v11, v01);
        }
    }
  }
  return { pos, index };
}
