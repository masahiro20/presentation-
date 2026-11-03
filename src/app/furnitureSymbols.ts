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
  // 短い家具（ミニキッチンなど）で幅が負にならないように
  const rect = (u: number, v: number, w: number, d: number, extra: Partial<Extract<Prim, { t: 'rect' }>> = {}) => P.push({ t: 'rect', u, v, w: Math.max(0.05, w), d: Math.max(0.05, d), ...extra });
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
      const fridgeSym = (fu: number, fv = 0) => {
        rect(fu, fv, 0.68, 0.7, { fill: WHITE, stroke: '#4a4e55' });
        text(fu, fv + 0.42, '冷蔵庫', 0.12);
      };
      /** シンクだけ／コンロだけの器具（Ⅱ型・L 型用） */
      const sinkSym = (u: number, v: number) => {
        rect(u, v + 0.12, 0.75, 0.42, { fill: '#dfe8ee', stroke: '#6d7178', r: 0.04 });
        circle(u, v + 0.1, 0.02, { fill: '#6d7178' });
        text(u, v + 0.62, 'シンク', 0.13);
      };
      const stoveSym = (u: number, v: number, vertical = false) => {
        for (const [du, dv] of [
          [-0.17, 0.18],
          [0.17, 0.18],
          [-0.17, 0.42],
          [0.17, 0.42],
        ])
          circle(u + (vertical ? dv - 0.3 : du), v + (vertical ? du + 0.3 : dv), 0.085, { fill: WHITE, stroke: '#4a4e55' });
        if (hood) rect(u, v + 0.3, vertical ? 0.5 : 0.9, vertical ? 0.9 : 0.5, { dash: true, stroke: '#4a4e55' });
        text(u, v + (vertical ? 0.85 : 0.62), hood ? 'コンロ・フード' : 'コンロ', 0.13);
      };
      if (type === 'wall') {
        const cw = Math.max(0.6, Math.min(len - 0.3, 3.0) - (fridge === 'none' ? 0 : 0.75));
        const cu = fridge === 'none' ? 0 : fridge === 'right' ? -0.375 : 0.375;
        rect(cu, 0, cw, 0.65, { fill: BODY });
        fittings(cu, 0, cw);
        if (fridge !== 'none') fridgeSym((fridge === 'right' ? 1 : -1) * (cw / 2 + 0.375 - 0.36) + cu);
        text(cu, 0.85, '壁付け I 型', 0.12);
        break;
      }
      if (type === 'l') {
        // L 型: 壁沿いにシンク（吊戸つき）、コンロ側の端から袖が部屋側へ伸びる（3D と同じ寸法）
        const wallW = Math.min(len - 0.3, 3.4);
        const W = Math.min(wallW, 2.75);
        const D = 0.65;
        const legL = it.d ? Math.max(1.5, Math.min(2.8, it.d)) : 2.1;
        const legU = sg * (W / 2 - D / 2);
        const mainW = W - D;
        const mainU = -sg * (D / 2);
        rect(mainU, 0, mainW, D, { fill: BODY });
        rect(legU, 0, D, legL, { fill: BODY });
        sinkSym(mainU - sg * (mainW / 2 - 0.55), 0);
        stoveSym(legU, Math.min(legL - 0.45, 1.05) - 0.3, true);
        if (fridge !== 'none') fridgeSym(-sg * (W / 2 + 0.36));
        text(mainU, D + 0.25, 'L 型', 0.12);
        break;
      }
      if (type === 'two') {
        // Ⅱ型: 壁にコンロ（W1840）、対面にシンク（W1840）。壁の残りに背面収納と冷蔵庫
        const wallW = Math.min(len - 0.3, 3.4);
        const D = 0.65;
        const su = sg * (wallW / 2 - 0.92);
        rect(su, 0, 1.84, D, { fill: BODY });
        stoveSym(su, 0);
        const restW = wallW - 1.84 - 0.05;
        if (restW >= 1.2) {
          const rc = -sg * (wallW / 2 - restW / 2);
          const fw = fridge === 'none' ? 0 : 0.72;
          const cupW = Math.max(0.6, restW - fw);
          const fridgeFirst = (fridge === 'right' ? 1 : -1) !== sg;
          const cx = rc + (fridgeFirst ? 1 : -1) * sg * (fw / 2);
          cabinetSym(cx, 0, cupW, 0.45);
          if (fw) fridgeSym(rc - (fridgeFirst ? 1 : -1) * sg * (cupW / 2));
        }
        const cv = (it.d ? Math.max(1.3, Math.min(2.6, it.d)) : D + 1.0 + 0.325) - D / 2;
        rect(su, cv, 1.84, 0.75, { fill: BODY });
        sinkSym(su - sg * 0.3, cv);
        text(su, cv + 0.95, 'Ⅱ型（対面はシンク）', 0.12);
        break;
      }
      const bw = Math.min(len - 0.3, 2.7);
      const cabW = Math.max(0.3, fridge === 'none' ? bw : bw - 0.75);
      const cabU = fridge === 'none' ? 0 : fridge === 'right' ? -0.375 : 0.375;
      cabinetSym(cabU, 0, cabW, 0.45);
      text(cabU, 0.3, '背面収納', 0.12);
      if (fridge !== 'none') fridgeSym((fridge === 'right' ? 1 : -1) * (bw / 2 - 0.36));
      const cw = Math.max(0.6, Math.min(len - 0.4, 2.55));
      const cv = it.d ? Math.max(1.2, Math.min(2.6, it.d)) - 0.17 : 1.35;
      if (type === 'island') {
        // アイランド: 四方が空く。ダイニング側にカウンターの持ち出しとスツール
        rect(0, cv, cw, 0.95, { fill: BODY });
        for (const du of [-cw / 4, cw / 4]) circle(du, cv + 1.2, 0.17, { fill: WHITE, stroke: '#6d7178' });
      } else {
        // ペニンシュラ: ダイニング側に腰壁（太い線）、コンロ側の端が壁に付く（端の線）
        rect(0, cv, cw, 0.75, { fill: BODY });
        rect(0, cv + 0.75, cw, 0.1, { fill: '#8b8f96' });
        line(sg * (cw / 2), -0.2, sg * (cw / 2), cv + 0.85, { stroke: '#4a4e55', dash: true });
      }
      fittings(0, cv, cw);
      text(0, cv + (type === 'island' ? 1.5 : 1.1), type === 'island' ? 'アイランド' : 'ペニンシュラ（腰壁）', 0.12);
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
      if (it.shape === 'l') {
        // L 型: 片側の端に部屋側へ伸びるカウチ
        const sg = (it.legSide ?? 'right') === 'right' ? 1 : -1;
        const depth = Math.max(1.2, it.leg ?? 1.6);
        rect(sg * (w / 2 - 0.475), 0.9, 0.95, depth - 0.9, { fill: BODY, r: 0.08 });
        rect(sg * (w / 2 - 0.09), 0.9, 0.18, depth - 0.95, { fill: '#c9bda9' });
      }
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
    case 'cupboard': {
      const cw = it.w ?? 1.8;
      cabinetSym(0, 0, cw, 0.45);
      if (it.shape === 'l') {
        const sg = (it.legSide ?? 'right') === 'right' ? 1 : -1;
        const legL = Math.max(0.9, it.leg ?? 1.8);
        cabinetSym(sg * (cw / 2 - 0.225), 0.45, 0.45, legL - 0.45);
      }
      text(0, 0.3, it.shape === 'l' ? 'L 型収納' : '背面収納', 0.12);
      break;
    }
    case 'hanger': {
      const w = it.w ?? 1.8;
      // 枕棚（細い矩形）とパイプ（壁から 300 の線）、掛かった服の目安（短い線）
      rect(0, 0, w, 0.35, { fill: WHITE, dash: true });
      line(-w / 2, 0.3, w / 2, 0.3, { stroke: '#4a4e55' });
      for (let u = -w / 2 + 0.12; u < w / 2 - 0.06; u += 0.12) line(u, 0.1, u, 0.5, { stroke: '#b5b0a6' });
      text(0, 0.72, 'ハンガーパイプ', 0.11);
      break;
    }
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
    case 'washstand': {
      const w = it.w ?? 0.77;
      const custom = it.washStyle === 'custom';
      rect(0, 0, w, custom ? 0.55 : 0.52, { fill: WHITE, stroke: '#6d7178' });
      const bowls = custom && w >= 1.5 ? [-w / 4, w / 4] : [0];
      for (const bu of bowls) circle(bu, custom ? 0.3 : 0.26, custom ? 0.19 : 0.17, { fill: '#dfe8ee', stroke: '#6d7178' });
      if (custom) text(0, 0.75, '造作洗面', 0.11);
      break;
    }
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
