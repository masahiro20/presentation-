import { h, clear, section, segmented, download, svgToDataUrl, svgToPng, toast } from '../dom';
import { state } from '../state';
import type { Step, StepCtx } from '../app';
import { renderElevation, type ElevationDir } from '../../drawings/elevation';
import { floorPlanSvg } from '../../drawings/plan';

const DIRS: ElevationDir[] = ['south', 'east', 'north', 'west'];

function generate(ctx: StepCtx, color: boolean) {
  ctx.app.ensureScene();
  const v = ctx.app.viewer;
  const prevCut = v.groups.roof.visible;
  v.setCutaway(null);
  state.elevations = DIRS.map((d) => {
    const r = renderElevation(v, d, { color });
    return { dir: d, title: r.title, svg: r.svg };
  });
  if (!prevCut) v.setCutaway(null);
  state.plans = state.model!.floors.map((f) => ({ level: f.level, svg: floorPlanSvg(state.model!, f) }));
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
      for (const e of state.elevations) view.appendChild(h('div', { class: 'sheet wide', html: e.svg }));
      for (const p of state.plans) view.appendChild(h('div', { class: 'sheet', html: p.svg }));
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
    if (!state.elevations.length) regen();
    else draw();
    const dl = async (name: string, svg: string, fmt: 'svg' | 'png') => {
      if (fmt === 'svg') download(svgToDataUrl(svg), `${state.name}_${name}.svg`);
      else download(await svgToPng(svg, 3000), `${state.name}_${name}.png`);
    };
    ctx.side.append(
      h('h2', null, '立面図'),
      h('p', { class: 'lead' }, '3D モデルから東西南北の4面の立面図を自動作成します。隠れ線を処理したベクター図面なので、拡大しても線がきれいです。GL・各階 FL・軒高・最高高さを記入しています。'),
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
        'ダウンロード',
        ...state.elevations.map((e) =>
          h('div', { class: 'btn-row', style: 'align-items:center' }, h('span', { style: 'flex:1;font-size:13px' }, e.title), h('button', { class: 'btn sm', onclick: () => dl(e.title, e.svg, 'svg') }, 'SVG'), h('button', { class: 'btn sm', onclick: () => dl(e.title, e.svg, 'png') }, 'PNG')),
        ),
        ...state.plans.map((p) =>
          h('div', { class: 'btn-row', style: 'align-items:center' }, h('span', { style: 'flex:1;font-size:13px' }, `${p.level}階平面図`), h('button', { class: 'btn sm', onclick: () => dl(`${p.level}階平面図`, p.svg, 'svg') }, 'SVG'), h('button', { class: 'btn sm', onclick: () => dl(`${p.level}階平面図`, p.svg, 'png') }, 'PNG')),
        ),
      ),
    );
  },
};
