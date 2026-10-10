/**
 * 日照シミュレーション: 想定の家（未建築の隣家）を置く・直す（「周辺建物の修正」の「想定の家（未建築の隣家）」）
 *
 * 分譲地などで隣の家がまだ建っていないときに、建った想定の家（屋根付きの仮の形。src/sun/plannedHouse.ts）を置き、
 * 影・日照時間マップ・測定点・日影図に入れる（レポート・日影図の注記に「想定で置いた建物 N 棟（未建築・仮の形状）」と出る）。
 *
 *  - 「＋ 想定の家を置く」（置く形のプリセットを選ぶ）: ボタンが dark・文言が変わり・十字カーソルになる。3D の地面（航空写真）を
 *    クリック（押してから 3 px 以内で離す。回転のドラッグでは置かない）した所に置く。続けて何棟でも置け、Esc・もう一度押すと終わる。
 *    向きは敷地の輪郭の主な辺の向き（輪郭が無ければ計画の建物の向き）に揃え、2 つの軸のうち東西に近い方を棟（長手）にする。
 *    既存の建物の屋根をクリックしたときはその真下の地面に置く（取り壊す家の跡に建つ想定。元の建物は「建物を選んで隠す」で外す）
 *  - 「計画の建物と同じ形を置く」: 計画の建物の幅×奥行×高さの箱を、計画の建物と同じ向きで置く（同じ置き方の別の形）
 *  - 3D で想定の家をクリック（建物を選んで隠す・測定点を置くモードの外）すると浮かぶ編集欄（形・名前・幅・奥行・向き・軒高・最高高さ・屋根・
 *    複製・削除）。ドラッグ（3 px 動いてから）で水平に動かす。選んでいる間は R / Shift+R で 90° 回転、Delete で削除、矢印キーで 0.1 m
 *    （Shift で 1 m）移動、Esc で閉じる
 *  - 一覧（名前・寸法・高さ・屋根・建物からの方向と距離）と「編集」「削除」、「想定の建物を含める（影・解析）」（study.plannedEnabled）
 *
 * 変更はすべて state の addPlannedHouse / updatePlannedHouse / removePlannedHouse / clearPlannedHouses / setPlannedEnabled を通す
 * （'neighbors' を 1 回発火 → simStep が古い解析結果を捨て、周辺建物を作り直してから refresh() を呼ぶ）。
 * ドラッグ中はメッシュを動かすだけで、離したときに 1 回だけ書く。選択の強調は scene.groups.select に入れる（影を落とさない・解析に入らない・撮影に写さない）。
 */
import * as THREE from 'three';
import { clear, field, h, toast } from '../../app/dom';
import { ALIGN_COLORS, dominantAngleDeg, pointInPolygon } from '../../sun/align';
import {
  DEFAULT_PLANNED_PRESET,
  PLANNED_DEFAULT_LABEL,
  PITCH_MAX_SUN,
  PLANNED_LABEL_MAX,
  PLANNED_MAX_SIZE,
  PLANNED_MIN_HEIGHT,
  PLANNED_MIN_SIZE,
  PLANNED_PRESETS,
  ROOF_LABEL,
  ROOF_TYPES,
  houseFromPreset,
  isPlannedPresetId,
  isRoofType,
  pitchRun,
  pitchSun,
  plannedAxes,
  plannedFootprint,
  plannedPreset,
  ridgeFromPitch,
  type PlannedHouse,
  type PlannedPreset,
  type PlannedPresetId,
  type RoofType,
} from '../../sun/plannedHouse';
import { buildingExclusionEN, buildingFootprintEN, currentPlaced } from '../building';
import { neighborWhere } from '../disclosure';
import { sitePolygonEN } from '../environment';
import type { StudyScene } from '../scene';
import { clearGroup } from '../scene';
import { addPlannedHouse, clearPlannedHouses, plannedHouses, removePlannedHouse, setPlannedEnabled, study, updatePlannedHouse, type PlannedNeighbor } from '../state';
import { worldToEN } from '../types';
import type { EN } from '../types';

// ---------------------------------------------------------------------------
// 文言・定数
// ---------------------------------------------------------------------------

/** これ以内の移動で離したらクリック（px）。回転・移動のドラッグでは置かない・選ばない */
export const PLANNED_CLICK_PX = 3;
/** 複製の間隔: 隣どうしの壁の間 (m)（隣地境界からの離れ 1 m × 2 の目安） */
export const PLANNED_DUP_GAP = 2;
/** 選択の強調色（建物を選んで隠すの選択と同じ橙） */
const SEL_COLOR = ALIGN_COLORS.target;

export const PLANNED_SECTION_TITLE = '想定の家（未建築の隣家）';
export const PLANNED_ARM_LABEL = '＋ 想定の家を置く';
export const PLANNED_ARM_ACTIVE = '想定の家を置くのをやめる（Esc）';
export const PLANNED_SAME_LABEL = '計画の建物と同じ形を置く';
export const PLANNED_SAME_ACTIVE = '同じ形を置くのをやめる（Esc）';
export const PLANNED_INCLUDE_LABEL = '想定の建物を含める（影・解析）';
export const PLANNED_KEYS_HELP = 'ドラッグで移動・R／Shift+R で 90° 回転・矢印キーで 0.1 m（Shift で 1 m）・Delete で削除・Esc で閉じる';

/** 屋根の勾配（立ち上がり ÷ 水平距離）: 陸屋根から勾配屋根に変えたときの最高高さに使う（切妻 6 寸・寄棟 5.5 寸・片流れ 2.6 寸） */
const ROOF_PITCH: Record<Exclude<RoofType, 'flat'>, number> = { gable: 0.6, hip: 0.55, shed: 0.26 };

// ---------------------------------------------------------------------------
// 純粋な計算（テストする）
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const norm360 = (d: number) => ((d % 360) + 360) % 360;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** 押した点と離した点が PLANNED_CLICK_PX 以内ならクリック */
export function isClickMove(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.hypot(b.x - a.x, b.y - a.y) <= PLANNED_CLICK_PX;
}

/** 数の表示（小数 2 桁まで、末尾の 0 は付けない: 9.1・12・8.25） */
export function fmtM(v: number): string {
  return String(r2(v));
}

/** 方位 a とそれに直交する a + 90° のうち、東西に近い方（[0, 180)。0.01° に丸める。ちょうど 45° なら a） */
export function eastWestAxis(baseDeg: number): number {
  const a = norm360(baseDeg) % 180;
  const b = (a + 90) % 180;
  const out = Math.abs(Math.sin(b * DEG)) > Math.abs(Math.sin(a * DEG)) + 1e-9 ? b : a;
  const r = r2(out);
  return r >= 180 ? 0 : r;
}

/**
 * 置く家の棟（長手 = width の軸）の方位（rotDeg）: 敷地の輪郭があればその主な辺の向き（dominantAngleDeg）、
 * 無ければ計画の建物の向き（headingDeg）、どちらも無ければ真東西。2 つの軸のうち東西に近い方を棟にする（南面に長い一般的な建て方）
 */
export function plannedPlacementRotation(site: readonly EN[] | null | undefined, headingDeg: number | null | undefined): number {
  if (site && site.length >= 3) return eastWestAxis(dominantAngleDeg([...site]));
  if (headingDeg != null && Number.isFinite(headingDeg)) return eastWestAxis(headingDeg);
  return 90;
}

/** 次の名前「想定の家 N」（使われていない一番小さい N） */
export function nextPlannedLabel(labels: readonly (string | null | undefined)[]): string {
  const used = new Set<number>();
  const re = new RegExp(`^${PLANNED_DEFAULT_LABEL}\\s*(\\d+)$`);
  for (const l of labels) {
    const m = re.exec((l ?? '').trim());
    if (m) used.add(Number(m[1]));
  }
  let k = 1;
  while (used.has(k)) k++;
  return `${PLANNED_DEFAULT_LABEL} ${k}`;
}

/** 向きを deg 度回す（正 = 上から見て時計回り。[0, 360)・0.01° に丸める） */
export function rotatedPatch(h: Pick<PlannedHouse, 'rotDeg'>, deg: number): Pick<PlannedHouse, 'rotDeg'> {
  const r = r2(norm360(h.rotDeg + deg));
  return { rotDeg: r >= 360 ? 0 : r };
}

/** 複製: 棟の向き（width の軸）に 幅 + gap だけずらした写し（id なし。名前は label）。分譲地で同じ家が並ぶ想定 */
export function duplicatePlanned(h: PlannedHouse, label: string, gap = PLANNED_DUP_GAP): Partial<PlannedHouse> {
  const { u } = plannedAxes(h.rotDeg);
  const s = h.width + gap;
  const out: Partial<PlannedHouse> = { ...h, ce: r2(h.ce + u.e * s), cn: r2(h.cn + u.n * s), label };
  delete out.id;
  return out;
}

/** プリセットの形にする（位置・向き・名前はそのまま） */
export function presetPatch(id: PlannedPresetId): Partial<PlannedHouse> {
  const p = plannedPreset(id);
  return { preset: p.id, width: p.width, depth: p.depth, eaveHeight: p.eaveHeight, ridgeHeight: p.ridgeHeight, roof: p.roof };
}

/**
 * 屋根の形を変える: 陸屋根へは最高高さ = 軒高。陸屋根（または棟と軒が同じ高さ）から勾配屋根へは、標準の勾配で最高高さを上げる
 * （切妻・寄棟は奥行の半分、片流れは奥行 + 軒の出が水平距離）。勾配屋根どうしは高さをそのまま
 */
export function roofPatch(h: PlannedHouse, roof: RoofType): Partial<PlannedHouse> {
  if (roof === h.roof) return {};
  if (roof === 'flat') return { roof, ridgeHeight: h.eaveHeight };
  if (h.roof === 'flat' || h.ridgeHeight - h.eaveHeight < 0.05) {
    const run = pitchRun({ roof, depth: h.depth }) ?? h.depth / 2;
    return { roof, ridgeHeight: r2(h.eaveHeight + run * ROOF_PITCH[roof]) };
  }
  return { roof };
}

/**
 * 高さを変える: 陸屋根は軒高 = 最高高さ。軒高を最高高さより上にしたら最高高さも、最高高さを軒高より下にしたら軒高も同じ値にする
 * （入力した値がいつもそのまま残るように）。0 以下・数でなければ null
 */
export function heightPatch(h: PlannedHouse, key: 'eaveHeight' | 'ridgeHeight', v: number): Partial<PlannedHouse> | null {
  if (!Number.isFinite(v) || v <= 0) return null;
  const x = Math.max(PLANNED_MIN_HEIGHT, Math.min(PLANNED_MAX_SIZE, v));
  if (h.roof === 'flat') return { eaveHeight: x, ridgeHeight: x };
  if (key === 'eaveHeight') return x > h.ridgeHeight ? { eaveHeight: x, ridgeHeight: x } : { eaveHeight: x };
  return x < h.eaveHeight ? { eaveHeight: x, ridgeHeight: x } : { ridgeHeight: x };
}

/**
 * 勾配（寸 = 水平 10 に対する立ち上がり）を変える: 最高高さ = 軒高 + 水平距離 × 寸 ÷ 10（切妻・寄棟は奥行の半分、片流れは奥行 + 軒の出）。
 * 陸屋根・負の値・数でなければ null。0 寸は最高高さ = 軒高
 */
export function pitchPatch(h: PlannedHouse, sun: number): Partial<PlannedHouse> | null {
  const r = ridgeFromPitch(h, sun);
  return r == null ? null : { ridgeHeight: r };
}

/** 編集欄の項目 */
export type PlannedField = 'label' | 'preset' | 'width' | 'depth' | 'rotDeg' | 'eaveHeight' | 'ridgeHeight' | 'pitch' | 'roof';

/** 入力欄の値（文字列）→ 変更（受け付けない値は null。入力欄は今の値に戻す） */
export function plannedFieldPatch(h: PlannedHouse, key: PlannedField, raw: string): Partial<PlannedHouse> | null {
  if (key === 'label') return { label: raw.trim().slice(0, PLANNED_LABEL_MAX) };
  if (key === 'preset') return isPlannedPresetId(raw) ? presetPatch(raw) : null;
  if (key === 'roof') return isRoofType(raw) ? roofPatch(h, raw) : null;
  const s = raw.trim();
  const v = s === '' ? NaN : Number(s);
  if (!Number.isFinite(v)) return null;
  if (key === 'width' || key === 'depth') return v > 0 ? { [key]: Math.max(PLANNED_MIN_SIZE, Math.min(PLANNED_MAX_SIZE, v)) } : null;
  if (key === 'rotDeg') return rotatedPatch({ rotDeg: v }, 0);
  if (key === 'pitch') return pitchPatch(h, v);
  return heightPatch(h, key, v);
}

/** 計画の建物と同じ形の箱（幅×奥行×高さ。幅 = 図面の横 = 真北から headingDeg + 90°。奥行 = 図面の上 = headingDeg） */
export function sameShapeHouse(dims: { w: number; d: number; h: number }, headingDeg: number, ce: number, cn: number, label: string): Partial<PlannedHouse> {
  const ht = r2(Math.max(PLANNED_MIN_HEIGHT, dims.h));
  return { ce: r2(ce), cn: r2(cn), width: r2(Math.max(PLANNED_MIN_SIZE, dims.w)), depth: r2(Math.max(PLANNED_MIN_SIZE, dims.d)), rotDeg: rotatedPatch({ rotDeg: headingDeg + 90 }, 0).rotDeg, eaveHeight: ht, ridgeHeight: ht, roof: 'flat', label };
}

/** 寸法の文（「9.1×7.3 m」） */
export function plannedSizeText(h: Pick<PlannedHouse, 'width' | 'depth'>): string {
  return `${fmtM(h.width)}×${fmtM(h.depth)} m`;
}

/** 高さの文（「軒高 6 m／最高 8.5 m・6.8 寸」、陸屋根は「高さ 9.5 m」） */
export function plannedHeightText(h: Pick<PlannedHouse, 'roof' | 'depth' | 'eaveHeight' | 'ridgeHeight'>): string {
  return h.roof === 'flat' ? `高さ ${fmtM(h.ridgeHeight)} m` : `軒高 ${fmtM(h.eaveHeight)} m／最高 ${fmtM(h.ridgeHeight)} m・${fmtM(pitchSun(h))} 寸`;
}

/** プリセットの選択肢の文（「2 階建て（切妻） 9.1×7.3 m・最高 8.5 m」） */
export function presetOptionText(p: PlannedPreset): string {
  return `${p.label}　${plannedSizeText(p)}・${p.roof === 'flat' ? '高さ' : '最高'} ${fmtM(p.ridgeHeight)} m`;
}

function segmentsCross(a: EN, b: EN, c: EN, d: EN): boolean {
  const o = (p: EN, q: EN, r: EN) => (q.e - p.e) * (r.n - p.n) - (q.n - p.n) * (r.e - p.e);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 2 つの輪郭が重なるか（どちらかの頂点が相手の内側にある、または辺どうしが交わる。接するだけは重ならない） */
export function ringsOverlap(a: readonly EN[], b: readonly EN[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  const A = [...a];
  const B = [...b];
  if (A.some((p) => pointInPolygon(p, B)) || B.some((p) => pointInPolygon(p, A))) return true;
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) if (segmentsCross(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
  return false;
}

/** ドラッグ: 掴んだ点（水平面上）の動き → 新しい中心（ワールド x = 東、z = 南。0.01 m に丸める） */
export function draggedCenter(orig: { ce: number; cn: number }, start: { x: number; z: number }, now: { x: number; z: number }): { ce: number; cn: number } {
  return { ce: r2(orig.ce + (now.x - start.x)), cn: r2(orig.cn - (now.z - start.z)) };
}

/** 置いた家が計画の建物・敷地の輪郭に重なっていれば注意の文（無ければ null） */
export function overlapWarning(h: Pick<PlannedHouse, 'ce' | 'cn' | 'rotDeg' | 'width' | 'depth'>, building: readonly EN[] | null, site: readonly EN[] | null): string | null {
  const fp = plannedFootprint(h);
  if (building && ringsOverlap(fp, building)) return '計画の建物と重なっています。ドラッグで隣地へ動かしてください';
  if (site && ringsOverlap(fp, site)) return '敷地の輪郭に重なっています（想定の家は隣地に置きます）。ドラッグで動かせます';
  return null;
}

// ---------------------------------------------------------------------------
// 操作（すべて state を通す = 'neighbors' を 1 回発火 → 古い解析結果を捨てて作り直す）
// ---------------------------------------------------------------------------

/** 置く形: プリセットか、計画の建物と同じ形の箱 */
export type PlannedShape = { kind: 'preset'; id: PlannedPresetId } | { kind: 'same' };

const labelsNow = () => plannedHouses().map((n) => n.planned.label);
const findPlanned = (id: string): PlannedNeighbor | null => plannedHouses().find((n) => n.id === id) ?? null;

/**
 * 想定の家を (e, n)（ピンからの東・北 m）に置く。プリセットは敷地の輪郭（無ければ計画の建物）の向きに揃え、同じ形は計画の建物と同じ向き。
 * 名前は「想定の家 N」。計画の建物が無いのに同じ形を選んだら null
 */
export function placePlanned(shape: PlannedShape, e: number, n: number): PlannedNeighbor | null {
  const label = nextPlannedLabel(labelsNow());
  if (shape.kind === 'same') {
    const placed = study.model ? currentPlaced() : null;
    if (!placed) return null;
    return addPlannedHouse(sameShapeHouse(placed.dimensions(), study.placement.headingDeg, e, n, label));
  }
  const rot = plannedPlacementRotation(sitePolygonEN(), study.model ? study.placement.headingDeg : null);
  return addPlannedHouse(houseFromPreset(shape.id, r2(e), r2(n), rot, { label }));
}

/** 中心を動かす */
export function movePlanned(id: string, ce: number, cn: number): boolean {
  return updatePlannedHouse(id, { ce: r2(ce), cn: r2(cn) });
}

/** 中心をずらす（矢印キー） */
export function nudgePlanned(id: string, de: number, dn: number): boolean {
  const n = findPlanned(id);
  return !!n && movePlanned(id, n.planned.ce + de, n.planned.cn + dn);
}

/** 回す（正 = 上から見て時計回り） */
export function rotatePlanned(id: string, deg: number): boolean {
  const n = findPlanned(id);
  return !!n && updatePlannedHouse(id, rotatedPatch(n.planned, deg));
}

/** 複製（棟の向きに 幅 + 2 m ずらす）。複製した家を返す */
export function duplicatePlannedHouse(id: string): PlannedNeighbor | null {
  const n = findPlanned(id);
  if (!n) return null;
  return addPlannedHouse(duplicatePlanned(n.planned, nextPlannedLabel(labelsNow())));
}

/** 編集欄の 1 項目を反映（受け付けない値・変わらなければ false） */
export function editPlannedField(id: string, key: PlannedField, raw: string): boolean {
  const n = findPlanned(id);
  if (!n) return false;
  const patch = plannedFieldPatch(n.planned, key, raw);
  return !!patch && Object.keys(patch).length > 0 && updatePlannedHouse(id, patch);
}

// ---------------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------------

export interface PlannedEditOptions {
  scene: StudyScene;
  /** 3D の上に重ねるステージ（編集欄を入れる） */
  stage: HTMLElement;
  /** 建物の中心（ワールド）: 一覧の方向・距離の基準 */
  center: () => THREE.Vector3;
  /** 置くモードに入る直前（建物を選んで隠す・測定点の配置を止める、隣家のポップアップを閉じる、周辺建物の表示を入れる） */
  onArm: () => void;
  /** 想定の家を選んだとき（隣家のポップアップを閉じる） */
  onSelect: () => void;
  /** ステージ上部の案内（null で消す） */
  setNote: (t: string | null) => void;
  /** ほかのモード（建物を選んで隠す・測定点を置く）の最中か。最中は 3D の想定の家を選ばない・動かさない */
  blocked: () => boolean;
}

export interface PlannedEdit {
  /** サイドパネルの「想定の家（未建築の隣家）」の欄 */
  el: HTMLElement;
  /** 置くモード中か */
  armed(): boolean;
  /** 置くモード・選択・ドラッグをやめる（ほかのモードに入るとき） */
  stop(): void;
  /** 選んでいる想定の家の id */
  selectedId(): string | null;
  /** 選ぶ（null で外す）。open なら編集欄を開く（at = 画面の位置。無ければ家の上） */
  select(id: string | null, opts?: { open?: boolean; at?: { clientX: number; clientY: number } }): void;
  /** canvas の pointerdown（capture）。想定の家を掴んだ・置くモード中なら true（隣家のポップアップ・測定点の配置を出さない） */
  onPointerDown(e: PointerEvent): boolean;
  onPointerUp(e: PointerEvent): boolean;
  /** キー（入力欄の外）: R / Shift+R・Delete / Backspace・矢印キー。扱ったら true */
  onKey(e: KeyboardEvent): boolean;
  /** Esc: ドラッグの取り消し・置くモードの終了・編集欄を閉じる。何かやめたら true */
  escape(): boolean;
  /** 周辺建物を作り直した後: 一覧・強調・編集欄を今の状態に合わせる */
  refresh(): void;
  dispose(): void;
}

/** 前回選んだ置く形（ステップを出入りしても残す） */
let lastPreset: PlannedPresetId = DEFAULT_PLANNED_PRESET;

interface Press {
  id: string;
  pointerId: number;
  sx: number;
  sy: number;
  plane: THREE.Plane;
  start: THREE.Vector3;
  orig: { ce: number; cn: number };
  active: boolean;
  /** 動かすもの（想定の家のメッシュと強調の線）と、ドラッグ前の位置 */
  objs: { o: THREE.Object3D; base: THREE.Vector3 }[];
  last: { ce: number; cn: number };
}

interface Editor {
  id: string;
  el: HTMLElement;
  sync(force?: HTMLElement): void;
}

export function createPlannedEdit(opts: PlannedEditOptions): PlannedEdit {
  const { scene, stage } = opts;
  const canvas = scene.renderer.domElement;
  let arm: PlannedShape | null = null;
  let armDown: { x: number; y: number; pointerId: number } | null = null;
  let sel: string | null = null;
  let press: Press | null = null;
  let editor: Editor | null = null;
  // 選択の強調（選んでいる間だけ scene.groups.select に入れる。ほかのモードの「select が空」の前提を崩さない）
  const hl = new THREE.Group();
  hl.name = 'planned-highlight';
  const edgeMat = new THREE.LineBasicMaterial({ color: SEL_COLOR, toneMapped: false, depthTest: false, transparent: true, opacity: 0.95 });

  const baseCursor = () => (arm ? 'crosshair' : scene.navMode === 'pan' ? 'grab' : '');
  const whereOf = (n: PlannedNeighbor) => neighborWhere(n, buildingFootprintEN(), worldToEN(opts.center())).text;
  const nameOf = (n: PlannedNeighbor) => n.planned.label ?? PLANNED_DEFAULT_LABEL;

  // ---- 3D のメッシュ・強調 ----
  /** 想定の家のメッシュ（表示だけ隠した建物の影だけのメッシュは除く） */
  const meshesOf = (id: string): THREE.Mesh[] => {
    const out: THREE.Mesh[] = [];
    scene.groups.neighbors.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.userData?.planned && !m.userData.shadowOnly && m.userData.neighborId === id) out.push(m);
    });
    return out;
  };
  const paintSel = () => {
    clearGroup(hl);
    if (sel) {
      for (const m of meshesOf(sel)) {
        m.updateMatrixWorld(true);
        const l = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 20), edgeMat);
        l.applyMatrix4(m.matrixWorld);
        l.renderOrder = 6;
        l.raycast = () => {};
        l.userData = { plannedHighlight: true, neighborId: sel, noShadow: true, overlay: true, sharedMaterial: true };
        hl.add(l);
      }
    }
    if (hl.children.length) {
      if (hl.parent !== scene.groups.select) scene.groups.select.add(hl);
    } else hl.parent?.remove(hl);
    scene.invalidate();
  };

  /** 画面上の位置（client 座標）。家の足元の中心・高さの中ほどを投影。カメラの後ろ・見えなければ null */
  const screenOf = (n: PlannedNeighbor): { clientX: number; clientY: number } | null => {
    const ms = meshesOf(n.id);
    let y = n.planned.ridgeHeight / 2;
    if (ms.length) {
      const bb = new THREE.Box3();
      for (const m of ms) bb.expandByObject(m);
      y = (bb.min.y + bb.max.y) / 2;
    }
    const v = new THREE.Vector3(n.planned.ce, y, -n.planned.cn);
    scene.camera.updateMatrixWorld();
    if (v.clone().applyMatrix4(scene.camera.matrixWorldInverse).z >= 0) return null;
    v.project(scene.camera);
    if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    const r = canvas.getBoundingClientRect();
    return { clientX: r.left + ((v.x + 1) / 2) * r.width, clientY: r.top + ((1 - v.y) / 2) * r.height };
  };

  // ---- 編集欄（3D の上に浮かぶ） ----
  const closeEditor = () => {
    editor?.el.remove();
    editor = null;
  };
  const placeEditor = (el: HTMLElement, at: { clientX: number; clientY: number } | null) => {
    const r = stage.getBoundingClientRect();
    const w = el.offsetWidth || 320;
    const hgt = el.offsetHeight || 360;
    const x = at ? at.clientX - r.left + 14 : r.width - w - 16;
    const y = at ? at.clientY - r.top + 10 : 120;
    el.style.left = `${Math.max(8, Math.min(r.width - w - 8, x))}px`;
    el.style.top = `${Math.max(8, Math.min(r.height - hgt - 8, y))}px`;
  };
  const numIn = (min: number, max: number, step: number, title?: string) => h('input', { type: 'number', min, max, step, title }) as HTMLInputElement;
  const openEditor = (id: string, at: { clientX: number; clientY: number } | null) => {
    closeEditor();
    const n0 = findPlanned(id);
    if (!n0) return;
    const title = h('span');
    const where = h('div', { class: 'hint planned-where' });
    const nameIn = h('input', { type: 'text', class: 'planned-name', maxlength: String(PLANNED_LABEL_MAX), placeholder: PLANNED_DEFAULT_LABEL }) as HTMLInputElement;
    const presetSel = h(
      'select',
      { class: 'planned-preset', title: '形を選ぶと寸法・高さ・屋根をその形にします（位置・向き・名前はそのまま）' },
      h('option', { value: '' }, '—（寸法を直接入力）'),
      ...PLANNED_PRESETS.map((p) => h('option', { value: p.id }, p.label)),
    ) as HTMLSelectElement;
    const wIn = numIn(PLANNED_MIN_SIZE, PLANNED_MAX_SIZE, 0.1, '棟（長手）の向きの長さ');
    const dIn = numIn(PLANNED_MIN_SIZE, PLANNED_MAX_SIZE, 0.1);
    const rIn = numIn(0, 359.99, 1, '棟（長手）の方位。真北から時計回り（0 = 南北、90 = 東西）');
    const eIn = numIn(PLANNED_MIN_HEIGHT, PLANNED_MAX_SIZE, 0.1, '壁の線での屋根の上面の高さ（片流れは低い側）');
    const hIn = numIn(PLANNED_MIN_HEIGHT, PLANNED_MAX_SIZE, 0.1, 'いちばん高い所（棟・片流れの高い側）');
    const pIn = numIn(0, PITCH_MAX_SUN, 0.5, '屋根の勾配（寸 = 水平 10 に対する立ち上がり。4 寸 ≈ 21.8°）。入れると最高高さを計算します');
    const roofSel = h('select', { class: 'planned-roof' }, ...ROOF_TYPES.map((r) => h('option', { value: r }, ROOF_LABEL[r]))) as HTMLSelectElement;
    const inputs: [PlannedField, HTMLInputElement | HTMLSelectElement][] = [
      ['label', nameIn],
      ['preset', presetSel],
      ['width', wIn],
      ['depth', dIn],
      ['rotDeg', rIn],
      ['eaveHeight', eIn],
      ['ridgeHeight', hIn],
      ['pitch', pIn],
      ['roof', roofSel],
    ];
    /** 今の値を入力欄に書く（入力中の欄は飛ばす。force の欄は入力中でも書く = 反映した直後・受け付けなかった値を戻す） */
    const sync = (force?: HTMLElement) => {
      const n = findPlanned(id);
      if (!n) return;
      const p = n.planned;
      title.textContent = nameOf(n);
      where.textContent = `${whereOf(n)}・${ROOF_LABEL[p.roof]}・${plannedSizeText(p)}・${plannedHeightText(p)}`;
      const val: Record<PlannedField, string> = {
        label: p.label ?? '',
        preset: p.preset ?? '',
        width: fmtM(p.width),
        depth: fmtM(p.depth),
        rotDeg: fmtM(p.rotDeg),
        eaveHeight: fmtM(p.eaveHeight),
        ridgeHeight: fmtM(p.ridgeHeight),
        pitch: fmtM(pitchSun(p)),
        roof: p.roof,
      };
      for (const [k, el] of inputs) if (el === force || document.activeElement !== el || k === 'preset' || k === 'roof') el.value = val[k];
      // 陸屋根は軒高 = 最高高さ（軒高は最高高さと同じ値で動く）
      eIn.disabled = p.roof === 'flat';
      pIn.disabled = p.roof === 'flat';
    };
    for (const [k, el] of inputs)
      el.addEventListener('change', () => {
        editPlannedField(id, k, el.value);
        // 反映した値（丸め・上限下限）か、受け付けなかったときは今の値を見せる（Enter で確定して入力欄に残っていても）
        if (editor?.id === id) editor.sync(el);
      });
    const el = h(
      'div',
      { class: 'pop planned-pop', 'data-id': id },
      h('h5', null, title, h('span', { class: 'src-tag planned' }, '想定（未建築）')),
      where,
      h(
        'div',
        { class: 'planned-grid' },
        h('div', { class: 'span2' }, field('名前', nameIn)),
        h('div', { class: 'span2' }, field('形', presetSel)),
        field('幅 m', wIn),
        field('奥行 m', dIn),
        field('向き °', rIn),
        field('屋根', roofSel),
        field('軒高 m', eIn),
        field('最高高さ m', hIn),
        field('勾配 寸', pIn),
        h('div', { class: 'hint span-rest' }, '勾配を入れると最高高さを計算します（切妻・寄棟は奥行の半分、片流れは奥行＋軒の出が水平距離）。最高高さを直すと勾配が変わります'),
      ),
      h(
        'div',
        { class: 'row', style: 'flex-wrap:wrap' },
        h('button', { class: 'btn sm', title: '上から見て反時計回りに 90°（Shift+R）', onclick: () => void rotatePlanned(id, -90) }, '↺ 90°'),
        h('button', { class: 'btn sm', title: '上から見て時計回りに 90°（R）', onclick: () => void rotatePlanned(id, 90) }, '↻ 90°'),
        h('button', { class: 'btn sm', title: `棟の向きに 幅 + ${PLANNED_DUP_GAP} m ずらして同じ家を置きます（分譲地で並ぶ家）`, onclick: () => duplicateSel(id) }, '複製'),
        h('button', { class: 'btn sm', title: 'この想定の家を消します（Delete）', onclick: () => deleteHouse(id) }, '削除'),
        h('button', { class: 'btn sm ghost', onclick: () => select(null) }, '閉じる'),
      ),
      h('div', { class: 'hint planned-keys' }, PLANNED_KEYS_HELP),
    );
    // 入力欄の中の Esc は編集欄を閉じる（入力欄の外の Esc は simStep が escape() を呼ぶ）
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      select(null);
    });
    editor = { id, el, sync };
    sync();
    stage.appendChild(el);
    placeEditor(el, at ?? screenOf(n0));
  };

  // ---- 選択 ----
  const select = (id: string | null, o: { open?: boolean; at?: { clientX: number; clientY: number } } = {}) => {
    if (id && !findPlanned(id)) id = null;
    if (id) opts.onSelect();
    const changed = id !== sel;
    sel = id;
    if (!id) closeEditor();
    else if (o.open) openEditor(id, o.at ?? null);
    else if (editor && editor.id !== id) closeEditor();
    if (changed) paintSel();
    renderList();
  };

  // ---- 操作 ----
  const deleteHouse = (id: string) => {
    const n = findPlanned(id);
    if (!n) return;
    const name = nameOf(n);
    if (sel === id) select(null);
    if (removePlannedHouse(id)) toast(`「${name}」を削除しました`, 'ok');
  };
  const duplicateSel = (id: string) => {
    const nb = duplicatePlannedHouse(id);
    if (!nb) return;
    const wasOpen = !!editor;
    select(nb.id, { open: wasOpen, at: undefined });
    toast(`「${nameOf(nb)}」を隣に複製しました（棟の向きに 幅 + ${PLANNED_DUP_GAP} m。ドラッグで動かせます）`, 'ok');
    const w = overlapWarning(nb.planned, buildingExclusionEN(), sitePolygonEN());
    if (w) toast(w, 'info', 8000);
  };

  /** 置くモード */
  const armBtn = h('button', { class: 'btn sm planned-arm' }, PLANNED_ARM_LABEL) as HTMLButtonElement;
  const sameBtn = h('button', { class: 'btn sm planned-same' }, PLANNED_SAME_LABEL) as HTMLButtonElement;
  const presetSel = h(
    'select',
    { class: 'planned-preset-select', title: '置く家の形（寸法は一般的な建売・分譲住宅の目安。置いた後にクリックで直せます）' },
    ...PLANNED_PRESETS.map((p) => h('option', { value: p.id, selected: p.id === lastPreset }, presetOptionText(p))),
  ) as HTMLSelectElement;
  const shapeLabel = (s: PlannedShape) => (s.kind === 'same' ? '計画の建物と同じ形（箱）' : plannedPreset(s.id).label);
  const setArm = (next: PlannedShape | null) => {
    if (next && !arm) {
      opts.onArm();
      // 含めない設定のままだと置いても見えないので、含める
      if (!study.plannedEnabled) {
        setPlannedEnabled(true);
        toast('「想定の建物を含める」を入れました（置いた家を影・解析に含めます）', 'info');
      }
    }
    arm = next;
    armDown = null;
    armBtn.classList.toggle('dark', arm?.kind === 'preset');
    armBtn.textContent = arm?.kind === 'preset' ? PLANNED_ARM_ACTIVE : PLANNED_ARM_LABEL;
    sameBtn.classList.toggle('dark', arm?.kind === 'same');
    sameBtn.textContent = arm?.kind === 'same' ? PLANNED_SAME_ACTIVE : PLANNED_SAME_LABEL;
    canvas.style.cursor = baseCursor();
    opts.setNote(arm ? `地面をクリックすると「${shapeLabel(arm)}」を置きます（続けて置けます・Esc で終了）` : null);
  };
  const toggleArm = (s: PlannedShape) => {
    const same = arm && arm.kind === s.kind;
    if (same) {
      setArm(null);
      return;
    }
    const first = !arm;
    setArm(s);
    if (first)
      toast(
        `地面（航空写真）をクリックすると「${shapeLabel(s)}」を置きます。続けて何棟でも置けます。置いた家はドラッグで動かし、クリックで寸法・向き・屋根を直せます（R／Shift+R で 90° 回転・Delete で削除）。既存の家の屋根をクリックするとその真下に置きます（取り壊す家は「建物を選んで隠す」で外してください）。Esc で終了`,
        'info',
        8000,
      );
  };
  armBtn.addEventListener('click', () => toggleArm({ kind: 'preset', id: isPlannedPresetId(presetSel.value) ? presetSel.value : DEFAULT_PLANNED_PRESET }));
  sameBtn.addEventListener('click', () => {
    if (!study.model || !currentPlaced()) {
      toast('建物の 3D データを読み込むと使えます');
      return;
    }
    toggleArm({ kind: 'same' });
  });
  presetSel.addEventListener('change', () => {
    if (isPlannedPresetId(presetSel.value)) lastPreset = presetSel.value;
    if (arm?.kind === 'preset') setArm({ kind: 'preset', id: lastPreset });
  });

  /** 地面のクリックで置く（既存の建物の屋根ならその真下の地面） */
  const placeAt = (e: PointerEvent) => {
    if (!arm) return;
    const hit = scene.pick(scene.ndcFromEvent(e), [scene.groups.neighbors, scene.groups.building, scene.groups.terrain]);
    if (!hit) {
      toast('地面（航空写真）の上をクリックしてください');
      return;
    }
    for (let p: THREE.Object3D | null = hit.object; p; p = p.parent)
      if (p === scene.groups.building) {
        toast('計画の建物の上には置けません。地面（航空写真）をクリックしてください');
        return;
      }
    const en = worldToEN(hit.point);
    const nb = placePlanned(arm, en.e, en.n);
    if (!nb) {
      toast('建物の 3D データを読み込むと使えます');
      return;
    }
    // 置いた家を選ぶ（R で回転・Delete で削除。編集欄はクリックで開く）
    select(nb.id);
    const p = nb.planned;
    toast(`「${nameOf(nb)}」（${shapeLabel(arm)}・${plannedSizeText(p)}・${plannedHeightText(p)}）を置きました。続けてクリックで置けます`, 'ok');
    const w = overlapWarning(p, buildingExclusionEN(), sitePolygonEN());
    if (w) toast(w, 'info', 8000);
  };

  // ---- ドラッグ（3 px 動いてから。水平面上で掴んだ点が付いてくる） ----
  const pickPlanned = (e: { clientX: number; clientY: number }): { id: string; point: THREE.Vector3 } | null => {
    const hit = scene.pick(scene.ndcFromEvent(e), [scene.groups.neighbors, scene.groups.building, scene.groups.terrain]);
    const ud = hit?.object.userData;
    if (!hit || !ud?.planned || ud.shadowOnly || typeof ud.neighborId !== 'string') return null;
    return { id: ud.neighborId, point: hit.point.clone() };
  };
  const planePoint = (e: { clientX: number; clientY: number }, plane: THREE.Plane): THREE.Vector3 | null => {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(scene.ndcFromEvent(e), scene.camera);
    const out = new THREE.Vector3();
    return rc.ray.intersectPlane(plane, out) ? out : null;
  };
  const releasePress = () => {
    const p = press;
    if (!p) return;
    press = null;
    try {
      canvas.releasePointerCapture(p.pointerId);
    } catch {
      /* 既に解放 */
    }
    scene.controls.enabled = true;
    canvas.style.cursor = baseCursor();
  };
  /** ドラッグを取り消して元の位置に戻す（Esc・2 本目の指） */
  const cancelPress = () => {
    if (!press) return;
    for (const { o, base } of press.objs) o.position.copy(base);
    releasePress();
    scene.invalidate();
  };
  const onMove = (e: PointerEvent) => {
    if (press && e.pointerId === press.pointerId) {
      if (!press.active) {
        if (Math.hypot(e.clientX - press.sx, e.clientY - press.sy) <= PLANNED_CLICK_PX) return;
        press.active = true;
        canvas.style.cursor = 'move';
      }
      const pt = planePoint(e, press.plane);
      if (!pt) return;
      press.last = draggedCenter(press.orig, press.start, pt);
      const dx = press.last.ce - press.orig.ce;
      const dz = -(press.last.cn - press.orig.cn);
      for (const { o, base } of press.objs) o.position.set(base.x + dx, base.y, base.z + dz);
      scene.invalidate();
      return;
    }
    hover(e);
  };
  // 想定の家の上ではカーソルを「移動」に（ドラッグで動かせることを示す）。間引いて調べる
  let hoverAt = 0;
  const hover = (e: PointerEvent) => {
    if (e.buttons || e.pointerType === 'touch' || opts.blocked()) return;
    const now = performance.now();
    if (now - hoverAt < 80) return;
    hoverAt = now;
    const want = pickPlanned(e) ? 'move' : baseCursor();
    if (canvas.style.cursor !== want) canvas.style.cursor = want;
  };
  // 取り消し（pointercancel）・ポインタの捕捉が外れた（離す前に別のウィンドウへ移ったなど）: 元の位置に戻し、視点の操作を戻す
  const onCancel = (e: PointerEvent) => {
    if (press && e.pointerId === press.pointerId) cancelPress();
    if (armDown && e.pointerId === armDown.pointerId) armDown = null;
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('lostpointercapture', onCancel);

  const onPointerDown = (e: PointerEvent): boolean => {
    if (opts.blocked()) return false;
    if (press) {
      // 2 本目のポインタ（タッチのピンチ）: 家を動かさず、視点の操作に任せる
      cancelPress();
      armDown = null;
      return false;
    }
    if (armDown && e.pointerId !== armDown.pointerId) {
      armDown = null;
      return false;
    }
    if (e.button !== 0) return false;
    const hit = pickPlanned(e);
    if (hit) {
      const n = findPlanned(hit.id);
      if (!n) return false;
      // 掴んだ点の高さの水平面で動かす（掴んだ所がポインタに付いてくる）
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y);
      e.preventDefault();
      e.stopImmediatePropagation();
      scene.controls.enabled = false;
      const objs = [...meshesOf(hit.id), ...(sel === hit.id ? hl.children : [])].map((o) => ({ o, base: o.position.clone() }));
      const orig = { ce: n.planned.ce, cn: n.planned.cn };
      press = { id: hit.id, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, plane, start: hit.point, orig, active: false, objs, last: orig };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* 古い環境 */
      }
      armDown = null;
      return true;
    }
    if (arm) {
      // 置くモード: クリックで置く。ドラッグ（回転・移動）は視点の操作にそのまま渡す
      armDown = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      return true;
    }
    return false;
  };

  const onPointerUp = (e: PointerEvent): boolean => {
    if (press && e.pointerId === press.pointerId) {
      const p = press;
      releasePress();
      if (!p.active) {
        // クリック: 選んで編集欄を開く
        select(p.id, { open: true, at: { clientX: e.clientX, clientY: e.clientY } });
        return true;
      }
      if (p.last.ce === p.orig.ce && p.last.cn === p.orig.cn) {
        for (const { o, base } of p.objs) o.position.copy(base);
        scene.invalidate();
        return true;
      }
      // 離したときに 1 回だけ書く（'neighbors' → 古い解析結果を捨てて作り直す → refresh で強調も作り直す）
      if (sel !== p.id) select(p.id);
      movePlanned(p.id, p.last.ce, p.last.cn);
      const n = findPlanned(p.id);
      const w = n ? overlapWarning(n.planned, buildingExclusionEN(), sitePolygonEN()) : null;
      if (w) toast(w, 'info', 8000);
      return true;
    }
    if (armDown && e.pointerId === armDown.pointerId) {
      const d = armDown;
      armDown = null;
      if (e.button === 0 && isClickMove(d, { x: e.clientX, y: e.clientY })) placeAt(e);
      return true;
    }
    return false;
  };

  const onKey = (e: KeyboardEvent): boolean => {
    if (!sel || press) return false;
    const id = sel;
    switch (e.key) {
      case 'r':
      case 'R':
        rotatePlanned(id, e.shiftKey ? -90 : 90);
        return true;
      case 'Delete':
      case 'Backspace':
        deleteHouse(id);
        return true;
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight': {
        const s = e.shiftKey ? 1 : 0.1;
        const de = e.key === 'ArrowRight' ? s : e.key === 'ArrowLeft' ? -s : 0;
        const dn = e.key === 'ArrowUp' ? s : e.key === 'ArrowDown' ? -s : 0;
        nudgePlanned(id, de, dn);
        return true;
      }
      default:
        return false;
    }
  };

  const escape = (): boolean => {
    let did = false;
    if (press) {
      cancelPress();
      did = true;
    }
    if (arm) {
      setArm(null);
      did = true;
    }
    if (sel || editor) {
      select(null);
      did = true;
    }
    return did;
  };

  // ---- サイドパネル: 一覧・含める ----
  const listEl = h('div', { class: 'planned-list' });
  const includeCb = h('input', { type: 'checkbox', checked: study.plannedEnabled }) as HTMLInputElement;
  includeCb.addEventListener('change', () => {
    const on = includeCb.checked;
    // 含めないと 3D に描かないので、選択・編集欄は閉じる（一覧の描き直しで checked が戻らないように値は先に読む）
    if (!on) select(null);
    setPlannedEnabled(on);
    includeCb.checked = study.plannedEnabled;
  });
  const offNote = h('p', { class: 'hint planned-off' }, '今は想定の家を 3D に描かず、影・日照の解析・日影図にも入れていません（一覧には残ります。レポート・日影図の注記には「今は含めていません」と書きます）。');
  const renderList = () => {
    clear(listEl);
    includeCb.checked = study.plannedEnabled;
    offNote.style.display = study.plannedEnabled ? 'none' : '';
    sameBtn.disabled = !study.model;
    sameBtn.title = study.model ? '計画の建物の幅×奥行×高さの箱を、計画の建物と同じ向きで置きます（同じ形の家が並ぶ分譲地の想定）' : '建物の 3D データを読み込むと使えます';
    const list = plannedHouses();
    listEl.appendChild(h('div', { class: 'field-label', style: 'margin-top:8px' }, `置いた想定の家: ${list.length} 棟`));
    if (!list.length) {
      listEl.appendChild(h('p', { class: 'hint' }, 'まだ置いていません。'));
      return;
    }
    for (const n of list) {
      const p = n.planned;
      const hidden = !!n.hidden;
      listEl.appendChild(
        h(
          'div',
          { class: `nb-row planned-row${n.id === sel ? ' sel' : ''}${study.plannedEnabled ? '' : ' off'}`, 'data-id': n.id },
          h('div', null, h('b', null, nameOf(n)), h('span', { class: 'src-tag planned' }, '想定'), hidden ? h('span', { class: 'meta' }, n.hideMode === 'view' ? '（表示だけ隠しています）' : '（計算から除外しています）') : null),
          h('div', { class: 'meta planned-meta' }, `${plannedSizeText(p)}・${plannedHeightText(p)}・${ROOF_LABEL[p.roof]}・${whereOf(n)}`),
          h(
            'div',
            { class: 'btn-row', style: 'margin:4px 0 0' },
            h('button', { class: 'btn sm', title: '3D の上に編集欄を開きます（3D で家をクリックしても開きます）', onclick: () => select(n.id, { open: true }) }, '編集'),
            h('button', { class: 'btn sm ghost', onclick: () => deleteHouse(n.id) }, '削除'),
          ),
        ),
      );
    }
    if (list.length >= 2)
      listEl.appendChild(
        h(
          'div',
          { class: 'btn-row', style: 'margin:4px 0 0' },
          h(
            'button',
            {
              class: 'btn sm ghost',
              onclick: () => {
                select(null);
                const k = clearPlannedHouses();
                if (k) toast(`想定の家 ${k} 棟をすべて消しました`, 'ok');
              },
            },
            '想定の家をすべて消す',
          ),
        ),
      );
  };

  const el = h(
    'div',
    { class: 'planned-section' },
    h('div', { class: 'field-label', style: 'margin-top:12px' }, PLANNED_SECTION_TITLE),
    h(
      'p',
      { class: 'hint' },
      '分譲地などで隣の家がまだ建っていないときに、建った想定の家を置きます。置いた家は影・日照時間マップ・測定点・日影図に入り、レポートと日影図の注記に「想定で置いた建物 N 棟（未建築・仮の形状）」と書きます。',
    ),
    field('置く形', presetSel),
    h('div', { class: 'btn-row' }, armBtn, sameBtn),
    listEl,
    h('label', { class: 'check' }, includeCb, PLANNED_INCLUDE_LABEL),
    offNote,
  );

  const refresh = () => {
    if (sel && !findPlanned(sel)) sel = null;
    if (editor && (!sel || editor.id !== sel)) closeEditor();
    // ドラッグ中に作り直された（別の操作で 'neighbors'）: 掴んでいたメッシュは捨てられたので取り消す
    if (press) releasePress();
    paintSel();
    editor?.sync();
    renderList();
  };

  renderList();

  return {
    el,
    armed: () => !!arm,
    stop() {
      cancelPress();
      if (arm) setArm(null);
      select(null);
    },
    selectedId: () => sel,
    select,
    onPointerDown,
    onPointerUp,
    onKey,
    escape,
    refresh,
    dispose() {
      cancelPress();
      if (arm) setArm(null);
      closeEditor();
      sel = null;
      clearGroup(hl);
      hl.parent?.remove(hl);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('lostpointercapture', onCancel);
      edgeMat.dispose();
      if (canvas.style.cursor === 'move') canvas.style.cursor = baseCursor();
      scene.invalidate();
    },
  };
}
