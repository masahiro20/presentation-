/**
 * 標準仕様（納まり）
 * パースの「線の少なさ」「統一感」は建具・窓・照明の納まりで決まるため、
 * 仕上げ（テイスト）とは別に工務店の標準仕様として管理する。
 */

export interface BuilderSpec {
  id: string;
  name: string;
  description: string;
  doors: {
    /** 天井までの高さの扉（上枠・下がり壁なし） */
    fullHeight: boolean;
    /** ステルス枠 = 枠が壁内に隠れ見えない / インセット枠 = 扉と同色の細い枠 / 一般的な三方枠 */
    frame: 'stealth' | 'inset' | 'casing';
    /** 扉厚 (mm) */
    thickness: number;
    /** 扉と天井のすき間 (mm) */
    topGap: number;
    handle: 'slim-lever' | 'lever';
    /** ハンドル色 */
    handleColor: string;
  };
  windows: {
    /** サッシ上端を天井高にそろえる */
    headAtCeiling: boolean;
    /** 室内側の枠: 塗り回し（枠なし）/ 額縁 */
    interiorReveal: 'plaster' | 'trim';
    /** 窓台（膳板） */
    sillBoard: boolean;
  };
  /** カーテン: 天井埋込のカーテンボックス / レール露出 / なし */
  curtains: 'pocket' | 'rail' | 'none';
  /** 照明: ダウンライト（天井をすっきり） / シーリングライト */
  lighting: 'downlight' | 'ceiling';
  /** 間接照明（天井際のコーブ照明） */
  indirectLighting: boolean;
  /** 巾木: 入り巾木（ほぼ見えない）/ 一般 */
  baseboard: 'recessed' | 'standard';
  /**
   * 吹抜に面する上階の縁（落下防止）: 'rail' = 鉄骨手すり（黒の細いフラットバーのフレーム＋横桟 1 本。御社の標準）／'half' = 腰壁 H1100／
   * 'glass' = ガラス手すり（細い支柱＋ガラス）／'halfGlass' = 腰壁 H900 ＋ ガラス H300／'wall' = 天井までの壁（吹抜を見せない）
   */
  voidGuard: VoidGuardSpec;
}
export type VoidGuardSpec = 'rail' | 'half' | 'glass' | 'halfGlass' | 'wall';
/** 家全体の吹抜の縁の選択肢（画面の並び順: 御社で多い順） */
export const VOID_GUARD_SPECS: { value: VoidGuardSpec; label: string; note: string }[] = [
  { value: 'rail', label: '鉄骨手すり', note: '黒の細いフラットバーのフレームに横桟 1 本（御社の標準）' },
  { value: 'half', label: '腰壁', note: '壁と同じ仕上げの腰壁 H1100' },
  { value: 'glass', label: 'ガラス手すり', note: '細い支柱に透明なガラス。吹抜の抜けを邪魔しない' },
  { value: 'halfGlass', label: '腰壁＋ガラス', note: '腰壁 H900 の上にガラス H300' },
  { value: 'wall', label: '壁', note: '天井までの壁（吹抜を見せない）' },
];

export const BUILDER_SPECS: BuilderSpec[] = [
  {
    id: 'minimal-lines',
    name: '線の少ない空間（標準）',
    description: 'KAMIYA フルハイトドア（ステルス枠・扉厚40mm）、サッシ高さ＝天井高、窓は塗り回し、カーテンボックス、ダウンライト。線を減らした統一感のある空間。',
    doors: { fullHeight: true, frame: 'stealth', thickness: 40, topGap: 6, handle: 'slim-lever', handleColor: '#2a2a2a' },
    windows: { headAtCeiling: true, interiorReveal: 'plaster', sillBoard: false },
    curtains: 'pocket',
    lighting: 'downlight',
    indirectLighting: true,
    baseboard: 'recessed',
    voidGuard: 'rail',
  },
  {
    id: 'standard',
    name: '一般的な仕様（比較用）',
    description: '高さ2mの扉と三方枠、下がり壁、額縁・窓台、カーテンレール、シーリングライト。',
    doors: { fullHeight: false, frame: 'casing', thickness: 36, topGap: 0, handle: 'lever', handleColor: '#b9b9b9' },
    windows: { headAtCeiling: false, interiorReveal: 'trim', sillBoard: true },
    curtains: 'rail',
    lighting: 'ceiling',
    indirectLighting: false,
    baseboard: 'standard',
    voidGuard: 'half',
  },
];

/** 以前の版で保存したプロジェクトの仕様 id（名前を変えたもの） */
const LEGACY_SPEC_IDS: Record<string, string> = { homelandick: 'minimal-lines' };

export function specById(id: string | undefined): BuilderSpec {
  const key = id ? LEGACY_SPEC_IDS[id] ?? id : id;
  return BUILDER_SPECS.find((s) => s.id === key) ?? BUILDER_SPECS[0];
}

/** 仕様を反映した開口部の高さ (mm) */
export function effectiveOpening(
  o: { kind: string; sill: number; height: number; windowStyle?: string; heightFrom?: string; interior?: boolean },
  ceilingHeight: number,
  spec: BuilderSpec,
): { sill: number; height: number } {
  if (o.kind === 'window') {
    // 立面図・設計の 3D データで分かった高さは図面どおり（仕様でそろえ直さない）。室内窓も外のサッシの納まりには合わせない
    if (!spec.windows.headAtCeiling || o.heightFrom || o.interior) return { sill: o.sill, height: o.height };
    // 上端を天井にそろえる（腰高は元の値、ただし小窓・高窓は高さを保って上に寄せる）
    if (o.windowStyle === 'small' || o.windowStyle === 'high') {
      const h = Math.min(o.height, ceilingHeight - 300);
      return { sill: ceilingHeight - h, height: h };
    }
    const sill = Math.min(o.sill, ceilingHeight - 400);
    return { sill, height: ceilingHeight - sill };
  }
  if (o.kind === 'entrance') return { sill: 0, height: Math.max(o.height, spec.doors.fullHeight ? 2400 : o.height) };
  if (spec.doors.fullHeight) return { sill: 0, height: ceilingHeight };
  return { sill: o.sill, height: o.height };
}

/** 案件ごとの細かな調整 */
export interface SpecPatch {
  fullHeightDoors?: boolean;
  windowHeadAtCeiling?: boolean;
  indirectLighting?: boolean;
  curtains?: BuilderSpec['curtains'];
  /** 室内ドアの色（未指定なら内観テイストの色） */
  doorColor?: string;
  /** 天井高 (mm)。未指定なら図面・入力値 */
  ceilingHeight?: number;
  /** 吹抜に面する上階の縁（手すり／腰壁／腰壁＋ガラス／壁） */
  voidGuard?: BuilderSpec['voidGuard'];
}

export function resolveSpec(id: string | undefined, patch: SpecPatch | undefined): BuilderSpec {
  const base = specById(id);
  if (!patch) return base;
  return {
    ...base,
    doors: {
      ...base.doors,
      fullHeight: patch.fullHeightDoors ?? base.doors.fullHeight,
      frame: patch.fullHeightDoors === false && base.doors.frame === 'stealth' ? 'inset' : base.doors.frame,
    },
    windows: { ...base.windows, headAtCeiling: patch.windowHeadAtCeiling ?? base.windows.headAtCeiling },
    indirectLighting: patch.indirectLighting ?? base.indirectLighting,
    curtains: patch.curtains ?? base.curtains,
    voidGuard: patch.voidGuard ?? base.voidGuard,
  };
}
