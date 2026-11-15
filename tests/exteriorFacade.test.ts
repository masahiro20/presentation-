// 外観のカット（道路側）の向きの選び方（2026-11-15。吉田様邸）:
//  - ガレージの扉は、道路側の面のいちばん大きな表情。窓と同じように数える
//  - その向きから見て、建物のほかの部分（張り出した棟）に隠れる窓は数えない
//    （中庭に面した居間の大きな窓を数えて南東の斜めから撮り、車庫の窓の無い側壁が画面の半分を占めていた）
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildBuilding } from '../src/scene/building';
import { buildLandscape, planExteriorOf } from '../src/scene/landscape';
import { exteriorShots, facadeWindows } from '../src/scene/shots';
import { exteriorById } from '../src/styles/presets';
import type { BuildingModel, Floor, Opening, Room, Vec2, Wall } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
/**
 * L 字の平屋。母屋（西。10 × 7 m）の東に、車庫の棟（6 × 8 m）が南へ 5m 張り出す。道路は東（図面の右）。
 * 車庫の東の面にガレージの扉（幅 6m）、母屋の東の面に玄関、母屋の南の面（車庫の棟のすぐ西）に掃き出し窓 2 つ。
 */
const O = [P(0, 0), P(10000, 0), P(10000, 4000), P(16000, 4000), P(16000, 12000), P(10000, 12000), P(10000, 7000), P(0, 7000)];
function model(withShutter = true): BuildingModel {
  const walls: Wall[] = O.map((a, i) => ({ id: `w${i}`, a, b: O[(i + 1) % O.length], thickness: 150, exterior: true, outsideSign: 1 as const }));
  const openings: Opening[] = [
    { id: 'ent', wallId: 'w1', kind: 'entrance', t0: 1500, t1: 2400, sill: 0, height: 2300 },
    // 南の面（w6: (10000,7000) → (0,7000)）。車庫の棟から 0.5〜3m と 3.5〜6m
    { id: 's1', wallId: 'w6', kind: 'window', t0: 500, t1: 3000, sill: 0, height: 2200 },
    { id: 's2', wallId: 'w6', kind: 'window', t0: 3500, t1: 6000, sill: 0, height: 2200 },
    ...(withShutter ? [{ id: 'sh', wallId: 'w3', kind: 'shutter' as const, t0: 1000, t1: 7000, sill: 0, height: 2300 }] : []),
  ];
  const rooms: Room[] = [
    { id: 'r1', name: 'LDK', type: 'ldk', polygon: [P(0, 0), P(10000, 0), P(10000, 7000), P(0, 7000)], labelPos: P(5000, 3500), area: 70 },
    { id: 'r2', name: '車庫', type: 'garage', polygon: [P(10000, 4000), P(16000, 4000), P(16000, 12000), P(10000, 12000)], labelPos: P(13000, 8000), area: 48 },
  ];
  const f1: Floor = { level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, outline: [O], rooms, stairs: [], openings, walls };
  return {
    name: 't',
    floors: [f1],
    northAngleDeg: 0,
    site: { roads: [{ side: 'right', source: 'manual', widthMm: 6000 }], bounds: { left: -3000, right: 21000, top: -3000, bottom: 16000 } },
    report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} },
  };
}
/** 道路側のカットの、建物の中心から見たカメラの方向（水平） */
function frontDir(m: BuildingModel): THREE.Vector3 {
  const style = exteriorById('hl-jolypat-grey');
  const { meta } = buildBuilding(m, { exterior: style });
  const site = buildLandscape(meta, style, m.site, planExteriorOf(m), m.siteLevels).site;
  const shot = exteriorShots(meta, site, { maxY: meta.topY, eaveY: meta.topY - 0.3 }, 16 / 9, 0, facadeWindows(m)).find((x) => x.id === 'ext-front')!;
  const c = meta.bbox.getCenter(new THREE.Vector3());
  return shot.view.pos.clone().sub(c).setY(0).normalize();
}

describe('道路側の外観は、見える表情の多い向きから撮る', () => {
  it('窓の量: ガレージの扉を数える。棟に隠れる窓は数えない', () => {
    const wins = facadeWindows(model());
    // 玄関・南の窓 2・ガレージの扉
    expect(wins.length).toBe(4);
    const shutter = wins.find((w) => w.area > 10)!;
    expect(shutter.normal.x).toBeCloseTo(1, 5);
    expect(shutter.area).toBeCloseTo(6 * 2.3, 1);
    for (const w of wins) expect(w.segs!.length).toBe(O.length);
  });

  it('L 字の家: 道路の正面寄り（±25° 以内）から撮る。車庫の棟に隠れる南の窓に引かれて斜め 45° へ振らない', () => {
    const d = frontDir(model());
    expect(d.x).toBeGreaterThan(Math.cos((25 * Math.PI) / 180));
  });

  it('ガレージの扉が無くても、隠れる窓は数えないので、道路の正面寄りのまま', () => {
    const d = frontDir(model(false));
    expect(d.x).toBeGreaterThan(Math.cos((25 * Math.PI) / 180));
  });
});
