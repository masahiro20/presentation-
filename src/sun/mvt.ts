/**
 * 最小限の Mapbox Vector Tile (protobuf) デコーダー
 * 国土地理院ベクトルタイル（建物 BldA など）の読み込みに使用
 */

class Pbf {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}
  get end() {
    return this.buf.length;
  }
  varint(): number {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.buf[this.pos++];
      if (shift < 28) result |= (b & 0x7f) << shift;
      else result += (b & 0x7f) * Math.pow(2, shift);
      shift += 7;
    } while (b >= 0x80);
    return result >>> 0 === result ? result : result;
  }
  sint() {
    const v = this.varint();
    return v % 2 === 1 ? (v + 1) / -2 : v / 2;
  }
  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  string(): string {
    return new TextDecoder().decode(this.bytes());
  }
  double() {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return v;
  }
  float() {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error('unknown wire type ' + wire);
  }
  packed(): number[] {
    const len = this.varint();
    const end = this.pos + len;
    const out: number[] = [];
    while (this.pos < end) out.push(this.varint());
    return out;
  }
}

export interface MvtFeature {
  type: number; // 1 point, 2 line, 3 polygon
  props: Record<string, string | number | boolean>;
  /** タイル座標 (0..extent) のリング */
  rings: [number, number][][];
}

export interface MvtLayer {
  name: string;
  extent: number;
  features: MvtFeature[];
}

export function decodeMvt(data: Uint8Array): Record<string, MvtLayer> {
  const p = new Pbf(data);
  const layers: Record<string, MvtLayer> = {};
  while (p.pos < p.end) {
    const tag = p.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 3 && wire === 2) {
      const l = decodeLayer(new Pbf(p.bytes()));
      layers[l.name] = l;
    } else p.skip(wire);
  }
  return layers;
}

function decodeLayer(p: Pbf): MvtLayer {
  let name = '';
  let extent = 4096;
  const keys: string[] = [];
  const values: (string | number | boolean)[] = [];
  const raw: { type: number; tags: number[]; geom: number[] }[] = [];
  while (p.pos < p.end) {
    const tag = p.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1) name = p.string();
    else if (field === 2) {
      const fp = new Pbf(p.bytes());
      const f = { type: 0, tags: [] as number[], geom: [] as number[] };
      while (fp.pos < fp.end) {
        const t = fp.varint();
        const fld = t >> 3;
        const w = t & 7;
        if (fld === 2) f.tags = fp.packed();
        else if (fld === 3) f.type = fp.varint();
        else if (fld === 4) f.geom = fp.packed();
        else fp.skip(w);
      }
      raw.push(f);
    } else if (field === 3) keys.push(p.string());
    else if (field === 4) {
      const vp = new Pbf(p.bytes());
      let val: string | number | boolean = '';
      while (vp.pos < vp.end) {
        const t = vp.varint();
        const fld = t >> 3;
        const w = t & 7;
        if (fld === 1) val = vp.string();
        else if (fld === 2) val = vp.float();
        else if (fld === 3) val = vp.double();
        else if (fld === 4 || fld === 5) val = vp.varint();
        else if (fld === 6) val = vp.sint();
        else if (fld === 7) val = !!vp.varint();
        else vp.skip(w);
      }
      values.push(val);
    } else if (field === 5) extent = p.varint();
    else p.skip(wire);
  }
  const features: MvtFeature[] = raw.map((f) => {
    const props: Record<string, string | number | boolean> = {};
    for (let i = 0; i + 1 < f.tags.length; i += 2) props[keys[f.tags[i]]] = values[f.tags[i + 1]];
    return { type: f.type, props, rings: decodeGeom(f.geom) };
  });
  return { name, extent, features };
}

function decodeGeom(g: number[]): [number, number][][] {
  const rings: [number, number][][] = [];
  let x = 0;
  let y = 0;
  let i = 0;
  let cur: [number, number][] = [];
  while (i < g.length) {
    const cmdInt = g[i++];
    const cmd = cmdInt & 7;
    const count = cmdInt >> 3;
    if (cmd === 1 || cmd === 2) {
      for (let k = 0; k < count; k++) {
        const dx = g[i++];
        const dy = g[i++];
        x += (dx >> 1) ^ -(dx & 1);
        y += (dy >> 1) ^ -(dy & 1);
        if (cmd === 1) {
          if (cur.length) rings.push(cur);
          cur = [];
        }
        cur.push([x, y]);
      }
    } else if (cmd === 7) {
      if (cur.length) rings.push(cur);
      cur = [];
    }
  }
  if (cur.length) rings.push(cur);
  return rings;
}
