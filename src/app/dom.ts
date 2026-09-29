/** 小さな DOM ヘルパー */
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
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 3500) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts' });
    document.body.appendChild(box);
  }
  const t = h('div', { class: `toast ${kind}` }, msg);
  box.appendChild(t);
  setTimeout(() => t.classList.add('hide'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export interface ProgressHandle {
  set(ratio: number, msg?: string, preview?: string): void;
  close(): void;
  signal: AbortSignal;
}

export function progressModal(title: string, cancellable = true): ProgressHandle {
  const ac = new AbortController();
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
      cancellable ? h('button', { class: 'btn ghost', onclick: () => ac.abort() }, '中止') : null,
    ),
  );
  document.body.appendChild(box);
  return {
    signal: ac.signal,
    set(r, m, p) {
      bar.style.width = `${Math.round(Math.max(0, Math.min(1, r)) * 100)}%`;
      if (m) msg.textContent = m;
      if (p) {
        img.src = p;
        img.style.display = 'block';
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
