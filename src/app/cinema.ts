/**
 * シネマ（プレゼン表示）: UI を消して全画面にし、見どころを明朝のキャプション付きで順に見せる。
 * 矢印キー／クリックで送り、自動再生では一定時間ごとに次へ。カメラは到着後ゆっくり回り込む。
 */
import { h, clear } from './dom';
import { state } from './state';
import type { Shot } from '../scene/shots';
import type { Viewer } from '../scene/viewer';

let active: { stop: () => void } | null = null;

export function cinemaRunning() {
  return !!active;
}

export function stopCinema() {
  active?.stop();
}

export function startCinema(viewer: Viewer, stage: HTMLElement, shots: Shot[], opts: { interval?: number; start?: number } = {}) {
  if (!shots.length) return;
  stopCinema();
  const interval = opts.interval ?? 8000;
  let i = Math.max(0, Math.min(shots.length - 1, opts.start ?? 0));
  let playing = true;
  let timer = 0;
  let t0 = 0;
  const cap = h('div', { class: 'cinema-cap' });
  const prog = h('div', { class: 'cinema-prog' });
  const brand = h('div', { class: 'cinema-brand' }, state.company || 'Atelier', h('small', null, state.name || ''));
  const ui = h('div', { class: 'cinema-ui' });
  const playBtn = h('button', { class: 'btn sm' }, '❚❚ 一時停止');
  const prevBtn = h('button', { class: 'btn sm', onclick: () => go(i - 1) }, '‹');
  const nextBtn = h('button', { class: 'btn sm', onclick: () => go(i + 1) }, '›');
  const exitBtn = h('button', { class: 'btn sm', onclick: () => stop() }, '✕ 終了 (Esc)');
  playBtn.onclick = () => {
    playing = !playing;
    playBtn.textContent = playing ? '❚❚ 一時停止' : '▶ 再生';
    if (playing) arm();
    else window.clearTimeout(timer);
  };
  ui.append(prevBtn, playBtn, nextBtn, exitBtn);
  const host = h('div', { class: 'view', style: 'pointer-events:none' }, brand, cap, prog, ui);
  stage.appendChild(host);
  document.body.classList.add('cinema');
  const kindJa = (s: Shot) => (s.kind === 'interior' ? 'Interior' : s.kind === 'aerial' ? 'Aerial' : s.kind === 'cutaway' ? 'Model' : s.kind === 'section' ? 'Section' : 'Exterior');
  const show = () => {
    const s = shots[i];
    cap.classList.remove('show');
    clear(cap);
    cap.append(h('div', { class: 'idx' }, `${String(i + 1).padStart(2, '0')} / ${String(shots.length).padStart(2, '0')}　${kindJa(s)}`), h('h3', null, s.title.replace(/[（）]/g, ' ').trim()), h('p', null, s.caption));
    viewer.setDrift(0);
    viewer.applyShot(s, true);
    // 到着後にゆっくり回り込む（外観・鳥瞰・模型のみ。内観は固定）
    window.setTimeout(() => {
      if (!active) return;
      cap.classList.add('show');
      viewer.setDrift(s.kind === 'interior' ? 0 : s.kind === 'cutaway' || s.kind === 'section' ? 0.025 : 0.035);
    }, 1100);
    t0 = performance.now();
    prog.style.transition = 'none';
    prog.style.width = '0';
  };
  const tick = () => {
    if (!active) return;
    if (playing) prog.style.width = `${Math.min(100, ((performance.now() - t0) / interval) * 100)}%`;
    requestAnimationFrame(tick);
  };
  const arm = () => {
    window.clearTimeout(timer);
    const remain = Math.max(300, interval - (performance.now() - t0));
    timer = window.setTimeout(() => go(i + 1), remain);
  };
  const go = (n: number) => {
    i = ((n % shots.length) + shots.length) % shots.length;
    show();
    if (playing) arm();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') stop();
    else if (e.key === 'ArrowRight' || e.key === ' ') {
      e.preventDefault();
      go(i + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(i - 1);
    }
  };
  window.addEventListener('keydown', onKey);
  const stop = () => {
    window.clearTimeout(timer);
    window.removeEventListener('keydown', onKey);
    viewer.setDrift(0);
    document.body.classList.remove('cinema');
    host.remove();
    active = null;
    viewer.resize();
    void document.fullscreenElement?.ownerDocument.exitFullscreen?.().catch(() => undefined);
  };
  active = { stop };
  // 全画面（拒否されてもそのまま続ける）
  void (document.documentElement.requestFullscreen?.() ?? Promise.resolve()).catch(() => undefined);
  window.setTimeout(() => viewer.resize(), 300);
  show();
  arm();
  requestAnimationFrame(tick);
}
