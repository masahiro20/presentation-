// 陰影のテイスト（濃い壁の内装）の昼の室内（2026-11-15。吉田様邸のスタッフの Twinmotion の内観から）:
//  - 室内は暗く沈み、窓の外と日差しの当たる所だけが明るい。壁の暗さに合わせて露出を上げない
//  - 空の光は全体に掛かる光なので、光を絞ると窓の外まで暗くなる。室内の素材（内装・家具）の側で拡散光を絞る
//  - 食卓は四角い天板・ペンダントなし。階段の踏板は、タイルの床の内装では家具の木に合わせる
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { patchRoomProbe, roomProbeUniforms } from '../src/scene/roomProbe';
import { isIndoorKey, stairWoodSpec } from '../src/scene/materials';
import { INTERIOR_STYLES, interiorById } from '../src/styles/presets';

const compile = (m: THREE.Material) => {
  const shader = { uniforms: {} as Record<string, unknown>, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  m.onBeforeCompile(shader as never, null as never);
  return shader;
};

describe('室内の素材だけ、拡散光を絞れる（シェーダーへの差し込み）', () => {
  it('室内の素材: 拡散光（空の光・照り返し・環境光）に倍率が掛かる。直接光の計算の後・まとめの前に入る', () => {
    const m = patchRoomProbe(new THREE.MeshStandardMaterial(), true);
    expect(m.defines).toHaveProperty('ROOM_INDIRECT');
    expect(m.defines).toHaveProperty('ROOM_PROBE');
    const sh = compile(m);
    const f = sh.fragmentShader;
    expect(f).toContain('uniform float roomIndirect;');
    const at = f.indexOf('irradiance *= roomIndirect;');
    expect(at).toBeGreaterThan(0);
    expect(f).toContain('iblIrradiance *= roomIndirect;');
    // three.js の「拡散光をまとめる所」の直前
    expect(f.indexOf('#include <lights_fragment_end>')).toBeGreaterThan(at);
    expect(f.indexOf('#include <lights_fragment_maps>')).toBeLessThan(at);
    expect(sh.uniforms.roomIndirect).toBe(roomProbeUniforms.roomIndirect);
  });

  it('屋外の素材には印を付けない（倍率の行は印が無ければ働かない）。あとから室内の素材にもできる', () => {
    const m = patchRoomProbe(new THREE.MeshStandardMaterial());
    expect(m.defines).not.toHaveProperty('ROOM_INDIRECT');
    expect(compile(m).fragmentShader).toContain('#if defined( ROOM_PROBE ) && defined( ROOM_INDIRECT ) && defined( RE_IndirectDiffuse )');
    const before = m.onBeforeCompile;
    patchRoomProbe(m, true);
    expect(m.defines).toHaveProperty('ROOM_INDIRECT');
    expect(m.onBeforeCompile).toBe(before);
  });

  it('倍率の既定は 1（今までどおり）。内装・家具の素材だけが室内の素材', () => {
    expect(roomProbeUniforms.roomIndirect.value).toBe(1);
    for (const k of ['int.wall', 'int.floor', 'int.ceiling', 'int.stairs@oak', 'f.fabric', 'f.wood']) expect(isIndoorKey(k)).toBe(true);
    for (const k of ['ext.wall', 'ext.glass', 'l.ground', 'l.lawn', 'l.gardenWall', 'x.carBody', 'cut.north']) expect(isIndoorKey(k)).toBe(false);
  });
});

describe('陰影のテイストの決まり', () => {
  it('「モルタル・陰影」「グレーの塗り壁 × 大判タイル（陰影）」だけが陰影のテイスト', () => {
    expect(INTERIOR_STYLES.filter((s) => s.lowKey).map((s) => s.id).sort()).toEqual(['hl-dark-mortar', 'hl-dark-stone']);
    expect(interiorById('hl-grey-oak').lowKey).toBeFalsy();
    expect(interiorById('hl-standard').lowKey).toBeFalsy();
  });

  it('食卓は四角い天板・ペンダントなし（照明器具を見せない）', () => {
    for (const id of ['hl-dark-mortar', 'hl-dark-stone']) {
      const v = interiorById(id).vocab!;
      expect(v.pendant).toBe('none');
      expect(v.table).toBe('plank');
    }
  });

  it('階段の踏板: タイルの床の内装は家具の木。木の床の内装はその床の木', () => {
    const dark = interiorById('hl-dark-mortar');
    expect(stairWoodSpec(dark).color).toBe(dark.furniture.wood.color);
    expect(stairWoodSpec(dark).pattern).toBe('wood');
    const oak = interiorById('hl-standard');
    expect(oak.floor.pattern === 'woodFloor' || oak.floor.pattern === 'herringbone').toBe(true);
    expect(stairWoodSpec(oak).color).toBe(oak.floor.color);
    expect(stairWoodSpec(oak).pattern).toBe('wood');
  });
});
