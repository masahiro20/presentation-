/**
 * 周辺建物の屋根の色を、航空写真から拾う。
 *
 * 前は航空写真をそのまま屋根に貼っていた。真上からは実物らしいが、斜めから近くで見ると
 * 写真の粗さ（1 画素 約 0.5 m）がそのまま大きくぼけて見え、写真のずれで隣の道路や庭の色が屋根に乗っていた。
 * ここでは建物の足元の範囲（縁を除いた内側）の色の中央値を、その建物の屋根の色にする（青い瓦は青く、黒い屋根は黒く）。
 * 見た目だけの処理で、影・日照の計算には関わらない。
 */
export interface PixelGrid {
  data: Uint8ClampedArray | Uint8Array | number[];
  width: number;
  height: number;
}

/** 写真の範囲（建物の ring と同じ原点の東・北 m） */
export interface PhotoBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

type EN = { e: number; n: number };

function inside(p: EN, ring: EN[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.n > p.n !== b.n > p.n && p.e < ((b.e - a.e) * (p.n - a.n)) / (b.n - a.n) + a.e) c = !c;
  }
  return c;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * 屋根らしい色に整える: 写真の影（真っ黒）や日なたの白飛びをそのまま塗ると、こちらの太陽の光と二重になる。
 * 明るさを中ほどに寄せ、鮮やかすぎる色は少し抑える。色み（青・茶・緑）は残す。
 */
export function tidyRoofColor(r: number, g: number, b: number): string {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  let l = (max + min) / 2;
  const d = max - min;
  // 鮮やかさは、整えた後の明るさで測り直す（白飛び・真っ黒のわずかな色みを、濃い色に膨らませない）
  const lc = Math.min(0.62, Math.max(0.2, l));
  let s = d === 0 ? 0 : Math.min(1, d / (1 - Math.abs(2 * lc - 1)));
  let h = 0;
  if (d !== 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  l = lc;
  s = Math.min(0.42, s * 0.85);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  // 4 ビットずつに丸める（似た色の屋根は同じ素材を使い回す）
  const q = (v: number) => Math.round(Math.min(1, Math.max(0, v + m)) * 15) * 17;
  return `#${[r1, g1, b1].map((v) => q(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 建物の足元の輪郭（ring）の内側の、写真の色の中央値。写真の外・小さすぎる建物は null（決まった色のばらつきに任せる）。
 * 縁の 3 割は見ない（写真の建物の倒れ込み・位置のずれで、隣の地面の色が入るため）。
 */
export function sampleRoofColor(px: PixelGrid, bounds: PhotoBounds, ring: EN[]): string | null {
  if (ring.length < 3 || !(bounds.east > bounds.west) || !(bounds.north > bounds.south)) return null;
  const c = ring.reduce((a, p) => ({ e: a.e + p.e / ring.length, n: a.n + p.n / ring.length }), { e: 0, n: 0 });
  const K = 0.7;
  const inner = ring.map((p) => ({ e: c.e + (p.e - c.e) * K, n: c.n + (p.n - c.n) * K }));
  const es = inner.map((p) => p.e);
  const ns = inner.map((p) => p.n);
  const e0 = Math.min(...es);
  const e1 = Math.max(...es);
  const n0 = Math.min(...ns);
  const n1 = Math.max(...ns);
  const N = 9;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const p = { e: e0 + ((i + 0.5) / N) * (e1 - e0), n: n0 + ((j + 0.5) / N) * (n1 - n0) };
      if (!inside(p, inner)) continue;
      const u = (p.e - bounds.west) / (bounds.east - bounds.west);
      const v = (bounds.north - p.n) / (bounds.north - bounds.south);
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const k = (Math.floor(v * px.height) * px.width + Math.floor(u * px.width)) * 4;
      rs.push(px.data[k]);
      gs.push(px.data[k + 1]);
      bs.push(px.data[k + 2]);
    }
  if (rs.length < 6) return null;
  return tidyRoofColor(median(rs), median(gs), median(bs));
}
