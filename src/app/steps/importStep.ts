import { h, clear, toast, progressModal, section, field } from '../dom';
import { state, emit } from '../state';
import type { Step, StepCtx } from '../app';
import { parsePdfInBrowser } from '../../parser/browser';
import { parseDxf } from '../../parser';
import { decodeDxf } from '../../parser/dxf';
import { floorPlanSvg } from '../../drawings/plan';
import { openPlanEditor } from '../planEditor';
import { ROOM_TYPE_LABEL, type BuildingModel, type PlanSide, type RoomType } from '../../core/types';
import { openProjectFile, isProjectFile, saveProjectFile } from '../project';

async function loadPdf(ctx: StepCtx, data: Uint8Array, name: string, scaleDenominator?: number, kind: 'pdf' | 'dxf' = 'pdf') {
  const pm = progressModal('平面図を解析しています', false);
  try {
    const model =
      kind === 'dxf'
        ? parseDxf(decodeDxf(data), { name })
        : await parsePdfInBrowser(data.slice(), {
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
    lastPdf = { data, name, kind };
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

let lastPdf: { data: Uint8Array; name: string; kind: 'pdf' | 'dxf' } | null = null;

function dropScreen(ctx: StepCtx) {
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf,.dxf,.json', style: 'display:none' }) as HTMLInputElement;
  const readFile = async (f: File) => {
    if (isProjectFile(f)) {
      try {
        await openProjectFile(f);
      } catch (e) {
        toast((e as Error).message, 'error', 6000);
      }
      return;
    }
    return loadPdf(ctx, new Uint8Array(await f.arrayBuffer()), f.name.replace(/\.(pdf|dxf)$/i, ''), undefined, /\.dxf$/i.test(f.name) ? 'dxf' : 'pdf');
  };
  input.addEventListener('change', () => input.files?.[0] && readFile(input.files[0]));
  const zone = h(
    'div',
    { class: 'dropzone' },
    h('div', { class: 'big' }, '📐'),
    h('p', null, h('b', null, '平面図の PDF（または CAD の DXF）をここにドロップ'), h('br'), 'または'),
    h('button', { class: 'btn primary', onclick: () => input.click() }, 'PDF / DXF ファイルを選択'),
    h('p', { class: 'hint', style: 'margin:10px 0 0' }, '保存したプロジェクト（.madori.json）もここにドロップ、またはこのボタンから開けます'),
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
    state.sheets = [];
    for (const p of state.plans) view.appendChild(h('div', { class: 'sheet', html: p.svg }));
  };
  drawPlans();
  ctx.stage.appendChild(view);

  const rep = model.report;
  const rooms = model.floors.reduce((s, f) => s + f.rooms.length, 0);
  const openings = model.floors.reduce((s, f) => s + f.openings.length, 0);
  const totalArea = model.floors.reduce((s, f) => s + f.rooms.reduce((a, r) => a + r.area, 0), 0);
  const scaleLabel = rep.scaleDenominator ? `1/${rep.scaleDenominator}` : `約1/${Math.round(rep.mmPerPt / 0.3528)}`;
  const srcLabel: Record<string, string> = { dimension: '寸法線から判定', text: '縮尺表記から判定', area: '帖数から推定', module: '壁の間隔から推定', default: '既定値', manual: '手動指定' };

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
  );
  const openEditor = () => {
    ctx.side.style.pointerEvents = 'none';
    ctx.side.style.opacity = '0.45';
    openPlanEditor(ctx.stage, model, (changed) => {
      ctx.side.style.pointerEvents = '';
      ctx.side.style.opacity = '';
      if (changed) {
        emit('model');
        toast('間取りの修正を反映しました（3D・パース・日照に反映されます）', 'ok');
        ctx.app.go('import');
      }
    }, state.pdfName ?? '');
  };
  side.append(
    checkCard(model, openEditor, () => northInput?.focus()),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary block', onclick: () => ctx.app.go('design') }, '3D パースを作成する →')),
    h(
      'div',
      { class: 'edit-callout' },
      h('b', null, '読み取りが違う所は、平面の上で直せます'),
      h('p', null, '部屋がつながっている・壁が足りない・余分な壁がある・窓やドアが無い・部屋名が違う、といった所を、壁を描く／消す、窓・ドアを置く、部屋名を置くだけで修正できます。'),
      h('button', { class: 'btn dark block', onclick: openEditor }, '✏️ 間取りを手で修正する'),
    ),
  );

  // 方位
  const northVal = h('span', null, `${model.northAngleDeg}°`);
  let northInput: HTMLInputElement | null = null;
  side.append(
    section(
      '方位・高さ',
      field(
        '真北の向き（図面の上から時計回り）',
        (northInput = h('input', {
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
        }) as HTMLInputElement),
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
        h('button', { class: 'btn sm', disabled: !lastPdf, onclick: () => lastPdf && loadPdf(ctx, lastPdf.data, lastPdf.name, scaleSel.value ? +scaleSel.value : undefined, lastPdf.kind) }, '再解析'),
        h('button', { class: 'btn sm', title: '図面の読み取り結果・修正・テイスト・建設地をファイルに保存（Ctrl+S）', onclick: () => void saveProjectFile() }, '💾 プロジェクトを保存'),
        h('button', { class: 'btn sm ghost', onclick: () => { state.model = null; emit('model'); ctx.app.go('import'); } }, '別の PDF を読み込む'),
      ),
    ),
  );
}

function numInput(v: number, onChange: (v: number) => void) {
  return h('input', { type: 'number', value: v, step: 50, onchange: (e: Event) => onChange(+(e.target as HTMLInputElement).value) });
}

/**
 * 読み込み直後の確認カード: 階・玄関・方位・階段・部屋・窓ドアを一目で確認し、
 * 怪しい所は修正画面へ直接飛べるようにする
 */
function checkCard(model: BuildingModel, openEditor: () => void, focusNorth: () => void): HTMLElement {
  type Row = { ok: boolean | null; label: string; detail: string; action?: { label: string; fn: () => void } };
  const rows: Row[] = [];
  const floors = model.floors;
  const multi = floors.length >= 2;
  // 階
  const thin = floors.filter((f) => f.rooms.filter((r) => r.type !== 'void').length < 3);
  rows.push({
    ok: floors.length > 0 && thin.length === 0,
    label: '階',
    detail: !floors.length ? '階が読み取れていません' : thin.length ? `${thin.map((f) => `${f.level}階`).join('・')}の部屋がほとんど読めていません（縮尺・壁線の太さを確認）` : floors.map((f) => `${f.level}階 ${f.rooms.filter((r) => r.type !== 'void').length}室`).join('　'),
    action: thin.length ? { label: '修正画面で確認', fn: openEditor } : undefined,
  });
  // 玄関
  const entF = floors.find((f) => f.openings.some((o) => o.kind === 'entrance'));
  const entRoom = floors.flatMap((f) => f.rooms).find((r) => r.type === 'entrance');
  rows.push({
    ok: !!entF,
    label: '玄関',
    detail: entF ? `${entF.level}階に玄関ドア${entRoom ? `（${entRoom.name}）` : ''}` : entRoom ? `「${entRoom.name}」はありますが玄関ドアが読めていません` : '玄関が見つかりません',
    action: entF ? undefined : { label: '修正画面で玄関を置く', fn: openEditor },
  });
  // 方位
  const nd = model.report.northDetected;
  rows.push({
    ok: nd === false ? null : true,
    label: '方位',
    detail: nd === false ? '方位記号が無いため、図面の上を北としています' : `真北 ${model.northAngleDeg}°（${nd ? '方位記号から' : '設定値'}）`,
    action: nd === false ? { label: '真北を指定', fn: focusNorth } : undefined,
  });
  // 階段
  const stairsPerFloor = floors.map((f) => `${f.level}階 ${f.stairs.length}`);
  const f1stairs = floors[0]?.stairs.filter((s) => s.goesUp).length ?? 0;
  rows.push({
    ok: multi ? f1stairs > 0 : true,
    label: '階段',
    detail: multi ? (f1stairs ? `${stairsPerFloor.join('・')} か所` : '1階に上り階段が見つかりません（ウォークスルー・吹抜に影響）') : '平屋（階段なし）',
    action: multi && !f1stairs ? { label: '修正画面で階段を描く', fn: openEditor } : undefined,
  });
  // 部屋名
  const allRooms = floors.flatMap((f) => f.rooms.filter((r) => r.type !== 'void'));
  const unnamed = allRooms.filter((r) => r.type === 'other' || /^室$|^部屋$/.test(r.name.trim()));
  const hasLdk = allRooms.some((r) => r.type === 'ldk' || r.type === 'living');
  rows.push({
    ok: unnamed.length === 0 && hasLdk,
    label: '部屋',
    detail: `${allRooms.length}室${hasLdk ? '' : '（LDK／リビングが見つかりません）'}${unnamed.length ? `、用途が分からない部屋 ${unnamed.length}（${unnamed.slice(0, 3).map((r) => r.name).join('・')}${unnamed.length > 3 ? '…' : ''}）` : ''}`,
    action: unnamed.length || !hasLdk ? { label: '部屋名を直す', fn: openEditor } : undefined,
  });
  // 窓・ドア
  const noWin = floors.filter((f) => !f.openings.some((o) => o.kind === 'window' || o.kind === 'entrance'));
  const opCount = floors.map((f) => `${f.level}階 窓${f.openings.filter((o) => o.kind === 'window').length}・戸${f.openings.filter((o) => o.kind !== 'window').length}`);
  rows.push({
    ok: noWin.length === 0,
    label: '窓・ドア',
    detail: noWin.length ? `${noWin.map((f) => `${f.level}階`).join('・')}に窓が読めていません` : opCount.join('　'),
    action: noWin.length ? { label: '修正画面で窓を置く', fn: openEditor } : undefined,
  });
  // 外形（階ごとの面積の目安）
  const areas = floors.map((f) => f.rooms.filter((r) => r.type !== 'void' && r.type !== 'balcony' && r.type !== 'porch' && r.type !== 'garage').reduce((a, r) => a + r.area, 0));
  const odd = areas.findIndex((a, i) => i > 0 && areas[0] > 0 && a > areas[0] * 1.35);
  rows.push({
    ok: odd < 0,
    label: '広さ',
    detail: odd < 0 ? areas.map((a, i) => `${floors[i].level}階 ${(a / 3.30579).toFixed(1)}坪`).join('　') : `${floors[odd].level}階が1階より大きく読めています（壁の読み落としの可能性）`,
    action: odd < 0 ? undefined : { label: '修正画面で確認', fn: openEditor },
  });

  const ng = rows.filter((r) => r.ok === false).length;
  const head = h('div', { class: 'check-head' }, h('b', null, ng ? `確認してください（${ng} 件）` : '読み取りチェック: 問題なし'), h('span', null, ng ? '⚠ の項目はパース・動画の出来に影響します' : '階・玄関・階段・部屋・窓が揃っています'));
  const list = h(
    'div',
    { class: 'check-rows' },
    ...rows.map((r) =>
      h(
        'div',
        { class: `check-row ${r.ok === false ? 'ng' : r.ok === null ? 'info' : 'ok'}` },
        h('span', { class: 'ic' }, r.ok === false ? '⚠' : r.ok === null ? 'ℹ' : '✓'),
        h('span', { class: 'lb' }, r.label),
        h('span', { class: 'dt' }, r.detail),
        r.action ? h('button', { class: 'btn sm', onclick: r.action.fn }, r.action.label) : null,
      ),
    ),
  );
  return h('div', { class: `check-card ${ng ? 'has-ng' : ''}` }, head, list);
}
