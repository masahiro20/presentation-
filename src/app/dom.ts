/** 小さな DOM ヘルパー */
import { USE_GROUPS } from '../core/roomUse';
type Attrs = Record<string, unknown> & { class?: string; style?: string };
type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element) {
  // 一括で消す（1 つずつ removeChild すると、フォーカス中の入力欄が外れて change が再入し、途中で子が入れ替わって例外になることがある）
  el.replaceChildren();
}

/** お知らせの履歴（新しい順に 8 件。下の 1 行をクリックすると読み返せる） */
const noticeLog: { msg: string; kind: 'info' | 'ok'; at: number }[] = [];
let noticeTimer = 0;

/**
 * お知らせを出す。出し方の決まり:
 *  - 失敗・やり直しが要るもの（error）だけ、画面の上にバナーで出す（押すと消える。同じ文は 1 つにまとめる）
 *  - それ以外（進み具合・できたこと・操作の案内）は、画面の上（見出しのすぐ下）の決まった 1 か所に 1 行で控えめに出す。
 *    新しいお知らせが来たら置き換える（積み重ねない）。数秒で消え、消えたあとも、次のお知らせを押すと履歴を読み返せる
 */
export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 3500) {
  if (kind === 'error') {
    let box = document.getElementById('toasts');
    if (!box) {
      box = h('div', { id: 'toasts' });
      document.body.appendChild(box);
    }
    // 同じ失敗が続けて起きても 1 つだけ
    for (const c of [...box.children]) if (c.textContent === msg) c.remove();
    const t = h('div', { class: 'toast error', title: '押すと消えます' }, msg);
    t.addEventListener('click', () => t.remove());
    box.appendChild(t);
    setTimeout(() => t.classList.add('hide'), ms);
    setTimeout(() => t.remove(), ms + 400);
    return;
  }
  noticeLog.unshift({ msg, kind, at: Date.now() });
  if (noticeLog.length > 8) noticeLog.length = 8;
  let bar = document.getElementById('statusline');
  if (!bar) {
    bar = h('div', { id: 'statusline' });
    document.body.appendChild(bar);
  }
  const line = h('div', { class: `toast quiet ${kind}`, title: 'これまでのお知らせを見る' }, h('span', { class: 'dot' }), h('span', { class: 'msg' }, msg));
  line.addEventListener('click', () => {
    const open = bar!.querySelector('.notice-log');
    if (open) return open.remove();
    const list = h(
      'div',
      { class: 'notice-log' },
      noticeLog.map((n) => h('div', { class: `row ${n.kind}` }, h('span', { class: 'at' }, new Date(n.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })), h('span', null, n.msg))),
    );
    bar!.prepend(list);
    // 読み返している間は消さない
    clearTimeout(noticeTimer);
  });
  bar.replaceChildren(line);
  clearTimeout(noticeTimer);
  // 長い案内文でも 6 秒まで（読み返しは履歴で）
  const show = Math.max(2500, Math.min(ms, 6000));
  noticeTimer = window.setTimeout(() => {
    line.classList.add('hide');
    window.setTimeout(() => {
      if (line.isConnected && !bar!.querySelector('.notice-log')) line.remove();
    }, 400);
  }, show);
}

export interface ProgressHandle {
  set(ratio: number, msg?: string, preview?: string): void;
  close(): void;
  signal: AbortSignal;
  /** 「ここで仕上げる」が押された（計算を打ち切って今の状態で保存する） */
  finish: AbortSignal;
}

export function progressModal(title: string, cancellable = true, finishLabel?: string): ProgressHandle {
  const ac = new AbortController();
  const fin = new AbortController();
  const finBtn = finishLabel
    ? (h('button', { class: 'btn primary', style: 'display:none', onclick: () => { fin.abort(); finBtn!.textContent = '仕上げています…'; (finBtn as HTMLButtonElement).disabled = true; } }, finishLabel) as HTMLButtonElement)
    : null;
  const bar = h('div', { class: 'bar-fill' });
  const msg = h('div', { class: 'progress-msg' }, '準備中…');
  const img = h('img', { class: 'progress-preview', style: 'display:none' });
  const box = h(
    'div',
    { class: 'modal-back' },
    h(
      'div',
      { class: 'modal progress' },
      h('h3', null, title),
      img,
      h('div', { class: 'bar' }, bar),
      msg,
      h('div', { class: 'btn-row', style: 'justify-content:center' }, finBtn, cancellable ? h('button', { class: 'btn ghost', onclick: () => ac.abort() }, '中止') : null),
    ),
  );
  document.body.appendChild(box);
  return {
    signal: ac.signal,
    finish: fin.signal,
    set(r, m, p) {
      bar.style.width = `${Math.round(Math.max(0, Math.min(1, r)) * 100)}%`;
      if (m) msg.textContent = m;
      if (p) {
        img.src = p;
        img.style.display = 'block';
        // 途中経過の画像が出たら「ここで仕上げる」を出す
        if (finBtn) finBtn.style.display = '';
      }
    },
    close() {
      box.remove();
    },
  };
}

export function modal(title: string, content: Node, actions: { label: string; primary?: boolean; onClick?: () => void }[] = [{ label: '閉じる' }], wide = false) {
  const back = h('div', { class: 'modal-back' });
  const close = () => back.remove();
  const box = h(
    'div',
    { class: `modal ${wide ? 'wide' : ''}` },
    h('div', { class: 'modal-head' }, h('h3', null, title), h('button', { class: 'icon-btn', onclick: close, title: '閉じる' }, '×')),
    h('div', { class: 'modal-body' }, content),
    h(
      'div',
      { class: 'modal-actions' },
      actions.map((a) =>
        h(
          'button',
          {
            class: `btn ${a.primary ? 'primary' : 'ghost'}`,
            onclick: () => {
              a.onClick?.();
              close();
            },
          },
          a.label,
        ),
      ),
    ),
  );
  back.appendChild(box);
  back.addEventListener('click', (e) => e.target === back && close());
  document.body.appendChild(back);
  return close;
}

export function download(url: string, filename: string) {
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function svgToDataUrl(svg: string) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/** SVG を PNG に */
export async function svgToPng(svg: string, width: number): Promise<string> {
  const img = new Image();
  img.src = svgToDataUrl(svg);
  await img.decode();
  const ratio = img.naturalHeight / img.naturalWidth || 0.7;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.round(width * ratio);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

export function section(title: string, ...children: Child[]) {
  return h('section', { class: 'panel-section' }, h('h4', null, title), ...children);
}

/**
 * 折りたたみの区画（普段は閉じておき、必要なときだけ開く）。summary には見出しと、閉じていても分かる要点（meta）を出す。
 * 戻り値の `.setMeta()` で要点を更新できる
 */
export function fold(title: string, opts: { open?: boolean; meta?: string; cls?: string }, ...children: Child[]) {
  const meta = h('span', { class: 'fold-meta' }, opts.meta ?? '');
  const el = h('details', { class: `panel-section fold ${opts.cls ?? ''}`, open: !!opts.open }, h('summary', null, h('span', { class: 'fold-title' }, title), meta), h('div', { class: 'fold-body' }, ...children));
  return Object.assign(el, {
    setMeta(t: string) {
      meta.textContent = t;
    },
  });
}

export function field(label: string, input: Node, hint?: string) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function segmented<T extends string>(options: { value: T; label: string }[], value: T, onChange: (v: T) => void) {
  const wrap = h('div', { class: 'segmented' });
  const render = (cur: T) => {
    clear(wrap);
    for (const o of options)
      wrap.appendChild(
        h(
          'button',
          {
            class: o.value === cur ? 'on' : '',
            onclick: () => {
              render(o.value);
              onChange(o.value);
            },
          },
          o.label,
        ),
      );
  };
  render(value);
  return wrap;
}

/** 部屋の用途を選ぶ（居室・水まわり・…・ガレージの建て方・外構をグループで） */
export function useSelect(current: string, onChange: (value: string) => void): HTMLSelectElement {
  return h(
    'select',
    { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
    USE_GROUPS.map((g) => h('optgroup', { label: g.label }, g.options.map((o) => h('option', { value: o.value, selected: o.value === current }, o.label)))),
  );
}

/**
 * 印刷の用紙を、いま表示している書類に合わせる（見積・内訳書 = A4 縦、資金計画書 = A3 横、資料 = A4 横）。
 * CSS の名前付き用紙（page:）は Chrome で 1 ページ目に効かないことがあるので、既定の @page を差し替える。null で外す
 */
export function setPrintPage(size: string | null) {
  let el = document.getElementById('print-page-size') as HTMLStyleElement | null;
  if (!size) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = 'print-page-size';
    document.head.appendChild(el);
  }
  el.textContent = `@media print { @page { size: ${size}; margin: 0; } }`;
}
