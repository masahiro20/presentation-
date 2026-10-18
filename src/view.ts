/**
 * お客様向けの閲覧ページ（view.html）
 * 共有リンク（?p=プロジェクト JSON の URL）を開くと、スマホで自分の家を
 * 見る・歩く・光を動かす・テイストを変える・AR で敷地に原寸で置く・動画を見る、ができる。
 */
import * as THREE from 'three';
import './view.css';
import { Viewer } from './scene/viewer';
import type { Shot } from './scene/shots';
import { exportGlb } from './scene/exportGlb';
import { exportUsdz } from './scene/exportUsdz';
import { EXTERIOR_STYLES, INTERIOR_STYLES, MAIN_EXTERIOR_IDS, MAIN_INTERIOR_IDS, type DesignOptions } from './styles/presets';
import type { ProjectFile } from './app/project';
import { siteLatLon } from './sun/geo';
import { sunPosition, localDate, sunDirectionWorld } from './sun/solar';
import { h, clear } from './app/dom';

type Project = ProjectFile & { share?: { id: string; videos: { title: string; url: string }[]; designer?: string; tel?: string; email?: string; url?: string } };

const root = document.getElementById('view')!;
const head = h('div', { class: 'vw-head' });
const stage = h('div', { class: 'vw-stage' });
const foot = h('div', { class: 'vw-foot' });
root.append(head, stage, foot);
const loading = h('div', { class: 'vw-loading' }, h('div', null, h('div', { class: 'mark' }, 'ご提案の家'), h('div', null, '読み込んでいます…')));
stage.appendChild(loading);

async function main() {
  const p = new URLSearchParams(location.search).get('p');
  if (!p) {
    loading.replaceChildren(h('div', null, 'リンクが正しくありません'));
    return;
  }
  let proj: Project;
  try {
    proj = (await (await fetch(p)).json()) as Project;
  } catch {
    loading.replaceChildren(h('div', null, '読み込めませんでした。リンクをもう一度ご確認ください'));
    return;
  }
  if (!proj.model) {
    loading.replaceChildren(h('div', null, 'データが入っていません'));
    return;
  }
  document.title = `${proj.customer ?? ''}　ご提案の家`;
  head.append(
    h('div', { class: 'office' }, proj.logo ? h('img', { src: proj.logo, alt: '' }) : proj.company || 'HOME LANDICK'),
    h('div', { class: 'title' }, proj.name || `${proj.customer}邸`),
  );

  const design: DesignOptions = { ...proj.design };
  const viewer = new Viewer(stage, design);
  viewer.setModel(proj.model);
  viewer.setDesign(design);
  viewer.setTownVisible(false);
  const shots = () => viewer.shots(stage.clientWidth / Math.max(1, stage.clientHeight));
  const tag = h('div', { class: 'vw-tag' });
  stage.appendChild(tag);
  const goto = (s: Shot) => {
    viewer.setNavMode('orbit');
    // 見どころカメラは横長（16:9）で構図を決めている。縦画面では横の写る範囲を保つように画角を広げる
    const aspect = stage.clientWidth / Math.max(1, stage.clientHeight);
    let shot = s;
    if (aspect < 1.2) {
      const hfov = 2 * Math.atan(Math.tan((s.view.fov * Math.PI) / 360) * (16 / 9));
      const vfov = (2 * Math.atan(Math.tan(hfov / 2) / aspect) * 180) / Math.PI;
      shot = { ...s, view: { ...s.view, fov: Math.min(100, vfov) } };
    }
    viewer.applyShot(shot, true);
    tag.textContent = s.title.replace(/パース/g, '').replace(/[（）()]/g, ' ').trim();
  };
  const first = shots().find((s) => s.kind === 'exterior') ?? shots()[0];
  if (first) goto(first);
  loading.remove();
  viewer.resize();

  // ---- 下のタブ ----
  const tabs = h('div', { class: 'vw-tabs' });
  const panes = new Map<string, HTMLElement>();
  const addTab = (id: string, label: string, build: (pane: HTMLElement) => void) => {
    const pane = h('div', { class: 'vw-pane', hidden: true });
    build(pane);
    panes.set(id, pane);
    tabs.appendChild(h('button', { class: 'vw-tab', 'data-tab': id, onclick: () => show(id) }, label));
    foot.appendChild(pane);
  };
  foot.prepend(tabs);
  let cur = '';
  const show = (id: string) => {
    cur = id;
    for (const [k, el] of panes) el.hidden = k !== id;
    for (const b of tabs.children) (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.tab === id);
    if (id !== 'walk') exitWalk();
  };

  // 外観
  addTab('ext', '外観', (pane) => {
    for (const s of shots().filter((x) => x.kind === 'exterior' || x.kind === 'aerial')) pane.appendChild(h('button', { class: 'vw-chip', onclick: () => goto(s) }, s.title.replace(/外観パース|パース/g, '').replace(/[（）()]/g, '').trim() || '外観'));
  });
  // 内観（部屋）
  addTab('int', '内観', (pane) => {
    for (const s of shots().filter((x) => x.kind === 'interior')) pane.appendChild(h('button', { class: 'vw-chip', onclick: () => goto(s) }, s.title.replace(/内観パース/g, '').replace(/[（）()]/g, '').trim().normalize('NFKC')));
    for (const s of shots().filter((x) => x.kind === 'cutaway')) pane.appendChild(h('button', { class: 'vw-chip', onclick: () => goto(s) }, s.title.replace(/パース/g, '').trim()));
    pane.appendChild(h('div', { class: 'vw-hint' }, '指でドラッグすると見回せます。扉をタップすると開きます。'));
  });
  // 歩く
  let pad: HTMLElement | null = null;
  let exitBtn: HTMLElement | null = null;
  const exitWalk = () => {
    pad?.remove();
    exitBtn?.remove();
    pad = exitBtn = null;
    for (const k of ['w', 'a', 's', 'd'] as const) viewer.pressKey(k, false);
    if (viewer.navMode === 'walk') viewer.setNavMode('orbit');
  };
  const enterWalk = () => {
    const ent = shots().find((x) => x.kind === 'interior' && /玄関|ホール/.test(x.title)) ?? shots().find((x) => x.kind === 'interior');
    if (ent) viewer.applyShot(ent, false);
    viewer.setNavMode('walk');
    tag.textContent = '';
    pad = h('div', { class: 'vw-pad' });
    const key = (k: 'w' | 'a' | 's' | 'd', cls: string, label: string) => {
      const b = h('button', { class: cls }, label);
      const on = (e: Event) => {
        e.preventDefault();
        viewer.pressKey(k, true);
      };
      const off = () => viewer.pressKey(k, false);
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off);
      b.addEventListener('pointerleave', off);
      return b;
    };
    pad.append(key('w', 'up', '▲'), key('a', 'left', '◀'), key('s', 'down', '▼'), key('d', 'right', '▶'));
    exitBtn = h('button', { class: 'vw-exit', onclick: () => show('int') }, '歩くのをやめる');
    stage.append(pad, exitBtn);
  };
  addTab('walk', '歩く', (pane) => {
    pane.appendChild(h('button', { class: 'vw-chip primary', onclick: enterWalk }, '玄関から歩いてみる'));
    pane.appendChild(h('div', { class: 'vw-hint' }, '右下のボタンで進み、画面をドラッグして見回します。階段も上れます。'));
  });
  // 光（時刻）
  addTab('sun', '光', (pane) => {
    const { lat, lon } = siteLatLon(proj.site);
    const y = new Date().getFullYear();
    let season: 'winter' | 'summer' = 'winter';
    let hour = 10;
    const val = h('span', { class: 'val' }, '10:00');
    const apply = () => {
      const [m, d] = season === 'winter' ? [12, 22] : [6, 21];
      const sp = sunPosition(localDate(y, m, d, hour), lat, lon);
      const night = sp.elevation < 0.02;
      if ((design.timeOfDay === 'night') !== night) {
        design.timeOfDay = night ? 'night' : 'day';
        viewer.setDesign(design);
      }
      if (!night) viewer.setSunDirection(sunDirectionWorld(sp.azimuth, sp.elevation, proj.model!.northAngleDeg));
      val.textContent = `${Math.floor(hour)}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')}`;
    };
    const seg = (id: 'winter' | 'summer', label: string) => {
      const b = h('button', { class: `vw-chip ${season === id ? 'on' : ''}`, onclick: () => { season = id; for (const c of pane.querySelectorAll('.vw-chip')) c.classList.toggle('on', (c as HTMLElement).dataset.s === id); apply(); } }, label);
      b.dataset.s = id;
      return b;
    };
    const slider = h('input', { type: 'range', min: 5, max: 20, step: 0.25, value: hour, oninput: (e: Event) => { hour = +(e.target as HTMLInputElement).value; apply(); } });
    pane.append(seg('winter', '冬至'), seg('summer', '夏至'), h('div', { class: 'vw-row' }, slider, val), h('div', { class: 'vw-hint' }, '建設地の緯度・経度と真北から計算した、実際の太陽の動きです。'));
  });
  // テイスト
  addTab('taste', 'テイスト', (pane) => {
    const row = (label: string, ids: string[], list: { id: string; name: string }[], key: 'exteriorId' | 'interiorId') => {
      pane.appendChild(h('div', { class: 'vw-hint' }, label));
      for (const id of ids) {
        const st = list.find((s) => s.id === id);
        if (!st) continue;
        const b = h('button', { class: `vw-chip ${design[key] === id ? 'on' : ''}`, onclick: () => { design[key] = id; viewer.setDesign(design); for (const c of pane.querySelectorAll(`[data-k=${key}]`)) c.classList.toggle('on', (c as HTMLElement).dataset.id === id); } }, st.name);
        b.dataset.k = key;
        b.dataset.id = id;
        pane.appendChild(b);
      }
    };
    row('外観', MAIN_EXTERIOR_IDS, EXTERIOR_STYLES, 'exteriorId');
    row('内観', MAIN_INTERIOR_IDS.slice(0, 4), INTERIOR_STYLES, 'interiorId');
  });
  // AR
  addTab('ar', 'AR', (pane) => {
    const mv = document.createElement('model-viewer') as HTMLElement & { activateAR: () => Promise<void>; canActivateAR: boolean };
    mv.setAttribute('ar', '');
    mv.setAttribute('ar-modes', 'webxr scene-viewer quick-look');
    mv.setAttribute('ar-scale', 'fixed');
    mv.setAttribute('ar-placement', 'floor');
    document.body.appendChild(mv);
    const status = h('div', { class: 'vw-hint' }, '敷地に立って「原寸で置く」を押すと、カメラの中に家が建ちます。机の上なら「1/50 の模型」。');
    let busy = false;
    const launch = async (scale: number) => {
      if (busy) return;
      busy = true;
      status.textContent = '3D データを用意しています（少しお待ちください）…';
      try {
        const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
        if (ios) {
          const usdz = await exportUsdz(viewer, { scale });
          const url = URL.createObjectURL(new Blob([usdz as BlobPart], { type: 'model/vnd.usdz+zip' }));
          const a = document.createElement('a');
          a.setAttribute('rel', 'ar');
          a.href = url;
          a.appendChild(document.createElement('img'));
          document.body.appendChild(a);
          a.click();
          a.remove();
        } else {
          const glb = await exportGlb(viewer);
          if (scale !== 1) {
            // 模型スケール: glb をそのまま使い、model-viewer 側で縮める
            mv.setAttribute('scale', `${scale} ${scale} ${scale}`);
          } else mv.removeAttribute('scale');
          const url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
          mv.setAttribute('src', url);
          await new Promise((r) => setTimeout(r, 800));
          await mv.activateAR();
        }
        status.textContent = 'AR を開きました。うまく開かない場合は、Safari（iPhone）または Chrome（Android）でお試しください。';
      } catch (e) {
        status.textContent = `AR を開けませんでした: ${(e as Error).message}`;
      } finally {
        busy = false;
      }
    };
    pane.append(h('button', { class: 'vw-chip primary', onclick: () => launch(1) }, '敷地に原寸で置く'), h('button', { class: 'vw-chip', onclick: () => launch(0.02) }, '1/50 の模型を机に置く'), status);
  });
  // 動画・パース
  const videos = proj.share?.videos ?? [];
  const photos = (proj.gallery ?? []).filter((g) => g.quality === 'photoreal');
  if (videos.length || photos.length) {
    addTab('media', videos.length ? '動画' : 'パース', (pane) => {
      const open = (kind: 'video' | 'photo', i: number) => {
        const box = h('div', { class: 'vw-media' });
        const bar = h('div', { class: 'bar' });
        const render = (k: 'video' | 'photo', idx: number) => {
          clear(box);
          box.append(k === 'video' ? h('video', { src: videos[idx].url, controls: true, autoplay: true, playsinline: true }) : h('img', { src: photos[idx].url }), bar);
          for (const b of bar.children) (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.key === `${k}:${idx}`);
        };
        bar.appendChild(h('button', { onclick: () => box.remove() }, '✕ 閉じる'));
        videos.forEach((v, idx) => {
          const b = h('button', { onclick: () => render('video', idx) }, v.title);
          b.dataset.key = `video:${idx}`;
          bar.appendChild(b);
        });
        photos.forEach((g, idx) => {
          const b = h('button', { onclick: () => render('photo', idx) }, g.title);
          b.dataset.key = `photo:${idx}`;
          bar.appendChild(b);
        });
        stage.appendChild(box);
        render(kind, i);
      };
      videos.forEach((v, i) => pane.appendChild(h('button', { class: 'vw-chip', onclick: () => open('video', i) }, `▶ ${v.title}`)));
      photos.slice(0, 8).forEach((g, i) => pane.appendChild(h('button', { class: 'vw-chip', onclick: () => open('photo', i) }, g.title.replace(/パース/g, ''))));
    });
  }
  show('ext');
  window.addEventListener('resize', () => viewer.resize());
  // 扉のタップ開閉はビューアに組み込み済み
}

void main();
