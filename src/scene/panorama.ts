/**
 * 360° ビュー（部屋ごとのパノラマ画像）: 立方体の 6 面（画角 90°）を、正距円筒（横 2:縦 1）の 1 枚に貼り直す。
 * 海外の住宅プレゼン（RoomSketcher の 360 Views・Getfloorplan のツアー）の定番。
 * 書き出す JPEG には Google の 360° 写真の印（XMP の GPano）を入れ、Google フォト・Facebook・Windows のフォトなどで見回せるようにする。
 * ここは計算だけ（DOM・WebGL を使わない）。撮影は Viewer.captureCubeFaces、書き出しは app/panoramaExport.ts。
 */

export type V3 = [number, number, number];

/** 立方体の 1 面: 正面（f）・上（u）。右は f × u（three.js のカメラの lookAt と同じ向き） */
export interface CubeFace {
  f: V3;
  u: V3;
}

export const CUBE_FACES: CubeFace[] = [
  { f: [1, 0, 0], u: [0, 1, 0] },
  { f: [-1, 0, 0], u: [0, 1, 0] },
  { f: [0, 0, 1], u: [0, 1, 0] },
  { f: [0, 0, -1], u: [0, 1, 0] },
  { f: [0, 1, 0], u: [0, 0, 1] },
  { f: [0, -1, 0], u: [0, 0, -1] },
];

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * 正距円筒の 1 点（経度 lon・緯度 lat [rad]）の向き。画像の中央（lon = 0）が heading（水平の単位ベクトル）を向き、右へ行くほど右を向く
 */
export function equirectDir(lon: number, lat: number, heading: V3): V3 {
  const right = cross(heading, [0, 1, 0]);
  const c = Math.cos(lat);
  const s = Math.sin(lon);
  const k = Math.cos(lon);
  return [c * (s * right[0] + k * heading[0]), Math.sin(lat), c * (s * right[2] + k * heading[2])];
}

/** 向き d が写る面と、その面の中の位置（px: 左 0 → 右 1、py: 上 0 → 下 1） */
export function faceLookup(d: V3): { face: number; px: number; py: number } {
  let best = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < CUBE_FACES.length; i++) {
    const v = dot(d, CUBE_FACES[i].f);
    if (v > bestDot) {
      bestDot = v;
      best = i;
    }
  }
  const F = CUBE_FACES[best];
  const r = cross(F.f, F.u);
  const a = dot(d, r) / bestDot;
  const b = dot(d, F.u) / bestDot;
  return { face: best, px: (a + 1) / 2, py: (1 - b) / 2 };
}

/**
 * 6 面の画素（RGBA・正方形 size×size、CUBE_FACES の順）から正距円筒（W×W/2）の画素を作る。双一次で補間する
 */
export function cubeToEquirect(faces: Uint8ClampedArray[], size: number, W: number, heading: V3): Uint8ClampedArray<ArrayBuffer> {
  const H = W / 2;
  const out = new Uint8ClampedArray(new ArrayBuffer(W * H * 4));
  const sample = (img: Uint8ClampedArray, x: number, y: number, o: number) => {
    // 面の端は 1 画素内側に寄せる（隣の面との継ぎ目で縁の色を拾わない）
    const fx = Math.min(size - 1.001, Math.max(0, x * size - 0.5));
    const fy = Math.min(size - 1.001, Math.max(0, y * size - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const i00 = (y0 * size + x0) * 4;
    const i10 = i00 + 4;
    const i01 = i00 + size * 4;
    const i11 = i01 + 4;
    for (let c = 0; c < 3; c++) {
      const top = img[i00 + c] * (1 - tx) + img[i10 + c] * tx;
      const bot = img[i01 + c] * (1 - tx) + img[i11 + c] * tx;
      out[o + c] = top * (1 - ty) + bot * ty;
    }
    out[o + 3] = 255;
  };
  for (let y = 0; y < H; y++) {
    const lat = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
    for (let x = 0; x < W; x++) {
      const lon = ((x + 0.5) / W) * Math.PI * 2 - Math.PI;
      const d = equirectDir(lon, lat, heading);
      const { face, px, py } = faceLookup(d);
      sample(faces[face], px, py, (y * W + x) * 4);
    }
  }
  return out;
}

/** JPEG に 360° 写真の印（XMP の GPano: 正距円筒）を入れる。SOI（FFD8）の直後に APP1 を差し込む */
export function addPanoXmp(jpeg: Uint8Array, width: number, height: number): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('JPEG ではありません');
  const xmp =
    "<?xpacket begin='﻿' id='W5M0MpCehiHzreSzNTczkc9d'?>" +
    "<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>" +
    "<rdf:Description rdf:about='' xmlns:GPano='http://ns.google.com/photos/1.0/panorama/'" +
    " GPano:ProjectionType='equirectangular' GPano:UsePanoramaViewer='True'" +
    ` GPano:FullPanoWidthPixels='${width}' GPano:FullPanoHeightPixels='${height}'` +
    ` GPano:CroppedAreaImageWidthPixels='${width}' GPano:CroppedAreaImageHeightPixels='${height}'` +
    " GPano:CroppedAreaLeftPixels='0' GPano:CroppedAreaTopPixels='0'/>" +
    "</rdf:RDF></x:xmpmeta><?xpacket end='w'?>";
  const enc = new TextEncoder();
  const ns = enc.encode('http://ns.adobe.com/xap/1.0/\0');
  const body = enc.encode(xmp);
  const len = 2 + ns.length + body.length;
  const seg = new Uint8Array(2 + len);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg[2] = (len >> 8) & 0xff;
  seg[3] = len & 0xff;
  seg.set(ns, 4);
  seg.set(body, 4 + ns.length);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(seg, 2);
  out.set(jpeg.subarray(2), 2 + seg.length);
  return out;
}
