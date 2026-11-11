/**
 * 屋根の塊・手で描いた屋根の手直しのパネル（3D の「屋根」の道具と、方眼の「屋根」の道具で共通）:
 * 掛け方・片流れの高い側・棟の向き・勾配・軒の出・辺ごとの軒の出（屋根を伸ばす）・パラペット・足した屋根の高さ・屋根なし
 */
import { h } from './dom';
import { ROOF_KIND_LABEL, type BuildingModel, type RoofHigh, type RoofKind, type RoofPatch } from '../core/types';
import type { RoofMass } from '../scene/roof';
import { wallTopOf } from '../scene/building';

/** 図面の辺（上下左右）に方位を添える: 「上（北）」 */
export function sideLabel(s: RoofHigh, northDeg: number): string {
  const names: Record<RoofHigh, string> = { n: '上', s: '下', e: '右', w: '左' };
  const a = (northDeg * Math.PI) / 180;
  const nv = { x: Math.sin(a), y: -Math.cos(a) };
  const ev = { x: -nv.y, y: nv.x };
  const sv: Record<RoofHigh, { x: number; y: number }> = { n: { x: 0, y: -1 }, s: { x: 0, y: 1 }, e: { x: 1, y: 0 }, w: { x: -1, y: 0 } };
  const dn = sv[s].x * nv.x + sv[s].y * nv.y;
  const de = sv[s].x * ev.x + sv[s].y * ev.y;
  const comp = Math.abs(dn) >= Math.abs(de) ? (dn > 0 ? '北' : '南') : de > 0 ? '東' : '西';
  return `${names[s]}（${comp}）`;
}

/** 選択肢の一覧に今の値が無ければ（3D のハンドルで自由な値にしたとき）その値も入れて返す */
const withCur = (list: number[], cur: number | undefined): number[] => (cur == null || list.includes(cur) ? list : [...list, cur].sort((a, b) => a - b));

/** 横並びの選択ボタン */
export const segButtons = (items: { v: string; label: string; title?: string }[], cur: string, on: (val: string) => void) =>
  h('div', { class: 'segmented' }, ...items.map((it) => h('button', { class: cur === it.v ? 'on' : '', title: it.title, onclick: () => on(it.v) }, it.label)));

/** 塊の名前: 「2階の屋根（7.0 × 8.0 m）」「1階に足した屋根（…）」「1階の屋根なしの範囲（…）」 */
export const massName = (ms: RoofMass) =>
  `${ms.level}階${ms.omit ? 'の屋根なしの範囲' : ms.manual ? 'に足した屋根' : ms.isTop ? 'の屋根' : 'の下屋'}（${((ms.bbox.maxX - ms.bbox.minX) / 1000).toFixed(1)} × ${((ms.bbox.maxY - ms.bbox.minY) / 1000).toFixed(1)} m）`;

/**
 * 塊の出どころの印: 立面図の屋根の線から読んだ掛け方なら「立面図から」（名前の横に常に出す。状態の行は説明文で、既定では隠れるため）。
 * それ以外は null
 */
export const massSourceTag = (ms: RoofMass): HTMLElement | null =>
  ms.patch?.source === 'elevation' && !ms.manual
    ? h('span', { title: '立面図の屋根の線から読んだ掛け方です。ここで変えると、その内容が優先されます', style: 'margin-left:6px;padding:1px 7px;border-radius:999px;border:1px solid currentColor;font-size:11px;opacity:.8;white-space:nowrap' }, '立面図から')
    : null;

/** 塊の今の状態を 1 行で */
export const massState = (ms: RoofMass, north: number) =>
  ms.omit
    ? 'この範囲には屋根を掛けません（自動の屋根からも除いています）'
    : `今: ${ROOF_KIND_LABEL[ms.kind]}${ms.kind === 'shed' ? `・高い側 ${sideLabel(ms.high, north)}` : ''}${ms.attached.length ? `・上の階に接する辺 ${ms.attached.map((s) => sideLabel(s, north).replace(/（.*/, '')).join('・')}` : ''}${ms.patch && !ms.manual ? (ms.patch.source === 'elevation' ? '（立面図から読んだ掛け方）' : '（手直しあり）') : ''}`;

export interface RoofPanelCtx {
  model: BuildingModel;
  ms: RoofMass;
  /** 全体の屋根の勾配（寸）と軒の出（mm）: 「おまかせ」の表示に */
  wholePitch: number;
  wholeEaves: number;
  /** 選んだ塊の手直しに fn を当てる（手直しが無ければ作る。項目が空になれば消す）。msg は完了のトースト */
  edit: (fn: (q: RoofPatch) => void, msg?: string) => void;
  /** 手で描いた屋根・屋根なしの範囲を消す */
  remove: () => void;
  /** 選ぶのをやめる（あれば最後のボタン列に出す） */
  deselect?: () => void;
}

/**
 * 選んだ塊の手直しの操作一式（名前・状態の行は含めない）。
 * 手で描いた範囲（manual）では高さと「屋根なし」、自動の塊では「おまかせに戻す」が付く
 */
export function roofPatchControls(ctx: RoofPanelCtx): HTMLElement[] {
  const { model: m, ms, edit } = ctx;
  const p = ms.patch;
  const north = m.northAngleDeg;
  const out: HTMLElement[] = [];
  if (ms.omit) {
    out.push(
      h(
        'div',
        { class: 'btn-row', style: 'margin-top:8px' },
        h('button', { class: 'btn sm', onclick: () => edit((q) => { delete q.omit; }, 'この範囲に屋根を掛けるようにしました') }, 'この範囲に屋根を掛ける'),
        h('button', { class: 'btn sm ghost', onclick: () => ctx.remove() }, 'この範囲を消す'),
        ctx.deselect ? h('button', { class: 'btn sm ghost', onclick: ctx.deselect }, '選ぶのをやめる') : null,
      ),
      h('p', { class: 'hint', style: 'margin:4px 0 0' }, '余分に出た下屋を消したい所に。範囲の角はドラッグで動かせます（方眼の修正画面）。'),
    );
    return out;
  }
  const kindCur = p?.kind ?? 'auto';
  out.push(
    h('div', { class: 'field-label' }, ms.manual ? 'この屋根の掛け方' : 'この塊の掛け方'),
    segButtons(
      [{ v: 'auto', label: 'おまかせ', title: ms.manual ? '緩い片流れ（全体が陸屋根なら陸屋根）' : ms.isTop ? '全体の屋根と同じ' : '緩い片流れの下屋（上の階に接する辺が高い）' }, ...(Object.keys(ROOF_KIND_LABEL) as RoofKind[]).map((k) => ({ v: k, label: ROOF_KIND_LABEL[k] }))],
      kindCur,
      (val) =>
        edit((q) => {
          if (val === 'auto') delete q.kind;
          else q.kind = val as RoofKind;
          // 切妻・寄棟にしたのに勾配が緩い（片流れ用の 0.5 寸）ままでは平らに見えるので、4 寸にしておく（勾配を決めていないときだけ）
          if ((val === 'gable' || val === 'hip') && q.pitch == null && ctx.wholePitch < 2.5) q.pitch = 4;
        }, val === 'auto' ? 'おまかせに戻しました' : `${ROOF_KIND_LABEL[val as RoofKind]}にしました`),
    ),
  );
  if (ms.kind === 'shed')
    out.push(
      h('div', { class: 'field-label', style: 'margin-top:8px' }, '高い側（水は反対へ流れます）'),
      segButtons(
        [{ v: 'auto', label: 'おまかせ' }, ...(['n', 's', 'e', 'w'] as RoofHigh[]).map((s) => ({ v: s, label: sideLabel(s, north) }))],
        p?.high ?? 'auto',
        (val) => edit((q) => { if (val === 'auto') delete q.high; else q.high = val as RoofHigh; }, val === 'auto' ? '向きをおまかせに戻しました' : `${sideLabel(val as RoofHigh, north)}を高くしました`),
      ),
    );
  if (ms.kind === 'gable' || ms.kind === 'hip')
    out.push(
      h('div', { class: 'field-label', style: 'margin-top:8px' }, '棟の向き'),
      segButtons(
        [
          { v: 'auto', label: '長い辺に沿う' },
          { v: 'x', label: '横（図面の左右）', title: '棟が左右に通り、屋根は上下へ流れる' },
          { v: 'z', label: '縦（図面の上下）', title: '棟が上下に通り、屋根は左右へ流れる' },
        ],
        p?.ridge ?? 'auto',
        (val) => edit((q) => { if (val === 'auto') delete q.ridge; else q.ridge = val as 'x' | 'z'; }, '棟の向きを変えました'),
      ),
    );
  if (ms.kind !== 'flat') {
    const pitches = withCur([0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6], p?.pitch);
    out.push(
      h(
        'div',
        { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 8px;margin-top:8px' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '勾配（寸）'), h('select', { onchange: (e: Event) => { const val = (e.target as HTMLSelectElement).value; edit((q) => { if (val === '') delete q.pitch; else q.pitch = Number(val); }, val === '' ? '勾配をおまかせに戻しました' : `勾配を ${val} 寸にしました`); } }, h('option', { value: '', selected: p?.pitch == null }, `おまかせ（${ms.isTop ? ctx.wholePitch : '0.5〜1'}）`), ...pitches.map((x) => h('option', { value: String(x), selected: p?.pitch === x }, `${x} 寸`)))),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '軒の出 (mm)'), h('select', { onchange: (e: Event) => { const val = (e.target as HTMLSelectElement).value; edit((q) => { if (val === '') delete q.eaves; else q.eaves = Number(val); }, val === '' ? '軒の出をおまかせに戻しました' : `軒の出を ${val} mm にしました`); } }, h('option', { value: '', selected: p?.eaves == null }, `おまかせ（${ctx.wholeEaves}）`), ...withCur([0, 150, 300, 450, 600, 750, 900, 1200], p?.eaves).map((x) => h('option', { value: String(x), selected: p?.eaves === x }, `${x}`)))),
      ),
    );
    // 屋根を片側だけ伸ばす: 辺ごとの軒の出（寄棟は 4 辺同じ出でないと隅が合わないので対象外）
    if (ms.kind !== 'hip') {
      const sides: RoofHigh[] = ['n', 'e', 's', 'w'];
      const baseEaves = p?.eaves ?? ctx.wholeEaves;
      out.push(
        h('div', { class: 'field-label', style: 'margin-top:8px' }, '屋根を伸ばす（辺ごとの軒の出 mm）'),
        h(
          'div',
          { style: 'display:grid;grid-template-columns:1fr 1fr;gap:4px 8px' },
          ...sides.map((s) =>
            h(
              'label',
              { class: 'field', style: 'margin:0' },
              h('span', { class: 'field-label' }, sideLabel(s, north)),
              h(
                'select',
                {
                  onchange: (e: Event) => {
                    const val = (e.target as HTMLSelectElement).value;
                    edit((q) => {
                      const by = { ...(q.eavesBy ?? {}) };
                      if (val === '') delete by[s];
                      else by[s] = Number(val);
                      if (Object.keys(by).length) q.eavesBy = by;
                      else delete q.eavesBy;
                    }, val === '' ? `${sideLabel(s, north)}の出をほかの辺と同じに戻しました` : `${sideLabel(s, north)}の屋根を ${val} mm 出しました`);
                  },
                },
                h('option', { value: '', selected: p?.eavesBy?.[s] == null }, `同じ（${baseEaves}）`),
                ...withCur([0, 150, 300, 450, 600, 900, 1200, 1500, 1820, 2730], p?.eavesBy?.[s]).map((x) => h('option', { value: String(x), selected: p?.eavesBy?.[s] === x }, `${x}`)),
              ),
            ),
          ),
        ),
        h('p', { class: 'hint', style: 'margin:2px 0 0' }, '庭側だけ深い軒にする・窓の上に屋根を伸ばすときに。窓 1 か所だけなら「窓・戸」の道具で庇を付けます。'),
      );
    }
  } else {
    out.push(
      h('label', { class: 'field', style: 'margin-top:8px' }, h('span', { class: 'field-label' }, 'パラペットの立ち上がり (mm)'), h('select', { onchange: (e: Event) => { const val = (e.target as HTMLSelectElement).value; edit((q) => { if (val === '') delete q.parapet; else q.parapet = Number(val); }, val === '' ? 'パラペットを標準（550）に戻しました' : `パラペットを ${val} mm にしました`); } }, h('option', { value: '', selected: p?.parapet == null }, '標準（550）'), ...withCur([300, 450, 700, 900, 1200], p?.parapet).map((x) => h('option', { value: String(x), selected: p?.parapet === x }, `${x}`)))),
    );
  }
  if (ms.manual && p) {
    // 手で描いた屋根: 軒の高さ（その階の床から）
    const f = m.floors.find((x) => x.level === ms.level);
    const autoTop = f ? wallTopOf(m, f) - f.elevation : 0;
    out.push(
      h('label', { class: 'field', style: 'margin-top:8px' }, h('span', { class: 'field-label' }, '軒の高さ（この階の床から mm）'), h('select', { onchange: (e: Event) => { const val = (e.target as HTMLSelectElement).value; edit((q) => { if (val === '') delete q.topMm; else q.topMm = Number(val); }, val === '' ? '高さを壁の天端に戻しました' : `屋根の高さを床から ${val} mm にしました`); } }, h('option', { value: '', selected: p.topMm == null }, `壁の天端（${Math.round(autoTop)}）`), ...withCur([2000, 2200, 2400, 2700, 3000, 3300, 3600, 4000], p.topMm).map((x) => h('option', { value: String(x), selected: p.topMm === x }, `${x}`)))),
    );
  }
  out.push(
    h(
      'div',
      { class: 'btn-row' },
      ms.manual && p
        ? h('button', { class: 'btn sm', onclick: () => ctx.remove() }, 'この屋根を消す')
        : p
          ? h('button', { class: 'btn sm', onclick: () => edit((q) => { delete q.kind; delete q.high; delete q.ridge; delete q.pitch; delete q.eaves; delete q.eavesBy; delete q.parapet; }, 'この塊をおまかせに戻しました') }, 'この塊をおまかせに戻す')
          : null,
      ms.manual && p ? h('button', { class: 'btn sm ghost', title: 'この範囲には屋根を掛けず、自動の屋根からも除きます（余分な下屋を消すときに）', onclick: () => edit((q) => { q.omit = true; }, 'この範囲を屋根なしにしました') }, '屋根なしの範囲にする') : null,
      ctx.deselect ? h('button', { class: 'btn sm ghost', onclick: ctx.deselect }, '選ぶのをやめる') : null,
    ),
  );
  return out;
}
