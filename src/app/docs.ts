/**
 * 打合せの書類（印刷用の 1 枚もの）。画面を増やさず、資料・図面の画面のボタン 1 つで新しいタブに開く。
 *
 *  - 打合せメモ（議事録の下書き）: 使う人 = 設計士・営業。今回の変更、ご要望との照合の △✖、決まったこと、次回までの宿題。
 *  - 設計レビュー（社内確認用）: 決める人 = 上司・社内の承認者。面積・木造チェックの全件・読み取りの注意・要望の照合を根拠つきで。
 */
import { state } from './state';
import { woodCheck } from '../parser/woodCheck';
import { parseWishes, checkWishes, WISH_STATUS_LABEL } from '../core/wishes';
import { planSummary, diffPlans, yenMan } from '../core/planDiff';
import { excludedFromFloorArea, ROOM_TYPE_LABEL } from '../core/types';
import { FINISH_CATEGORIES, selectedProduct } from '../coordinate/catalog';
import { itemOf, STATUS_LABEL, isFixed } from '../coordinate/decisions';
import { estimateSummary } from './steps/estimateStep';

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};

const CSS = `
  body { font-family: 'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif; color: #222; margin: 0; padding: 18mm 16mm; font-size: 11pt; line-height: 1.55; }
  h1 { font-size: 16pt; margin: 0 0 2px; font-weight: 600; letter-spacing: .04em; }
  .sub { color: #666; font-size: 9.5pt; margin: 0 0 14px; }
  h2 { font-size: 11.5pt; margin: 16px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #ccc; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; font-size: 10pt; }
  td, th { border-bottom: 1px solid #e3e0da; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { color: #666; font-weight: 500; width: 22%; }
  .m { width: 18px; text-align: center; font-weight: 700; }
  .ok { color: #2f7d4a; } .check { color: #c28a12; } .ng { color: #b4473d; } .na { color: #888; }
  .small { color: #666; font-size: 9pt; }
  .blank { display: inline-block; min-width: 120px; border-bottom: 1px solid #999; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 24px; }
  .lines p { margin: 0; border-bottom: 1px dotted #bbb; height: 1.7em; }
  .tools { position: fixed; top: 8px; right: 8px; } .tools button { font: inherit; padding: 6px 12px; }
  @media print { .tools { display: none; } body { padding: 12mm 14mm; } }
`;

export function openPrintable(title: string, body: string) {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body><div class="tools"><button onclick="window.print()">印刷 / PDF に保存</button></div>${body}</body></html>`;
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function wishRows(): { label: string; status: 'ok' | 'ng' | 'check' | 'na'; evidence: string }[] {
  if (!state.model || !state.wishes?.trim()) return [];
  const narrow = woodCheck(state.model).filter((i) => i.id.startsWith('narrow-')).map((i) => i.title);
  return checkWishes(state.model, parseWishes(state.wishes), { narrowIssues: narrow }).map((r) => ({ label: r.wish.label, status: r.status, evidence: r.evidence }));
}

function changesNow(): string[] {
  const prev = state.revisions?.[state.revisions.length - 1];
  if (!prev || !state.model) return [];
  let grand: number | undefined;
  try {
    grand = estimateSummary()?.grand;
  } catch {
    grand = undefined;
  }
  return diffPlans(prev, planSummary(state.model, state.pdfName ?? '今回', grand)).map((c) => c.text);
}

const mark = (st: string) => (st === 'ok' ? '✓' : st === 'check' ? '△' : st === 'ng' ? '✖' : '…');

/** 打合せメモ（議事録の下書き） */
export function openMeetingMemo() {
  const model = state.model;
  if (!model) return;
  const changes = changesNow();
  const wishes = wishRows();
  const open = wishes.filter((w) => w.status === 'ng' || w.status === 'check');
  const notes = wishes.filter((w) => w.status === 'na');
  const decided: string[] = [];
  const pending: string[] = [];
  for (const cat of FINISH_CATEGORIES) {
    if (isFixed(cat.id)) continue;
    const it = itemOf(state.coord, cat.id);
    const p = selectedProduct(cat, state.design);
    const line = `${cat.label.replace(/（.*?）/g, '')}: ${p.maker !== '—' ? `${p.maker} ` : ''}${p.name}${p.color ? `（${p.color}）` : ''}`;
    if (it.status === 'decided') decided.push(line);
    else if (it.status === 'proposed' || it.status === 'picked') pending.push(`${line} — ${STATUS_LABEL[it.status]}`);
  }
  let sm: ReturnType<typeof estimateSummary> = null;
  try {
    sm = estimateSummary();
  } catch {
    sm = null;
  }
  const li = (a: string[], empty: string) => (a.length ? `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="small">${esc(empty)}</p>`);
  const body = `
    <h1>打合せメモ</h1>
    <p class="sub">${esc(state.name)}　${esc(state.customer)}　／　${today()}　／　${esc(state.pdfName ?? '')}</p>
    <table><tr><th>日時・場所</th><td><span class="blank"></span>　<span class="blank"></span></td></tr>
    <tr><th>ご出席</th><td><span class="blank"></span></td></tr>
    <tr><th>担当</th><td>${esc(state.designer ?? '')}</td></tr></table>
    <h2>1. 前回からの変更</h2>
    ${li(changes, state.revisions?.length ? '部屋・帖数・窓・延床に変わりはありません。' : '（図面を読み直すと、前回との差分がここに入ります）')}
    <h2>2. ご要望との照合で相談すること</h2>
    ${open.length ? `<table>${open.map((w) => `<tr><td class="m ${w.status}">${mark(w.status)}</td><td><b>${esc(w.label)}</b><br><span class="small">${esc(w.evidence)}</span></td></tr>`).join('')}</table>` : `<p class="small">${wishes.length ? '図面で判定できる要望はすべて叶っています。' : '（図面読込の「ご要望との照合」に要望を貼ると、△・✖ の項目がここに入ります）'}</p>`}
    ${notes.length ? `<p class="small">打合せで確認: ${esc(notes.map((n) => n.label).join('／'))}</p>` : ''}
    <h2>3. 決まったこと（仕上げ・設備）</h2>
    ${li(decided, 'まだ決定した部位はありません。')}
    ${pending.length ? `<p class="small">候補をご提示中: ${esc(pending.join('、'))}</p>` : ''}
    <h2>4. 概算</h2>
    <p>${sm ? `建物工事 税込 ${yenMan(sm.contract)}（${sm.grade} シリーズ・施工面積 ${sm.tsubo.toFixed(1)} 坪）／ 総合計 ${yenMan(sm.grand)}` : '（見積の画面を開くと概算が入ります）'}</p>
    <h2>5. 今日話したこと・決めたこと</h2>
    <div class="lines"><p></p><p></p><p></p><p></p><p></p><p></p></div>
    <h2>6. 次回までの宿題</h2>
    <div class="cols"><div><p class="small">御社</p><div class="lines"><p></p><p></p><p></p></div></div><div><p class="small">お客様</p><div class="lines"><p></p><p></p><p></p></div></div></div>
    <h2>7. 次回</h2>
    <p><span class="blank"></span>　月　　日　　時　／　場所 <span class="blank"></span></p>
  `;
  openPrintable(`打合せメモ ${state.name}`, body);
}

/** 設計レビュー（社内確認用） */
export function openDesignReview() {
  const model = state.model;
  if (!model) return;
  const issues = woodCheck(model);
  const warn = issues.filter((i) => i.severity === 'warn');
  const info = issues.filter((i) => i.severity === 'info');
  const wishes = wishRows();
  const changes = changesNow();
  const floors = model.floors.map((f) => {
    const area = f.rooms.filter((r) => !excludedFromFloorArea(r.type)).reduce((s, r) => s + r.area, 0);
    return { level: f.level, area, rooms: f.rooms.filter((r) => r.area > 1.5 && r.type !== 'void').length, stairs: f.stairs.length, windows: f.openings.filter((o) => o.kind === 'window').length };
  });
  const total = floors.reduce((s, f) => s + f.area, 0);
  const rep = model.report;
  let sm: ReturnType<typeof estimateSummary> = null;
  try {
    sm = estimateSummary();
  } catch {
    sm = null;
  }
  const roomsList = model.floors
    .map((f) => `<tr><th>${f.level}階</th><td>${esc(f.rooms.filter((r) => r.area > 1.5 && r.type !== 'void').map((r) => `${r.name || ROOM_TYPE_LABEL[r.type]} ${(r.labeledTatami ?? r.area / 1.62).toFixed(1)}帖`).join('、'))}</td></tr>`)
    .join('');
  const body = `
    <h1>設計レビュー（社内確認用）</h1>
    <p class="sub">${esc(state.name)}　${esc(state.customer)}　／　${today()}　／　図面: ${esc(state.pdfName ?? '')}　／　設計: ${esc(state.designer ?? '')}</p>
    <h2>1. 概要</h2>
    <table>
      <tr><th>階数・延床</th><td>${floors.length} 階建て　延床 ${total.toFixed(2)} ㎡（${(total / 3.30579).toFixed(2)} 坪）　${floors.map((f) => `${f.level}階 ${f.area.toFixed(2)} ㎡`).join('／')}</td></tr>
      ${roomsList}
      <tr><th>階段・窓</th><td>${floors.map((f) => `${f.level}階 階段 ${f.stairs}・窓 ${f.windows}`).join('／')}</td></tr>
      <tr><th>方位・敷地</th><td>真北 ${model.northAngleDeg.toFixed(0)}°（${rep.northDetected ? '図面の方位記号から' : '図面の上を北として扱い'}）　${model.site?.roads?.length ? `接道 ${model.site.roads.map((r) => r.side).join('・')}` : '接道 未設定'}${model.site?.areaM2 ? `　敷地 ${model.site.areaM2.toFixed(1)} ㎡` : ''}</td></tr>
      <tr><th>概算</th><td>${sm ? `建物工事 税込 ${yenMan(sm.contract)}（${sm.grade} シリーズ・坪単価 ${yenMan(sm.tsuboPrice)}）／ 総合計 ${yenMan(sm.grand)}` : '未算出'}</td></tr>
    </table>
    <h2>2. 木造（在来軸組）のチェック — 要確認 ${warn.length} 件・参考 ${info.length} 件</h2>
    ${warn.length || info.length ? `<table>${[...warn, ...info].map((i) => `<tr><td class="m ${i.severity === 'warn' ? 'ng' : 'check'}">${i.severity === 'warn' ? '⚠' : 'ℹ'}</td><td><b>${esc(i.title)}</b><br><span class="small">${esc(i.detail)}</span></td></tr>`).join('')}</table>` : '<p class="small">壁の端・直下率・梁のスパン・出入口・階段の位置に不自然な所はありません。</p>'}
    <h2>3. 読み取りの注意（図面 → 3D）</h2>
    ${rep.warnings.length ? `<ul class="small">${rep.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '<p class="small">特になし。</p>'}
    <h2>4. ご要望との照合</h2>
    ${wishes.length ? `<table>${wishes.map((w) => `<tr><td class="m ${w.status}">${mark(w.status)}</td><td><b>${esc(w.label)}</b>　<span class="small">${esc(WISH_STATUS_LABEL[w.status])}　${esc(w.evidence)}</span></td></tr>`).join('')}</table>` : '<p class="small">（要望が登録されていません）</p>'}
    ${changes.length ? `<h2>5. 前回からの変更</h2><ul>${changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    <h2>${changes.length ? 6 : 5}. 確認者</h2>
    <p>確認日 <span class="blank"></span>　確認者 <span class="blank"></span>　所見 <span class="blank" style="min-width:300px"></span></p>
  `;
  openPrintable(`設計レビュー ${state.name}`, body);
}
