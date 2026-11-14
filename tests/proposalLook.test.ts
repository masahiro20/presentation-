// 御社の実際の提案パース（内観）から学んだ「見せ方」の約束（2026-11-13）:
//  - 室内の戸は閉じて描く（輪切り模型だけ少し開ける）
//  - カーテンの布は既定では描かない（カーテンボックスの溝だけ）
//  - 吹抜の下（天井の無い所）にダウンライトを付けない
//  - 腰壁の天端は壁と同じ仕上げ
//  - 食卓のペンダントは既定では描かない（コーディネートで足す）
//  - 「グレーの塗り壁 × 大判タイル」は、天井も壁と同じ色
//  - 構図: キッチンは天板の内側から天板越しに／2 階ホールは吹抜を見下ろす／LDK は家具を手前で切らない
//  - 戸を閉じて描いても、歩くモードの当たり判定には戸の板を入れない（戸口を通れる。シャッターは入れる）
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildBuilding } from '../src/scene/building';
import { exteriorById, INTERIOR_STYLES, interiorById, DEFAULT_DESIGN } from '../src/styles/presets';
import { resolveSpec } from '../src/styles/spec';
import { FINISH_CATEGORIES, interiorFor } from '../src/coordinate/catalog';
import { interiorShots, type RayFn } from '../src/scene/shots';
import type { Footprint } from '../src/scene/furniture';
import { buildOccluder } from '../src/sun/analysis';
import type { Viewer } from '../src/scene/viewer';
import type { BuildingModel, Floor, Opening, Room, Vec2, Wall } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const O = [P(0, 0), P(8000, 0), P(8000, 6000), P(0, 6000)];
const wall = (id: string, a: Vec2, b: Vec2, exterior = true): Wall => ({ id, a, b, thickness: exterior ? 150 : 120, exterior, ...(exterior ? { outsideSign: 1 as const } : {}) });
const walls = (lv: number): Wall[] => [wall(`n${lv}`, O[0], O[1]), wall(`e${lv}`, O[1], O[2]), wall(`s${lv}`, O[2], O[3]), wall(`w${lv}`, O[3], O[0])];
const room = (id: string, type: Room['type'], polygon: Vec2[], labelPos: Vec2): Room => ({ id, name: type, type, polygon, labelPos, area: 20 });

/**
 * 8m × 6m の 2 階建て。
 * 1 階: 西 5m が LDK、東 3m が洋室（間に壁と開き戸）。LDK の南の壁に掃き出し窓。
 * 2 階: 西 4m がホール、東 4m が吹抜（= 1 階の LDK の東 1m と洋室の上は天井が無い）
 */
function model(): BuildingModel {
  const mid = wall('m1', P(5000, 0), P(5000, 6000), false);
  const openings: Opening[] = [
    { id: 'w1', wallId: 's1', kind: 'window', t0: 4500, t1: 7000, sill: 0, height: 2000 },
    { id: 'd1', wallId: 'm1', kind: 'door', t0: 2000, t1: 2800, sill: 0, height: 2000 },
    { id: 'd2', wallId: 'm1', kind: 'sliding', t0: 4000, t1: 4800, sill: 0, height: 2000 },
  ];
  const f1: Floor = {
    level: 1,
    elevation: 500,
    height: 2900,
    ceilingHeight: 2400,
    outline: [O],
    rooms: [room('r1', 'ldk', [P(0, 0), P(5000, 0), P(5000, 6000), P(0, 6000)], P(2500, 3000)), room('r2', 'bedroom', [P(5000, 0), P(8000, 0), P(8000, 6000), P(5000, 6000)], P(6500, 3000))],
    stairs: [],
    openings,
    walls: [...walls(1), mid],
  };
  const f2: Floor = {
    level: 2,
    elevation: 3400,
    height: 2900,
    ceilingHeight: 2400,
    outline: [O],
    rooms: [room('h2', 'hall', [P(0, 0), P(4000, 0), P(4000, 6000), P(0, 6000)], P(2000, 3000)), room('v2', 'void', [P(4000, 0), P(8000, 0), P(8000, 6000), P(4000, 6000)], P(6000, 3000))],
    stairs: [],
    openings: [],
    walls: walls(2),
  };
  return { name: 't', floors: [f1, f2], northAngleDeg: 0, report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} } };
}
const style = exteriorById('hl-jolypat-grey');

/** 素材ごとの頂点 */
function points(spec = resolveSpec('minimal-lines', undefined)): Record<string, THREE.Vector3[]> {
  const { mb } = buildBuilding(model(), { exterior: style, spec });
  const g = mb.build(() => new THREE.MeshBasicMaterial());
  const pts: Record<string, THREE.Vector3[]> = {};
  for (const mesh of g.children as THREE.Mesh[]) {
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) (pts[mesh.name] ??= []).push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  return pts;
}

describe('室内の戸は閉じて描く', () => {
  it('開き戸・引戸とも、通常表示の開き具合は 0。輪切り模型で見せる開き具合は別に持つ', () => {
    const { meta } = buildBuilding(model(), { exterior: style });
    const swing = meta.doors.find((d) => d.id === 'd1')!;
    const slide = meta.doors.find((d) => d.id === 'd2')!;
    expect(swing.kind).toBe('swing');
    expect(slide.kind).toBe('slide');
    expect(swing.staticOpen).toBe(0);
    expect(slide.staticOpen).toBe(0);
    // 輪切り模型では、つながりが分かるように開ける
    expect(swing.cutOpen).toBeGreaterThan(0.5);
    expect(slide.cutOpen).toBeGreaterThan(0.3);
  });
});

describe('カーテンの布は既定では描かない', () => {
  it('標準の納まり（カーテンボックス）は、布を描かない設定が既定', () => {
    expect(resolveSpec('minimal-lines', undefined).curtains).toBe('pocket');
    expect(resolveSpec('minimal-lines', undefined).drapes).toBe(false);
    expect(resolveSpec('minimal-lines', { drapes: true }).drapes).toBe(true);
    // 比較用の「一般的な仕様」は従来どおりレールと布
    expect(resolveSpec('standard', undefined).drapes).toBe(true);
  });
  it('3D: 既定では布（f.curtain）が無く、「カーテンの布も描く」にすると出る', () => {
    expect(points()['f.curtain']).toBeUndefined();
    expect((points(resolveSpec('minimal-lines', { drapes: true }))['f.curtain'] ?? []).length).toBeGreaterThan(0);
  });
});

describe('吹抜の下（天井の無い所）に照明を付けない', () => {
  it('1 階のダウンライトは、2 階が吹抜の範囲（x > 4m）には無い', () => {
    const pts = points();
    // 1 階の天井の高さ（床 0.5 + 天井 2.4 = 2.9m 付近）の器具
    const lamps = (pts['f.downlight'] ?? []).filter((v) => v.y > 2.8 && v.y < 3.0);
    expect(lamps.length).toBeGreaterThan(0);
    expect(Math.max(...lamps.map((v) => v.x))).toBeLessThan(4.0);
  });
});

describe('腰壁の天端は壁と同じ仕上げ', () => {
  it('吹抜の縁を腰壁にしても、白い天端（int.wallTop）の面は 2 階に出ない', () => {
    const pts = points(resolveSpec('minimal-lines', { voidGuard: 'half' }));
    const tops = (pts['int.wallTop'] ?? []).filter((v) => v.y > 3.4 && v.y < 4.6);
    expect(tops.length).toBe(0);
  });
});

describe('食卓のペンダントは既定では描かない', () => {
  it('御社のテイスト（hl-）の家具の語彙は、ペンダントなしが既定。白い塗り壁 × オークだけ、和紙の球を 1 灯', () => {
    // 白い内装の明るい LDK のご提案（大崎様邸・堀様邸）は、食卓の上に和紙の球のペンダントを 1 灯下げる
    for (const s of INTERIOR_STYLES.filter((x) => x.id.startsWith('hl-') && x.vocab)) expect(s.vocab!.pendant, s.id).toBe(s.id === 'hl-standard' ? 'paper' : 'none');
    expect(interiorFor(DEFAULT_DESIGN).vocab?.pendant).toBe('none');
  });
  it('コーディネートの「ダイニングの照明」の先頭は「ペンダントなし」。器具を選ぶと語彙が変わる', () => {
    const cat = FINISH_CATEGORIES.find((c) => c.id === 'pendant')!;
    expect(cat.products[0].id).toBe('pend.none');
    expect(interiorFor({ ...DEFAULT_DESIGN, finishes: { pendant: 'pend.dome' } }).vocab?.pendant).toBe('dome');
    expect(interiorFor({ ...DEFAULT_DESIGN, finishes: { pendant: 'pend.none' } }).vocab?.pendant).toBe('none');
  });
});

describe('実際の提案に近いテイスト', () => {
  it('グレーの塗り壁 × 大判タイル: 天井は壁と同じ色・同じ塗り', () => {
    const s = interiorById('hl-dark-stone');
    expect(s.ceiling.pattern).toBe('plaster');
    expect(s.ceiling.color).toBe(s.wall.color);
    expect(s.floor.pattern).toBe('tileFloor');
  });
  it('白い壁 × オーク（標準）: ソファの布は暖かいベージュ（暗いグレーではない）', () => {
    const c = new THREE.Color(interiorById('hl-standard').furniture.fabric.color);
    expect(c.r).toBeGreaterThan(c.b);
    expect(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b).toBeGreaterThan(0.25);
  });
  it('白い壁 × オーク（標準）: 壁と天井は同じクリームがかった白の塗り（真っ白にしない）', () => {
    const s = interiorById('hl-standard');
    expect(s.ceiling.pattern).toBe('plaster');
    expect(s.ceiling.color).toBe(s.wall.color);
    const c = new THREE.Color(s.wall.color);
    // 黄み寄り（赤 > 青）で、白飛びしない明るさ
    expect(c.r).toBeGreaterThan(c.b);
    expect(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b).toBeLessThan(0.8);
  });
});

// ---- 構図 ----

/** 壁までの距離（1 階は LDK の箱 x 0〜5m、2 階は家全体の箱 x 0〜8m。奥行きはどちらも z 0〜6m） */
const boxRay: RayFn = (o, d, far) => {
  const maxX = o.y > 3 ? 8 : 5;
  let t = far;
  if (d.x > 1e-6) t = Math.min(t, (maxX - o.x) / d.x);
  if (d.x < -1e-6) t = Math.min(t, (0 - o.x) / d.x);
  if (d.z > 1e-6) t = Math.min(t, (6 - o.z) / d.z);
  if (d.z < -1e-6) t = Math.min(t, (0 - o.z) / d.z);
  return Math.max(0, t);
};

describe('構図: 御社の提案パースの撮り方', () => {
  const m = model();
  const { meta } = buildBuilding(m, { exterior: style });
  // LDK の北寄りに対面キッチンの天板（長さ 2.5m・奥行 0.9m。北の壁との間が通路）、南側に食卓とソファ
  const occ = new Map<string, Footprint[]>([
    [
      'r1',
      [
        { minX: 1.2, maxX: 3.7, minZ: 1.3, maxZ: 2.2, maxY: 0.87, baseY: 0.5, key: 'f.counter' },
        { minX: 1.6, maxX: 3.4, minZ: 3.2, maxZ: 4.1, maxY: 0.72, baseY: 0.5, key: 'f.wood' },
        { minX: 1.4, maxX: 3.5, minZ: 4.9, maxZ: 5.7, maxY: 0.68, baseY: 0.5, key: 'f.fabric' },
      ],
    ],
  ]);
  const shots = interiorShots(m, meta, occ, 16 / 9, boxRay);

  it('キッチンから: 天板の内側（北の通路）に立ち、天板越しに食卓・ソファの方（南）を見る', () => {
    const k = shots.find((s) => s.id === 'int-kitchen-r1');
    expect(k).toBeDefined();
    const { pos, target } = k!.view;
    // 天板の北の縁（z = 1.3）から 0.55m 手前
    expect(pos.z).toBeGreaterThan(0.6);
    expect(pos.z).toBeLessThan(0.9);
    expect(pos.x).toBeGreaterThan(1.2);
    expect(pos.x).toBeLessThan(3.7);
    // 南を向く。目の高さは立った人（床 0.5 + 1.45m）で、天板が手前に入るよう少し見下ろす
    expect(target.z - pos.z).toBeGreaterThan(3);
    expect(pos.y).toBeCloseTo(0.5 + 1.45, 2);
    expect(target.y).toBeLessThan(pos.y);
  });

  it('2 階のホール: 手すりの内側（吹抜の縁から 0.5〜1.3m）に立ち、吹抜の方を見下ろす', () => {
    const h = shots.find((s) => s.id === 'int-hall-h2');
    expect(h).toBeDefined();
    const { pos, target } = h!.view;
    // 吹抜の縁は x = 4m
    expect(4 - pos.x).toBeGreaterThanOrEqual(0.5);
    expect(4 - pos.x).toBeLessThanOrEqual(1.3);
    expect(target.x - pos.x).toBeGreaterThan(2);
    expect(target.y).toBeLessThan(pos.y);
    expect(h!.caption).toContain('吹抜');
  });

  it('LDK: カメラのすぐ前（1.25m 以内）に家具が来る位置は選ばない', () => {
    const l = shots.find((s) => s.id === 'int-r1');
    expect(l).toBeDefined();
    const { pos, target } = l!.view;
    const dir = target.clone().sub(pos).setY(0).normalize();
    for (const o of occ.get('r1')!) {
      const nx = Math.max(o.minX, Math.min(pos.x, o.maxX));
      const nz = Math.max(o.minZ, Math.min(pos.z, o.maxZ));
      const d = Math.hypot(nx - pos.x, nz - pos.z);
      const front = d > 0.05 && ((nx - pos.x) * dir.x + (nz - pos.z) * dir.z) / d > 0.75;
      if (front) expect(d, o.key).toBeGreaterThan(1.0);
    }
  });
});

describe('歩くモードの当たり判定: 閉じた戸の板で戸口をふさがない', () => {
  // 壁（x = 0 の面）に幅 0.8m の戸口。戸の板は viewer と同じく、建物のグループの中の独立したグループに入れる
  const slab = (w: number, h: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, h, w), new THREE.MeshBasicMaterial());
    m.position.set(x, y, z);
    return m;
  };
  const stub = () => {
    const building = new THREE.Group();
    building.add(slab(2, 2.4, 0, 1.2, -1.4), slab(2, 2.4, 0, 1.2, 1.4)); // 戸口の両脇の壁
    const door = new THREE.Group();
    door.name = 'door:d1';
    door.userData.walkThrough = true;
    const inner = new THREE.Group();
    inner.add(slab(0.8, 2.0, 0, 1.0, 0));
    door.add(inner);
    const shutter = new THREE.Group();
    shutter.name = 'door:s1';
    shutter.userData.walkThrough = false;
    shutter.add(slab(2.4, 2.0, 0, 1.0, 6));
    building.add(door, shutter);
    return { groups: { building, roof: new THREE.Group(), external: new THREE.Group() }, userData: {} } as unknown as Viewer;
  };
  const hitAt = (occ: ReturnType<typeof buildOccluder>, z: number) => occ.bvh.raycastFirst(new THREE.Ray(new THREE.Vector3(-3, 1.5, z), new THREE.Vector3(1, 0, 0)), THREE.DoubleSide);

  it('doors: false なら、開き戸・引戸の板は当たらない（壁とシャッターは当たる）', () => {
    const occ = buildOccluder(stub(), { buildingOnly: true, doors: false });
    expect(hitAt(occ, 0)).toBeFalsy();
    expect(hitAt(occ, -1.4)?.distance).toBeCloseTo(2.95, 2);
    expect(hitAt(occ, 6)?.distance).toBeCloseTo(2.95, 2);
  });

  it('既定（日照・構図の見通し）は、閉じた戸の板も遮る', () => {
    const occ = buildOccluder(stub(), { buildingOnly: true });
    expect(hitAt(occ, 0)?.distance).toBeCloseTo(2.95, 2);
  });
});
