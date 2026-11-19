// 間取り（JSON）と 3D の形の照合: 正しく作れた形では問題が出ず、3D に変える途中で形が変わった（ずれた）ときに見つける
import { describe, expect, it } from 'vitest';
import { parseSample } from './pdfNode';
import { buildBuilding } from '../src/scene/building';
import { buildRoofs } from '../src/scene/roof';
import { EXTERIOR_STYLES } from '../src/styles/presets';
import { checkBuiltGeometry } from '../src/scene/geometryCheck';

describe('間取りと 3D の形の照合', () => {
  it('サンプル住宅は、階の高さ・外壁・窓・戸・階段・屋根とも照合の問題が無い', async () => {
    const m = await parseSample('sample_house_A3.pdf');
    const built = buildBuilding(m, { exterior: EXTERIOR_STYLES[0] });
    expect(checkBuiltGeometry(m, built, [buildRoofs(m, EXTERIOR_STYLES[0]).mb])).toEqual([]);
  });

  it('3D を作ったあとで間取りの高さ・窓が変わっていたら（3D が古い・変換で失われた）見つける', async () => {
    const m = await parseSample('sample_house_A3.pdf');
    const built = buildBuilding(m, { exterior: EXTERIOR_STYLES[0] });
    const roof = buildRoofs(m, EXTERIOR_STYLES[0]).mb;
    const changed = JSON.parse(JSON.stringify(m));
    changed.floors[1].elevation += 300; // 2 階の床だけ上げる → 1 階の天端が届かない
    for (const o of changed.floors[0].openings) if (o.kind === 'window') o.id = `${o.id}-new`; // 3D に無い窓
    const kinds = checkBuiltGeometry(changed, built, [roof]).map((i) => i.kind);
    expect(kinds).toContain('level-gap');
    expect(kinds).toContain('window-missing');
  });
});
