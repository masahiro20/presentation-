import { h, clear, section, segmented, download, svgToDataUrl, svgToPng, toast } from '../dom';
import { state } from '../state';
import type { Step, StepCtx } from '../app';
import { renderElevation, type ElevationDir } from '../../drawings/elevation';
import { floorPlanSvg, floorPlanParts, areaTableSvg } from '../../drawings/plan';
import { composeSheet, sheetScale, SHEET_TOP_W } from '../../drawings/sheet';
import { exteriorFinishTableSvg } from '../../drawings/finishTable';
import { modelToDxf } from '../../drawings/dxf';
import { sheetInfo } from '../sheetInfo';

const DIRS: ElevationDir[] = ['south', 'east', 'north', 'west'];

function generate(ctx: StepCtx, color: boolean) {
  buildSheets(ctx.app, color);
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
  let no = 1;
  const sheets: { title: string; svg: string }[] = [];
  {
    const parts = model.floors.map((f) => floorPlanParts(model, f, { sheet: sheetInfo('平面図'), sectionLines }));
    const at = areaTableSvg(model, 0, 0);
    const opts = { right: { svg: at.svg, w: at.w, h: at.h }, defs: parts.map((p) => p.defs ?? '').join(''), gap: 2400 };
    const groups = sheetScale(parts, { ...opts, scales: [100] }) ? [model.floors.map((_, i) => i)] : model.floors.map((_, i) => [i]);
    for (const g of groups) {
      const fl = g.map((i) => model.floors[i]);
      const title = fl.length > 1 ? `平面図（${fl.map((f) => `${f.level}階`).join('・')}）` : `${fl[0]?.level ?? 1}階 平面図`;
      sheets.push({ title, svg: composeSheet(g.map((i) => parts[i]), sheetInfo(title, `A-${no++}`), { ...opts, defs: g.map((i) => parts[i].defs ?? '').join('') }) });
    }
  }
  // 立面図は御社の立面図シートと同じ構成: 上に外部仕上表の帯、その下に 4 面を 2 × 2（南・東／北・西）
  const top = exteriorFinishTableSvg(state.design, 0, 0, SHEET_TOP_W);
  sheets.push({ title: '立面図', svg: composeSheet(elevs.map((r) => ({ inner: r.inner, vb: r.vb })), sheetInfo('立面図', `A-${no++}`), { top, gap: 1200 }) });
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
    const draw = () => {
      clear(view);
      for (const sh of state.sheets) view.appendChild(h('div', { class: 'sheet wide', html: sh.svg }));
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
    if (!state.sheets.length) regen();
    else draw();
    const dl = async (name: string, svg: string, fmt: 'svg' | 'png') => {
      if (fmt === 'svg') download(svgToDataUrl(svg), `${state.name}_${name}.svg`);
      else download(await svgToPng(svg, 4200), `${state.name}_${name}.png`);
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
      section(
        'ダウンロード（A3 シート）',
        ...state.sheets.map((sh) =>
          h('div', { class: 'btn-row', style: 'align-items:center' }, h('span', { style: 'flex:1;font-size:13px' }, sh.title), h('button', { class: 'btn sm', onclick: () => dl(sh.title, sh.svg, 'svg') }, 'SVG'), h('button', { class: 'btn sm', onclick: () => dl(sh.title, sh.svg, 'png') }, 'PNG')),
        ),
        h('p', { class: 'hint' }, 'PNG は A3 横（幅 4,200px）で保存します。SVG はベクターなので CAD・Illustrator で開いて編集できます。'),
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
  },
};
