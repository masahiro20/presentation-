/**
 * 外部の正確な建物（設計チームの 3DS / OBJ / STL / GLB / FBX）を間取りプレゼンの 3D に置き、PDF から起こした建物の代わりに影を落とさせる。
 *
 *  - 読み込み: src/sunstudy/importModel.ts（日照シミュレーション側と共有、読み取り専用で使う）
 *  - 配置: PlacedModel（pivot → object → inner）。pivot は PDF の bbox 中心 c に置いたラッパー Group の子で、
 *    pivot.position = (dx, baseY, dz)、pivot.rotation.y = −planRotDeg（PLAN 座標 = ワールド）。
 *    placement.headingDeg/offsetE/offsetN はここでは地理的な意味を持たず、planRotDeg/dx/−dz を入れて applyTransform に渡すだけ。
 *  - 表示・解析: viewer.groups.external（setModel で消えない）。userData.externalReplaces が true なら
 *    buildOccluder（src/sun/analysis.ts）は PDF の建物・屋根の代わりに external を焼き込み、
 *    日照ステップ表示中（userData.externalMounted）は PDF の建物・屋根・家具・照明を隠す（viewer.applyExternalReplace）。
 *    ガラス（userData.glass）は noShadow にして、部屋ごとの日当たりの光線が窓を通るようにする。
 *  - 作り直しへの備え: emit('model') で PDF の建物が作り直されても external は残る。on('model') で dirty にし、
 *    日照ステップが sync() を呼んでラッパー位置・影の範囲・隠す設定を再適用する。
 */
import * as THREE from 'three';
import type { Viewer } from '../scene/viewer';
import { PlacedModel, importModelFile, loadSampleModel } from '../sunstudy/importModel';
import type { ImportedModel } from '../sunstudy/types';
import { buildOccluderFrom, disposeOccluder, type Occluder } from '../sun/analysis';
import { convexHull, type EN } from '../sun/align';
import { state, on } from './state';
import { fitExternalToPlan, outlineOfPivot, planOutlineEN, planOutlinePolygon, seedPlacement, type ExternalBuilding, type PlanFit } from './externalFit';

export const SAMPLE_EXTERNAL_PATH = 'samples/sample_house.3ds';

/** メッシュの影の扱い: ガラスは影を落とさず解析の光線も通す、それ以外は落とす・受ける */
export function fixUpMeshes(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.userData.glass) {
      m.userData.noShadow = true;
      m.castShadow = false;
      m.receiveShadow = true;
    } else {
      m.userData.noShadow = false;
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
}

/** PDF の 1 階床の高さ (m)。部屋が無ければ最下階の elevation、それも無ければ 0 */
export function pdfFloor1Y(viewer: Viewer): number {
  const st = viewer.state;
  if (!st) return 0;
  const r1 = st.meta.rooms.find((r) => r.floor.level === 1) ?? st.meta.rooms[0];
  if (r1) return r1.floorY;
  const f = st.model.floors.reduce<number | null>((a, f) => (a == null || f.elevation < a ? f.elevation : a), null);
  return f == null ? 0 : f / 1000;
}

export class ExternalController {
  /** PDF の bbox 中心に置くラッパー（pivot の親） */
  readonly wrapper = new THREE.Group();
  placed: PlacedModel;
  /** emit('model') の後で sync が必要 */
  dirty = true;

  constructor(public readonly ext: ExternalBuilding) {
    this.wrapper.name = 'external';
    this.placed = new PlacedModel(ext.model, ext.placement);
    this.placed.pivot.name = 'external-building';
    this.wrapper.add(this.placed.pivot);
    fixUpMeshes(this.placed.pivot);
  }

  markDirty() {
    this.dirty = true;
  }

  /** external グループに入れて配置する */
  attach(viewer: Viewer) {
    if (this.wrapper.parent !== viewer.groups.external) viewer.groups.external.add(this.wrapper);
    this.sync(viewer);
  }

  /** 3DS の底面の高さ: PDF の 1 階床 − 3DS の 1 階床（省略時は PDF と同じ = 最下点が GL） */
  baseY(viewer: Viewer): number {
    const f1 = pdfFloor1Y(viewer);
    const own = this.ext.floor1M ?? f1;
    return f1 - own;
  }

  /** ラッパー位置・pivot の変換・影の扱い・置き換えの表示・影の範囲を今の状態に合わせる（作り直しの後にも呼ぶ） */
  sync(viewer: Viewer) {
    const st = viewer.state;
    if (!st) return;
    if (this.wrapper.parent !== viewer.groups.external) viewer.groups.external.add(this.wrapper);
    const c = st.meta.bbox.getCenter(new THREE.Vector3());
    this.wrapper.position.set(c.x, 0, c.z);
    const p = this.ext.placement;
    p.headingDeg = this.ext.planRotDeg;
    p.offsetE = this.ext.dx;
    p.offsetN = -this.ext.dz;
    p.baseY = this.baseY(viewer);
    this.placed.applyTransform();
    this.wrapper.updateMatrixWorld(true);
    fixUpMeshes(this.placed.pivot);
    viewer.userData.externalReplaces = this.ext.replaces;
    viewer.applyExternalReplace();
    viewer.invalidateOccluders();
    viewer.fitShadow();
    viewer.invalidate();
    this.dirty = false;
  }

  /** 単位・上方向・鏡像・非表示オブジェクトが変わった */
  rebuild(viewer: Viewer) {
    this.placed.rebuild();
    fixUpMeshes(this.placed.pivot);
    this.sync(viewer);
  }

  setReplaces(viewer: Viewer, on: boolean) {
    this.ext.replaces = on;
    this.sync(viewer);
  }

  /** 3D から外す（state 側は呼び出し側が null にする） */
  remove(viewer: Viewer) {
    this.wrapper.removeFromParent();
    this.placed.dispose();
    viewer.userData.externalReplaces = false;
    viewer.applyExternalReplace();
    viewer.invalidateOccluders();
    viewer.fitShadow();
    viewer.invalidate();
  }

  /** pivot ローカル EN（a = x, b = −z）の外形。band 省略時は壁の高さ帯（底 + 0.3 〜 min(2.0, 0.6×高さ)） */
  outlineLocal(band?: { yMin: number; yMax: number }): EN[] {
    return outlineOfPivot(this.placed.pivot, band);
  }

  /** 全高（軒先を含む）の外形 */
  outlineLocalFull(): EN[] {
    return outlineOfPivot(this.placed.pivot, { yMin: -Infinity, yMax: Infinity });
  }

  /** pivot ローカル EN → ワールド XZ（PLAN） */
  localToWorld(p: EN): THREE.Vector3 {
    this.placed.pivot.updateMatrixWorld(true);
    return new THREE.Vector3(p.e, 0, -p.n).applyMatrix4(this.placed.pivot.matrixWorld);
  }

  /** ワールド → pivot ローカル */
  worldToLocal(p: THREE.Vector3): THREE.Vector3 {
    this.placed.pivot.updateMatrixWorld(true);
    return p.clone().applyMatrix4(this.placed.pivot.matrixWorld.clone().invert());
  }

  /** ワールド XZ（PLAN）の外周の多角形（凹みも残る）。band 省略時は壁の高さ帯 */
  outlineWorld(band?: { yMin: number; yMax: number }): THREE.Vector2[] {
    const local = band === undefined ? this.outlineLocal() : this.outlineLocal(band);
    return local.map((p) => {
      const w = this.localToWorld(p);
      return new THREE.Vector2(w.x, w.z);
    });
  }

  /** ワールド XZ の凸包（軒先など、外接の形が欲しいとき） */
  outlineWorldHull(band?: { yMin: number; yMax: number }): THREE.Vector2[] {
    const pts = this.outlineWorld(band).map((p) => ({ e: p.x, n: -p.y }));
    return convexHull(pts).map((p) => new THREE.Vector2(p.e, -p.n));
  }

  worldBox(): THREE.Box3 {
    this.wrapper.updateMatrixWorld(true);
    return this.placed.worldBox();
  }

  /** 建物の最高高さ (m, ワールド) */
  topY(): number {
    return this.worldBox().max.y;
  }

  /**
   * 間取り（PDF の 1 階外形）に自動で合わせる: 壁の高さ帯の外周を PDF の外形に重ねる。
   * 同点（180° 対称）のときは preferRotDeg（省略時は今の planRotDeg）に近い回転を選ぶ。結果を ext に入れて sync する
   */
  autoFitToPlan(viewer: Viewer, preferRotDeg?: number): PlanFit {
    const st = viewer.state;
    if (!st) throw new Error('3D がまだありません');
    const c = st.meta.bbox.getCenter(new THREE.Vector3());
    const src = this.outlineLocal();
    // PDF の 1 階外形: 最も大きい多角形（凹みも使う）。無ければ全頂点
    let dst = planOutlinePolygon(st.meta.outlines, { x: c.x, z: c.z });
    if (dst.length < 3) dst = planOutlineEN(st.meta.outlines, { x: c.x, z: c.z });
    const fit = fitExternalToPlan(src, dst, preferRotDeg ?? this.ext.planRotDeg);
    this.ext.planRotDeg = fit.planRotDeg;
    this.ext.dx = fit.dx;
    this.ext.dz = fit.dz;
    this.ext.fit = { mismatchM: fit.mismatchM, swapped: fit.swapped, at: new Date().toISOString(), score: fit.score, mirrorScore: fit.mirrorScore, pdfW: fit.pdfW, pdfD: fit.pdfD, extW: fit.extW, extD: fit.extD, planRotDeg: fit.planRotDeg };
    this.sync(viewer);
    return fit;
  }

  /**
   * 部屋ごとの日当たりの測定点の高さ: PDF の床高 floorY + 1.2 から下へ外部の建物だけに光線を飛ばし、
   * [floorY − 0.3, floorY + 0.6] に床（ガラス以外）があればその 3 cm 上、無ければ floorY + 0.03。
   * BVH を 1 回作るので、使い終わったら dispose() する
   */
  sampleYFactory(): { fn: (x: number, z: number, floorY: number) => number; dispose: () => void } {
    this.wrapper.updateMatrixWorld(true);
    const occ: Occluder = buildOccluderFrom([{ root: this.placed.pivot, kind: 'external' }], undefined, { ancestors: false });
    const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    const fn = (x: number, z: number, floorY: number) => {
      ray.origin.set(x, floorY + 1.2, z);
      const hit = occ.bvh.raycastFirst(ray, THREE.DoubleSide, 0.6, 1.5);
      return hit ? hit.point.y + 0.03 : floorY + 0.03;
    };
    return { fn, dispose: () => disposeOccluder(occ) };
  }
}

// ---------------------------------------------------------------- モジュールの状態

let current: ExternalController | null = null;
// PDF の建物が作り直されたら sync が必要（日照ステップの mount / rotate 経路で呼ぶ）
on('model', () => current?.markDirty());

/** 今の controller（viewer.userData.external にも入れている） */
export function externalController(): ExternalController | null {
  return current;
}

/** 読み込んだモデルから新しい建物の状態を作る（配置は推定した単位・上方向、建物以外のオブジェクトは非表示） */
export function createExternal(model: ImportedModel): ExternalBuilding {
  return { model, placement: seedPlacement(model), planRotDeg: 0, dx: 0, dz: 0, replaces: true };
}

/** state.external と controller を差し替えて viewer に付ける（古いものは外す） */
export function installExternal(viewer: Viewer, ext: ExternalBuilding | null): ExternalController | null {
  if (current) {
    current.remove(viewer);
    current = null;
  }
  state.external = ext;
  if (ext) {
    current = new ExternalController(ext);
    current.attach(viewer);
  }
  viewer.userData.external = current;
  viewer.userData.externalReplaces = !!ext && ext.replaces;
  viewer.applyExternalReplace();
  viewer.invalidateOccluders();
  viewer.fitShadow();
  viewer.invalidate();
  return current;
}

/** 日照ステップの表示中か（PDF の建物を隠す・external を見せるのはこの間だけ） */
export function setExternalMounted(viewer: Viewer, mounted: boolean) {
  viewer.userData.externalMounted = mounted;
  viewer.groups.external.visible = mounted;
  viewer.applyExternalReplace();
  viewer.invalidate();
}

/** ファイルから読み込む（進行表示は呼び出し側） */
export async function loadExternal(file: { name: string; data: ArrayBuffer } | File): Promise<ImportedModel> {
  if (file instanceof File) return importModelFile({ name: file.name, data: await file.arrayBuffer() });
  return importModelFile(file);
}

/** 同梱のサンプル住宅（public/samples/sample_house.3ds。配信できない公開先では base64 の写し） */
export function loadSampleExternal(): Promise<ImportedModel> {
  return loadSampleModel(SAMPLE_EXTERNAL_PATH);
}

/** 置き換え中なら analyzeRooms に渡す測定点の高さの決め方（使い終わったら dispose） */
export function externalSampleY(viewer: Viewer): { fn: (x: number, z: number, floorY: number) => number; dispose: () => void } | null {
  const ctrl = (viewer.userData.external as ExternalController | undefined) ?? current;
  if (!ctrl || !ctrl.ext.replaces) return null;
  return ctrl.sampleYFactory();
}
