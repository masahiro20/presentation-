/**
 * 修正画面に描く家具の平面記号
 *
 * 3D と同じ寸法で、キッチンならシンク・コンロ・レンジフード・冷蔵庫・背面収納の位置、ソファなら背と肘、
 * ベッドなら枕側、といった「向きが分かる」形で描く。局所座標は 3D の Frame と同じ: u = 並び方向（m）、
 * v = 壁から室内へ（m）。描画側で (x, y, rot) に変換する。
 */
import type { FurnitureItem } from '../core/types';
import { furnitureDims } from '../scene/furniture';

export type Prim =
  | { t: 'rect'; u: number; v: number; w: number; d: number; fill?: string; stroke?: string; dash?: boolean; r?: number }
  | { t: 'circle'; u: number; v: number; r: number; fill?: string; stroke?: string }
  | { t: 'line'; u1: number; v1: number; u2: number; v2: number; stroke?: string; dash?: boolean }
  | { t: 'text'; u: number; v: number; text: string; size?: number };

const BODY = '#d8cfc2';
const DARK = '#8b8f96';
const WHITE = '#fbfaf8';

/** 家具 1 つの記号（局所座標、m） */
export function furnitureSymbol(it: FurnitureItem): Prim[] {
  const P: Prim[] = [];
  const rect = (u: number, v: number, w: number, d: number, extra: Partial<Extract<Prim, { t: 'rect' }>> = {}) => P.push({ t: 'rect', u, v, w, d, ...extra });
  const circle = (u: number, v: number, r: number, extra: Partial<Extract<Prim, { t: 'circle' }>> = {}) => P.push({ t: 'circle', u, v, r, ...extra });
  const line = (u1: number, v1: number, u2: number, v2: number, extra: Partial<Extract<Prim, { t: 'line' }>> = {}) => P.push({ t: 'line', u1, v1, u2, v2, ...extra });
  const text = (u: number, v: number, s: string, size = 0.16) => P.push({ t: 'text', u, v, text: s, size });
  // 収納の記号: 矩形に対角線
  const cabinetSym = (u: number, v: number, w: number, d: number) => {
    rect(u, v, w, d, { fill: WHITE });
    line(u - w / 2, v, u + w / 2, v + d);
  };
  switch (it.kind) {
    case 'kitchen': {
      const len = it.len ?? 3;
      const type = it.kitchenType ?? 'peninsula';
      const sg = (it.stoveSide ?? 'right') === 'right' ? 1 : -1;
      const fridge = it.fridge ?? 'right';
      const hood = it.hood !== false;
      const fittings = (cu: number, cv: number, cw: number) => {
        const sinkU = cu - sg * (cw / 2 - 0.6);
        const stoveU = cu + sg * (cw / 2 - 0.5);
        rect(sinkU, cv + 0.12, 0.75, 0.42, { fill: '#dfe8ee', stroke: '#6d7178', r: 0.04 });
        circle(sinkU, cv + 0.1, 0.02, { fill: '#6d7178' });
        for (const [du, dv] of [
          [-0.17, 0.18],
          [0.17, 0.18],
          [-0.17, 0.42],
          [0.17, 0.42],
        ])
          circle(stoveU + du, cv + dv, 0.085, { fill: WHITE, stroke: '#4a4e55' });
        if (hood) rect(stoveU, cv + 0.05, 0.9, 0.5, { dash: true, stroke: '#4a4e55' });
        text(sinkU, cv + 0.62, 'シンク', 0.13);
        text(stoveU, cv + 0.62, hood ? 'コンロ・フード' : 'コンロ', 0.13);
      };
      if (type === 'wall') {
        const cw = Math.min(len - 0.3, 3.0) - (fridge === 'none' ? 0 : 0.75);
        const cu = fridge === 'none' ? 0 : fridge === 'right' ? -0.375 : 0.375;
        rect(cu, 0, cw, 0.65, { fill: BODY });
        fittings(cu, 0, cw);
        if (fridge !== 'none') {
          const fu = (fridge === 'right' ? 1 : -1) * (cw / 2 + 0.375 - 0.36) + cu;
          rect(fu, 0, 0.68, 0.7, { fill: WHITE, stroke: '#4a4e55' });
          text(fu, 0.42, '冷蔵庫', 0.12);
        }
        break;
      }
      const bw = Math.min(len - 0.3, 2.7);
      const cabW = fridge === 'none' ? bw : bw - 0.75;
      const cabU = fridge === 'none' ? 0 : fridge === 'right' ? -0.375 : 0.375;
      cabinetSym(cabU, 0, cabW, 0.45);
      text(cabU, 0.3, '背面収納', 0.12);
      if (fridge !== 'none') {
        const fu = (fridge === 'right' ? 1 : -1) * (bw / 2 - 0.36);
        rect(fu, 0, 0.68, 0.7, { fill: WHITE, stroke: '#4a4e55' });
        text(fu, 0.42, '冷蔵庫', 0.12);
      }
      const cw = Math.min(len - 0.4, 2.55);
      const cv = 1.35;
      rect(0, cv, cw, type === 'island' ? 0.95 : 0.75, { fill: BODY });
      if (type === 'peninsula') line(-cw / 2, cv + 0.75, cw / 2, cv + 0.75, { stroke: '#4a4e55' });
      fittings(0, cv, cw);
      text(0, cv + (type === 'island' ? 1.15 : 0.95), type === 'island' ? 'アイランド' : '対面（腰壁）', 0.12);
      break;
    }
    case 'dining': {
      rect(0, -0.425, 1.6, 0.85, { fill: '#e2d2bc' });
      for (const du of [-0.4, 0.4]) for (const side of [-1, 1]) rect(du, side * (0.425 + 0.2) - 0.22, 0.44, 0.44, { fill: WHITE, r: 0.06 });
      break;
    }
    case 'sofa': {
      const w = it.w ?? 2.1;
      rect(0, 0, w, 0.9, { fill: BODY, r: 0.08 });
      rect(0, 0, w, 0.22, { fill: '#c9bda9' }); // 背
      rect(-w / 2 + 0.1, 0, 0.2, 0.9, { fill: '#c9bda9' });
      rect(w / 2 - 0.1, 0, 0.2, 0.9, { fill: '#c9bda9' });
      break;
    }
    case 'coffeeTable':
      rect(0, 0, 1.0, 0.5, { fill: '#e2d2bc' });
      break;
    case 'tv': {
      const w = it.w ?? 1.8;
      rect(0, 0, w, 0.42, { fill: BODY });
      rect(0, 0.12, 1.3, 0.05, { fill: '#2a2c30' });
      text(0, 0.33, 'TV', 0.14);
      break;
    }
    case 'rug':
      rect(0, 0, it.w ?? 2.2, it.d ?? 1.6, { dash: true, fill: 'none' });
      break;
    case 'plant': {
      const r = 0.25 * (it.w ?? 1);
      circle(0, 0, r, { fill: '#cfe0c5' });
      circle(0, 0, r * 0.5, { fill: '#a9c69a' });
      break;
    }
    case 'chair':
      rect(0, -0.4, 0.75, 0.8, { fill: BODY, r: 0.1 });
      rect(0, -0.4, 0.75, 0.2, { fill: '#c9bda9' });
      break;
    case 'bed': {
      const w = it.w ?? 1.4;
      rect(0, 0, w + 0.06, 2.04, { fill: WHITE, stroke: '#6d7178' });
      line(-w / 2 - 0.03, 0, w / 2 + 0.03, 0, { stroke: '#4a4e55' }); // ヘッドボード
      const np = w > 1.2 ? 2 : 1;
      for (let i = 0; i < np; i++) rect(np === 2 ? (i === 0 ? -w / 4 : w / 4) : 0, 0.1, np === 2 ? w / 2 - 0.1 : w - 0.2, 0.4, { fill: '#eee9e0', r: 0.08 });
      rect(0, 0.75, w, 1.26, { fill: '#e6e2da' });
      text(0, 1.2, 'ベッド', 0.14);
      break;
    }
    case 'nightstand':
      rect(0, 0, 0.45, 0.4, { fill: BODY });
      break;
    case 'desk':
      rect(0, 0, 1.0, 0.55, { fill: '#e2d2bc' });
      rect(0, 0.75, 0.45, 0.45, { fill: WHITE, r: 0.06 });
      break;
    case 'cabinet':
      cabinetSym(0, 0, 1.2, 0.45);
      break;
    case 'bookshelf':
      cabinetSym(0, 0, 0.9, 0.32);
      break;
    case 'shoeCabinet':
      cabinetSym(0, 0, 1.22, 0.4);
      text(0, 0.28, '下駄箱', 0.11);
      break;
    case 'cupboard':
      cabinetSym(0, 0, it.w ?? 1.8, 0.45);
      text(0, 0.3, '背面収納', 0.12);
      break;
    case 'fridge':
      rect(0, 0, 0.68, 0.7, { fill: WHITE, stroke: '#4a4e55' });
      line(-0.34, 0.7, 0.34, 0.7, { stroke: '#4a4e55' });
      text(0, 0.42, '冷蔵庫', 0.12);
      break;
    case 'lowTable':
      rect(0, -0.4, 1.2, 0.8, { fill: '#e2d2bc' });
      for (const [du, dv] of [
        [-0.35, -0.75],
        [0.35, -0.75],
        [-0.35, 0.75],
        [0.35, 0.75],
      ])
        rect(du, dv - 0.26, 0.52, 0.52, { fill: WHITE, r: 0.06 });
      break;
    case 'bath': {
      const tw = it.len ?? 1.6;
      rect(0, 0, tw, 0.8, { fill: WHITE, stroke: '#6d7178' });
      rect(0, 0.08, tw - 0.16, 0.64, { fill: '#dfe8ee', r: 0.12 });
      break;
    }
    case 'mirror':
      rect(0, 0, 0.45, 0.06, { fill: '#cfe3ec' });
      break;
    case 'washstand':
      rect(0, 0, 0.77, 0.52, { fill: WHITE, stroke: '#6d7178' });
      circle(0, 0.26, 0.17, { fill: '#dfe8ee', stroke: '#6d7178' });
      break;
    case 'washer':
      rect(0, 0, 0.6, 0.6, { fill: WHITE, stroke: '#6d7178' });
      circle(0, 0.3, 0.2, { fill: 'none', stroke: '#6d7178' });
      break;
    case 'toilet':
      rect(0, 0.02, 0.38, 0.2, { fill: WHITE, stroke: '#6d7178' });
      circle(0, 0.5, 0.19, { fill: WHITE, stroke: '#6d7178' });
      break;
  }
  // 手前（部屋側）を示す矢印
  const { d, v0 } = furnitureDims(it);
  const front = v0 + d;
  if (it.kind !== 'rug' && it.kind !== 'plant') {
    P.push({ t: 'line', u1: 0, v1: front + 0.05, u2: 0, v2: front + 0.3, stroke: DARK });
    P.push({ t: 'line', u1: -0.09, v1: front + 0.2, u2: 0, v2: front + 0.3, stroke: DARK });
    P.push({ t: 'line', u1: 0.09, v1: front + 0.2, u2: 0, v2: front + 0.3, stroke: DARK });
  }
  return P;
}
