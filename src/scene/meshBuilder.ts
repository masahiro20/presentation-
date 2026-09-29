/**
 * マテリアルキーごとに三角形を蓄積し、まとめて Mesh を作るビルダー。
 * UV はメートル単位（テクスチャ側で repeat = 1/tile）。
 */
import * as THREE from 'three';

type V3 = THREE.Vector3;

interface Bucket {
  pos: number[];
  nor: number[];
  uv: number[];
}

export class MeshBuilder {
  private buckets = new Map<string, Bucket>();

  private bucket(key: string): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { pos: [], nor: [], uv: [] };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** 三角形（反時計回りが表） */
  tri(key: string, a: V3, b: V3, c: V3, uAxis: V3, vAxis: V3, normal?: V3) {
    const n = normal ?? new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const bk = this.bucket(key);
    for (const p of [a, b, c]) {
      bk.pos.push(p.x, p.y, p.z);
      bk.nor.push(n.x, n.y, n.z);
      bk.uv.push(p.dot(uAxis), p.dot(vAxis));
    }
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
    const k = typeof keys === 'string' ? [keys, keys, keys, keys, keys, keys] : keys;
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
    // +n 面
    if (k[0]) this.quad(k[0], c[3], c[2], c[6], c[7], u, up);
    // -n 面
    if (k[1]) this.quad(k[1], c[1], c[0], c[4], c[5], u, up);
    // 上
    if (k[2]) this.quad(k[2], c[4], c[7], c[6], c[5]);
    // 下
    if (k[3]) this.quad(k[3], c[0], c[1], c[2], c[3]);
    // 始端
    if (k[4]) this.quad(k[4], c[0], c[3], c[7], c[4], n, up);
    // 終端
    if (k[5]) this.quad(k[5], c[2], c[1], c[5], c[6], n, up);
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
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const p0 = new THREE.Vector3(base.x + Math.cos(a0) * radius, base.y, base.z + Math.sin(a0) * radius);
      const p1 = new THREE.Vector3(base.x + Math.cos(a1) * radius, base.y, base.z + Math.sin(a1) * radius);
      const p2 = p1.clone().setY(base.y + height);
      const p3 = p0.clone().setY(base.y + height);
      const bk = this.bucket(key);
      const n0 = new THREE.Vector3(Math.cos(a0), 0, Math.sin(a0));
      const n1 = new THREE.Vector3(Math.cos(a1), 0, Math.sin(a1));
      const push = (p: V3, n: V3, uu: number, vv: number) => {
        bk.pos.push(p.x, p.y, p.z);
        bk.nor.push(n.x, n.y, n.z);
        bk.uv.push(uu, vv);
      };
      const u0 = a0 * radius;
      const u1 = a1 * radius;
      push(p0, n0, u0, base.y);
      push(p3, n0, u0, base.y + height);
      push(p2, n1, u1, base.y + height);
      push(p0, n0, u0, base.y);
      push(p2, n1, u1, base.y + height);
      push(p1, n1, u1, base.y);
      if (caps) {
        const ct = base.clone().setY(base.y + height);
        this.tri(key, ct, p2, p3, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), up);
        const cb = base.clone();
        this.tri(key, cb, p0, p1, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), up.clone().negate());
      }
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
        const bk = this.bucket(key);
        for (const p of [a, b, cc, a, cc, d]) {
          const n = p.clone().sub(c).normalize();
          bk.pos.push(p.x, p.y, p.z);
          bk.nor.push(n.x, n.y, n.z);
          bk.uv.push(p.dot(ua), p.dot(va));
        }
      }
  }

  isEmpty() {
    return this.buckets.size === 0;
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
      g.add(m);
    }
    return g;
  }
}

function autoAxes(n: V3): [V3, V3] {
  if (Math.abs(n.y) > 0.7) return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)];
  const u = new THREE.Vector3(-n.z, 0, n.x).normalize();
  return [u, new THREE.Vector3(0, 1, 0)];
}

export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
