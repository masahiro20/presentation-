/**
 * iPhone の AR（Quick Look）用に USDZ を書き出す。
 * 建物・屋根・家具を材料ごと。外構（地面・道路・木）は入れない（原寸で敷地に置くので、地面は本物を使う）
 */
import * as THREE from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import type { Viewer } from './viewer';
import { prepareMaterials, restoreMaterials } from './photoFinish';
import { stripUnexportableTextures } from './exportAr';

export async function exportUsdz(viewer: Viewer, opts: { landscape?: boolean; scale?: number } = {}): Promise<Uint8Array> {
  const g = viewer.groups;
  const roots = [g.building, g.roof, g.furniture, ...(opts.landscape ? [g.landscape] : [])].filter((o) => o.visible);
  // 想定の街並み（パースの背景）は書き出さない（AR で実物の場所に置くと、想像の隣家が邪魔になる）
  const town = viewer.townShown();
  viewer.setTownVisible(false);
  const saved = prepareMaterials(viewer.scene);
  const holder = new THREE.Scene();
  const parents = roots.map((r) => r.parent);
  try {
    for (const r of roots) holder.add(r);
    if (opts.scale && opts.scale !== 1) holder.scale.setScalar(opts.scale);
    holder.updateMatrixWorld(true);
    const exporter = new USDZExporter();
    const restore = stripUnexportableTextures(holder);
    try {
      return await exporter.parseAsync(holder, { maxTextureSize: 1024, quickLookCompatible: true });
    } finally {
      restore();
    }
  } finally {
    roots.forEach((r, i) => parents[i]?.add(r));
    restoreMaterials(saved);
    viewer.setTownVisible(town);
    viewer.invalidate();
  }
}
