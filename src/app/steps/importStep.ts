import { h, clear, toast, progressModal, section, field } from '../dom';
import { state, emit } from '../state';
import type { Step, StepCtx } from '../app';
import { parsePdfInBrowser } from '../../parser/browser';
import { floorPlanSvg } from '../../drawings/plan';
import { ROOM_TYPE_LABEL, type PlanSide, type RoomType } from '../../core/types';

async function loadPdf(ctx: StepCtx, data: Uint8Array, name: string, scaleDenominator?: number) {
  const pm = progressModal('平面図を解析しています', false);
  try {
    const model = await parsePdfInBrowser(data, {
      name,
      scaleDenominator,
      onProgress: (msg, r) => pm.set(r, msg),
    });
    const rooms = model.floors.reduce((s, f) => s + f.rooms.length, 0);
    if (!model.floors.length || rooms === 0) {
      toast('平面図を認識できませんでした。CAD から出力したベクター形式の PDF をお試しください', 'error', 6000);
      return;
    }
    state.model = model;
    state.pdfName = name;
    lastPdf = { data, name };
    emit('model');
    toast(`${model.floors.length}階分・${rooms}室を認識しました`, 'ok');
    ctx.app.go('import');
  } catch (e) {
    console.error(e);
    toast(`PDF の読み込みに失敗しました: ${(e as Error).message}`, 'error', 6000);
  } finally {
    pm.close();
  }
}

let lastPdf: { data: Uint8Array; name: string } | null = null;

function dropScreen(ctx: StepCtx) {
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', style: 'display:none' }) as HTMLInputElement;
  const readFile = async (f: File) => loadPdf(ctx, new Uint8Array(await f.arrayBuffer()), f.name.replace(/\.pdf$/i, ''));
  input.addEventListener('change', () => input.files?.[0] && readFile(input.files[0]));
  const zone = h(
    'div',
    { class: 'dropzone' },
    h('div', { class: 'big' }, '📐'),
    h('p', null, h('b', null, '平面図の PDF をここにドロップ'), h('br'), 'または'),
    h('button', { class: 'btn primary', onclick: () => input.click() }, 'PDF ファイルを選択'),
    input,
  );
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('hover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('hover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('hover');
    const f = e.dataTransfer?.files?.[0];
    if (f) readFile(f);
  });
  const sample = async (file: string) => {
    const buf = new Uint8Array(await (await fetch(`./samples/${file}`)).arrayBuffer());
    loadPdf(ctx, buf, 'サンプル邸');
  };
  return h(
    'div',
    { class: 'drop' },
    h(
      'div',
      { class: 'drop-card' },
      h('h1', null, '平面図 PDF から、ワクワクするプレゼンを。'),
      h('p', null, '間取りの PDF を読み込むだけで、壁・窓・ドア・部屋を自動で認識し、立面図・外観／内観パース・ウォークスルー動画・日照シミュレーションまで一気に作成します。'),
      zone,
      h(
        'div',
        { class: 'btn-row', style: 'justify-content:center;margin-top:14px' },
        h('span', { style: 'font-size:13px;color:#8b9098;align-self:center' }, 'お試し:'),
        h('button', { class: 'btn sm', onclick: () => sample('sample_house_A3.pdf') }, 'サンプル平面図（A3・1階2階）'),
        h('button', { class: 'btn sm', onclick: () => sample('sample_house_pages.pdf') }, 'サンプル平面図（階ごと・方位回転）'),
        h('button', { class: 'btn sm', onclick: () => sample('sample_house_site.pdf') }, 'サンプル平面図（敷地・道路あり）'),
      ),
      h(
        'div',
        { class: 'flow' },
        h('div', null, h('b', null, '① 図面を読む'), '壁・開口部・室名・寸法・方位を自動認識'),
        h('div', null, h('b', null, '② パースを作る'), 'テイストを選ぶだけで外観・内観が完成'),
        h('div', null, h('b', null, '③ 日当たりを見る'), '航空写真と周辺建物で季節・時刻の日照を検討'),
        h('div', null, h('b', null, '④ 提案する'), '動画とプレゼン資料をワンクリックで出力'),
      ),
    ),
  );
}

export const importStep: Step = {
  id: 'import',
  label: '図面読込',
  needsModel: false,
  uses3d: false,
  mount(ctx) {
    ctx.stage.style.pointerEvents = 'auto';
    if (!state.model) {
      ctx.stage.appendChild(dropScreen(ctx));
      ctx.side.append(
        h('h2', null, 'はじめに'),
        h('p', { class: 'lead' }, 'CAD（ARCHITREND・Walk in home・JW-CAD など）から出力したベクター形式の PDF に対応しています。1ページに複数階が並んだ図面、階ごとに分かれた図面のどちらも読み込めます。'),
        section(
          '読み取りのコツ',
          h(
            'ul',
            { style: 'font-size:13px;line-height:1.9;color:#5b6068;padding-left:18px;margin:0' },
            h('li', null, '「S=1/100」などの縮尺表記、または寸法線と寸法値があると縮尺を自動判定します'),
            h('li', null, '室名（LDK・洋室・和室・浴室など）と帖数の文字から部屋の用途を判定します'),
            h('li', null, '方位記号（N）から真北の向きを読み取ります'),
            h('li', null, '「前面道路」「幅員4.0m」などの文字と敷地境界線から、道路に面する側と敷地の広さを読み取ります'),
            h('li', null, '「S=1/100」のまま縮小印刷された図面も、帖数表記から実際の縮尺に補正します'),
            h('li', null, 'スキャン画像の PDF は読み取り精度が下がります'),
          ),
        ),
        section(
          'お客様情報',
          field('プロジェクト名', h('input', { type: 'text', value: state.name, oninput: (e: Event) => (state.name = (e.target as HTMLInputElement).value) })),
          field('お客様名', h('input', { type: 'text', value: state.customer, oninput: (e: Event) => (state.customer = (e.target as HTMLInputElement).value) })),
          field('会社名・担当者', h('input', { type: 'text', value: state.company, placeholder: '〇〇ホーム 設計担当 〇〇', oninput: (e: Event) => (state.company = (e.target as HTMLInputElement).value) })),
        ),
      );
      return;
    }
    renderResult(ctx);
  },
};

const PLAN_SIDE_LABEL: Record<PlanSide, string> = { top: '図面の上', right: '図面の右', bottom: '図面の下', left: '図面の左' };

/** 図面の辺 → 方位（北・南東など） */
function sideCompass(side: PlanSide, northDeg: number): string {
  const v = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] }[side];
  const a = (northDeg * Math.PI) / 180;
  const n = [Math.sin(a), -Math.cos(a)];
  const e = [Math.cos(a), Math.sin(a)];
  const deg = ((Math.atan2(v[0] * e[0] + v[1] * e[1], v[0] * n[0] + v[1] * n[1]) * 180) / Math.PI + 360) % 360;
  return ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(deg / 45) % 8];
}

/** 接道（道路に面する側）と敷地の確認・修正 */
function roadSection(model: NonNullable<typeof state.model>, redraw: () => void): HTMLElement {
  const box = h('div');
  const render = () => {
    clear(box);
    const site = model.site;
    const roads = site?.roads ?? [];
    const sides: PlanSide[] = ['top', 'right', 'bottom', 'left'];
    const detected = roads.filter((r) => r.source !== 'manual');
    const summary = roads.length
      ? roads.map((r) => `${sideCompass(r.side, model.northAngleDeg)}側（${PLAN_SIDE_LABEL[r.side]}）${r.widthMm ? `・幅員${(r.widthMm / 1000).toFixed(1)}m` : ''}`).join('／')
      : '図面に道路の表記が見つかりませんでした。玄関の向きを道路側として扱っています';
    const src = detected.length ? `図面の「${detected.map((r) => r.label).filter(Boolean).join('」「')}」から読み取り` : roads.length ? '手動で設定' : '';
    const nb = site ? Object.keys(site.bounds).length : 0;
    const parts: (HTMLElement | null)[] = [
      h('div', { style: 'font-size:13px;line-height:1.8' }, h('b', null, '道路：'), summary),
      src ? h('div', { class: 'hint', style: 'margin:0' }, src) : null,
      h('div', { class: 'field-label', style: 'margin-top:8px' }, '道路に面している側（角地は複数選択）'),
      h(
        'div',
        { class: 'btn-row', style: 'margin-top:0' },
        sides.map((sd) => {
          const on = roads.some((r) => r.side === sd);
          return h(
            'button',
            {
              class: `btn sm ${on ? 'dark' : ''}`,
              onclick: () => {
                const s0 = (model.site ??= { roads: [], bounds: {} });
                if (on) s0.roads = s0.roads.filter((r) => r.side !== sd);
                else s0.roads.push({ side: sd, source: 'manual', widthMm: s0.roads[0]?.widthMm });
                emit('model');
                redraw();
                render();
              },
            },
            `${sideCompass(sd, model.northAngleDeg)}（${PLAN_SIDE_LABEL[sd].replace('図面の', '')}）`,
          );
        }),
      ),
      roads.length
        ? field(
            '道路幅員 (m)',
            h('input', {
              type: 'number',
              step: 0.5,
              min: 2,
              max: 30,
              value: roads[0].widthMm ? roads[0].widthMm / 1000 : '',
              placeholder: '例: 4.0',
              onchange: (e: Event) => {
                const v = parseFloat((e.target as HTMLInputElement).value);
                for (const r of roads) r.widthMm = Number.isFinite(v) ? v * 1000 : undefined;
                emit('model');
                redraw();
                render();
              },
            }),
          )
        : null,
      h(
        'div',
        { style: 'font-size:12.5px;color:#5b6068;line-height:1.8' },
        `敷地境界線：${nb ? `${nb}辺を図面から読み取り` : '図面から読み取れなかったため標準の余白で作成'}${site?.areaM2 ? `／敷地面積 ${site.areaM2.toFixed(2)}㎡（${(site.areaM2 / 3.30579).toFixed(1)}坪）` : ''}`,
      ),
      h('p', { class: 'hint' }, '道路側に駐車スペース・アプローチを配置し、「道路側から見た外観パース」を作成します。'),
    ];
    box.append(...parts.filter((x): x is HTMLElement => !!x));
  };
  render();
  return section('接道・敷地', box);
}

function renderResult(ctx: StepCtx) {
  const model = state.model!;
  const view = h('div', { class: 'plan-view' });
  const drawPlans = () => {
    clear(view);
    state.plans = model.floors.map((f) => ({ level: f.level, svg: floorPlanSvg(model, f) }));
    for (const p of state.plans) view.appendChild(h('div', { class: 'sheet', html: p.svg }));
  };
  drawPlans();
  ctx.stage.appendChild(view);

  const rep = model.report;
  const rooms = model.floors.reduce((s, f) => s + f.rooms.length, 0);
  const openings = model.floors.reduce((s, f) => s + f.openings.length, 0);
  const totalArea = model.floors.reduce((s, f) => s + f.rooms.reduce((a, r) => a + r.area, 0), 0);
  const scaleLabel = rep.scaleDenominator ? `1/${rep.scaleDenominator}` : `約1/${Math.round(rep.mmPerPt / 0.3528)}`;
  const srcLabel: Record<string, string> = { dimension: '寸法線から判定', text: '縮尺表記から判定', area: '帖数から推定', default: '既定値', manual: '手動指定' };

  const side = ctx.side;
  side.append(
    h('h2', null, '図面の解析結果'),
    h('p', { class: 'lead' }, `${state.pdfName ?? ''} を読み込みました。部屋名や用途が違う場合はここで修正できます（3D・パース・日照に反映されます）。`),
    h(
      'div',
      { class: 'stats' },
      h('div', { class: 'stat' }, h('b', null, `${model.floors.length}`), h('span', null, '階')),
      h('div', { class: 'stat' }, h('b', null, `${rooms}`), h('span', null, '部屋')),
      h('div', { class: 'stat' }, h('b', null, `${openings}`), h('span', null, '窓・ドア')),
    ),
    h('div', { style: 'font-size:12.5px;color:#5b6068;line-height:1.8' }, `縮尺 ${scaleLabel}（${srcLabel[rep.scaleSource]}）／延床 約${totalArea.toFixed(1)}㎡（${(totalArea / 3.30579).toFixed(1)}坪）／壁厚 ${rep.wallThicknesses.slice(0, 4).join('・')}mm`),
    ...rep.warnings.map((w) => h('div', { class: 'warn' }, w)),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary block', onclick: () => ctx.app.go('design') }, '3D パースを作成する →')),
  );

  // 方位
  const northVal = h('span', null, `${model.northAngleDeg}°`);
  side.append(
    section(
      '方位・高さ',
      field(
        '真北の向き（図面の上から時計回り）',
        h('input', {
          type: 'range',
          min: -180,
          max: 180,
          step: 1,
          value: model.northAngleDeg,
          oninput: (e: Event) => {
            model.northAngleDeg = +(e.target as HTMLInputElement).value;
            northVal.textContent = `${model.northAngleDeg}°`;
          },
          onchange: () => {
            emit('model');
            drawPlans();
          },
        }),
      ),
      northVal,
      h(
        'div',
        { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px' },
        field('1階床高 (mm)', numInput(model.floors[0]?.elevation ?? 500, (v) => {
          let e = v;
          for (const f of model.floors) {
            f.elevation = e;
            e += f.height;
          }
          emit('model');
        })),
        field('階高 (mm)', numInput(model.floors[0]?.height ?? 2900, (v) => {
          let e = model.floors[0]?.elevation ?? 500;
          for (const f of model.floors) {
            f.height = v;
            f.elevation = e;
            e += v;
          }
          emit('model');
        })),
        field('天井高 (mm)', numInput(model.floors[0]?.ceilingHeight ?? 2400, (v) => {
          for (const f of model.floors) f.ceilingHeight = v;
          emit('model');
        })),
      ),
    ),
  );

  // 接道・敷地
  side.append(roadSection(model, drawPlans));

  // 部屋
  const types = Object.keys(ROOM_TYPE_LABEL) as RoomType[];
  for (const f of model.floors) {
    const tbody = h('tbody');
    for (const r of f.rooms) {
      tbody.appendChild(
        h(
          'tr',
          null,
          h('td', { style: 'width:44%' }, h('input', { value: r.name, onchange: (e: Event) => { r.name = (e.target as HTMLInputElement).value; emit('model'); drawPlans(); } })),
          h(
            'td',
            { style: 'width:34%' },
            h(
              'select',
              { onchange: (e: Event) => { r.type = (e.target as HTMLSelectElement).value as RoomType; emit('model'); drawPlans(); } },
              types.map((t) => h('option', { value: t, selected: t === r.type }, ROOM_TYPE_LABEL[t])),
            ),
          ),
          h('td', { style: 'text-align:right;color:#8b9098' }, `${(r.labeledTatami ?? r.area / 1.62).toFixed(1)}帖`),
        ),
      );
    }
    side.append(section(`${f.level}階の部屋`, h('table', { class: 'room-table' }, tbody)));
  }

  // 再読み込み
  const scaleSel = h(
    'select',
    null,
    h('option', { value: '' }, '自動判定'),
    [30, 50, 100, 150, 200].map((n) => h('option', { value: n, selected: rep.scaleDenominator === n && rep.scaleSource === 'manual' }, `1/${n}`)),
  ) as HTMLSelectElement;
  side.append(
    section(
      '読み込みのやり直し',
      field('縮尺を指定して再解析', scaleSel, '縮尺がずれている場合に指定してください'),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn sm', disabled: !lastPdf, onclick: () => lastPdf && loadPdf(ctx, lastPdf.data, lastPdf.name, scaleSel.value ? +scaleSel.value : undefined) }, '再解析'),
        h('button', { class: 'btn sm ghost', onclick: () => { state.model = null; emit('model'); ctx.app.go('import'); } }, '別の PDF を読み込む'),
      ),
    ),
  );
}

function numInput(v: number, onChange: (v: number) => void) {
  return h('input', { type: 'number', value: v, step: 50, onchange: (e: Event) => onChange(+(e.target as HTMLInputElement).value) });
}
