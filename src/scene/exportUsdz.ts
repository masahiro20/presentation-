/**
 * iPhone の AR（Quick Look）用に USDZ を書き出す。
 * 建物・屋根・家具を材料ごと。外構（地面・道路・木）は入れない（原寸で敷地に置くので、地面は本物を使う）
 */
import * as THREE from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import type { Viewer } from './viewer';
import { prepareMaterials, restoreMaterials } from './photoreal';

export async function exportUsdz(viewer: Viewer, opts: { landscape?: boolean; scale?: number } = {}): Promise<Uint8Array> {
  const g = viewer.groups;
  const roots = [g.building, g.roof, g.furniture, ...(opts.landscape ? [g.landscape] : [])].filter((o) => o.visible);
  const saved = prepareMaterials(viewer.scene);
  const holder = new THREE.Scene();
  const parents = roots.map((r) => r.parent);
  try {
    for (const r of roots) holder.add(r);
    if (opts.scale && opts.scale !== 1) holder.scale.setScalar(opts.scale);
    holder.updateMatrixWorld(true);
    const exporter = new USDZExporter();
    return await exporter.parseAsync(holder, { maxTextureSize: 1024, quickLookCompatible: true });
  } finally {
    roots.forEach((r, i) => parents[i]?.add(r));
    restoreMaterials(saved);
    viewer.invalidate();
  }
}
