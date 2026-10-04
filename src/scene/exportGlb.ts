/**
 * 3D モデルの書き出し（glTF バイナリ .glb）
 *
 * 外部のレンダラー（Blender・D5 Render・Twinmotion・Lumion など）で写真品質のパースを作るために、
 * 建物・屋根・家具・外構を、材料（実写テクスチャ・ガラスの透過）ごと書き出す。
 * 見どころカメラの位置・向き・画角も JSON で書き出し、外部でも同じ構図を再現できるようにする。
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { Viewer } from './viewer';
import { prepareMaterials, restoreMaterials } from './photoreal';

export async function exportGlb(viewer: Viewer): Promise<ArrayBuffer> {
  const g = viewer.groups;
  const roots = [g.building, g.roof, g.furniture, g.landscape].filter((o) => o.visible);
  // ガラスは透過の材料に（写真品質の計算と同じ設定）
  const saved = prepareMaterials(viewer.scene);
  try {
    const exporter = new GLTFExporter();
    const out = await exporter.parseAsync(roots, { binary: true, onlyVisible: true, maxTextureSize: 2048 });
    return out as ArrayBuffer;
  } finally {
    restoreMaterials(saved);
    viewer.invalidate();
  }
}

/** 見どころカメラ・太陽・時間帯（外部レンダラーで同じ構図・光を再現するため） */
export function sceneInfo(viewer: Viewer) {
  const shots = viewer.shots().map((s) => ({
    id: s.id,
    title: s.title,
    kind: s.kind,
    pos: s.view.pos.toArray(),
    target: s.view.target.toArray(),
    fov: s.view.fov,
  }));
  const cur = viewer.currentView();
  return {
    units: 'meter',
    up: 'Y',
    timeOfDay: viewer.design.timeOfDay,
    sunDir: viewer.sunDir.toArray(),
    current: { pos: cur.pos.toArray(), target: cur.target.toArray(), fov: cur.fov },
    shots,
    bbox: viewer.state ? { min: viewer.state.meta.bbox.min.toArray(), max: viewer.state.meta.bbox.max.toArray() } : null,
  };
}

export function downloadBlob(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

void THREE;
