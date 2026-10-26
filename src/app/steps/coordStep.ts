/**
 * コーディネート（打ち合わせを減らす段取り）
 *
 * 1. 決める順番（外まわり → LDK の床・キッチン・建具 → 水まわり・設備）に沿って部位を並べ、決まり具合を見せる
 * 2. 部位ごとに候補を 2〜3 案に絞る（差額は図面の数量で計算した、この家の金額）。「3D で見比べる」で候補を並べた絵にする
 * 3. 「プロの目」: 色数・金物の色・木の色の喧嘩・明るさ・汚れやすさを点検し、お客様に話せる言葉で出す
 * 4. 体験リンクで候補を送り、お客様が家で自分の家の 3D を見ながら選ぶ → 「お客様の選択を受け取る」で取り込む
 * 5. 打ち合わせで「決定」→ 仕様決定書（署名欄つき・A4）と発注用の一覧（CSV）
 *
 * ステージ: 3D（選んだ部位の見える構図へ自動で移動）／決定ボード（大きな画面でお客様と見る）／仕様決定書（印刷）
 */
import { h, clear, section, fold, toast, modal, download } from '../dom';
import { state, emit } from '../state';
import type { Step, StepCtx } from '../app';
import type { Shot } from '../../scene/shots';
import { FINISH_CATEGORIES, selectedProduct, catalogUrl, type FinishCategory, type Product } from '../../coordinate/catalog';
import { MOODS, moodOf, applyMood } from '../../coordinate/moods';
import { harmonyCheck, adviceFor, type Advice } from '../../coordinate/harmony';
import { ROUNDS, EQUIPMENT_CATS, STATUS_LABEL, DEPENDS, itemOf, setCandidates, decide, progress, blockedBy, needsReview, isFixed, categoryById, applyCustomerPicks, picksUrlFor, reconcileDecided, shotFor, deltaText, NON_VISUAL, type CoordState, type DecisionStatus, type CustomerPicks } from '../../coordinate/decisions';
import { syncEstimateWithFinishes, finishDeltas } from './estimateStep';
import { currentShots } from './designStep';
import { shareDialog } from '../share';
import { lookOf, hasLook, shrinkPhoto, saveLibrarySample, deleteLibrarySample, librarySample } from '../../coordinate/samples';
import { renderStudio } from '../../scene/studio';
import { exposureFor } from '../draftCapture';
import type { DesignOptions } from '../../styles/presets';

type StageMode = '3d' | 'board' | 'doc';
let stageMode: StageMode = '3d';
/** 開いている部位（サイドパネル） */
let openCat: string | null = null;
let prevViewMode: 'browse' | 'finish' = 'browse';
let viewerRef: { setViewMode(m: 'browse' | 'finish'): void } | null = null;

const catLabel = (id: string) => categoryById(id)?.label ?? id;

function productLabel(p: Product): string {
  return `${p.maker === '—' ? '' : `${p.maker}　`}${p.name}${p.color ? `　${p.color}` : ''}`;
}

/** お客様に見せる候補（未設定なら今の選択と、その次の 2 つ） */
function candidatesOf(c: CoordState, cat: FinishCategory, d: DesignOptions): string[] {
  const it = itemOf(c, cat.id);
  if (it.candidates && it.candidates.length >= 2) return it.candidates;
  const cur = selectedProduct(cat, d).id;
  const rest = cat.products.map((p) => p.id).filter((id) => id !== cur);
  return [cur, ...rest].slice(0, 3);
}

/**
 * コーディネートの定点カメラ: 間取りごとに 1 度だけ決めて使い回す（部位を開くたび・見比べのたびに構図が変わらないように）。
 * 室内は LDK を少し広角（建築写真の 20mm → 16mm 相当）で、部屋全体が入るように
 */
type FixedKey = 'ldk' | 'ext' | 'ent' | 'wet' | 'stair';
let fixedViews: { model: unknown; views: Partial<Record<FixedKey, Shot>> } | null = null;
const FIXED_OF: Record<FixedKey, string> = { ldk: 'floor', ext: 'extWall', ent: 'entFloor', wet: 'wetFloor', stair: 'stair' };
function fixedView(ctx: StepCtx, key: FixedKey): Shot | undefined {
  // 建物を作り直したとき（間取りの修正）だけ決め直す。家具・照明の差し替えでは変えない
  const key0 = ctx.app.viewer.state?.meta;
  if (!fixedViews || fixedViews.model !== key0) {
    const shots = currentShots(ctx);
    const views: Partial<Record<FixedKey, Shot>> = {};
    for (const k of Object.keys(FIXED_OF) as FixedKey[]) {
      const s0 = shotFor(FIXED_OF[k], shots);
      if (!s0) continue;
      views[k] = s0.kind === 'interior' ? { ...s0, view: { ...s0.view, fov: Math.min(78, s0.view.fov + 10) } } : s0;
    }
    fixedViews = { model: key0, views };
  }
  return fixedViews.views[key];
}
/** 部位 → 定点（外部は道路側の外観、玄関土間は玄関、水まわりは洗面、階段は階段、他は LDK） */
function viewFor(ctx: StepCtx, catId: string): Shot | undefined {
  if (NON_VISUAL.has(catId)) return undefined;
  const cat = categoryById(catId);
  const key: FixedKey = catId === 'entFloor' ? 'ent' : catId === 'wetFloor' ? 'wet' : catId === 'stair' ? 'stair' : cat?.part === '外部' ? 'ext' : 'ldk';
  return fixedView(ctx, key) ?? fixedView(ctx, 'ldk');
}

/** 見比べの絵（同じ構図・同じ光で、部位だけ差し替えて描く） */
async function renderCompare(ctx: StepCtx, catId: string, ids: string[], w = 960, hgt = 540): Promise<{ id: string; url: string }[]> {
  const v = ctx.app.viewer;
  const shot = viewFor(ctx, catId);
  if (!shot) return [];
  const keep = state.design;
  const prevView = v.currentView();
  const out: { id: string; url: string }[] = [];
  try {
    for (const id of ids) {
      v.setDesign({ ...keep, finishes: { ...(keep.finishes ?? {}), [catId]: id } });
      v.applyShot(shot);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      // 色を決めるための絵なので、資料の下絵と同じ描き方（室内の照明・露出・柔らかい影）で描く
      out.push({ id, url: await renderStudio(v, { width: w, height: hgt, interior: shot.kind === 'interior', exposure: exposureFor(shot.kind, v.design.timeOfDay) }) });
    }
  } finally {
    v.setDesign(keep);
    v.applyView(prevView);
  }
  return out;
}

export const coordStep: Step = {
  id: 'coord',
  label: 'コーディネート',
  short: 'コーデ',
  needsModel: true,
  uses3d: true,
  mount(ctx) {
    const v = ctx.app.viewer;
    v.setCutaway(null);
    v.setTownVisible(false);
    v.groups.context.visible = false;
    // 色・素材を決める画面なので、3D は仕上げ表示（室内の照明・高精細）。閲覧表示の昼は室内の照明を消すため、床や壁が灰色に沈んで見える
    prevViewMode = v.viewMode;
    v.setViewMode('finish');
    viewerRef = v;
    const side = ctx.side;

    // ---- ステージ: 3D／決定ボード／仕様決定書 ----
    const modeBar = h('div', { class: 'view-tools', style: 'pointer-events:auto;z-index:31' });
    const overlay = h('div', { class: 'coord-overlay', style: 'pointer-events:auto' });
    ctx.stage.append(modeBar, overlay);
    const renderModeBar = () => {
      clear(modeBar);
      for (const [m, label] of [
        ['3d', '3D で見る'],
        ['board', '決定ボード'],
        ['doc', '仕様決定書'],
      ] as const)
        modeBar.appendChild(h('button', { class: `btn ${stageMode === m ? 'on' : ''}`, onclick: () => setMode(m) }, label));
      if (stageMode === '3d') {
        modeBar.appendChild(h('span', { class: 'sep' }));
        for (const [k, label] of [['ldk', 'LDK 広角'], ['ext', '外観'], ['ent', '玄関'], ['wet', '水まわり']] as const)
          if (fixedView(ctx, k)) modeBar.appendChild(h('button', { class: 'btn', title: '決まった構図（定点）で見る。部位を開いたときも同じ構図に戻ります', onclick: () => showFixed(k) }, label));
      }
      if (stageMode === 'doc') modeBar.appendChild(h('button', { class: 'btn primary', onclick: () => window.print() }, '印刷・PDF'));
    };
    const setMode = (m: StageMode) => {
      stageMode = m;
      document.body.classList.toggle('print-coord', m === 'doc');
      renderAll();
    };

    const coord = () => state.coord;
    /** 事務所の写真庫（このブラウザ）の写真。プロジェクトに入っている写真が優先 */
    const lib: Record<string, string> = {};
    const sampleMap = () => ({ ...lib, ...(state.coord.samples ?? {}) });
    /** 使っている商品（選択中・候補）の写真をプロジェクトに写す（保存ファイル・体験リンクに入るように） */
    const syncUsedSamples = () => {
      const used = new Set<string>();
      for (const cat of FINISH_CATEGORIES) {
        used.add(selectedProduct(cat, state.design).id);
        for (const id of itemOf(state.coord, cat.id).candidates ?? []) used.add(id);
      }
      const cur = state.coord.samples ?? {};
      const next: Record<string, string> = {};
      for (const id of used) if (cur[id] ?? lib[id]) next[id] = cur[id] ?? lib[id];
      if (JSON.stringify(Object.keys(next).sort()) !== JSON.stringify(Object.keys(cur).sort())) state.coord = { ...state.coord, samples: next };
    };
    const setCoord = (c: CoordState) => {
      state.coord = c;
      syncUsedSamples();
    };

    /** 商品を選ぶ（3D・見積を同時に）。決定済みの部位を変えたら決定を外し、後から決めた部位に見直しの印 */
    const choose = (catId: string, productId: string) => {
      const before = selectedProduct(categoryById(catId)!, state.design).id;
      if (before === productId) return;
      state.design = { ...state.design, finishes: { ...(state.design.finishes ?? {}), [catId]: productId } };
      v.setDesign(state.design);
      syncEstimateWithFinishes();
      let c = coord();
      if (itemOf(c, catId).status === 'decided') {
        c = decide(c, catId, false);
        toast(`${catLabel(catId)} の決定を外しました（選び直したため）`, 'info');
      }
      const review = needsReview(c, catId);
      if (review.length) toast(`${review.map(catLabel).join('・')} は ${catLabel(catId)} に合わせて決めています。合っているか見直してください`, 'info', 6000);
      setCoord(c);
      emit('coord');
      renderAll();
    };

    const flyTo = (catId: string) => {
      if (stageMode !== '3d') return;
      const s = viewFor(ctx, catId);
      if (s) v.applyShot(s, true);
    };
    /** 定点で見せる（お客様と画面を見るとき、動かしすぎない） */
    const showFixed = (key: FixedKey) => {
      const s = fixedView(ctx, key);
      if (s) v.applyShot(s, true);
    };

    // ---- 見比べ（モーダル） ----
    const openCompare = async (catId: string) => {
      const cat = categoryById(catId)!;
      const ids = candidatesOf(coord(), cat, state.design);
      const deltas = finishDeltas(catId);
      const box = h('div', { class: 'coord-compare' }, h('p', { class: 'hint' }, '描いています…'));
      const m = modal(`${cat.label}を見比べる（同じ構図・同じ光）`, box, [{ label: '閉じる' }], true);
      const imgs = await renderCompare(ctx, catId, ids);
      clear(box);
      const base = state.design;
      for (const id of ids) {
        const p = cat.products.find((x) => x.id === id)!;
        const img = imgs.find((x) => x.id === id);
        const warns = adviceFor(harmonyCheck({ ...base, finishes: { ...(base.finishes ?? {}), [catId]: id } }), catId);
        const on = selectedProduct(cat, state.design).id === id;
        box.appendChild(
          h(
            'figure',
            { class: `coord-cmp ${on ? 'on' : ''}` },
            img ? h('img', { src: img.url }) : h('div', { class: 'sw big' }, ...p.swatch.map((c) => h('span', { style: `background:${c}` }))),
            (() => {
              // 3D の絵の下に、実物写真（無ければ質感イメージ）: 画面の色と実物の差を埋める
              const look = lookOf(catId, p, base, sampleMap());
              return look ? h('div', { class: 'sample' }, h('img', { src: look.url }), h('span', { class: look.real ? 'real' : '' }, look.real ? '実物写真' : '質感イメージ（実物はサンプルで）')) : null;
            })(),
            h(
              'figcaption',
              null,
              h('div', { class: 'nm' }, productLabel(p)),
              h('div', { class: 'cd' }, [p.code, p.note].filter(Boolean).join('　')),
              h('div', { class: `dl ${deltas[id] && deltas[id]! > 0 ? 'up' : ''}` }, on ? '今の選択' : deltaText(deltas[id])),
              ...warns.map((a) => h('div', { class: `adv ${a.level}` }, `${a.level === 'warn' ? '⚠' : '・'} ${a.title}`)),
              h('button', { class: `btn sm ${on ? 'dark' : ''}`, onclick: () => { choose(catId, id); m(); } }, on ? '選択中' : 'これにする'),
            ),
          ),
        );
      }
      if (!imgs.length) box.prepend(h('p', { class: 'hint' }, 'この部位は見た目が 3D で変わらないので、色見本で比べます。'));
    };

    // ---- お客様の選択を受け取る ----
    const receivePicks = async () => {
      let link = coord().shareUrl;
      if (!link) {
        const input = h('input', { type: 'text', placeholder: 'https://…/view.html?p=…', style: 'width:100%' }) as HTMLInputElement;
        await new Promise<void>((resolve) => modal('お客様に送った体験リンク', h('div', null, h('p', { class: 'hint' }, 'お客様に送った体験リンクを貼ってください。'), input), [{ label: '取り込む', primary: true, onClick: () => resolve() }, { label: 'やめる', onClick: () => resolve() }]));
        link = input.value.trim();
        if (!link) return;
        setCoord({ ...coord(), shareUrl: link });
      }
      const url = picksUrlFor(link);
      if (!url) {
        toast('体験リンクの形が違います（view.html?p=… のリンクを使ってください）', 'error');
        return;
      }
      let picks: CustomerPicks;
      try {
        const r = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
        picks = (await r.json()) as CustomerPicks;
      } catch {
        toast('お客様の選択がまだ届いていません（お客様が体験リンクの「仕様を選ぶ」→「担当者に送る」を押すと届きます）', 'info', 7000);
        return;
      }
      const res = applyCustomerPicks(coord(), state.design, picks);
      setCoord(res.coord);
      state.design = { ...state.design, finishes: res.finishes };
      v.setDesign(state.design);
      syncEstimateWithFinishes();
      emit('coord');
      renderAll();
      const n = Object.keys(picks.picks).length;
      toast(`お客様の選択を取り込みました（${n} 部位・変更 ${res.changed.length}）`, 'ok', 6000);
      if (res.conflicts.length)
        modal(
          '決定済みの部位にお客様の別の選択があります',
          h('div', null, h('p', null, `${res.conflicts.map(catLabel).join('・')} は決定済みのため変えていません。お客様の選択は各部位に表示しています。変える場合は部位を開いて選び直してください。`)),
        );
    };

    // ---- サイドパネル ----
    const renderSide = (adv: Advice[]) => {
      clear(side);
      const c = coord();
      const pr = progress(c);
      side.append(
        h('h2', null, 'コーディネート'),
        h(
          'div',
          { class: 'coord-progress' },
          h('div', { class: 'bar' }, h('span', { style: `width:${Math.round((pr.decided / pr.total) * 100)}%` })),
          h('div', { class: 'txt' }, h('b', null, `決定 ${pr.decided} / ${pr.total}`), `　${pr.byRound.map((r) => `${'①②③'[r.no - 1]} ${r.decided}/${r.total}`).join('　')}`),
        ),
        h('p', { class: 'hint', style: 'margin:6px 0 10px' }, '進め方: 決める順番に、候補を 2〜3 案に絞る → 体験リンクでお客様に送る（家で 3D を見て選べます）→ 打ち合わせで「決定」→ 仕様決定書に署名。'),
      );

      // 雰囲気（最初の一手）
      {
        const cur = moodOf(state.design);
        const grid = h(
          'div',
          { class: 'style-grid mood-grid' },
          MOODS.map((m) =>
            h(
              'button',
              {
                class: `style-card ${cur?.id === m.id ? 'on' : ''}`,
                title: m.catch,
                onclick: () => {
                  const before = state.design;
                  state.design = applyMood(state.design, m);
                  // 決定済みの部位が雰囲気で入れ替わったら、決定を外す（決めた内容と違う物が決定のまま残らないように）
                  const { coord: cc, undone } = reconcileDecided(coord(), before, state.design);
                  setCoord(cc);
                  if (undone.length) toast(`雰囲気を変えたので、${undone.join('・')} の決定を外しました`, 'info', 6000);
                  v.setDesign(state.design);
                  syncEstimateWithFinishes();
                  renderAll();
                },
              },
              h('div', { class: 'sw' }, m.swatch.map((col) => h('span', { style: `background:${col}` }))),
              h('div', { class: 'nm' }, m.name),
              h('div', { class: 'ct' }, m.catch),
            ),
          ),
        );
        side.appendChild(fold('雰囲気から始める', { open: pr.decided === 0 && !cur, meta: cur ? cur.name : '未選択' }, h('p', { class: 'hint', style: 'margin-top:0' }, '御社の事例と SNS で人気の組み合わせ。選ぶと部位ごとの商品がまとめて入ります（決定済みの部位も入れ替わるので最初に）。'), grid, cur ? h('div', { class: 'mood-why' }, h('p', null, cur.why), h('p', null, h('b', null, '合う間取り・お客様 '), cur.fits)) : null));
      }

      // プロの目
      {
        const warn = adv.filter((a) => a.level === 'warn');
        const note = adv.filter((a) => a.level === 'note');
        const good = adv.filter((a) => a.level === 'good');
        const row = (a: Advice) => h('div', { class: `coord-adv ${a.level}` }, h('div', { class: 't' }, `${a.level === 'warn' ? '⚠ ' : a.level === 'good' ? '✓ ' : '・'}${a.title}`), h('div', { class: 'w' }, a.why), h('div', { class: 'c' }, a.cats.map(catLabel).join('・')));
        side.appendChild(
          fold(
            'プロの目（組み合わせの点検）',
            { open: warn.length > 0, meta: `${warn.length ? `要確認 ${warn.length}` : '問題なし'}・ひとこと ${note.length}・良い点 ${good.length}`, cls: warn.length ? 'has-warn' : '' },
            ...warn.map(row),
            ...note.map(row),
            good.length ? h('details', { class: 'coord-good' }, h('summary', null, `良い点 ${good.length}（お客様への安心材料）`), ...good.map(row)) : null,
          ),
        );
      }

      // 決める順番ごと
      for (const r of ROUNDS) {
        const dn = r.cats.filter((id) => itemOf(c, id).status === 'decided').length;
        const rows = r.cats.map((id) => catRow(id, adv));
        side.appendChild(fold(`${'①②③'[r.no - 1]} ${r.title}`, { open: r.cats.includes(openCat ?? '') || (dn < r.cats.length && r.no === firstOpenRound(c)), meta: `決定 ${dn}/${r.cats.length}`, cls: 'coord-round' }, h('p', { class: 'hint', style: 'margin:0 0 4px' }, r.why), h('p', { class: 'hint', style: 'margin:0 0 8px' }, `目安: ${r.deadline}。${r.prepare}`), ...rows, bulkStandard(r.cats)));
      }

      // お客様とのやり取り
      {
        const proposed = FINISH_CATEGORIES.filter((cat) => (itemOf(c, cat.id).candidates?.length ?? 0) >= 2 && itemOf(c, cat.id).status !== 'decided').length;
        side.appendChild(
          section(
            'お客様に選んでもらう',
            h('p', { class: 'hint', style: 'margin-top:0' }, `候補を絞った部位: ${proposed}。体験リンクの「仕様を選ぶ」に、候補だけが並びます（お客様は自分の家の 3D で切り替えて見比べ、ひとことを添えて送れます）。`),
            h('button', { class: 'btn primary block', onclick: () => void shareDialog() }, '候補を体験リンクで送る'),
            h('button', { class: 'btn dark block', style: 'margin-top:8px', onclick: () => void receivePicks() }, 'お客様の選択を受け取る'),
            c.customerNote ? h('div', { class: 'coord-cust' }, h('b', null, 'お客様から: '), c.customerNote) : null,
            c.shareUrl ? h('p', { class: 'hint' }, `受け取り先: 最後に作った体験リンク`) : null,
          ),
        );
      }

      // 設備: 色で選ぶものではないので、仕様の確認だけ（見積に反映）
      side.appendChild(
        fold(
          '設備の仕様（確認だけ）',
          { meta: EQUIPMENT_CATS.map((id) => selectedProduct(categoryById(id)!, state.design).name.replace(/（.*?）/g, '')).join('・') },
          h('p', { class: 'hint', style: 'margin-top:0' }, '太陽光・給湯・換気・空調・トイレは、色や柄のコーディネートではなく仕様の確認です。変えると見積に反映します。'),
          ...EQUIPMENT_CATS.map((id) => {
            const cat = categoryById(id)!;
            const cur = selectedProduct(cat, state.design);
            return h(
              'label',
              { class: 'field' },
              h('span', { class: 'field-label' }, cat.label),
              h('select', { onchange: (e: Event) => choose(id, (e.target as HTMLSelectElement).value) }, cat.products.map((p) => h('option', { value: p.id, selected: p.id === cur.id }, `${p.maker === '—' ? '' : `${p.maker} `}${p.name}${p.code ? `（${p.code}）` : ''}`))),
            );
          }),
        ),
      );

      // 書類
      side.appendChild(
        section(
          '書類',
          h('button', { class: 'btn block', onclick: () => setMode('doc') }, '仕様決定書を開く（署名欄つき・印刷／PDF）'),
          h('button', { class: 'btn block', style: 'margin-top:8px', onclick: () => download('data:text/csv;charset=utf-8,' + encodeURIComponent(orderCsv()), `${state.name}_仕様一覧.csv`) }, '発注用の仕様一覧（CSV）'),
        ),
      );
    };

    const firstOpenRound = (c: CoordState) => ROUNDS.find((r) => r.cats.some((id) => itemOf(c, id).status !== 'decided'))?.no ?? 0;

    /** 標準のまま決める（選択肢が 1 つ、または今の選択のまま） */
    const bulkStandard = (cats: string[]) => {
      const left = cats.filter((id) => itemOf(coord(), id).status !== 'decided');
      if (!left.length) return null;
      return h(
        'button',
        {
          class: 'btn sm ghost',
          style: 'margin-top:6px',
          title: '残りの部位を今の選択のまま決定にします（標準仕様のまま進める部位をまとめて）',
          onclick: () => {
            let c = coord();
            for (const id of left) c = decide(c, id);
            setCoord(c);
            emit('coord');
            renderAll();
          },
        },
        `残り ${left.length} 部位を今の選択で決定`,
      );
    };

    /** 商品の実物写真を登録（事務所の写真庫と、このプロジェクトの両方に）。Shift を押しながらで削除 */
    const attachPhoto = async (productId: string) => {
      const input = h('input', { type: 'file', accept: 'image/*', style: 'display:none' }) as HTMLInputElement;
      document.body.appendChild(input);
      const file = await new Promise<File | undefined>((resolve) => {
        input.addEventListener('change', () => resolve(input.files?.[0]), { once: true });
        input.click();
      }).finally(() => input.remove());
      if (!file) return;
      try {
        const url = await shrinkPhoto(file);
        await saveLibrarySample(productId, { url, name: file.name, at: new Date().toISOString() });
        lib[productId] = url;
        setCoord({ ...coord(), samples: { ...(coord().samples ?? {}), [productId]: url } });
        toast('実物写真を登録しました（事務所の写真庫にも入り、他のお客様でも使えます）', 'ok');
        renderAll();
      } catch (e) {
        toast(`写真を読み込めませんでした: ${(e as Error).message}`, 'error');
      }
    };
    const removePhoto = async (productId: string) => {
      await deleteLibrarySample(productId).catch(() => undefined);
      delete lib[productId];
      const next = { ...(coord().samples ?? {}) };
      delete next[productId];
      setCoord({ ...coord(), samples: next });
      renderAll();
    };

    const statusChip = (s: DecisionStatus) => h('span', { class: `coord-st ${s}` }, STATUS_LABEL[s]);

    const catRow = (catId: string, adv: Advice[]) => {
      const cat = categoryById(catId)!;
      const c = coord();
      const it = itemOf(c, catId);
      const cur = selectedProduct(cat, state.design);
      const warns = adviceFor(adv, catId);
      const blocked = it.status !== 'decided' ? blockedBy(c, catId) : [];
      const isOpen = openCat === catId;
      const head = h(
        'button',
        {
          class: 'coord-head',
          onclick: () => {
            openCat = isOpen ? null : catId;
            if (!isOpen) flyTo(catId);
            renderAll();
          },
        },
        h('div', { class: 'sw' }, ...cur.swatch.map((col) => h('span', { style: `background:${col}` }))),
        h(
          'div',
          { class: 'body' },
          h('div', { class: 'k' }, cat.label, statusChip(it.status), warns.some((a) => a.level === 'warn') ? h('span', { class: 'coord-warn', title: warns.map((a) => a.title).join('\n') }, '⚠') : null),
          h('div', { class: 'nm' }, productLabel(cur)),
          it.customerPick && it.customerPick !== cur.id ? h('div', { class: 'cust' }, `お客様の希望: ${productLabel(cat.products.find((p) => p.id === it.customerPick) ?? cur)}`) : null,
          it.customerComment ? h('div', { class: 'cust' }, `「${it.customerComment}」`) : null,
        ),
      );
      const row = h('div', { class: `coord-item ${isOpen ? 'open' : ''} ${it.status}` }, head);
      if (!isOpen) return row;

      // 開いた部位: 商品の一覧（候補の印・差額・選ぶ）
      const deltas = finishDeltas(catId);
      const cands = new Set(it.candidates ?? []);
      const list = h('div', { class: 'coord-list' });
      for (const p of cat.products) {
        const on = p.id === cur.id;
        const star = h(
          'button',
          {
            class: `star ${cands.has(p.id) ? 'on' : ''}`,
            title: 'お客様に見せる候補（2〜3 案）',
            onclick: (e: Event) => {
              e.stopPropagation();
              const next = new Set(cands);
              if (next.has(p.id)) next.delete(p.id);
              else {
                if (next.size >= 3) {
                  toast('候補は 3 案までにしましょう（選択肢が多いほど決まりにくくなります）', 'info');
                  return;
                }
                next.add(p.id);
              }
              setCoord(setCandidates(coord(), catId, [...next]));
              renderAll();
            },
          },
          cands.has(p.id) ? '★' : '☆',
        );
        list.appendChild(
          h(
            'div',
            { class: `coord-prod ${on ? 'on' : ''}`, onclick: () => choose(catId, p.id) },
            (() => {
              const look = lookOf(catId, p, state.design, sampleMap());
              return look ? h('div', { class: `thumb ${look.real ? 'real' : ''}`, title: look.real ? '実物写真' : '質感イメージ' }, h('img', { src: look.url })) : h('div', { class: 'sw' }, ...p.swatch.map((col) => h('span', { style: `background:${col}` })));
            })(),
            h(
              'div',
              { class: 'body' },
              h('div', { class: 'nm' }, productLabel(p)),
              h('div', { class: 'cd' }, [p.code, p.note].filter(Boolean).join('　')),
              p.used ? h('div', { class: 'used' }, `御社の採用例: ${p.used}`) : null,
              catalogUrl(p) ? h('a', { class: 'linkbtn', href: catalogUrl(p), target: '_blank', rel: 'noopener', title: 'メーカーのサイトでこの商品のカタログ・色見本を探します（別のタブ）', onclick: (e: Event) => e.stopPropagation() }, 'カタログ ↗') : null,
              hasLook(catId) ? h('button', { class: 'linkbtn photo', title: 'この商品の実物写真（サンプルを撮った写真・メーカーの写真）を登録。事務所の写真庫に入り、他のお客様でも使えます', onclick: (e: Event) => { e.stopPropagation(); void attachPhoto(p.id); } }, sampleMap()[p.id] ? '写真を差し替え' : '＋実物写真') : null,
              sampleMap()[p.id] ? h('button', { class: 'linkbtn photo', onclick: (e: Event) => { e.stopPropagation(); void removePhoto(p.id); } }, '写真を外す') : null,
            ),
            h('div', { class: `dl ${deltas[p.id] && deltas[p.id]! > 0 ? 'up' : ''}` }, on ? '選択中' : deltaText(deltas[p.id])),
            isFixed(catId) ? null : star,
          ),
        );
      }
      const note = h('input', {
        type: 'text',
        class: 'note',
        placeholder: '正確な品番・メモ（例: IS-1234、AA-1234）',
        value: state.design.finishNotes?.[catId] ?? '',
        onchange: (e: Event) => {
          const val = (e.target as HTMLInputElement).value.trim();
          const notes = { ...(state.design.finishNotes ?? {}) };
          if (val) notes[catId] = val;
          else delete notes[catId];
          state.design = { ...state.design, finishNotes: notes };
        },
      });
      row.append(
        h(
          'div',
          { class: 'coord-detail' },
          blocked.length ? h('p', { class: 'coord-blocked' }, `先に ${blocked.map(catLabel).join('・')} を決めると選びやすくなります（${catLabel(catId)} は ${DEPENDS[catId].map(catLabel).join('・')} に合わせて決まります）`) : null,
          ...warns.map((a) => h('div', { class: `coord-adv ${a.level}` }, h('div', { class: 't' }, `${a.level === 'warn' ? '⚠ ' : '・'}${a.title}`), h('div', { class: 'w' }, a.why))),
          list,
          note,
          h(
            'div',
            { class: 'btn-row', style: 'margin-top:8px' },
            isFixed(catId) ? null : h('button', { class: 'btn sm', onclick: () => void openCompare(catId) }, NON_VISUAL.has(catId) ? '候補を並べて比べる' : '3D で見比べる'),
            it.status === 'decided'
              ? h('button', { class: 'btn sm', onclick: () => { setCoord(decide(coord(), catId, false)); renderAll(); } }, `決定を外す（${it.decidedAt ?? ''}）`)
              : h('button', { class: 'btn sm primary', onclick: () => { setCoord(decide(coord(), catId)); emit('coord'); renderAll(); } }, 'この内容で決定'),
          ),
          isFixed(catId) ? h('p', { class: 'hint' }, '標準仕様で決まっている部位です（変更はご相談で）。') : h('p', { class: 'hint' }, '☆ で候補に入れると、お客様の体験リンクにはその候補だけが並びます。行を押すと 3D と見積がその商品に変わります。'),
          hasLook(catId) ? h('p', { class: 'hint' }, '左の小さな見本: 「実物」の印があるものは登録した実物写真（サンプルを撮った写真）、無いものは 3D と同じ素材から作った質感イメージです。正確な色・柄は「カタログ ↗」（メーカーのサイト）と実物のサンプルで。') : null,
        ),
      );
      return row;
    };

    // ---- 決定ボード（ステージ） ----
    const renderBoard = (adv: Advice[]) => {
      const c = coord();
      const pr = progress(c);
      const board = h('div', { class: 'coord-board' });
      board.appendChild(
        h(
          'div',
          { class: 'cb-head' },
          h('div', null, h('div', { class: 'cb-title' }, `${state.customer || 'お客様'}邸　仕様の決定ボード`), h('div', { class: 'cb-sub' }, `決定 ${pr.decided} / ${pr.total} 部位　・　${new Date().toLocaleDateString('ja-JP')}`)),
          h('div', { class: 'cb-legend' }, ...(['decided', 'picked', 'proposed', 'open'] as DecisionStatus[]).map((s) => statusChip(s))),
        ),
      );
      for (const r of ROUNDS) {
        const grid = h('div', { class: 'cb-grid' });
        for (const id of r.cats) {
          const cat = categoryById(id)!;
          const it = itemOf(c, id);
          const cur = selectedProduct(cat, state.design);
          const cands = (it.candidates?.length ?? 0) >= 2 && it.status !== 'decided' ? it.candidates! : [];
          const warns = adviceFor(adv, id).filter((a) => a.level === 'warn');
          grid.appendChild(
            h(
              'div',
              { class: `cb-card ${it.status}`, onclick: () => { openCat = id; setMode('3d'); flyTo(id); } },
              (() => {
                const look = lookOf(id, cur, state.design, sampleMap());
                return look ? h('div', { class: `ph ${look.real ? 'real' : ''}` }, h('img', { src: look.url })) : h('div', { class: 'sw' }, ...cur.swatch.map((col) => h('span', { style: `background:${col}` })));
              })(),
              h('div', { class: 'k' }, cat.label, statusChip(it.status)),
              h('div', { class: 'nm' }, `${cur.name}`),
              h('div', { class: 'cl' }, [cur.color, cur.maker === '—' ? '' : cur.maker].filter(Boolean).join('・')),
              cands.length
                ? h('div', { class: 'cands' }, ...cands.map((pid) => { const p = cat.products.find((x) => x.id === pid); return p ? h('span', { class: pid === cur.id ? 'on' : '', title: productLabel(p), style: `background:${p.swatch[p.swatch.length - 1]}` }) : null; }), h('em', null, `候補 ${cands.length} 案`))
                : null,
              it.customerComment ? h('div', { class: 'cust' }, `「${it.customerComment}」`) : null,
              warns.length ? h('div', { class: 'warn' }, `⚠ ${warns[0].title}`) : null,
              it.decidedAt ? h('div', { class: 'date' }, `決定 ${it.decidedAt}`) : null,
            ),
          );
        }
        board.appendChild(h('section', { class: 'cb-round' }, h('h3', null, `${'①②③'[r.no - 1]} ${r.title}`, h('span', null, `決定 ${r.cats.filter((id) => itemOf(c, id).status === 'decided').length}/${r.cats.length}　目安 ${r.deadline}`)), grid));
      }
      return board;
    };

    // ---- 仕様決定書（A4・署名欄つき） ----
    const renderDoc = () => {
      const c = coord();
      const wrap = h('div', { class: 'est-view coord-doc' });
      const pr = progress(c);
      const rowsFor = (cats: string[]) =>
        cats.map((id) => {
          const cat = categoryById(id)!;
          const it = itemOf(c, id);
          const p = selectedProduct(cat, state.design);
          const memo = state.design.finishNotes?.[id];
          return h(
            'tr',
            { class: it.status === 'decided' || cat.equipment ? '' : 'pending' },
            h('td', { class: 'k' }, cat.label),
            h('td', { class: 'sw' }, (() => {
              const real = sampleMap()[p.id];
              return real ? h('img', { src: real }) : h('div', null, ...p.swatch.map((col) => h('span', { style: `background:${col}` })));
            })()),
            h('td', null, h('div', null, p.maker === '—' ? '' : p.maker), h('div', { class: 'nm' }, p.name)),
            h('td', null, [p.code, memo].filter(Boolean).join(' ／ ')),
            h('td', null, p.color ?? ''),
            h('td', { class: 'st' }, cat.equipment ? '仕様' : it.status === 'decided' ? `決定 ${it.decidedAt ?? ''}` : STATUS_LABEL[it.status]),
          );
        });
      const co = { name: state.company || 'ホームランディック', designer: state.designer ?? '' };
      const sheet = h(
        'div',
        { class: 'est-sheet coord-sheet' },
        h('div', { class: 'est-title' }, '仕　様　決　定　書'),
        h(
          'div',
          { class: 'est-head' },
          h('div', { class: 'est-to' }, h('div', { class: 'name' }, `${state.customer || '〇〇様'} 邸　新築工事`), h('div', { class: 'sub' }, `下記の仕様で決定いたしました（決定 ${pr.decided} / ${pr.total} 部位）。`)),
          h('div', { class: 'est-from' }, h('div', null, new Date().toLocaleDateString('ja-JP')), state.logo ? h('img', { class: 'logo', src: state.logo }) : null, h('div', { class: 'co' }, co.name), co.designer ? h('div', { class: 'staff' }, `担当　${co.designer}`) : null),
        ),
        ...ROUNDS.map((r) =>
          h(
            'div',
            { class: 'cs-block' },
            h('div', { class: 'cs-h' }, `${'①②③'[r.no - 1]} ${r.title}`),
            h('table', { class: 'cs-table' }, h('thead', null, h('tr', null, ...['部位', '色', 'メーカー・商品', '品番', '色・柄', '状態'].map((t) => h('th', null, t)))), h('tbody', null, ...rowsFor(r.cats))),
          ),
        ),
        h('div', { class: 'cs-block' }, h('div', { class: 'cs-h' }, '設備の仕様'), h('table', { class: 'cs-table' }, h('thead', null, h('tr', null, ...['部位', '', 'メーカー・商品', '品番', '', ''].map((t) => h('th', null, t)))), h('tbody', null, ...rowsFor(EQUIPMENT_CATS)))),
        h('p', { class: 'cs-note' }, '※ 色見本は画面・印刷の色です。実物のサンプルでご確認ください。「決定」以外の部位は次回までにお決めいただく項目です。決定後の変更は、発注の状況により費用・工期に影響する場合があります。'),
        h('div', { class: 'cs-sign' }, h('div', null, h('span', null, 'ご確認日'), h('i', null, '　　年　　月　　日')), h('div', null, h('span', null, 'お客様ご署名'), h('i', null, '')), h('div', null, h('span', null, '担当'), h('i', null, co.designer))),
      );
      wrap.appendChild(sheet);
      const left = FINISH_CATEGORIES.filter((cat) => itemOf(c, cat.id).status !== 'decided');
      if (left.length) {
        wrap.appendChild(
          h(
            'div',
            { class: 'est-sheet coord-sheet' },
            h('div', { class: 'est-title small' }, '次回までにお決めいただくこと'),
            ...ROUNDS.map((r) => {
              const items = r.cats.filter((id) => itemOf(c, id).status !== 'decided');
              if (!items.length) return null;
              return h(
                'div',
                { class: 'cs-block' },
                h('div', { class: 'cs-h' }, `${'①②③'[r.no - 1]} ${r.title}　（目安: ${r.deadline}）`),
                h('p', { class: 'cs-prep' }, r.prepare),
                h(
                  'ul',
                  { class: 'cs-todo' },
                  ...items.map((id) => {
                    const cat = categoryById(id)!;
                    const it = itemOf(c, id);
                    const cands = (it.candidates?.length ?? 0) >= 2 ? it.candidates! : [];
                    const dl = cands.length ? finishDeltas(id) : {};
                    return h(
                      'li',
                      null,
                      h('b', null, cat.label),
                      cands.length ? `　候補: ${cands.map((pid) => { const p = cat.products.find((x) => x.id === pid); return p ? `${p.name}${p.color ? `（${p.color}）` : ''} ${deltaText(dl[pid]) === '見積に影響なし' ? '' : deltaText(dl[pid])}`.trim() : ''; }).join(' ／ ')}` : '　候補をご提示します',
                      blockedBy(c, id).length ? h('span', { class: 'dep' }, `（${blockedBy(c, id).map(catLabel).join('・')}が決まってから）`) : null,
                    );
                  }),
                ),
              );
            }),
            h('p', { class: 'cs-note' }, '体験リンクの「仕様を選ぶ」から、ご自宅で 3D を見ながら候補を選んで送っていただけます。'),
          ),
        );
      }
      return wrap;
    };

    const orderCsv = () => {
      const c = coord();
      const lines = ['"順番","部位","メーカー","商品","品番","品番メモ","色・柄","状態","決定日","お客様のひとこと"'];
      for (const r of [...ROUNDS, { title: '設備の仕様', cats: EQUIPMENT_CATS }])
        for (const id of r.cats) {
          const cat = categoryById(id)!;
          const it = itemOf(c, id);
          const p = selectedProduct(cat, state.design);
          lines.push([r.title, cat.label, p.maker, p.name, p.code, state.design.finishNotes?.[id] ?? '', p.color ?? '', STATUS_LABEL[it.status], it.decidedAt ?? '', it.customerComment ?? ''].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','));
        }
      return '﻿' + lines.join('\n');
    };

    const renderAll = () => {
      const adv = harmonyCheck(state.design);
      renderModeBar();
      clear(overlay);
      overlay.hidden = stageMode === '3d';
      if (stageMode === 'board') overlay.appendChild(renderBoard(adv));
      else if (stageMode === 'doc') overlay.appendChild(renderDoc());
      const scroll = side.scrollTop;
      renderSide(adv);
      side.scrollTop = scroll;
    };
    renderAll();
    // 最初は LDK の広角の定点（部屋全体が見える）。開いている部位があればその構図
    if (openCat) flyTo(openCat);
    else {
      const s = fixedView(ctx, 'ldk');
      if (s) v.applyShot(s);
    }
    // 写真庫を読み込んで、写真のある商品を写真で出し直す
    void (async () => {
      let n = 0;
      for (const cat of FINISH_CATEGORIES)
        for (const p of cat.products) {
          const ph = await librarySample(p.id);
          if (ph) {
            lib[p.id] = ph.url;
            n++;
          }
        }
      if (n) {
        syncUsedSamples();
        renderAll();
      }
    })();
  },
  unmount() {
    document.body.classList.remove('print-coord');
    viewerRef?.setViewMode(prevViewMode);
    viewerRef = null;
  },
};
