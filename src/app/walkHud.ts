/**
 * 歩く体験の画面部品（打合せの画面と、お客様の体験リンクの両方で使う）:
 *  - 右下の「現在地の地図」: いまいる階の平面図に、現在地と向いている方向を出す。押すとその場所へ移動して、その目線になる
 *  - 「広角」の切り替え（通常の目線 ⇄ 少し引いた広い目線。キーは V）と「揺れ」の入切
 *  - クリックで動く物（戸・シャッター）にカーソルを合わせたときの札
 * 目線モードのあいだだけ出る。
 */
import type { Viewer } from '../scene/viewer';
import { h } from './dom';

const CSS = `
.walkhud{position:absolute;right:12px;bottom:12px;z-index:30;display:flex;flex-direction:row;align-items:flex-end;gap:8px;pointer-events:none;font-family:inherit}
.walkhud[hidden],.walktip[hidden],.walkhud svg[hidden]{display:none}
.walkhud>*{pointer-events:auto}
.walkhud .wh-row{display:flex;flex-direction:column;gap:6px}
.walkhud .wh-btn{border:1px solid rgba(0,0,0,.14);background:rgba(255,255,255,.94);color:#2b2a27;border-radius:999px;padding:7px 13px;font-size:13px;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12);min-height:34px}
.walkhud .wh-btn.on{background:#2b2a27;color:#fff;border-color:#2b2a27}
.walkhud .wh-map{background:rgba(255,255,255,.95);border:1px solid rgba(0,0,0,.14);border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.16);overflow:hidden;width:min(250px,44vw)}
.walkhud .wh-head{display:flex;align-items:center;gap:4px;padding:5px 6px 5px 10px;font-size:12px;color:#55524c;border-bottom:1px solid rgba(0,0,0,.08)}
.walkhud .wh-head .wh-where{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;color:#2b2a27}
.walkhud .wh-tab{border:0;background:transparent;border-radius:6px;padding:4px 7px;font-size:12px;cursor:pointer;color:#55524c;min-height:26px}
.walkhud .wh-tab.on{background:#2b2a27;color:#fff}
.walkhud .wh-fold{border:0;background:transparent;font-size:14px;cursor:pointer;color:#55524c;padding:3px 7px;min-height:26px}
.walkhud svg{display:block;width:100%;height:auto;cursor:pointer;touch-action:manipulation;background:#eef0ea}
.walkhud .wh-room{fill:#fff;stroke:#8d8a83;stroke-width:calc(var(--u)*1.1)}
.walkhud .wh-room.out{fill:#e3e1da}
.walkhud .wh-room.here{fill:#fbf1dc}
.walkhud .wh-name{font-size:calc(var(--u)*9.5);fill:#6b675f;text-anchor:middle;dominant-baseline:middle;pointer-events:none}
.walkhud .wh-cone{fill:rgba(201,122,42,.28)}
.walkhud .wh-dot{fill:#c97a2a;stroke:#fff;stroke-width:calc(var(--u)*1.6)}
.walkhud .wh-fade{opacity:.35}
.walkhud .wh-tip{align-self:center}
.walktip{position:absolute;left:50%;bottom:76px;transform:translateX(-50%);z-index:30;background:rgba(43,42,39,.88);color:#fff;border-radius:999px;padding:7px 14px;font-size:13px;pointer-events:none;white-space:nowrap}
.walkhud.wh-tl{right:auto;bottom:auto;left:14px;top:52px;align-items:flex-start;flex-direction:row-reverse}
@media (max-width:640px){.walkhud .wh-map{width:min(180px,44vw)}.walktip{bottom:136px;max-width:92vw;white-space:normal;text-align:center}}
`;

function ensureCss() {
  if (document.getElementById('walkhud-css')) return;
  const st = document.createElement('style');
  st.id = 'walkhud-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag: string, attrs: Record<string, string | number> = {}) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

const OUTDOOR = new Set(['balcony', 'porch', 'terrace', 'deck', 'carport', 'parking']);

export interface WalkHud {
  /** 目線モードに入った／抜けたときに呼ぶ（出す・隠す） */
  sync(): void;
  dispose(): void;
}

/** 階の呼び名（1 → 1階） */
const floorName = (level: number) => `${level}階`;

export function createWalkHud(viewer: Viewer, host: HTMLElement, opts: { place?: 'bottom-right' | 'top-left' } = {}): WalkHud {
  ensureCss();
  let folded = false;
  /** 手で選んだ階（null = いまいる階に合わせる） */
  let picked: number | null = null;
  let builtKey = '';
  let raf = 0;
  let introTimer = 0;

  const svg = el('svg') as SVGSVGElement;
  const gRooms = el('g');
  const cone = el('path', { class: 'wh-cone' });
  const dot = el('circle', { class: 'wh-dot', r: 0.2 });
  svg.append(gRooms, cone, dot);
  const where = h('span', { class: 'wh-where' }, '');
  const tabs = h('span', { class: 'wh-tabs' });
  const fold = h('button', { class: 'wh-fold', title: '地図をたたむ／ひらく', 'aria-label': '地図をたたむ／ひらく' }, '▾');
  const map = h('div', { class: 'wh-map' }, h('div', { class: 'wh-head' }, where, tabs, fold), svg as unknown as HTMLElement);
  const wide = h('button', { class: 'wh-btn', title: '広角（少し引いた広い目線）に切り替える。キーは V' }, '広角');
  const bob = h('button', { class: 'wh-btn', title: '歩くときの揺れ（歩幅に合わせた小さな上下）を入れる／切る' }, '揺れ');
  const root = h('div', { class: `walkhud${opts.place === 'top-left' ? ' wh-tl' : ''}`, hidden: true }, h('div', { class: 'wh-row' }, wide, bob), map);
  const tip = h('div', { class: 'walktip', hidden: true }, '');
  host.append(root, tip);

  let bounds = { x0: 0, z0: 0, w: 1, hh: 1 };
  let unit = 0.1;

  const levels = () => {
    const st = viewer.state;
    if (!st) return [] as number[];
    return [...new Set(st.meta.rooms.map((r) => r.floor.level))].sort((a, b) => a - b);
  };

  const build = (level: number) => {
    const st = viewer.state;
    if (!st) return;
    const b = st.meta.bbox;
    // 建物のまわり 3.5m まで（庭・アプローチ・道路側へ出られるように）
    const M = 3;
    bounds = { x0: b.min.x - M, z0: b.min.z - M, w: b.max.x - b.min.x + M * 2, hh: b.max.z - b.min.z + M * 2 };
    svg.setAttribute('viewBox', `${bounds.x0} ${bounds.z0} ${bounds.w} ${bounds.hh}`);
    // 図の 1 画素ぶんの長さ（図の幅 250px を基準に、線の太さ・文字・印の大きさを決める）
    unit = bounds.w / 250;
    svg.style.setProperty('--u', `${unit}px`);
    dot.setAttribute('r', (unit * 5).toFixed(3));
    gRooms.replaceChildren();
    for (const ri of st.meta.rooms) {
      if (ri.floor.level !== level || ri.poly.length < 3 || ri.room.type === 'void') continue;
      const p = el('polygon', { class: `wh-room${OUTDOOR.has(ri.room.type) ? ' out' : ''}`, points: ri.poly.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(' ') });
      (p as unknown as { dataset: DOMStringMap }).dataset.room = ri.room.id;
      gRooms.appendChild(p);
    }
    for (const ri of st.meta.rooms) {
      if (ri.floor.level !== level || ri.poly.length < 3 || ri.room.type === 'void' || ri.room.area < 6 || !ri.room.name) continue;
      const t = el('text', { class: 'wh-name', x: ri.center.x.toFixed(2), y: ri.center.z.toFixed(2) });
      t.textContent = ri.room.name.length > 6 ? ri.room.name.slice(0, 6) : ri.room.name;
      gRooms.appendChild(t);
    }
    tabs.replaceChildren();
    const ls = levels();
    if (ls.length > 1)
      for (const l of ls) {
        const tb = h('button', { class: `wh-tab${l === level ? ' on' : ''}`, onclick: () => { picked = l; update(); } }, floorName(l));
        tabs.appendChild(tb);
      }
  };

  const update = () => {
    raf = 0;
    const on = viewer.navMode === 'walk' && !!viewer.state;
    if (on && root.hidden) {
      // 歩き始めに、押して動かせることを 5 秒だけ知らせる
      tip.textContent = '床を押すとそこへ歩きます ／ 戸は押すと開きます';
      tip.hidden = false;
      clearTimeout(introTimer);
      introTimer = window.setTimeout(() => { if (tip.textContent?.startsWith('床を')) tip.hidden = true; }, 5000);
    }
    root.hidden = !on;
    if (!on) {
      tip.hidden = true;
      picked = null;
      return;
    }
    wide.classList.toggle('on', viewer.walkWide);
    bob.classList.toggle('on', viewer.walkBob);
    map.querySelector('svg')!.toggleAttribute('hidden', folded);
    fold.textContent = folded ? '▴' : '▾';
    const pose = viewer.walkPose();
    if (!pose) return;
    where.textContent = pose.room ? `${levels().length > 1 ? floorName(pose.level) + ' ' : ''}${pose.room}` : pose.inside ? floorName(pose.level) : '屋外';
    if (folded) return;
    const level = picked ?? pose.level;
    const key = `${level}|${viewer.state!.meta.rooms.length}|${viewer.state!.meta.bbox.min.x.toFixed(2)}|${viewer.state!.meta.bbox.max.z.toFixed(2)}`;
    if (key !== builtKey) {
      builtKey = key;
      build(level);
    }
    const same = level === pose.level;
    // 図の外（遠い屋外）にいるときは、図の縁に印を出す
    const px = Math.max(bounds.x0 + unit * 6, Math.min(bounds.x0 + bounds.w - unit * 6, pose.x));
    const pz = Math.max(bounds.z0 + unit * 6, Math.min(bounds.z0 + bounds.hh - unit * 6, pose.z));
    dot.setAttribute('cx', px.toFixed(2));
    dot.setAttribute('cy', pz.toFixed(2));
    // 見えている範囲の扇（画角ぶん）
    const half = (viewer.camera.fov * Math.PI) / 360;
    const a = Math.atan2(pose.dirZ, pose.dirX);
    const R = unit * 34;
    const p1 = `${(px + Math.cos(a - half) * R).toFixed(2)},${(pz + Math.sin(a - half) * R).toFixed(2)}`;
    const p2 = `${(px + Math.cos(a + half) * R).toFixed(2)},${(pz + Math.sin(a + half) * R).toFixed(2)}`;
    cone.setAttribute('d', `M${px.toFixed(2)},${pz.toFixed(2)} L${p1} A${R},${R} 0 0 1 ${p2} Z`);
    dot.classList.toggle('wh-fade', !same);
    cone.classList.toggle('wh-fade', !same);
    for (const c of gRooms.querySelectorAll('.wh-room')) c.classList.remove('here');
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };

  svg.addEventListener('click', (e) => {
    const pose = viewer.walkPose();
    if (!pose) return;
    const r = svg.getBoundingClientRect();
    // viewBox は幅に合わせて等倍（preserveAspectRatio の既定 = 中央合わせ）
    const k = Math.min(r.width / bounds.w, r.height / bounds.hh);
    const ox = r.left + (r.width - bounds.w * k) / 2;
    const oz = r.top + (r.height - bounds.hh * k) / 2;
    const x = bounds.x0 + (e.clientX - ox) / k;
    const z = bounds.z0 + (e.clientY - oz) / k;
    const level = picked ?? pose.level;
    picked = null;
    viewer.walkGoto(x, z, level);
    schedule();
  });
  fold.addEventListener('click', () => {
    folded = !folded;
    update();
  });
  wide.addEventListener('click', () => viewer.setWalkWide(!viewer.walkWide));
  bob.addEventListener('click', () => {
    viewer.walkBob = !viewer.walkBob;
    update();
  });
  const onKey = (e: KeyboardEvent) => {
    if (viewer.navMode !== 'walk' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (e.key.toLowerCase() === 'v') viewer.setWalkWide(!viewer.walkWide);
  };
  window.addEventListener('keydown', onKey);

  viewer.onWalkChange = schedule;
  viewer.onWalkHover = (hit) => {
    if (!hit || viewer.navMode !== 'walk') {
      if (!tip.textContent?.startsWith('床を')) tip.hidden = true;
      return;
    }
    tip.textContent = hit.kind === 'roll' ? (hit.open ? 'クリックでシャッターを閉める' : 'クリックでシャッターを開ける') : hit.open ? 'クリックで戸を閉める' : 'クリックで戸を開ける';
    tip.hidden = false;
  };
  update();

  return {
    sync: update,
    dispose() {
      window.removeEventListener('keydown', onKey);
      if (viewer.onWalkChange === schedule) viewer.onWalkChange = null;
      viewer.onWalkHover = null;
      root.remove();
      tip.remove();
    },
  };
}
