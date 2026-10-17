// 同梱デモ public/demo/okusawa.json（scripts/plateau-demo.mjs で作る）が PLATEAU 3D Tiles 版であることの固定:
//   周辺建物は id plateau:gml_id・実形状（meshQ）・plateau 属性付きで、注記はデータセット（市区・年度・LOD）の文、env.plateau に出典、
//   旧 MVT 形式（id plateau:緯度:経度:面積・「東京23区・2020年度」の注記・meshQ 無し）が残っていない。開いたときに mesh が復元できる
import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromSavedNeighbor, sanitizePlateauAttrs } from '../src/sunstudy/project';
import type { ProjectJson, SavedNeighbor } from '../src/sunstudy/types';

const DEMO = new URL('../public/demo/okusawa.json', import.meta.url);
const demo = JSON.parse(readFileSync(DEMO, 'utf8')) as ProjectJson;
const env = demo.env!;
const plateau = env.neighbors.filter((n) => n.source === 'plateau');

describe('同梱デモ okusawa.json（PLATEAU 3D Tiles 版）', () => {
  it('奥沢のサンプル住宅プロジェクト（場所・3DS・周辺環境を同梱）で、サイズは 4.2 MB 以内', () => {
    expect(demo.version).toBe(1);
    expect(demo.app).toBe('sunstudy');
    expect(demo.frame).toMatchObject({ lat: 35.601929, lon: 139.67363, address: '東京都世田谷区奥沢三丁目' });
    expect(demo.model).toMatchObject({ name: 'sample_house.3ds', format: '3ds' });
    expect(env.grid).not.toBeNull();
    expect(env.aerial).not.toBeNull();
    expect(env.horizon).not.toBeNull();
    // 旧デモ 3.16 MB + 1 MB 以内
    expect(statSync(DEMO).size).toBeLessThan(4.2 * 1024 * 1024);
  });

  it('周辺建物は PLATEAU（世田谷区・2025年度・LOD2）の実形状: id plateau:gml_id・meshQ・plateau 属性（実測の最高高さ）が全棟に揃う', () => {
    expect(plateau.length).toBeGreaterThan(200);
    expect(env.neighborSources[0]).toBe('plateau');
    for (const n of plateau) {
      expect(n.id).toMatch(/^plateau:bldg_[0-9a-f-]+$/);
      expect(n.heightKind).toBe('measured');
      expect(n.meshQ).toMatchObject({ v: 1, q: 100 });
      expect(typeof n.meshQ!.posB64).toBe('string');
      expect(n.plateau).toMatchObject({ gmlId: n.id.slice('plateau:'.length), muniCd: '13112', pref: '東京都', city: '世田谷区', year: 2025, datasetLod: 2 });
      expect(n.plateau!.anchor.lat).toBeCloseTo(35.6, 1);
      expect(n.plateau!.anchor.lon).toBeCloseTo(139.67, 1);
      expect(n.plateau!.zmax - n.plateau!.zmin).toBeCloseTo(n.height, 0);
      expect(typeof n.plateau!.measuredHeight).toBe('number');
    }
  });

  it('注記と出典（env.plateau）は新しいデータセットの文で、旧 MVT の文言・id 形式が残っていない', () => {
    expect(env.neighborNotes[0]).toMatch(/^PLATEAU（国土交通省 3D都市モデル・東京都世田谷区・2025年度・LOD2）の実測の高さ・形状を使用（\d+ 棟を取得。/);
    expect(env.neighborNotes.join('\n')).not.toMatch(/東京23区|2020年度/);
    expect(env.plateau?.datasets).toHaveLength(1);
    expect(env.plateau?.datasets[0]).toMatchObject({ muniCd: '13112', city: '世田谷区', year: 2025, lod: 2, label: '東京都世田谷区・2025年度・LOD2' });
    expect(env.plateau?.indexGenerated).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(env.neighbors.some((n) => /^plateau:\d/.test(n.id))).toBe(false);
  });

  it('開いたときに meshQ から実形状（Float32Array・9 の倍数・屋根が先頭）が復元され、属性の検査を通る', () => {
    const sample: SavedNeighbor[] = [plateau[0], plateau[Math.floor(plateau.length / 2)], plateau[plateau.length - 1]];
    for (const s of sample) {
      const n = sanitizePlateauAttrs(fromSavedNeighbor(s));
      expect(n.plateau).toBeDefined();
      expect(n.mesh).toBeDefined();
      expect(n.mesh!.tris).toBeInstanceOf(Float32Array);
      expect(n.mesh!.tris.length % 9).toBe(0);
      expect(n.mesh!.tris.length).toBeGreaterThan(0);
      expect(n.mesh!.roofTriangles).toBeGreaterThan(0);
      expect(n.mesh!.roofTriangles).toBeLessThanOrEqual(n.mesh!.tris.length / 9);
      expect('meshQ' in n).toBe(false);
    }
  });
});
