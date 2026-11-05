import { h, clear, section, segmented, field, download, svgToDataUrl, svgToPng, toast } from '../dom';
import { state } from '../state';
import { openDesignReview } from '../docs';
import type { Step, StepCtx } from '../app';
import type { BuildingModel } from '../../core/types';
import { renderElevation, type ElevationDir } from '../../drawings/elevation';
import { floorPlanSvg, floorPlanParts, areaTableSvg, type PlanParts } from '../../drawings/plan';
import { composeSheet, sheetScale, SHEET_TOP_W } from '../../drawings/sheet';
import { exteriorFinishTableSvg } from '../../drawings/finishTable';
import { exteriorQuantityTableSvg } from '../../drawings/quantities';
import { exteriorById } from '../../styles/presets';
import { modelToDxf } from '../../drawings/dxf';
import { sheetInfo } from '../sheetInfo';

const DIRS: ElevationDir[] = ['south', 'east', 'north', 'west'];

/** 1 階と 2 階の間隔の既定 (m)。以前は 2.4m で、寸法線の余白と合わせて 7m も離れて見えた */
const PLAN_GAP_M = 0.6;

/** 平面図シートの材料。配置（間隔・縮尺・ずらし）を直すときに立面図を描き直さなくて済むように覚えておく */
let planCache: { model: BuildingModel; parts: PlanParts[]; at: { svg: string; w: number; h: number } } | null = null;

function generate(ctx: StepCtx, color: boolean) {
  buildSheets(ctx.app, color);
}

/**
 * 平面図シート（配置の手直し込み）: 2 階建てまでは 1 階・2 階を 1 枚に（1/100 で収まらなければ 1/150・1/200 に落として 1 枚にする）。
 * 3 階建ては 1/100 で収まるときだけ 1 枚。縮尺を指定したときは収まらなくても 1 枚にする（はみ出しはドラッグで直す）
 */
function composePlanSheets(model: BuildingModel, parts: PlanParts[], at: { svg: string; w: number; h: number }, startNo: number): { title: string; svg: string; floors: number[] }[] {
  const lay = state.sheetLayout?.plan ?? {};
  const gap = Math.max(0, lay.gapM ?? PLAN_GAP_M) * 1000;
  const base = { right: { svg: at.svg, w: at.w, h: at.h }, gap, stack: lay.stack ?? 'row', draggable: true } as const;
  const oneSheet = lay.scale ? [lay.scale] : model.floors.length <= 2 ? [100, 150, 200] : [100];
  const fits = sheetScale(parts, { ...base, defs: parts.map((p) => p.defs ?? '').join(''), scales: oneSheet });
  const groups = fits || lay.scale ? [model.floors.map((_, i) => i)] : model.floors.map((_, i) => [i]);
  const sheets: { title: string; svg: string; floors: number[] }[] = [];
  let no = startNo;
  for (const g of groups) {
    const fl = g.map((i) => model.floors[i]);
    const title = fl.length > 1 ? `平面図（${fl.map((f) => `${f.level}階`).join('・')}）` : `${fl[0]?.level ?? 1}階 平面図`;
    const offsets = g.map((i) => lay.offsets?.[String(i)]);
    sheets.push({ title, floors: g, svg: composeSheet(g.map((i) => parts[i]), sheetInfo(title, `A-${no++}`), { ...base, defs: g.map((i) => parts[i].defs ?? '').join(''), scales: lay.scale ? [lay.scale] : undefined, offsets }) });
  }
  return sheets;
}

/** 平面図シートだけ組み直す（配置を直したとき）。材料が無ければ false（全部作り直す） */
export function relayoutPlanSheets(): boolean {
  const model = state.model;
  if (!model || !planCache || planCache.model !== model) return false;
  const planSheets = composePlanSheets(model, planCache.parts, planCache.at, 1);
  const others = state.sheets.filter((s) => !/平面図/.test(s.title));
  state.sheets = [...planSheets, ...others];
  return true;
}

/** 図面一式（平面図シート・立面図シート）を 3D から作って state に入れる。資料の自動作成からも呼ぶ */
export function buildSheets(app: StepCtx['app'], color = false) {
  // 提案用の図面は線画が標準（面ごとの張り分け・色塗りはしない）
  app.ensureScene();
  const v = app.viewer;
  const model = state.model!;
  v.setCutaway(null);
  // 立面図（4 面）: プレゼン用の単体図と、A3 シート
  const elevs = DIRS.map((d) => renderElevation(v, d, { color }));
  state.elevations = elevs.map((r) => ({ dir: r.dir, title: r.title, svg: r.svg }));
  // 断面図は提案の水準に届くまで出さない（切断線も描かない）
  const sectionLines: { nx: number; nz: number; d: number; label: string }[] = [];
  state.plans = model.floors.map((f) => ({ level: f.level, svg: floorPlanSvg(model, f) }));
  // A3 シート（御社の構成）: 平面図は 1/100（全階が 1 枚に収まれば 1 枚、収まらなければ階ごとに 1 枚）。面積表はどのシートも右上。
  // 立面図は 4 面を 1 枚。建具表のシートは提案には付けない（平面図・立面図の 2 種類）
  const parts = model.floors.map((f) => floorPlanParts(model, f, { sheet: sheetInfo('平面図'), sectionLines }));
  const at = areaTableSvg(model, 0, 0);
  planCache = { model, parts, at };
  const sheets: { title: string; svg: string; floors?: number[] }[] = composePlanSheets(model, parts, at, 1);
  // 立面図は御社の立面図シートと同じ構成: 上に外部仕上表の帯、その下に 4 面を 2 × 2（南・東／北・西）
  const top = exteriorFinishTableSvg(state.design, 0, 0, SHEET_TOP_W);
  // 右上に外部数量表（外壁面積・屋根面積など。見積の拾いと同じ計算。テイストの屋根・軒の出に合わせる）
  const ext = exteriorById(state.design.exteriorId);
  const qt = exteriorQuantityTableSvg(model, { grade: 'P', eavesMm: state.design.eaves ?? ext.roof.eaves, pitch: state.design.roofPitch ?? ext.roof.pitch, roofType: state.design.roofOverride ?? ext.roof.type, solido: ext.accent ? ext.accentRule : 'none' }, 0, 0);
  sheets.push({ title: '立面図', svg: composeSheet(elevs.map((r) => ({ inner: r.inner, vb: r.vb })), sheetInfo('立面図', `A-${sheets.length + 1}`), { top, gap: 1200, right: { svg: qt.svg, w: qt.w, h: qt.h } }) });
  state.sheets = sheets;
}

export const elevationStep: Step = {
  id: 'elevation',
  label: '図面',
  needsModel: true,
  uses3d: false,
  mount(ctx) {
    let color = false;
    const view = h('div', { class: 'plan-view' });
    ctx.stage.appendChild(view);
    const layoutPanel = h('div', null);
    /** 平面図シートの上でパネル（1 階・2 階）をドラッグして動かす。離したら紙の mm に直して保存し、組み直す */
    const enableDrag = (el: HTMLElement, floors: number[]) => {
      const svg = el.querySelector('svg');
      if (!svg) return;
      const denom = Number(svg.dataset.denom || '100');
      const vbw = svg.viewBox.baseVal.width;
      for (const g of svg.querySelectorAll<SVGGElement>('g[data-panel]')) {
        g.style.cursor = 'move';
        g.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const fi = floors[Number(g.dataset.panel)] ?? Number(g.dataset.panel);
          const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(g.getAttribute('transform') ?? '');
          const tx0 = m ? +m[1] : 0;
          const ty0 = m ? +m[2] : 0;
          const sx = e.clientX;
          const sy = e.clientY;
          const k = vbw / Math.max(1, svg.getBoundingClientRect().width);
          let dxu = 0;
          let dyu = 0;
          const move = (ev: PointerEvent) => {
            dxu = (ev.clientX - sx) * k;
            dyu = (ev.clientY - sy) * k;
            g.setAttribute('transform', `translate(${(tx0 + dxu).toFixed(0)} ${(ty0 + dyu).toFixed(0)})`);
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            if (Math.abs(dxu) < denom && Math.abs(dyu) < denom) return;
            const plan = ((state.sheetLayout ??= {}).plan ??= {});
            const offs = (plan.offsets ??= {});
            const prev = offs[String(fi)] ?? { x: 0, y: 0 };
            offs[String(fi)] = { x: Math.round((prev.x + dxu / denom) * 10) / 10, y: Math.round((prev.y + dyu / denom) * 10) / 10 };
            applyLayout();
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        });
      }
    };
    const draw = () => {
      clear(view);
      for (const sh of state.sheets) {
        const el = h('div', { class: 'sheet wide', html: sh.svg });
        view.appendChild(el);
        if (sh.floors) enableDrag(el, sh.floors);
      }
      renderDownloads();
    };
    const regen = () => {
      try {
        generate(ctx, color);
      } catch (e) {
        console.error(e);
        toast('立面図の作成に失敗しました', 'error');
      }
      draw();
    };
    /** 配置の変更を平面図シートに反映（材料が無ければ全部作り直す） */
    const applyLayout = () => {
      if (relayoutPlanSheets()) draw();
      else regen();
      renderLayoutPanel();
    };
    const setLay = (patch: NonNullable<NonNullable<typeof state.sheetLayout>['plan']>) => {
      (state.sheetLayout ??= {}).plan = { ...(state.sheetLayout.plan ?? {}), ...patch };
      applyLayout();
    };
    const renderLayoutPanel = () => {
      clear(layoutPanel);
      const lay = state.sheetLayout?.plan ?? {};
      const offs = Object.entries(lay.offsets ?? {}).filter(([, o]) => o.x || o.y);
      layoutPanel.append(
        h('div', null,
        field('縮尺', segmented([{ value: 'auto', label: '自動' }, { value: '100', label: '1/100' }, { value: '150', label: '1/150' }, { value: '200', label: '1/200' }], lay.scale ? String(lay.scale) : 'auto', (val) => setLay({ scale: val === 'auto' ? undefined : Number(val) })), lay.scale ? '収まらなくても 1 枚にします（はみ出しはドラッグで）' : '1/100 で収まらなければ 1/150・1/200'),
        field('1 階と 2 階の間隔 (m)', h('input', { type: 'number', step: 0.1, min: 0, max: 8, value: lay.gapM ?? PLAN_GAP_M, onchange: (e: Event) => { const v = Math.max(0, Number((e.target as HTMLInputElement).value) || 0); setTimeout(() => setLay({ gapM: v }), 0); } })),
        field('並べ方', segmented([{ value: 'row', label: '横に並べる' }, { value: 'col', label: '縦に並べる' }], lay.stack ?? 'row', (val) => setLay({ stack: val }))),
        h('p', { class: 'hint' }, 'シートの上で平面図（1 階・2 階）をドラッグすると動かせます。動かした分はプロジェクトに保存され、資料の図面ページにも使われます。'),
        offs.length ? h('p', { class: 'hint' }, `ずらし: ${offs.map(([k, o]) => `${state.model?.floors[Number(k)]?.level ?? Number(k) + 1}階 (${o.x > 0 ? '+' : ''}${o.x}, ${o.y > 0 ? '+' : ''}${o.y}) mm`).join('　')}`) : null,
        h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', disabled: !lay.scale && lay.gapM == null && !lay.stack && !offs.length, onclick: () => { if (state.sheetLayout) delete state.sheetLayout.plan; applyLayout(); } }, '配置を元に戻す')),
        ),
      );
    };
    const dl = async (name: string, svg: string, fmt: 'svg' | 'png') => {
      if (fmt === 'svg') download(svgToDataUrl(svg), `${state.name}_${name}.svg`);
      else download(await svgToPng(svg, 4200), `${state.name}_${name}.png`);
    };
    const dlPanel = h('div', null);
    const renderDownloads = () => {
      clear(dlPanel);
      dlPanel.append(
        ...state.sheets.map((sh) =>
          h('div', { class: 'btn-row', style: 'align-items:center' }, h('span', { style: 'flex:1;font-size:13px' }, sh.title), h('button', { class: 'btn sm', onclick: () => dl(sh.title, sh.svg, 'svg') }, 'SVG'), h('button', { class: 'btn sm', onclick: () => dl(sh.title, sh.svg, 'png') }, 'PNG')),
        ),
        h('p', { class: 'hint' }, 'PNG は A3 横（幅 4,200px）で保存します。SVG はベクターなので CAD・Illustrator で開いて編集できます。'),
      );
    };
    ctx.side.append(
      h('h2', null, '図面（A3 シート）'),
      section(
        '表示',
        segmented(
          [
            { value: 'line', label: '線画（標準）' },
            { value: 'color', label: '仕上げの色を付ける' },
          ],
          'line',
          (val) => {
            color = val === 'color';
            regen();
          },
        ),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: regen }, '最新のテイストで作り直す')),
        h('p', { class: 'hint' }, 'パースでテイスト（外壁・屋根）を変えた後は「作り直す」を押してください。'),
      ),
      section('平面図の配置', layoutPanel),
      section('ダウンロード（A3 シート）', dlPanel),
      section(
        '社内確認',
        h('p', { class: 'hint', style: 'margin-top:0' }, '面積・木造チェックの全件・読み取りの注意・ご要望との照合を 1 枚にした、上司・社内承認者向けのレビュー用紙です（新しいタブに開きます）。'),
        h('button', { class: 'btn block', onclick: () => openDesignReview() }, '設計レビュー（社内確認用）を開く'),
      ),
      section(
        'CAD へ戻す（DXF）',
        h('p', { class: 'hint' }, '読み取った壁・建具・部屋名・階段・外形を階ごとのレイヤに分けた DXF（R12）で書き出します。JW_CAD・AutoCAD・ARCHITREND などで下図として開けます（単位 mm）。'),
        h(
          'button',
          {
            class: 'btn block',
            onclick: () => {
              const dxf = modelToDxf(state.model!);
              const url = URL.createObjectURL(new Blob([dxf], { type: 'application/dxf' }));
              download(url, `${state.name}_間取り.dxf`);
              setTimeout(() => URL.revokeObjectURL(url), 10000);
            },
          },
          'DXF を保存',
        ),
      ),
    );
    renderLayoutPanel();
    if (!state.sheets.length) regen();
    else draw();
  },
};
