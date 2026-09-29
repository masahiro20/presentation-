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
}

export const BUILDER_SPECS: BuilderSpec[] = [
  {
    id: 'homelandick',
    name: 'ホームランディック標準',
    description: 'KAMIYA フルハイトドア（ステルス枠・扉厚40mm）、サッシ高さ＝天井高、窓は塗り回し、カーテンボックス、ダウンライト。線を減らした統一感のある空間。',
    doors: { fullHeight: true, frame: 'stealth', thickness: 40, topGap: 6, handle: 'slim-lever', handleColor: '#2a2a2a' },
    windows: { headAtCeiling: true, interiorReveal: 'plaster', sillBoard: false },
    curtains: 'pocket',
    lighting: 'downlight',
    indirectLighting: true,
    baseboard: 'recessed',
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
  },
];

export function specById(id: string | undefined): BuilderSpec {
  return BUILDER_SPECS.find((s) => s.id === id) ?? BUILDER_SPECS[0];
}

/** 仕様を反映した開口部の高さ (mm) */
export function effectiveOpening(
  o: { kind: string; sill: number; height: number; windowStyle?: string },
  ceilingHeight: number,
  spec: BuilderSpec,
): { sill: number; height: number } {
  if (o.kind === 'window') {
    if (!spec.windows.headAtCeiling) return { sill: o.sill, height: o.height };
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
