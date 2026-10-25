/**
 * Google の API キー（住所の番地検索 = Geocoding API、Google 実写 3D = Map Tiles API）を 1 か所で入れる欄。
 *
 * - キーはこのパソコンのブラウザにだけ保存（localStorage の googleMapsKey）。サーバーには送らない。
 * - 「保存して確認」で 2 つの API を実際に 1 回ずつ呼び、使える・使えない（理由と直し方）を並べて出す。
 * - キーの作り方を番号付きの手順で畳んで添える。
 */
import { h, clear } from './dom';
import { checkGoogle3dKey } from '../sun/googleEarth';

const STORE = 'googleMapsKey';
const listeners = new Set<(key: string) => void>();

export function getGoogleKey(): string {
  try {
    return (localStorage.getItem(STORE) ?? '').trim();
  } catch {
    return memo;
  }
}
let memo = '';

export function setGoogleKey(key: string) {
  memo = key.trim();
  try {
    if (memo) localStorage.setItem(STORE, memo);
    else localStorage.removeItem(STORE);
  } catch {
    // 保存できない環境（プライベートウィンドウなど）では開いている間だけ使う
  }
  for (const f of listeners) f(memo);
}

export function onGoogleKeyChange(f: (key: string) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** 住所検索（Geocoding API）が使えるか */
export async function checkGeocodingKey(key: string, fetchFn: typeof fetch = fetch): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!key) return { ok: false, message: 'キーが入っていません' };
  try {
    const res = await fetchFn(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent('愛知県小牧市小牧')}&region=jp&language=ja&key=${encodeURIComponent(key)}`);
    const js = (await res.json()) as { status: string; error_message?: string };
    if (js.status === 'OK' || js.status === 'ZERO_RESULTS') return { ok: true };
    const m = js.error_message ?? js.status;
    if (/not authorized|not activated|disabled|has not been used/i.test(m)) return { ok: false, message: `「Geocoding API」が有効になっていないか、キーの「API の制限」に入っていません（${m}）` };
    if (/billing/i.test(m)) return { ok: false, message: `請求先アカウントが登録されていません（${m}）` };
    if (/referer|referrer/i.test(m)) return { ok: false, message: `キーの「ウェブサイトの制限」にこのサイトの URL が入っていません（${m}）` };
    if (/invalid/i.test(m)) return { ok: false, message: `キーが正しくありません（コピーの欠け・余分な空白がないか）（${m}）` };
    return { ok: false, message: m };
  } catch (e) {
    return { ok: false, message: `Google に接続できませんでした（${(e as Error).message}）` };
  }
}

const SITE_URL = typeof location !== 'undefined' ? `${location.origin}/*` : 'https://madori-presentation.vercel.app/*';

/**
 * キーの欄。onSaved は保存したときに呼ぶ（日照ステップの表示の更新など）。
 * 返す要素の focusInput() で欄に移る（「キーを入れる」ボタンから）
 */
export function googleKeyPanel(): HTMLElement & { focusInput(): void } {
  const input = h('input', { type: 'password', placeholder: 'AIza で始まるキーを貼り付け', autocomplete: 'off', spellcheck: false, value: getGoogleKey(), style: 'flex:1;min-width:0;font-family:ui-monospace,monospace' }) as HTMLInputElement;
  const eye = h('button', { class: 'btn sm ghost', type: 'button', title: 'キーを表示する／隠す', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; eye.textContent = input.type === 'password' ? '表示' : '隠す'; } }, '表示') as HTMLButtonElement;
  const rows = h('div', { class: 'gkey-status' });
  const row = (label: string, state: 'ok' | 'ng' | 'wait' | 'none', text: string) =>
    h('div', { class: `gkey-row ${state}` }, h('span', { class: 'gkey-dot' }, state === 'ok' ? '✓' : state === 'ng' ? '!' : state === 'wait' ? '…' : '－'), h('div', null, h('b', null, label), h('span', null, text)));
  const render = (geo: Awaited<ReturnType<typeof checkGeocodingKey>> | 'wait' | null, tiles: Awaited<ReturnType<typeof checkGoogle3dKey>> | 'wait' | null) => {
    clear(rows);
    const st = (r: typeof geo | typeof tiles, okText: string) => (r === 'wait' ? (['wait', '確認しています…'] as const) : !r ? (['none', '未確認'] as const) : r.ok ? (['ok', okText] as const) : (['ng', r.message] as const));
    const g = st(geo, '使えます（番地まで検索できます）');
    const t = st(tiles, '使えます（日照の「Google 実写 3D」を表示できます）');
    rows.append(row('住所の番地検索（Geocoding API）', g[0], g[1]), row('Google 実写 3D（Map Tiles API）', t[0], t[1]));
  };
  const check = async () => {
    const key = input.value.trim();
    setGoogleKey(key);
    if (!key) {
      clear(rows);
      rows.append(h('p', { class: 'hint' }, 'キーを消しました。住所検索は国土地理院（番地は丁目まで出ないことがあります）、実写 3D は使えません。'));
      return;
    }
    render('wait', 'wait');
    const [geo, tiles] = await Promise.all([checkGeocodingKey(key), checkGoogle3dKey(key)]);
    render(geo, tiles);
  };
  const steps = h(
    'details',
    { class: 'gkey-howto' },
    h('summary', null, 'キーの作り方（初めての方・10 分ほど）'),
    h(
      'ol',
      null,
      h('li', null, h('a', { href: 'https://console.cloud.google.com/', target: '_blank', rel: 'noopener' }, 'Google Cloud コンソール'), 'に会社の Google アカウントでログインし、プロジェクトを作る（名前は何でも）'),
      h('li', null, '左のメニュー「お支払い」で請求先アカウントを登録（どちらの API も毎月の無料枠があり、日照の検討程度ならほぼ無料の範囲です）'),
      h('li', null, '「API とサービス」→「ライブラリ」で ', h('b', null, 'Geocoding API'), ' と ', h('b', null, 'Map Tiles API'), ' を検索して、それぞれ「有効にする」'),
      h('li', null, '「API とサービス」→「認証情報」→「認証情報を作成」→「API キー」'),
      h('li', null, 'できたキーの「編集」で、アプリケーションの制限を「ウェブサイト」にして ', h('code', null, SITE_URL), ' を追加。API の制限で上の 2 つを選んで保存（他の人に使われないように）'),
      h('li', null, 'キーをコピーして、上の欄に貼り付け →「保存して確認」'),
    ),
  );
  const box = h(
    'div',
    { class: 'gkey' },
    h('p', { class: 'gkey-lead' }, '住所を番地まで正確に探すときと、日照で「Google 実写 3D」（Google Earth の街並み）を出すときに使います。無くても他の機能はすべて使えます。'),
    h('div', { style: 'display:flex;gap:6px;align-items:center' }, input, eye),
    h('div', { class: 'btn-row', style: 'margin-top:8px' }, h('button', { class: 'btn sm primary', type: 'button', onclick: check }, '保存して確認'), h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { input.value = ''; void check(); } }, 'キーを消す')),
    rows,
    h('p', { class: 'hint' }, 'キーはこのパソコンのブラウザにだけ保存され、他の人やサーバーには送られません。'),
    steps,
  );
  input.addEventListener('keydown', (e) => e.key === 'Enter' && void check());
  if (getGoogleKey()) render(null, null);
  return Object.assign(box, {
    focusInput() {
      input.focus();
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
  });
}
