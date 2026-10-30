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
import { sceneViewerUrl, type ArFiles } from './scene/exportAr';
import { EXTERIOR_STYLES, INTERIOR_STYLES, MAIN_EXTERIOR_IDS, MAIN_INTERIOR_IDS, type DesignOptions } from './styles/presets';
import type { ProjectFile } from './app/project';
import { siteLatLon } from './sun/geo';
import { sunPosition, localDate, sunDirectionWorld } from './sun/solar';
import { h, clear } from './app/dom';
import { upload } from '@vercel/blob/client';
import { FINISH_CATEGORIES, selectedProduct } from './coordinate/catalog';
import { ROUNDS, shotFor, deltaText, type CustomerPicks, type CustomerInbox } from './coordinate/decisions';
import { yenMan } from './core/planDiff';
import { lookOf } from './coordinate/samples';

type Project = ProjectFile & { share?: { id: string; videos: { title: string; url: string }[]; ar?: ArFiles; deltas?: Record<string, Record<string, number | null>>; grand?: number; designer?: string; tel?: string; email?: string; url?: string } };

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
    // お客様向けの言葉に（「道路側」→「正面」など、社内の呼び方を出さない）
    tag.textContent = s.title.replace(/パース/g, '').replace(/[（）()]/g, ' ').replace(/道路側/g, '正面').replace(/^(外観|内観)\s+\1/, '$1').trim();
    curShot = s;
    paintLike();
  };
  // ---- お客様からのもの（customer.json）: いいねした構図・ご要望の文章。担当者が受け取る ----
  const canSend = !!proj.share?.id;
  const inboxUrl = p.replace(/project\.json(\?.*)?$/, 'customer.json');
  let inbox: CustomerInbox = { at: '' };
  if (canSend)
    try {
      const r = await fetch(`${inboxUrl}?t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) inbox = (await r.json()) as CustomerInbox;
    } catch {
      /* まだ無い */
    }
  const likes = new Map<string, string>((inbox.likes ?? []).map((l) => [l.id, l.title]));
  const saveInbox = async () => {
    inbox = { ...inbox, at: new Date().toISOString(), likes: [...likes].map(([id, title]) => ({ id, title })) };
    await upload(`share/${proj.share!.id}/customer.json`, new Blob([JSON.stringify(inbox)], { type: 'application/json' }), { access: 'public', handleUploadUrl: '/api/share', contentType: 'application/json' });
  };
  // いいね: 今見ている構図に ♡（タップで保存。担当者は「お客様の選択を受け取る」で見られる）
  let curShot: Shot | null = null;
  const likeBtn = h('button', { class: 'vw-like', hidden: true }, '♡ いいね') as HTMLButtonElement;
  const likeMsg = h('span', { class: 'vw-like-msg' });
  let likeTimer = 0;
  const paintLike = () => {
    if (!canSend || !curShot) {
      likeBtn.hidden = true;
      return;
    }
    likeBtn.hidden = false;
    const on = likes.has(curShot.id);
    likeBtn.classList.toggle('on', on);
    likeBtn.textContent = on ? '♥ いいね' : '♡ いいね';
  };
  likeBtn.onclick = () => {
    if (!curShot) return;
    if (likes.has(curShot.id)) likes.delete(curShot.id);
    else likes.set(curShot.id, tag.textContent || curShot.title);
    paintLike();
    likeMsg.textContent = '';
    window.clearTimeout(likeTimer);
    likeTimer = window.setTimeout(() => void saveInbox().then(() => (likeMsg.textContent = '担当者に伝わります')).catch(() => (likeMsg.textContent = '保存できませんでした')), 800);
  };
  stage.append(likeBtn, likeMsg);
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
    for (const s of shots().filter((x) => x.kind === 'exterior' || x.kind === 'aerial')) pane.appendChild(h('button', { class: 'vw-chip', onclick: () => goto(s) }, s.title.replace(/外観パース|パース/g, '').replace(/[（）()]/g, '').replace(/道路側/g, '正面').trim() || '外観'));
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
    curShot = null;
    paintLike();
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
  // 仕様を選ぶ（コーディネーターが絞った候補だけ）: 自分の家の 3D で切り替えて選び、ひとことを添えて担当者に送る
  const proposed = ROUNDS.flatMap((r) => r.cats)
    .map((id) => ({ cat: FINISH_CATEGORIES.find((c) => c.id === id)!, it: proj.coord?.items?.[id] }))
    .filter((x) => x.cat && x.it && (x.it.candidates?.length ?? 0) >= 2 && x.it.status !== 'decided');
  if (proposed.length && proj.share?.id)
    addTab('pick', '仕様を選ぶ', (pane) => {
      const picks: CustomerPicks['picks'] = {};
      const deltas = proj.share?.deltas ?? {};
      pane.appendChild(h('div', { class: 'vw-hint' }, `担当者がお選びした候補です（${proposed.length} か所）。押すと、この家の 3D がその仕上げに変わります。気に入ったものを選んで、最後に「担当者に送る」を押してください。`));
      // 選ぶたびに総額が動く（担当者が体験リンクを作った時点の概算 ＋ 候補の差額）
      const grand = proj.share?.grand;
      const total = h('div', { class: 'vw-total' });
      const paintTotal = () => {
        if (grand == null) return;
        let d = 0;
        for (const { cat } of proposed) {
          const pid = picks[cat.id]?.id;
          if (pid) d += deltas[cat.id]?.[pid] ?? 0;
        }
        total.replaceChildren(h('span', { class: 'k' }, '今の選択での概算（税込）'), h('b', null, yenMan(grand + d)), h('span', { class: `d ${d > 0 ? 'up' : ''}` }, Math.abs(d) < 1000 ? 'ご提案のとおり' : `ご提案から ${d > 0 ? '＋' : '−'}${yenMan(Math.abs(d))}`));
      };
      paintTotal();
      if (grand != null) pane.appendChild(total);
      for (const { cat, it } of proposed) {
        const box = h('div', { class: 'vw-pick' }, h('div', { class: 'k' }, cat.label));
        const chips = h('div', { class: 'chips' });
        const cur = () => picks[cat.id]?.id ?? selectedProduct(cat, design).id;
        const render = () => {
          clear(chips);
          for (const pid of it!.candidates!) {
            const p = cat.products.find((x) => x.id === pid);
            if (!p) continue;
            const d = deltas[cat.id]?.[pid];
            chips.appendChild(
              h(
                'button',
                {
                  class: `vw-cand ${cur() === pid ? 'on' : ''}`,
                  onclick: () => {
                    picks[cat.id] = { ...(picks[cat.id] ?? {}), id: pid };
                    design.finishes = { ...(design.finishes ?? {}), [cat.id]: pid };
                    viewer.setDesign(design);
                    // 色を比べるときは室内の照明も点ける仕上げ表示（閲覧表示の昼は床・壁が灰色に沈んで見える）
                    viewer.setViewMode('finish');
                    const s = shotFor(cat.id, shots());
                    if (s) goto(s);
                    render();
                    paintTotal();
                  },
                },
                (() => {
                  // 実物写真（担当者が登録したもの）→ 無ければ質感イメージ → 色見本
                  const look = lookOf(cat.id, p, design, proj.coord?.samples);
                  return look ? h('span', { class: `ph ${look.real ? 'real' : ''}` }, h('img', { src: look.url, alt: '' })) : h('span', { class: 'sw' }, ...p.swatch.map((c) => h('i', { style: `background:${c}` })));
                })(),
                h('span', { class: 'nm' }, `${p.name}${p.color ? `　${p.color}` : ''}`),
                d != null && Math.abs(d) >= 1000 ? h('span', { class: 'dl' }, deltaText(d)) : null,
              ),
            );
          }
        };
        render();
        const memo = h('input', { type: 'text', placeholder: 'ひとこと（例: もう少し明るい色が好き）', oninput: (e: Event) => { picks[cat.id] = { id: cur(), comment: (e.target as HTMLInputElement).value }; } });
        box.append(chips, memo);
        pane.appendChild(box);
      }
      const note = h('textarea', { rows: 2, placeholder: '全体へのご要望・ご質問（任意）' }) as HTMLTextAreaElement;
      const status = h('div', { class: 'vw-hint' });
      const send = h('button', { class: 'vw-chip primary' }, '担当者に送る') as HTMLButtonElement;
      send.onclick = async () => {
        // 触っていない部位は今の選択（担当者のおすすめ）のまま送る
        for (const { cat } of proposed) if (!picks[cat.id]) picks[cat.id] = { id: selectedProduct(cat, design).id };
        const body: CustomerPicks = { at: new Date().toISOString(), picks, note: note.value.trim() || undefined };
        send.disabled = true;
        status.textContent = '送っています…';
        try {
          await upload(`share/${proj.share!.id}/picks.json`, new Blob([JSON.stringify(body)], { type: 'application/json' }), { access: 'public', handleUploadUrl: '/api/share', contentType: 'application/json' });
          status.textContent = '送りました。ありがとうございます。担当者から次回の打ち合わせでご案内します（何度でも送り直せます）。';
        } catch (e) {
          status.textContent = `送れませんでした（${(e as Error).message}）。お手数ですが担当者にご連絡ください。`;
        } finally {
          send.disabled = false;
        }
      };
      pane.append(note, send, status);
    });
  // ご要望: 思いついたときにスマホで書いて送る（担当者の読込画面の「ご要望との照合」に入る）
  if (canSend)
    addTab('wish', 'ご要望', (pane) => {
      pane.appendChild(h('div', { class: 'vw-hint' }, 'この家に「こうしたい」「ここが気になる」を、思いついたときに書いてください。担当者が次の打ち合わせまでに間取りと照らし合わせます。'));
      const ta = h('textarea', { rows: 5, placeholder: '例）玄関に土間収納がほしい\n寝室とトイレは近くに\n今の家は洗濯物を干す場所が遠くて困っている\n家族: 夫婦＋子ども 2 人（小学生）' }) as HTMLTextAreaElement;
      ta.value = inbox.wishes ?? '';
      const status = h('div', { class: 'vw-hint' }, inbox.wishes ? `${inbox.at ? new Date(inbox.at).toLocaleDateString('ja-JP') + ' に' : '前に'}送った内容です。書き足して、もう一度送れます。` : '');
      const send = h('button', { class: 'vw-chip primary' }, '担当者に送る') as HTMLButtonElement;
      send.onclick = async () => {
        inbox.wishes = ta.value.trim();
        send.disabled = true;
        status.textContent = '送っています…';
        try {
          await saveInbox();
          status.textContent = '送りました。ありがとうございます（何度でも書き足せます）。';
        } catch (e) {
          status.textContent = `送れませんでした（${(e as Error).message}）。お手数ですが担当者にご連絡ください。`;
        } finally {
          send.disabled = false;
        }
      };
      pane.append(ta, send, status);
    });
  // 設計士のメモ（図面の吹き出し）: タップでその場所へ
  const notes = proj.model.floors.flatMap((f) => (f.notes ?? []).map((n) => ({ ...n, level: f.level })));
  if (notes.length)
    addTab('notes', '設計士のメモ', (pane) => {
      for (const n of notes) {
        pane.appendChild(
          h(
            'button',
            {
              class: 'vw-chip note',
              onclick: () => {
                const s = (n.roomId && shots().find((x) => x.kind === 'interior' && x.roomId === n.roomId)) || shots().find((x) => x.kind === 'cutaway' && x.cutaway === n.level) || shots().find((x) => x.kind === 'cutaway');
                if (s) goto(s);
                tag.textContent = n.text;
              },
            },
            n.text,
          ),
        );
      }
      pane.appendChild(h('div', { class: 'vw-hint' }, '図面に書き込んだ、この家の見どころです。'));
    });
  addTab('ar', 'AR', (pane) => {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const android = /Android/.test(navigator.userAgent);
    const ar = proj.share?.ar ?? {};
    const title = `${proj.name || 'わが家'}`;
    const status = h('div', { class: 'vw-hint' }, '敷地に立って「原寸で置く」を押すと、カメラの中に家が建ちます。机の上なら「1/50 の模型」。');
    // 体験リンクを作ったときに用意した AR のデータ（公開 URL）をタップで直接開く。
    // iPhone の Quick Look・Android の Scene Viewer は、タップの直後でないと開かないので、ここでは待ち時間を挟まない
    const openReady = (model: boolean): boolean => {
      if (ios) {
        const u = model ? ar.usdzModel : ar.usdz;
        if (!u) return false;
        const a = document.createElement('a');
        a.setAttribute('rel', 'ar');
        a.href = `${u}#allowsContentScaling=${model ? 1 : 0}`;
        a.appendChild(document.createElement('img'));
        document.body.appendChild(a);
        a.click();
        a.remove();
        return true;
      }
      if (android) {
        const u = model ? ar.glbModel : ar.glb;
        if (!u) return false;
        location.href = sceneViewerUrl(u, title, location.href);
        return true;
      }
      return false;
    };
    // 古い体験リンク（AR のデータが無い）: ここで書き出してから、もう一度タップしてもらう
    let prepared: { model: boolean; url: string } | null = null;
    const prepare = async (model: boolean) => {
      status.textContent = '3D データを用意しています（少しお待ちください）…';
      const scale = model ? 0.02 : 1;
      const data = ios ? await exportUsdz(viewer, { scale }) : await exportGlb(viewer);
      const url = URL.createObjectURL(new Blob([data as BlobPart], { type: ios ? 'model/vnd.usdz+zip' : 'model/gltf-binary' }));
      prepared = { model, url };
      status.textContent = '用意ができました。もう一度ボタンを押すと AR が開きます。';
    };
    const launch = (model: boolean) => {
      if (!ios && !android) {
        status.textContent = 'AR はスマートフォン（iPhone の Safari、Android の Chrome）で開いてください。パソコンでは開けません。';
        return;
      }
      if (openReady(model)) {
        status.textContent = 'AR を開いています。開かないときは、iPhone は Safari、Android は Chrome でこのページを開き直してください。';
        return;
      }
      if (prepared && prepared.model === model && ios) {
        const a = document.createElement('a');
        a.setAttribute('rel', 'ar');
        a.href = prepared.url;
        a.appendChild(document.createElement('img'));
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
      }
      if (!ios) {
        status.textContent = 'この体験リンクには Android 用の AR データがありません。担当者に体験リンクの作り直しをご依頼ください。';
        return;
      }
      void prepare(model).catch((e) => (status.textContent = `AR を用意できませんでした: ${(e as Error).message}`));
    };
    pane.append(h('button', { class: 'vw-chip primary', onclick: () => launch(false) }, '敷地に原寸で置く'), h('button', { class: 'vw-chip', onclick: () => launch(true) }, '1/50 の模型を机に置く'), status);
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
