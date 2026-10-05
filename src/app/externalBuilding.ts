/**
 * 外部の正確な建物（設計チームの 3DS / OBJ / STL / GLB / FBX）を間取りプレゼンの 3D に置き、PDF から起こした建物の代わりに影を落とさせる。
 *
 *  - 読み込み: src/sunstudy/importModel.ts（日照シミュレーション側と共有、読み取り専用で使う）
 *  - 配置: PlacedModel（pivot → object → inner）。pivot は PDF の bbox 中心 c に置いたラッパー Group の子で、
 *    pivot.position = (dx, baseY, dz)、pivot.rotation.y = −planRotDeg（PLAN 座標 = ワールド）。
 *    placement.headingDeg/offsetE/offsetN はここでは地理的な意味を持たず、planRotDeg/dx/−dz を入れて applyTransform に渡すだけ。
 *  - 表示・解析: viewer.groups.external（setModel で消えない）。userData.externalReplaces が true で、
 *    日照ステップ表示中（userData.externalMounted）に表示中のメッシュがあるときだけ、
 *    buildOccluder（src/sun/analysis.ts）は PDF の建物・屋根の代わりに external を焼き込み、
 *    PDF の建物・屋根・家具・照明を隠す（viewer.applyExternalReplace）。他のステップ（デザイン・ウォークスルー・提案資料）では
 *    PDF の建物が表示も壁判定も担う。提案資料など日照ステップ外で 3DS を使いたい解析は buildOccluder に external: true を渡す。
 *    ガラス（userData.glass）は noShadow にして、部屋ごとの日当たりの光線が窓を通るようにする。
 *  - 作り直しへの備え: emit('model') で PDF の建物が作り直されても external は残る。on('model') で dirty にし、
 *    日照ステップが sync() を呼んでラッパー位置・影の範囲・隠す設定を再適用する。
 *    ただし別の間取り（state.model が別のオブジェクト・null）になったら、合わせた相手が無くなるので 3DS を外す。
 */
import * as THREE from 'three';
import type { Viewer } from '../scene/viewer';
import type { BuildingModel } from '../core/types';
import { PlacedModel, importModelFile, loadSampleModel } from '../sunstudy/importModel';
import type { ImportedModel } from '../sunstudy/types';
import { buildOccluderFrom, disposeOccluder, type Occluder } from '../sun/analysis';
import { convexHull, type EN } from '../sun/align';
import { state, on } from './state';
import { toast } from './dom';
import { allObjectsAutoHidden, fitExternalToPlan, outlineOfTriangles, pivotLocalTriangles, planOutlineEN, planOutlinePolygon, seedPlacement, type ExternalBuilding, type PlanFit } from './externalFit';

export const SAMPLE_EXTERNAL_PATH = 'samples/sample_house.3ds';

/** 別の間取りを読み込んで 3DS を外したときの案内 */
export const EXTERNAL_DETACHED_MSG = '別の間取りを読み込んだため 3DS を外しました';

/** ガラスと見なす名前（マテリアル名。マテリアルが無いときはオブジェクト名）。importModel.ts の GLASS_RE と同じ */
const GLASS_NAME_RE = /glass|ガラス|window|窓/i;

/**
 * 焼き込んだメッシュ（importModel の BakedMeshData を持つ）をガラスとして扱うか。
 *  - マテリアルの情報があるとき（名前がある、または不透明度 < 1）: そのマテリアルで決める
 *    （不透明度 < 0.5・transmission > 0.5（読み込み時に不透明度 0.3 に写される）・名前があってすべてのマテリアル名がガラス）。
 *    名前の無い半透明（0.5〜1）のマテリアルはガラスではない（importModel.ts の判定と同じ。空の名前の every() は常に true なので明示的に除く）
 *  - マテリアルの情報が無いとき（MTL の無い OBJ・STL など）だけ、オブジェクト名で決める（読み込み時の判定 = 名前）
 * 'Wall_with_windows' のように名前に窓を含む壁が、不透明なマテリアルを持つのにガラス扱いで影を落とさなくなるのを防ぐ
 */
export function isGlassMesh(m: THREE.Mesh): boolean {
  const ud = m.userData as { glass?: boolean; origOpacity?: number; materialName?: string };
  const names = (ud.materialName ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const opacity = typeof ud.origOpacity === 'number' ? ud.origOpacity : 1;
  const hasMaterialInfo = names.length > 0 || opacity < 1;
  if (hasMaterialInfo) return opacity < 0.5 || (names.length > 0 && names.every((n) => GLASS_NAME_RE.test(n)));
  return GLASS_NAME_RE.test(m.name) || ud.glass === true;
}

/**
 * 読み込んだモデルの全メッシュ（model.raw）のガラス判定をマテリアル優先でやり直し、userData.glass に入れる。
 * 戻り値: glass = ガラスとして扱うオブジェクト名、nameOnly = 名前は窓・ガラスだがマテリアルが不透明なので壁として扱うオブジェクト名
 */
export function classifyGlass(model: ImportedModel): { glass: string[]; nameOnly: string[] } {
  const glass = new Set<string>();
  const nameOnly = new Set<string>();
  for (const o of model.raw.children) {
    const m = o as THREE.Mesh;
    if (!m.isMesh) continue;
    const g = isGlassMesh(m);
    m.userData.glass = g;
    if (g) glass.add(m.name || '(名前なし)');
    else if (GLASS_NAME_RE.test(m.name)) nameOnly.add(m.name);
  }
  return { glass: [...glass], nameOnly: [...nameOnly] };
}

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

/** 読み込んだデータの焼き込み済みジオメトリ（GPU のバッファ）を解放する（別のデータに差し替えた・外したとき） */
export function disposeExternalGeometry(model: ImportedModel): void {
  for (const o of model.raw.children) (o as THREE.Mesh).geometry?.dispose?.();
}

export class ExternalController {
  /** PDF の bbox 中心に置くラッパー（pivot の親） */
  readonly wrapper = new THREE.Group();
  placed: PlacedModel;
  /** emit('model') の後で sync が必要 */
  dirty = true;
  /** 合わせた相手の間取り（state.model）。別のオブジェクトになったら 3DS を外す（on('model')） */
  fitModel: BuildingModel | null = null;
  /** 最後の autoFitToPlan の結果（計算できなかったときは null、理由は fitError） */
  lastFit: PlanFit | null = null;
  fitError: string | null = null;
  /** pivot ローカルの三角形と高さ帯ごとの外形のキャッシュ（形が変わる rebuild で捨てる。sync/applyTransform では変わらない） */
  private trisCache: Float32Array | null = null;
  private outlineCache = new Map<string, EN[]>();

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
    this.trisCache = null;
    this.outlineCache.clear();
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
    this.trisCache = null;
    this.outlineCache.clear();
    viewer.userData.externalReplaces = false;
    viewer.applyExternalReplace();
    viewer.invalidateOccluders();
    viewer.fitShadow();
    viewer.invalidate();
  }

  /** 表示中のメッシュがあるか（すべて非表示・空のデータなら false。外形も取れない） */
  hasVisibleMesh(): boolean {
    let has = false;
    this.placed.pivot.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.visible) has = true;
    });
    return has;
  }

  /** pivot ローカルの表示中メッシュの三角形（9 floats / 三角形）。rebuild まで使い回す */
  private triangles(): Float32Array {
    if (!this.trisCache) this.trisCache = pivotLocalTriangles(this.placed.pivot);
    return this.trisCache;
  }

  /** pivot ローカル EN（a = x, b = −z）の外形。band 省略時は壁の高さ帯（底 + 0.3 〜 min(2.0, 0.6×高さ)）。帯ごとにキャッシュ */
  outlineLocal(band?: { yMin: number; yMax: number }): EN[] {
    const key = band ? `${band.yMin}|${band.yMax}` : 'wall';
    const hit = this.outlineCache.get(key);
    if (hit) return hit;
    const out = outlineOfTriangles(this.triangles(), band);
    // 2 点合わせの吸着はクリックした高さごとに帯が変わるので、無制限に貯めない
    if (this.outlineCache.size >= 32) this.outlineCache.clear();
    this.outlineCache.set(key, out);
    return out;
  }

  /** 全高（軒先を含む）の外形 */
  outlineLocalFull(): EN[] {
    return this.outlineLocal({ yMin: -Infinity, yMax: Infinity });
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

  /**
   * ワールド bbox: pivot ローカルの bbox（placed.localBox、rebuild が決める）の 8 隅を pivot.matrixWorld で回す。
   * 全頂点を歩かないので位置の微調整・回転のたびに呼んでも軽い（Y 軸回転 + 平行移動の箱の外接なので影の範囲・寸法表示には十分）
   */
  worldBox(): THREE.Box3 {
    this.wrapper.updateMatrixWorld(true);
    const lb = this.placed.localBox;
    const box = new THREE.Box3();
    if (lb.isEmpty()) return box.setFromCenterAndSize(this.placed.pivot.getWorldPosition(new THREE.Vector3()), new THREE.Vector3());
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? lb.max.x : lb.min.x, i & 2 ? lb.max.y : lb.min.y, i & 4 ? lb.max.z : lb.min.z).applyMatrix4(this.placed.pivot.matrixWorld);
      box.expandByPoint(v);
    }
    return box;
  }

  /** 建物の最高高さ (m, ワールド) */
  topY(): number {
    return this.worldBox().max.y;
  }

  /**
   * 間取り（PDF の 1 階外形）に自動で合わせる: 壁の高さ帯の外周を PDF の外形に重ねる。
   * 同点（180° 対称）のときは preferRotDeg（省略時は今の planRotDeg）に近い回転を選ぶ。結果を ext に入れて sync する。
   * 戻り値: 合わせを計算できたら true（結果は ext.fit / lastFit）。3DS の外形が取れない（表示中のメッシュが無い等）・
   * PDF の外形が無い・3D がまだ無いときは false（理由は fitError。ext.fit は変えない）
   */
  autoFitToPlan(viewer: Viewer, preferRotDeg?: number): boolean {
    this.lastFit = null;
    this.fitError = null;
    const st = viewer.state;
    if (!st) {
      this.fitError = '3D がまだありません';
      return false;
    }
    const c = st.meta.bbox.getCenter(new THREE.Vector3());
    const src = this.hasVisibleMesh() ? this.outlineLocal() : [];
    if (src.length < 3) {
      this.fitError = '3DS の外形が取れません（表示中のオブジェクトがありません）';
      return false;
    }
    // PDF の 1 階外形: 最も大きい多角形（凹みも使う）。無ければ全頂点
    let dst = planOutlinePolygon(st.meta.outlines, { x: c.x, z: c.z });
    if (dst.length < 3) dst = planOutlineEN(st.meta.outlines, { x: c.x, z: c.z });
    if (dst.length < 3) {
      this.fitError = 'PDF の外形が取れません';
      return false;
    }
    let fit: PlanFit;
    try {
      fit = fitExternalToPlan(src, dst, preferRotDeg ?? this.ext.planRotDeg);
    } catch (e) {
      this.fitError = (e as Error).message;
      return false;
    }
    this.ext.planRotDeg = fit.planRotDeg;
    this.ext.dx = fit.dx;
    this.ext.dz = fit.dz;
    this.ext.fit = { mismatchM: fit.mismatchM, swapped: fit.swapped, at: new Date().toISOString(), score: fit.score, mirrorScore: fit.mirrorScore, pdfW: fit.pdfW, pdfD: fit.pdfD, extW: fit.extW, extD: fit.extD, planRotDeg: fit.planRotDeg, unitSuspect: fit.unitSuspect };
    this.fitModel = st.model;
    this.lastFit = fit;
    this.sync(viewer);
    return true;
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
/** 最後に installExternal / setExternalMounted を呼んだ viewer（on('model') で 3DS を外すときに使う） */
let currentViewer: Viewer | null = null;

/** DOM が無い環境（テスト）では案内を出さない */
function notify(msg: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 3500): void {
  if (typeof document === 'undefined') return;
  toast(msg, kind, ms);
}

// PDF の建物が作り直されたら sync が必要（日照ステップの mount / rotate 経路で呼ぶ）。
// 別の間取り（state.model が合わせた相手と別のオブジェクト・null）になったら、古い dx/dz/回転・合わせの記録ごと 3DS を外す
on('model', () => {
  if (!current) return;
  if (state.model !== current.fitModel) {
    if (currentViewer) installExternal(currentViewer, null);
    else {
      current = null;
      state.external = null;
    }
    notify(EXTERNAL_DETACHED_MSG, 'info', 8000);
    return;
  }
  current.markDirty();
});

/** 今の controller（viewer.userData.external にも入れている） */
export function externalController(): ExternalController | null {
  return current;
}

/**
 * 読み込んだモデルから新しい建物の状態を作る（配置は推定した単位・上方向、建物以外のオブジェクトは非表示）。
 *  - すべてのオブジェクトが建物以外と判定されたときは何も隠さず、その旨を注意に書く（このアプリにはオブジェクト一覧が無い）
 *  - ガラスの判定をマテリアル優先でやり直し、ガラスとして扱う名前を注意に書く
 */
export function createExternal(model: ImportedModel): ExternalBuilding {
  const notes = model.notes.filter((n) => !/^建物以外と判定して除外:|^ガラスと判定したオブジェクト/.test(n));
  const hidden = model.objects.filter((o) => o.autoHidden).map((o) => o.name);
  if (allObjectsAutoHidden(model)) notes.push(`すべてのオブジェクト（${hidden.join(', ')}）が名前・形から建物以外と判定されましたが、建物が無くなるのでそのまま表示します`);
  else if (hidden.length) notes.push(`建物以外と判定して除外: ${hidden.join(', ')}`);
  const g = classifyGlass(model);
  if (g.glass.length) notes.push(`ガラスとして扱うオブジェクト（影を落とさず、部屋の日当たりの光が通る）: ${g.glass.join(', ')}`);
  if (g.nameOnly.length) notes.push(`名前は窓・ガラスですがマテリアルが不透明なので壁として扱うオブジェクト: ${g.nameOnly.join(', ')}`);
  model.notes = notes;
  return { model, placement: seedPlacement(model), planRotDeg: 0, dx: 0, dz: 0, replaces: true };
}

/**
 * state.external と controller を差し替えて viewer に付ける（古いものは外す）。
 * 古いデータのジオメトリ（GPU のバッファ）は、新しい ext が同じ ImportedModel を使うのでなければ解放する
 */
export function installExternal(viewer: Viewer, ext: ExternalBuilding | null): ExternalController | null {
  currentViewer = viewer;
  if (current) {
    const oldModel = current.ext.model;
    current.remove(viewer);
    current = null;
    if (!ext || ext.model !== oldModel) disposeExternalGeometry(oldModel);
  }
  state.external = ext;
  if (ext) {
    current = new ExternalController(ext);
    current.fitModel = state.model;
    current.attach(viewer);
  }
  viewer.userData.external = current;
  const ctrl = current;
  viewer.externalBounds = ctrl ? () => ctrl.worldBox() : null;
  viewer.userData.externalReplaces = !!ext && ext.replaces;
  viewer.applyExternalReplace();
  viewer.invalidateOccluders();
  viewer.fitShadow();
  viewer.invalidate();
  return current;
}

/**
 * 日照ステップの表示中か（PDF の建物を隠す・external を見せる・解析と壁判定で 3DS を使うのはこの間だけ）。
 * 遮蔽物のキャッシュ（歩行の壁判定・見どころカメラ）と影の範囲も今の表示に合わせて作り直す
 */
export function setExternalMounted(viewer: Viewer, mounted: boolean) {
  currentViewer = viewer;
  viewer.userData.externalMounted = mounted;
  viewer.groups.external.visible = mounted;
  viewer.applyExternalReplace();
  viewer.invalidateOccluders();
  viewer.fitShadow();
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
