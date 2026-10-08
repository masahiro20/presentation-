import { h, clear, section, segmented, download, svgToDataUrl, svgToPng, toast } from '../dom';
import { state } from '../state';
import type { Step, StepCtx } from '../app';
import { renderElevation, renderSection, type ElevationDir } from '../../drawings/elevation';
import { floorPlanSvg, floorPlanParts, areaTableSvg, openingTableSvg } from '../../drawings/plan';
import { composeSheet } from '../../drawings/sheet';
import { modelToDxf } from '../../drawings/dxf';
import { sheetInfo } from '../sheetInfo';

const DIRS: ElevationDir[] = ['south', 'east', 'north', 'west'];

function generate(ctx: StepCtx, color: boolean) {
  ctx.app.ensureScene();
  const v = ctx.app.viewer;
  const model = state.model!;
  v.setCutaway(null);
  // 立面図（4 面）: プレゼン用の単体図と、A3 シート
  const elevs = DIRS.map((d) => renderElevation(v, d, { color }));
  state.elevations = elevs.map((r) => ({ dir: r.dir, title: r.title, svg: r.svg }));
  // 断面図（断面パースと同じ切断面 A-A・B-B）
  const secs = v.shots().filter((s) => s.kind === 'section' && s.section);
  const labels = ['A', 'B'];
  const sectionLines: { nx: number; nz: number; d: number; label: string }[] = [];
  const sections = secs.slice(0, 2).flatMap((s, i) => {
    try {
      const r = renderSection(v, s.section!, labels[i], { color });
      sectionLines.push({ ...s.section!, label: labels[i] });
      return [r];
    } catch (e) {
      console.error(e);
      return [];
    }
  });
  state.plans = model.floors.map((f) => ({ level: f.level, svg: floorPlanSvg(model, f) }));
  // A3 シート: 平面図（階ごと・面積表・建具表・切断線）→ 立面図（4 面を 1 枚）→ 断面図（1 枚）
  let no = 1;
  const sheets: { title: string; svg: string }[] = [];
  for (const f of model.floors) {
    const parts = floorPlanParts(model, f, { sheet: sheetInfo(`${f.level}階平面図`), sectionLines });
    const at = areaTableSvg(model, 0, 0);
    const ot = openingTableSvg(f, 0, at.h + 700);
    const right = { svg: at.svg + ot.svg, w: Math.max(at.w, ot.w), h: at.h + 700 + ot.h };
    sheets.push({ title: `${f.level}階平面図`, svg: composeSheet([parts], sheetInfo(`${f.level}階平面図`, `A-${no++}`), { right, defs: parts.defs }) });
  }
  sheets.push({ title: '立面図（4 面）', svg: composeSheet(elevs.map((r) => ({ inner: r.inner, vb: r.vb })), sheetInfo('立面図', `A-${no++}`)) });
  if (sections.length) sheets.push({ title: '断面図 A-A・B-B', svg: composeSheet(sections.map((r) => ({ inner: r.inner, vb: r.vb })), sheetInfo('断面図', `A-${no++}`)) });
  state.sheets = sheets;
}

export const elevationStep: Step = {
  id: 'elevation',
  label: '立面図',
  needsModel: true,
  uses3d: false,
  mount(ctx) {
    let color = true;
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
      h('h2', null, '立面図'),
      h('p', { class: 'lead' }, '3D モデルから東西南北の立面図と断面図（A-A・B-B）を、A3 の図枠・表題欄付きで自動作成します。平面図には建具記号と建具表・面積表・切断線が入ります。隠れ線を処理したベクター図面なので、拡大しても線がきれいです。'),
      section(
        '表示',
        segmented(
          [
            { value: 'color', label: 'カラー立面図' },
            { value: 'line', label: '線画' },
          ],
          'color',
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
          '📐 DXF を保存',
        ),
      ),
    );
  },
};
