/**
 * プレビューの拡大縮小（図面・数量の根拠シート・読み込み結果の図面・資料のページ・仕様決定書）。
 *
 * 入れ物（.plan-view / .est-view / .deck / .coord-overlay: position:absolute; overflow:auto）の中身を
 * transform: scale で拡大し、スクロールで見る位置を動かす。3D 以外のプレビューは全部これを通す。
 *
 *  - Ctrl（Mac は ⌘）＋ホイール／トラックパッドのピンチ: カーソルの位置を中心に拡大縮小
 *  - タッチパネル: 2 本指のピンチで拡大縮小・移動、1 本指で動かす、ダブルタップで 2.5 倍 ⇄ 全体
 *  - マウス: 拡大中はドラッグで動かす（手のひら）、ダブルクリックで 2.5 倍 ⇄ 全体
 *  - 右下のバー: － ／ 倍率（押すと全体）／ ＋。Ctrl＋ ＋ － 0 のキーも、カーソルがプレビューの上にある間は効く
 *
 * 普通のホイールはこれまでどおりスクロール。ボタン・入力欄・掴める印（data-panel）の上では何もしない。
 */
import { h } from './dom';

export interface ZoomPane {
  /** 中身を入れる所（入れ物に直接入れず、ここへ入れる） */
  content: HTMLElement;
  /** 今の倍率（1 = 幅に合わせた全体） */
  readonly zoom: number;
  setZoom(z: number, at?: { x: number; y: number }): void;
  /** 全体（100%）に戻す */
  reset(): void;
  /** 中身を入れ替えた後などに、大きさを測り直す */
  refresh(): void;
  destroy(): void;
}

const INTERACTIVE = 'button, input, select, textarea, a, label, summary, [contenteditable], .zoom-bar, .pe-svg';

export function zoomPane(host: HTMLElement, opts: { min?: number; max?: number; barIn?: HTMLElement | null } = {}): ZoomPane {
  const min = opts.min ?? 1;
  const max = opts.max ?? 6;
  let z = 1;
  let W = 0;
  const inner = h('div', { class: 'zp-inner' });
  const size = h('div', { class: 'zp-size' }, inner);
  host.classList.add('zp-host');
  host.appendChild(size);

  // ---- ズームバー（入れ物の親 = ステージに置く。入れ物がスクロールしても動かない） ----
  const pct = h('button', { class: 'zoom-pct', title: '全体に戻す（100%）' }, '100%');
  const bar = h(
    'div',
    { class: 'zoom-bar', title: 'Ctrl＋ホイール（Mac は ⌘）やピンチで拡大縮小。ダブルクリック・ダブルタップで 2.5 倍 ⇄ 全体。拡大中はドラッグで動かせます' },
    h('button', { class: 'zoom-btn', title: '縮小（Ctrl＋−）', 'aria-label': '縮小' }, '－'),
    pct,
    h('button', { class: 'zoom-btn', title: '拡大（Ctrl＋＋）', 'aria-label': '拡大' }, '＋'),
  );
  const [btnMinus, , btnPlus] = [...bar.children] as HTMLButtonElement[];
  const barParent = opts.barIn === null ? null : (opts.barIn ?? host.parentElement);
  barParent?.appendChild(bar);

  const padOf = () => {
    const cs = getComputedStyle(host);
    return { l: parseFloat(cs.paddingLeft) || 0, r: parseFloat(cs.paddingRight) || 0, t: parseFloat(cs.paddingTop) || 0 };
  };
  const layout = () => {
    const pad = padOf();
    W = Math.max(0, host.clientWidth - pad.l - pad.r);
    inner.style.width = `${W}px`;
    inner.style.transform = Math.abs(z - 1) < 1e-4 ? '' : `scale(${z})`;
    const H = inner.offsetHeight;
    size.style.width = `${Math.round(W * z)}px`;
    size.style.height = `${Math.round(H * z)}px`;
    pct.textContent = `${Math.round(z * 100)}%`;
    host.classList.toggle('zp-zoomed', z > 1.001);
    btnMinus.disabled = z <= min + 1e-4;
    btnPlus.disabled = z >= max - 1e-4;
  };
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const setZoom = (nz: number, at?: { x: number; y: number }) => {
    nz = clamp(nz);
    if (Math.abs(nz - z) < 1e-4) return;
    const r = host.getBoundingClientRect();
    const pad = padOf();
    // 基準点（入れ物の中の位置。省略時は見えている範囲の中央）と、その下にある中身の点
    const ax = at ? at.x - r.left - host.clientLeft : host.clientWidth / 2;
    const ay = at ? at.y - r.top - host.clientTop : host.clientHeight / 2;
    const cx = (host.scrollLeft + ax - pad.l) / z;
    const cy = (host.scrollTop + ay - pad.t) / z;
    z = nz;
    layout();
    host.scrollLeft = cx * z - ax + pad.l;
    host.scrollTop = cy * z - ay + pad.t;
  };
  const stepZoom = (k: number, at?: { x: number; y: number }) => setZoom(z * k, at);
  const toggleZoom = (at: { x: number; y: number }) => (z < 1.9 ? setZoom(2.5, at) : setZoom(1));
  btnMinus.addEventListener('click', () => stepZoom(1 / 1.25));
  btnPlus.addEventListener('click', () => stepZoom(1.25));
  pct.addEventListener('click', () => setZoom(1));

  // ---- 大きさの変化（側パネルの開閉・中身の入れ替え）に追従 ----
  const ro = new ResizeObserver(() => layout());
  ro.observe(host);
  ro.observe(inner);

  // ---- ホイール（Ctrl／⌘）: カーソルの位置を中心に。トラックパッドのピンチも ctrlKey 付きのホイールで来る ----
  const onWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    stepZoom(k, { x: e.clientX, y: e.clientY });
  };
  host.addEventListener('wheel', onWheel, { passive: false });

  // ---- ポインタ: マウスのドラッグ移動、タッチの 1 本指移動・2 本指ピンチ・ダブルタップ ----
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; mid: { x: number; y: number } } | null = null;
  let pan: { id: number; x: number; y: number; sl: number; st: number; moved: boolean; vx: number; vy: number; t: number } | null = null;
  let inertia = 0;
  let lastTap = 0;
  let lastTapAt = { x: 0, y: 0 };
  // ボタン・入力欄の上では何もしない。掴める印（data-panel。図面の 1 階・2 階の配置直し）は全体表示のときだけ優先し、拡大中はドラッグで動かす方を優先する
  const interactive = (t: EventTarget | null) => {
    const el = t as Element | null;
    if (!el?.closest) return false;
    if (el.closest(INTERACTIVE)) return true;
    return z <= 1.001 && !!el.closest('[data-panel]');
  };
  const overflowing = () => host.scrollWidth > host.clientWidth + 1 || host.scrollHeight > host.clientHeight + 1;
  const capture = (id: number) => {
    try {
      host.setPointerCapture(id);
    } catch {
      /* 合成イベントなど、ポインタが無いとき */
    }
  };
  const stopInertia = () => {
    if (inertia) cancelAnimationFrame(inertia);
    inertia = 0;
  };
  const onDown = (e: PointerEvent) => {
    stopInertia();
    if (e.pointerType === 'mouse') {
      if (e.button !== 0 || interactive(e.target) || !overflowing()) return;
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY, sl: host.scrollLeft, st: host.scrollTop, moved: false, vx: 0, vy: 0, t: performance.now() };
      capture(e.pointerId);
      host.classList.add('zp-grabbing');
      return;
    }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size >= 2) {
      const [a, b] = [...touches.values()];
      pinch = { d: Math.hypot(b.x - a.x, b.y - a.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      if (pan) host.classList.remove('zp-grabbing');
      pan = null;
      capture(e.pointerId);
      return;
    }
    if (interactive(e.target)) return;
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY, sl: host.scrollLeft, st: host.scrollTop, moved: false, vx: 0, vy: 0, t: performance.now() };
    capture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) {
      if (touches.size < 2) return;
      const [a, b] = [...touches.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      setZoom(z * (d / pinch.d), mid);
      host.scrollLeft -= mid.x - pinch.mid.x;
      host.scrollTop -= mid.y - pinch.mid.y;
      pinch = { d, mid };
      return;
    }
    if (!pan || e.pointerId !== pan.id) return;
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (!pan.moved && Math.hypot(dx, dy) < 4) return;
    if (!pan.moved) {
      pan.moved = true;
      if (e.pointerType !== 'mouse') host.classList.add('zp-grabbing');
    }
    const now = performance.now();
    const dt = Math.max(1, now - pan.t);
    const nl = pan.sl - dx;
    const nt = pan.st - dy;
    // 速度（px/ms。離したときの惰性に使う）
    pan.vx = 0.6 * pan.vx + 0.4 * ((nl - host.scrollLeft) / dt);
    pan.vy = 0.6 * pan.vy + 0.4 * ((nt - host.scrollTop) / dt);
    pan.t = now;
    host.scrollLeft = nl;
    host.scrollTop = nt;
  };
  const glide = (vx: number, vy: number) => {
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      host.scrollLeft += vx * dt;
      host.scrollTop += vy * dt;
      const k = Math.pow(0.94, dt / 16);
      vx *= k;
      vy *= k;
      inertia = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    inertia = requestAnimationFrame(step);
  };
  const onUp = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    if (pinch && touches.size < 2) pinch = null;
    if (!pan || e.pointerId !== pan.id) return;
    const p = pan;
    pan = null;
    host.classList.remove('zp-grabbing');
    if (p.moved) {
      if (e.pointerType !== 'mouse' && e.type === 'pointerup' && Math.hypot(p.vx, p.vy) > 0.05) glide(p.vx, p.vy);
      return;
    }
    // 軽いタップ 2 回（320ms・40px 以内）で 2.5 倍 ⇄ 全体
    if (e.pointerType !== 'mouse' && e.type === 'pointerup') {
      const now = performance.now();
      if (now - lastTap < 320 && Math.hypot(e.clientX - lastTapAt.x, e.clientY - lastTapAt.y) < 40) {
        toggleZoom({ x: e.clientX, y: e.clientY });
        lastTap = 0;
      } else {
        lastTap = now;
        lastTapAt = { x: e.clientX, y: e.clientY };
      }
    }
  };
  const onDbl = (e: MouseEvent) => {
    if (interactive(e.target)) return;
    e.preventDefault();
    toggleZoom({ x: e.clientX, y: e.clientY });
  };
  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onUp);
  host.addEventListener('dblclick', onDbl);

  // ---- キー: Ctrl＋ ＋ － 0（カーソルがプレビューの上にある間だけ。ブラウザの拡大と取り合わない） ----
  let hover = false;
  const onEnter = () => (hover = true);
  const onLeave = () => (hover = false);
  host.addEventListener('pointerenter', onEnter);
  host.addEventListener('pointerleave', onLeave);
  const onKey = (e: KeyboardEvent) => {
    if (!hover || !(e.ctrlKey || e.metaKey) || host.hidden || !host.isConnected) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '')) return;
    if (e.key === '+' || e.key === '=' || e.key === ';') stepZoom(1.25);
    else if (e.key === '-') stepZoom(1 / 1.25);
    else if (e.key === '0') setZoom(1);
    else return;
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);

  // ---- 入れ物が隠れたらバーも隠す。入れ物が外されたら片付ける ----
  const syncBar = () => {
    bar.hidden = host.hidden || host.style.display === 'none';
  };
  const mo = new MutationObserver(() => {
    if (!host.isConnected) {
      destroy();
      return;
    }
    syncBar();
  });
  mo.observe(host, { attributes: true, attributeFilter: ['hidden', 'style'] });
  if (host.parentElement) mo.observe(host.parentElement, { childList: true });
  syncBar();

  const destroy = () => {
    ro.disconnect();
    mo.disconnect();
    stopInertia();
    host.removeEventListener('wheel', onWheel);
    host.removeEventListener('pointerdown', onDown);
    host.removeEventListener('pointermove', onMove);
    host.removeEventListener('pointerup', onUp);
    host.removeEventListener('pointercancel', onUp);
    host.removeEventListener('dblclick', onDbl);
    host.removeEventListener('pointerenter', onEnter);
    host.removeEventListener('pointerleave', onLeave);
    window.removeEventListener('keydown', onKey);
    bar.remove();
  };
  layout();
  return {
    content: inner,
    get zoom() {
      return z;
    },
    setZoom,
    reset: () => setZoom(1),
    refresh: layout,
    destroy,
  };
}
