/**
 * 周辺建物の屋根の編集欄（建物クリックのポップアップに入れる）。PLATEAU の建物（mesh と属性がある）だけ。
 * 屋根の形（寄棟・切妻・片流れ・陸屋根）・切妻の棟の向き・片流れの高い側・階数・階高・軒高（陸屋根は屋上面）・棟高（陸屋根はパラペットの天端）。
 * 階数 × 階高 = 軒高（階数か階高を直すと軒高を、軒高を直すと階高を計算）。「推定に戻す」で自動の推定に戻す。
 */
import { HIGH_SIDES, HIGH_SIDE_LABEL, ROOF_KINDS, ROOF_KIND_LABEL, normalizeSpec } from '../sun/plateau';
import type { HighSide, PlateauAttrs, RoofKind, RoofSpec } from '../sun/plateau';
import { field, h } from './dom';

/** 編集欄に必要な建物の欄（日照ツールの Neighbor・プレゼンの NeighborBuilding 共通） */
export interface RoofEditable {
  plateau?: PlateauAttrs;
  mesh?: unknown;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** 編集欄の初期値: 今の屋根（推定・手入力）、無ければ箱（陸屋根・屋上 = 箱の高さ） */
export function initialRoofSpec(n: Pick<RoofEditable, 'plateau'>): RoofSpec | null {
  const a = n.plateau;
  if (!a) return null;
  if (a.roofEstimate) return { ...a.roofEstimate };
  const box = a.zmax - a.zmin;
  return { kind: 'flat', eave: r2(box), ridge: r2(box), boxHeight: r2(box), parapet: 0, ...(a.storeys ? { storeys: a.storeys, floorH: r2(box / a.storeys) } : {}) };
}

export interface RoofEditor {
  el: HTMLElement;
  /** 入力欄の今の値を仕様にする（数が壊れていれば null） */
  read: () => RoofSpec | null;
}

export function createRoofEditor(n: RoofEditable, hasOverride: boolean, onApply: (spec: RoofSpec) => void, onReset: () => void): RoofEditor | null {
  const init = initialRoofSpec(n);
  if (!init || !n.mesh) return null;
  const num = (v: number | undefined, step: number, min = 0, max = 300) => h('input', { type: 'number', value: v == null ? '' : String(v), min, max, step, style: 'width:100%;box-sizing:border-box' }) as HTMLInputElement;
  const kindSel = h('select', { style: 'width:100%' }, ...ROOF_KINDS.map((k) => h('option', { value: k, selected: k === init.kind }, ROOF_KIND_LABEL[k]))) as HTMLSelectElement;
  const dirSel = h('select', { style: 'width:100%' }, h('option', { value: 'long', selected: (init.ridgeDir ?? 'long') === 'long' }, '長手'), h('option', { value: 'short', selected: init.ridgeDir === 'short' }, '短手')) as HTMLSelectElement;
  const sideSel = h('select', { style: 'width:100%' }, ...HIGH_SIDES.map((s) => h('option', { value: s, selected: (init.highSide ?? 'N') === s }, HIGH_SIDE_LABEL[s]))) as HTMLSelectElement;
  const stIn = num(init.storeys, 1, 1, 60);
  const fhIn = num(init.floorH, 0.05, 1.5, 8);
  const eaveIn = num(init.eave, 0.1, 0.5);
  const topIn = num(init.kind === 'flat' ? r2(init.ridge - init.eave) : init.ridge, 0.1, 0);
  const topLabel = h('span', { class: 'field-label' }, '棟高 m');
  const dirField = field('棟の向き（切妻）', dirSel);
  const sideField = field('高い側（片流れ）', sideSel);
  const eaveLabel = h('span', { class: 'field-label' }, '軒高 m');

  const sync = () => {
    const flat = kindSel.value === 'flat';
    topLabel.textContent = flat ? 'パラペット m' : '棟高 m';
    eaveLabel.textContent = flat ? '屋上面 m' : '軒高 m';
    dirField.style.display = kindSel.value === 'gable' ? '' : 'none';
    sideField.style.display = kindSel.value === 'shed' ? '' : 'none';
  };
  kindSel.addEventListener('change', () => {
    const eave = +eaveIn.value;
    const cur = +topIn.value;
    if (kindSel.value === 'flat') topIn.value = String(r2(Math.min(Math.max(cur - eave, 0) || 0.8, 1.5)));
    else if (init.kind === 'flat' || cur < eave) topIn.value = String(r2(eave + (kindSel.value === 'shed' ? 2 : 1.8)));
    sync();
  });
  stIn.addEventListener('change', () => {
    if (+stIn.value > 0 && +fhIn.value > 0) eaveIn.value = String(r2(+stIn.value * +fhIn.value));
  });
  fhIn.addEventListener('change', () => {
    if (+stIn.value > 0 && +fhIn.value > 0) eaveIn.value = String(r2(+stIn.value * +fhIn.value));
  });
  eaveIn.addEventListener('change', () => {
    if (+stIn.value > 0 && +eaveIn.value > 0) fhIn.value = String(r2(+eaveIn.value / +stIn.value));
  });
  sync();

  const read = (): RoofSpec | null => {
    const eave = +eaveIn.value;
    const top = +topIn.value;
    if (!(eave > 0) || !Number.isFinite(top) || top < 0) return null;
    const kind = kindSel.value as RoofKind;
    const spec: RoofSpec = { kind, eave, ridge: kind === 'flat' ? eave + top : top, boxHeight: init.boxHeight };
    if (kind === 'gable') spec.ridgeDir = dirSel.value as 'long' | 'short';
    if (kind === 'shed') spec.highSide = sideSel.value as HighSide;
    if (+stIn.value > 0) spec.storeys = +stIn.value;
    if (+fhIn.value > 0) spec.floorH = +fhIn.value;
    return normalizeSpec(spec);
  };

  const el = h(
    'div',
    { class: 'roof-editor', style: 'margin:6px 0;padding:6px 8px;border:1px solid var(--line, #ddd);border-radius:8px' },
    h('div', { class: 'field-label' }, `屋根・階高${init.user ? '（手入力）' : n.plateau?.roofEstimate ? '（推定）' : '（箱形）'}`),
    h(
      'div',
      { style: 'display:grid;grid-template-columns:1fr 1fr;gap:2px 8px' },
      field('屋根の形', kindSel),
      dirField,
      sideField,
      field('階数', stIn),
      field('階高 m', fhIn),
      h('label', { class: 'field' }, eaveLabel, eaveIn),
      h('label', { class: 'field' }, topLabel, topIn),
    ),
    h(
      'div',
      { class: 'row', style: 'margin-top:4px' },
      h(
        'button',
        {
          class: 'btn sm dark',
          title: '入力した屋根・高さにして、影・解析を作り直します（実際の屋根の形ではなく入力値として扱います）',
          onclick: () => {
            const s = read();
            if (s) onApply(s);
          },
        },
        '屋根を適用',
      ),
      hasOverride ? h('button', { class: 'btn sm ghost', title: '手入力をやめて自動の推定に戻します', onclick: onReset }, '推定に戻す') : null,
    ),
  );
  return { el, read };
}
