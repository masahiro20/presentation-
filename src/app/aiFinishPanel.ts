/**
 * 「写真に仕上げる」（AI 仕上げ）の区画と流れ。
 * Google AI Studio のキーとモデルを入れ、カットごと／全カットを Gemini の画像生成モデルで写真に仕上げ、
 * 下絵との照合（形が変わっていないか）を見せてから、外部で仕上げた写真と同じギャラリー（＝資料・体験リンク）に入れる
 */
import type { StepCtx } from './app';
import type { Shot } from '../scene/shots';
import { h, clear, modal, progressModal, section, toast } from './dom';
import { state, emit } from './state';
import { renderStudio } from '../scene/studio';
import { exposureFor } from './draftCapture';
import { cutPrompt, finishAssets, focusForCut, setRefsForPrompt } from './cuts';
import { addFinished } from './finishImport';
import { harmonizeBatch } from './photoHarmonize';
import { checkGeminiKey, compareWithDraft, costPerImage, generateFinish, getGeminiKey, getImageModel, onAiFinishChange, readUsage, scoreLabel, setGeminiKey, setImageModel, toAttachment, toJpegDataUrl, usageSummary, type ImageModelInfo } from './aiFinish';

export interface FinishedCut {
  shot: Shot;
  draft: string;
  url: string;
  score: number;
  label: ReturnType<typeof scoreLabel>;
  overlay: string;
  model: string;
}

const SIZE_STORE = 'madori.aiFinishSize';
const getSize = (): '1K' | '2K' => {
  try {
    return localStorage.getItem(SIZE_STORE) === '2K' ? '2K' : '1K';
  } catch {
    return '1K';
  }
};

/**
 * カットを順に仕上げる。下絵はその場で描く（部屋名の札・想像の家並みは消す）。
 * 説明文はカット集と同じ（cutPrompt）、添付も同じ（素材ボード・お手本）。キーの誤りなど続けても無駄な失敗では打ち切る
 */
export async function finishShots(ctx: StepCtx, shots: Shot[], opts: { signal?: AbortSignal; onProgress?: (i: number, n: number, msg: string, preview?: string) => void } = {}): Promise<{ done: FinishedCut[]; failed: string[] }> {
  const key = getGeminiKey();
  const model = getImageModel();
  const v = ctx.app.viewer;
  const done: FinishedCut[] = [];
  const failed: string[] = [];
  if (!key) return { done, failed: ['Google AI Studio の API キーが入っていません'] };
  const assets = await finishAssets();
  // 添付を送れる形（JPEG の data URL）にそろえる。事務所のお手本は https の URL なので取得して縮める。取れない物は外して続ける
  const board = assets.board ? await toAttachment(assets.board, 1400).catch(() => undefined) : undefined;
  const refUrls = new Map<string, string>();
  for (const r of assets.refs) {
    try {
      refUrls.set(r.id, await toAttachment(r.url, 1200));
    } catch (e) {
      console.warn('お手本を添付できませんでした', r.name ?? r.id, e);
    }
  }
  const refsLoaded = assets.refs.filter((r) => refUrls.has(r.id));
  setRefsForPrompt(refsLoaded);
  const prev = v.currentView();
  const prevLabels = v.roomLabelsShown();
  v.setRoomLabels(false);
  v.setTownVisible(false);
  // 下絵は AI に渡す用なので横 1,600 px まで（それ以上は送る前に縮めるだけ）。資料用のサイズ設定とは別
  const baseW = state.render.width || 1920;
  const baseH = state.render.height || 1080;
  const width = Math.min(1600, baseW);
  const height = Math.round((width * baseH) / baseW);
  const imageSize = getSize() === '2K' && /pro/i.test(model) ? '2K' : undefined;
  try {
    for (let i = 0; i < shots.length; i++) {
      if (opts.signal?.aborted) break;
      const shot = shots[i];
      opts.onProgress?.(i, shots.length, `${shot.title}: 下絵を描いています`);
      v.applyShot(shot);
      await new Promise((r) => setTimeout(r, 40));
      try {
        const tod = shot.timeOfDay ?? v.design.timeOfDay;
        const raw = await renderStudio(v, { width, height, interior: shot.kind === 'interior', exposure: exposureFor(shot.kind, tod) });
        const draft = await toJpegDataUrl(raw, 1600);
        const p = cutPrompt(shot, i);
        const refs = refsLoaded.filter((r) => r.kind === (shot.kind === 'interior' ? 'interior' : 'exterior')).slice(-3).map((r) => refUrls.get(r.id)!);
        opts.onProgress?.(i, shots.length, `${shot.title}: 写真に仕上げています（${model}）`, draft);
        // こだわりの参考画像（このカットに写る部位のもの。3 枚まで）
        const focus = focusForCut(shot).images;
        const out = await generateFinish(key, model, { prompt: `${p.ja}\n\n${p.en}`, draft, board, refs, ...(focus.length ? { focus } : {}), aspectRatio: '16:9', imageSize }, { signal: opts.signal });
        const cmp = await compareWithDraft(draft, out.url);
        done.push({ shot, draft, url: out.url, score: cmp.score, label: cmp.label, overlay: cmp.overlayUrl, model });
        opts.onProgress?.(i + 1, shots.length, `${shot.title}: ${cmp.label.text}`, out.url);
      } catch (e) {
        const msg = (e as Error).message;
        failed.push(`${shot.title}: ${msg}`);
        if (opts.signal?.aborted || /キーが正しく|このキーでは|入っていません/.test(msg)) break;
      }
    }
  } finally {
    setRefsForPrompt(null);
    v.setRoomLabels(prevLabels);
    v.setTownVisible(true);
    v.applyView(prev);
  }
  return { done, failed };
}

/** 仕上がりをギャラリーに入れる（複数なら明るさ・色味をそろえてから） */
export async function acceptFinished(items: FinishedCut[], harmonize: boolean): Promise<void> {
  let urls = items.map((x) => x.url);
  if (harmonize && items.length) {
    try {
      const existing = state.gallery.filter((g) => g.quality === 'photoreal' && !items.some((x) => g.shotId === `${x.shot.id}-ai`)).map((g) => ({ url: g.url, kind: g.kind }));
      urls = await harmonizeBatch(items.map((x) => ({ url: x.url, kind: x.shot.kind })), existing);
    } catch (e) {
      console.warn('色味をそろえられませんでした', e);
    }
  }
  items.forEach((x, i) => addFinished(urls[i], x.shot, '', { score: x.score, model: x.model }));
  emit('gallery');
}

const pct = (s: number) => `${Math.round(s * 100)}%`;

/** 1 枚の見比べ: 下絵・仕上がり・ずれた所（赤）。資料に入れる／作り直す */
function reviewOne(ctx: StepCtx, item: FinishedCut, onDone: () => void) {
  let mode: 'result' | 'draft' | 'overlay' = 'result';
  const big = h('img', { src: item.url, style: 'width:100%;aspect-ratio:16/9;object-fit:contain;background:#222;border-radius:4px' }) as HTMLImageElement;
  const seg = h('div', { class: 'segmented' });
  const renderSeg = () => {
    clear(seg);
    for (const [m, label] of [['result', '仕上がり'], ['draft', '下絵'], ['overlay', 'ずれた所（赤）']] as const)
      seg.appendChild(h('button', { class: mode === m ? 'on' : '', onclick: () => { mode = m; big.src = m === 'result' ? item.url : m === 'draft' ? item.draft : item.overlay; renderSeg(); } }, label));
  };
  renderSeg();
  const lv = item.label.level;
  modal(
    `${item.shot.title} を写真に仕上げました`,
    h(
      'div',
      null,
      big,
      h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px' }, seg, h('span', { class: `aif-score ${lv}` }, `下絵との一致 ${pct(item.score)}・${item.label.text}`)),
      h('p', { class: 'hint' }, '赤い線は、下絵にあった輪郭が仕上がりで消えた所です（窓・屋根・壁の線が消えていたら作り直してください。植栽や空の違いは問題ありません）。入れた写真は、資料と体験リンクで同じカットの下絵と入れ替わります。'),
    ),
    [
      { label: 'やめる' },
      {
        label: '作り直す',
        onClick: () => void runAndReview(ctx, [item.shot], onDone),
      },
      {
        label: '資料に入れる',
        primary: true,
        onClick: () => {
          void acceptFinished([item], true).then(() => {
            toast(`${item.shot.title} の写真を資料に入れました`, 'ok');
            onDone();
          });
        },
      },
    ],
    true,
  );
}

/**
 * まとめて仕上げたあとの一覧。
 * 形がほぼそのまま／要確認のものは資料に入れてある。形が変わっている可能性が高いもの（一致 55% 未満）は入れずに保留し、
 * 「作り直す」か、見たうえで「このまま入れる」を選んでもらう（お客様に出る資料に、形の違う家を黙って入れない）
 */
function reviewMany(ctx: StepCtx, items: FinishedCut[], held: FinishedCut[], failed: string[], onDone: () => void) {
  const check = items.filter((x) => x.label.level === 'check');
  const inserted = items.length - held.length;
  const card = (x: FinishedCut) => {
    const isHeld = held.includes(x);
    const acceptBtn = isHeld
      ? (h('button', { class: 'btn xs', style: 'margin-left:6px' }, 'このまま入れる') as HTMLButtonElement)
      : null;
    if (acceptBtn) {
      acceptBtn.onclick = () => {
        acceptBtn.disabled = true;
        acceptBtn.textContent = '入れました';
        void acceptFinished([x], true).then(() => { toast(`${x.shot.title} の写真を資料に入れました`, 'ok'); onDone(); });
      };
    }
    return h(
      'figure',
      { style: 'margin:0' },
      h('img', { src: x.url, style: 'width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:3px;cursor:zoom-in', onclick: () => reviewOne(ctx, x, onDone) }),
      h(
        'figcaption',
        { style: 'font-size:12.5px;line-height:1.5;margin-top:3px' },
        x.shot.title,
        isHeld ? h('span', { class: 'aif-held' }, '保留') : null,
        h('br'),
        h('span', { class: `aif-score ${x.label.level}` }, `一致 ${pct(x.score)}`),
        x.label.level === 'ok' ? null : h('button', { class: 'btn xs', style: 'margin-left:6px', onclick: () => void runAndReview(ctx, [x.shot], onDone) }, '作り直す'),
        acceptBtn,
      ),
    );
  };
  const list = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;max-height:60vh;overflow:auto' }, ...items.map(card));
  const notes: HTMLElement[] = [];
  if (held.length) notes.push(h('p', { class: 'warn', style: 'margin-top:0' }, `${held.length} 枚は下絵と形が違う可能性が高いので、資料に入れていません（一致 55% 未満・「保留」）。画像をクリックして「ずれた所」を確かめ、作り直すか、問題なければ「このまま入れる」を押してください。`));
  if (check.length) notes.push(h('p', { class: 'warn', style: 'margin-top:0' }, `${check.length} 枚は下絵と形が少し違う可能性があります（一致 55〜72%）。資料には入れてあるので、「ずれた所」を確かめて、必要なら作り直してください。`));
  if (!notes.length) notes.push(h('p', { class: 'hint keep', style: 'margin-top:0' }, 'どれも下絵の形をほぼ保っています。'));
  modal(
    held.length ? `${items.length} 枚を写真に仕上げました（${inserted} 枚を資料に入れ、${held.length} 枚は保留）` : `${items.length} 枚を写真に仕上げて資料に入れました`,
    h('div', null, ...notes, list, failed.length ? h('p', { class: 'warn' }, `仕上げられなかったカット: ${failed.join('／')}`) : null),
    [{ label: '閉じる' }],
    true,
  );
}

/** 仕上げを走らせて見せる（1 枚なら見比べ、複数なら進み具合 → 一覧） */
export async function runAndReview(ctx: StepCtx, shots: Shot[], onDone: () => void) {
  if (!getGeminiKey()) {
    toast('先に Google AI Studio の API キーを入れてください（「写真に仕上げる」の欄）', 'error', 6000);
    return;
  }
  const targets = shots.length > 1 ? shots.filter((s) => s.kind !== 'cutaway' && s.kind !== 'section') : shots;
  if (!targets.length) {
    toast('カットがありません');
    return;
  }
  const pm = progressModal(`写真に仕上げています（${targets.length} 枚・${getImageModel()}）`);
  let res: Awaited<ReturnType<typeof finishShots>>;
  try {
    res = await finishShots(ctx, targets, { signal: pm.signal, onProgress: (i, n, msg, preview) => pm.set(i / n, msg, preview) });
  } finally {
    pm.close();
  }
  if (!res.done.length) {
    toast(res.failed[0] ?? '仕上げられませんでした', 'error', 8000);
    return;
  }
  if (targets.length === 1) {
    reviewOne(ctx, res.done[0], onDone);
    return;
  }
  // 形が変わっている可能性が高いもの（bad）は入れずに保留。それ以外は明るさ・色味をそろえて入れる
  const held = res.done.filter((x) => x.label.level === 'bad');
  const good = res.done.filter((x) => x.label.level !== 'bad');
  if (good.length) await acceptFinished(good, true);
  onDone();
  reviewMany(ctx, res.done, held, res.failed, onDone);
}

/** パースの右パネルの区画 */
export function aiFinishSection(ctx: StepCtx, deps: { shots: () => Shot[]; currentAsShot: () => Shot; onDone: () => void }): HTMLElement {
  const input = h('input', { type: 'password', placeholder: 'AIza で始まるキーを貼り付け', autocomplete: 'off', spellcheck: false, value: getGeminiKey(), style: 'flex:1;min-width:0;font-family:ui-monospace,monospace' }) as HTMLInputElement;
  const eye = h('button', { class: 'btn sm ghost', type: 'button', title: 'キーを表示する／隠す', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; eye.textContent = input.type === 'password' ? '表示' : '隠す'; } }, '表示') as HTMLButtonElement;
  const status = h('div', { class: 'gkey-status' });
  const modelSel = h('select', { style: 'width:100%', onchange: (e: Event) => { setImageModel((e.target as HTMLSelectElement).value); renderUsage(); } }) as HTMLSelectElement;
  // 枚数と費用の目安は説明文ではなく数字なので、「説明」を消していても見せる（keep）
  const usageEl = h('div', { class: 'hint keep', style: 'margin:4px 0 0' });
  let models: ImageModelInfo[] = [];
  const renderModels = () => {
    clear(modelSel);
    const cur = getImageModel();
    const names = models.map((m) => m.name);
    if (!names.includes(cur)) modelSel.appendChild(h('option', { value: cur, selected: true }, `${cur}（今の設定）`));
    for (const m of models) modelSel.appendChild(h('option', { value: m.name, selected: m.name === cur }, `${m.displayName}（${m.name}・${costPerImage(m.name).label}）`));
  };
  const renderUsage = () => {
    const u = usageSummary(readUsage());
    const c = costPerImage(getImageModel());
    usageEl.textContent = `${u.text}。今のモデルは 1 枚あたり目安 ¥${c.jpy}（${c.label}）。無料枠の残りは `;
    usageEl.appendChild(h('a', { href: 'https://aistudio.google.com/usage', target: '_blank', rel: 'noopener' }, 'AI Studio の利用状況'));
    usageEl.appendChild(document.createTextNode(' で確認できます。'));
  };
  const row = (st: 'ok' | 'ng' | 'wait', text: string) => h('div', { class: `gkey-row ${st}` }, h('span', { class: 'gkey-dot' }, st === 'ok' ? '✓' : st === 'ng' ? '!' : '…'), h('div', null, h('b', null, '画像生成（Gemini API）'), h('span', null, text)));
  const check = async () => {
    const key = input.value.trim();
    setGeminiKey(key);
    clear(status);
    if (!key) {
      status.appendChild(h('p', { class: 'hint keep' }, 'キーを消しました。写真の仕上げは外部（カット集を保存して Nano Banana Pro で）に戻ります。'));
      return;
    }
    status.appendChild(row('wait', '確認しています…'));
    const r = await checkGeminiKey(key);
    clear(status);
    if (r.ok) {
      models = r.models;
      renderModels();
      status.appendChild(row('ok', `使えます（画像を出せるモデル ${r.models.length} 件。下で選べます）`));
    } else status.appendChild(row('ng', r.message));
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && void check());
  const sizeSel = h(
    'select',
    { onchange: (e: Event) => { try { localStorage.setItem(SIZE_STORE, (e.target as HTMLSelectElement).value); } catch { /* 保存できない環境 */ } } },
    h('option', { value: '1K', selected: getSize() === '1K' }, '標準（横 1,300 px 前後。画面・資料向け）'),
    h('option', { value: '2K', selected: getSize() === '2K' }, '2K（Pro のモデルだけ。印刷向け・費用も上がる）'),
  );
  const steps = h(
    'details',
    { class: 'gkey-howto' },
    h('summary', null, 'キーの作り方（Google AI Studio・3 分ほど）'),
    h(
      'ol',
      null,
      h('li', null, h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, 'Google AI Studio の API キー'), ' を会社の Google アカウントで開く'),
      h('li', null, '「Create API key」（API キーを作成）→ プロジェクトは新規でも既存でも可 → できたキーをコピー'),
      h('li', null, '上の欄に貼り付けて「保存して確認」。画像を出せるモデルの一覧が出るので、Flash（軽い・無料枠のある方）か Pro（高品質・有料）を選ぶ'),
      h('li', null, '無料枠は Google が時期とモデルごとに決めています（1 日あたりの枚数など）。上限に当たると「上限に当たりました」と出るので、翌日まで待つか、AI Studio で有料枠（請求先）を有効にする'),
    ),
  );
  const run = (shots: Shot[]) => void runAndReview(ctx, shots, () => { renderUsage(); deps.onDone(); });
  const all = () => deps.shots().filter((s) => s.kind !== 'cutaway' && s.kind !== 'section');
  const sec = section(
    '写真に仕上げる（AI・ツールの中で）',
    h('p', { class: 'hint', style: 'margin-top:0' }, '下絵・素材ボード・お手本を Google の画像生成 AI（Gemini）に渡して写真に仕上げ、そのまま資料と体験リンクに入れます。構図・間取り・窓と戸の数・屋根の形は変えない指示で、仕上がりは下絵と輪郭を照合します。キーはこのパソコンのブラウザにだけ保存し、呼び出しもここから直接行うので、費用は Google の分だけ（無料枠の中なら 0 円）です。'),
    h('div', { style: 'display:flex;gap:6px;align-items:center' }, input, eye),
    h('div', { class: 'btn-row', style: 'margin-top:8px' }, h('button', { class: 'btn sm primary', type: 'button', onclick: check }, '保存して確認'), h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { input.value = ''; void check(); } }, 'キーを消す')),
    status,
    h('label', { class: 'field', style: 'margin-top:8px' }, h('span', { class: 'field-label' }, 'モデル'), modelSel),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, '仕上がりの大きさ'), sizeSel),
    h('div', { class: 'btn-row', style: 'margin-top:10px' }, h('button', { class: 'btn primary', onclick: () => run([deps.currentAsShot()]) }, 'この構図を写真に仕上げる')),
    h(
      'div',
      { class: 'btn-row' },
      h('button', { class: 'btn sm', onclick: () => run(all().filter((s) => s.kind !== 'interior')) }, '外観をすべて'),
      h('button', { class: 'btn sm', onclick: () => run(all().filter((s) => s.kind === 'interior')) }, '内観をすべて'),
      h('button', { class: 'btn sm dark', onclick: () => run(all()) }, `全カット（${all().length} 枚）`),
    ),
    usageEl,
    h('p', { class: 'hint' }, 'こつ: 1 枚目を見て良ければ「全カット」。まとめて仕上げると明るさ・色味を自動でそろえます。下絵との一致が 72% 未満のものは一覧に印が付き、55% 未満は資料に入れずに保留になるので、見比べて作り直してください。'),
    steps,
  );
  renderModels();
  renderUsage();
  if (getGeminiKey()) void checkGeminiKey(getGeminiKey()).then((r) => { if (r.ok) { models = r.models; renderModels(); } });
  onAiFinishChange(renderUsage);
  return sec;
}
