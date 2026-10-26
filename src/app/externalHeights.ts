/**
 * 位置合わせした設計の 3D データ（3DS など）から、床の高さ・窓の腰高と高さ・屋根の形を測って間取りに反映する。
 * 測る中身は src/parser/heightsFrom3d.ts。ここはビューアから三角形を取り出して、結果を state に入れるだけ。
 */
import * as THREE from 'three';
import { state, emit } from './state';
import type { Viewer } from '../scene/viewer';
import { pivotLocalTriangles } from './externalFit';
import { isGlassMesh, type ExternalController } from './externalBuilding';
import { measure3d, applyMeasured, type HeightChanges } from '../parser/heightsFrom3d';

const MM = 0.001;

function toWorld(local: Float32Array, m: THREE.Matrix4): Float32Array {
  const out = new Float32Array(local.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < local.length; i += 3) {
    v.set(local[i], local[i + 1], local[i + 2]).applyMatrix4(m);
    out[i] = v.x;
    out[i + 1] = v.y;
    out[i + 2] = v.z;
  }
  return out;
}

/** 今の間取りの各階の床（ワールド m）: 3D の部屋の床の高さ（無ければ GL からの床高） */
function floorWorldY(viewer: Viewer): number[] {
  const st = viewer.state!;
  return [...st.model.floors].sort((a, b) => a.level - b.level).map((f) => st.meta.rooms.find((r) => r.floor.level === f.level)?.floorY ?? f.elevation * MM);
}

/** 測って反映する。変えた内容（案内）を返す。間取りのオブジェクトは差し替えずに中身を書き換える（3DS の位置合わせを保つため） */
export function applyHeightsFromExternal(viewer: Viewer, ctrl: ExternalController): HeightChanges | null {
  const st = viewer.state;
  const model = state.model;
  if (!st || !model) return null;
  const pivot = ctrl.placed.pivot;
  pivot.updateMatrixWorld(true);
  const m = pivot.matrixWorld;
  const solid = toWorld(pivotLocalTriangles(pivot, (x) => !isGlassMesh(x)), m);
  const glass = toWorld(pivotLocalTriangles(pivot, (x) => isGlassMesh(x)), m);
  const expect = floorWorldY(viewer);
  const measured = measure3d(model, solid, glass, expect);
  const ch = applyMeasured(model, measured, expect);
  // 点検用
  (globalThis as unknown as { __lastHeights: unknown }).__lastHeights = { expect, measured: { ...measured, glass: measured.glass.slice(0, 40) }, nSolid: solid.length / 9, nGlass: glass.length / 9, bboxSolid: bbox(solid) };
  // 中身を書き戻す（床の高さ・階高・開口の腰高と高さ）
  for (const f of model.floors) {
    const n = ch.model.floors.find((x) => x.level === f.level);
    if (!n) continue;
    f.elevation = n.elevation;
    f.height = n.height;
    // 3D データから足した窓
    for (const no of n.openings) if (no.id.startsWith('o3d-') && !f.openings.some((o) => o.id === no.id)) f.openings.push(no);
    for (const o of f.openings) {
      const no = n.openings.find((x) => x.id === o.id);
      if (no) {
        o.sill = no.sill;
        o.height = no.height;
      }
    }
  }
  const fl = [...model.floors].sort((a, b) => a.level - b.level);
  model.heights = { source: '3d', floor1: fl[0]?.elevation, storyHeights: fl.slice(0, -1).map((f) => f.height), roofPitch: ch.roof?.pitch, maxHeight: measured.groundY != null ? Math.round((measured.topY - measured.groundY) / MM) : undefined };
  if (ch.roof) state.design = { ...state.design, roofOverride: ch.roof.type, roofPitch: ch.roof.type === 'flat' ? undefined : ch.roof.pitch };
  viewer.setDesign(state.design);
  emit('model');
  return ch;
}

function bbox(a: Float32Array) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < a.length; i++) {
    const k = i % 3;
    if (a[i] < mn[k]) mn[k] = a[i];
    if (a[i] > mx[k]) mx[k] = a[i];
  }
  return { mn, mx };
}
