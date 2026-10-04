import * as THREE from 'three';
import { h, clear, toast, progressModal, section, field, modal, download, svgToDataUrl, svgToPng } from '../dom';
import { state, emit } from '../state';
import type { Step, StepCtx } from '../app';
import { SunContext } from '../../sun/context';
import { geocode, siteLatLon, PRECISION_LABEL } from '../../sun/geo';
import { sunPosition, sunDirectionWorld, localDate, sunriseSunset, formatHM, keyDates } from '../../sun/solar';
import { analyzeRooms, groundSunHours, heatmapMesh, shadowDiagram, type SunDay } from '../../sun/analysis';
import { sunHighlights, sunTimelineSvg, type SeasonResult } from '../../sun/report';
import { clearGroup } from '../../scene/viewer';

interface SunUI {
  year: number;
  month: number;
  day: number;
  hour: number;
  playing: boolean;
  speed: number;
}

const ui: SunUI = { year: new Date().getFullYear(), month: 12, day: 22, hour: 10, playing: false, speed: 1 };
let raf = 0;
let heat: THREE.Mesh | null = null;

function getCtx(ctx: StepCtx): SunContext {
  const v = ctx.app.viewer;
  let sc = v.userData.sunCtx as SunContext | undefined;
  if (!sc) {
    sc = new SunContext(v, state.site);
    v.userData.sunCtx = sc;
  }
  sc.state.site = state.site;
  return sc;
}

function sunDay(): SunDay {
  const { lat, lon } = siteLatLon(state.site);
  return { year: ui.year, month: ui.month, day: ui.day, lat, lon, northAngleDeg: state.model!.northAngleDeg };
}

let cleanupPlace: (() => void) | null = null;

export const sunStep: Step = {
  id: 'sun',
  label: '日照シミュレーション',
  needsModel: true,
  uses3d: true,
  unmount() {
    cancelAnimationFrame(raf);
    ui.playing = false;
    cleanupPlace?.();
    cleanupPlace = null;
  },
  async mount(ctx) {
    const v = ctx.app.viewer;
    if (state.design.timeOfDay !== 'day') {
      state.design = { ...state.design, timeOfDay: 'day' };
      v.setDesign(state.design);
    }
    v.setCutaway(null);
    v.groups.context.visible = true;
    const sc = getCtx(ctx);
    sc.year = ui.year;
    sc.buildSunPath();
    sc.buildNeighbors();

    // ---- 表示の更新 ----
    const badge = h('div', { class: 'sun-badge', style: 'pointer-events:auto' });
    const timeEl = h('div', { class: 'time' });
    const subEl = h('div', { class: 'sub' });
    const slider = h('input', { type: 'range', min: 4, max: 20, step: 1 / 60, value: ui.hour }) as HTMLInputElement;
    let lastEnv = 0;
    const apply = (envNow = false) => {
      const d = sunDay();
      const sp = sunPosition(localDate(ui.year, ui.month, ui.day, ui.hour), d.lat, d.lon);
      const dir = sunDirectionWorld(sp.azimuth, sp.elevation, d.northAngleDeg);
      const now = performance.now();
      const env = envNow || now - lastEnv > 400;
      if (env) lastEnv = now;
      v.setSunDirection(dir, env);
      sc.updateSunMarker(dir);
      const rs = sunriseSunset(ui.year, ui.month, ui.day, d.lat, d.lon);
      timeEl.textContent = formatHM(ui.hour);
      subEl.textContent = `${ui.month}月${ui.day}日`;
      const dirName = (az: number) => ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(az / 45) % 8];
      clear(badge);
      badge.append(
        h('div', null, h('b', null, `${ui.month}月${ui.day}日 ${formatHM(ui.hour)}`)),
        h('div', null, sp.elevation > 0 ? `太陽高度 ${sp.elevation.toFixed(1)}°／方位 ${dirName(sp.azimuth)}（${sp.azimuth.toFixed(0)}°）` : '日没後・日の出前'),
        h('div', { style: 'color:#8b9098' }, `日の出 ${formatHM(rs.sunrise)}／南中 ${formatHM(rs.noon)}／日の入 ${formatHM(rs.sunset)}`),
        h('div', { style: 'color:#8b9098' }, `昼の長さ ${formatHM(rs.sunset - rs.sunrise).replace(':', '時間')}分`),
      );
      slider.value = String(ui.hour);
    };

    // ---- ステージ: 時刻バー ----
    const playBtn = h('button', { class: 'play', title: '再生' }, '▶');
    const chips = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
    const renderChips = () => {
      clear(chips);
      const today = new Date();
      const opts = [...keyDates(ui.year).map((k) => ({ label: k.label, m: k.month, d: k.day })), { label: '今日', m: today.getMonth() + 1, d: today.getDate() }];
      for (const o of opts)
        chips.appendChild(
          h(
            'button',
            {
              class: `chip ${ui.month === o.m && ui.day === o.d ? 'on' : ''}`,
              onclick: () => {
                ui.month = o.m;
                ui.day = o.d;
                renderChips();
                apply(true);
              },
            },
            o.label,
          ),
        );
      chips.appendChild(
        h('input', {
          type: 'date',
          value: `${ui.year}-${String(ui.month).padStart(2, '0')}-${String(ui.day).padStart(2, '0')}`,
          style: 'background:transparent;color:#fff;border:1px solid #50555d;border-radius:999px;padding:3px 10px',
          onchange: (e: Event) => {
            const [y, m, d] = (e.target as HTMLInputElement).value.split('-').map(Number);
            if (!y) return;
            ui.year = y;
            ui.month = m;
            ui.day = d;
            renderChips();
            apply(true);
          },
        }),
      );
    };
    renderChips();
    slider.addEventListener('input', () => {
      ui.hour = +slider.value;
      apply();
    });
    slider.addEventListener('change', () => apply(true));
    const speedSel = h('select', { style: 'background:#2a2d31;color:#fff;border:1px solid #50555d;border-radius:6px;padding:3px' }, h('option', { value: 0.5 }, '0.5x'), h('option', { value: 1, selected: true }, '1x'), h('option', { value: 2 }, '2x'), h('option', { value: 4 }, '4x')) as HTMLSelectElement;
    speedSel.addEventListener('change', () => (ui.speed = +speedSel.value));
    let lastT = 0;
    const tick = (t: number) => {
      if (!ui.playing) return;
      const dt = lastT ? (t - lastT) / 1000 : 0;
      lastT = t;
      ui.hour += dt * 0.9 * ui.speed; // 1秒で約54分
      const d = sunDay();
      const rs = sunriseSunset(ui.year, ui.month, ui.day, d.lat, d.lon);
      if (ui.hour > rs.sunset + 0.3) ui.hour = rs.sunrise - 0.3;
      apply();
      raf = requestAnimationFrame(tick);
    };
    playBtn.addEventListener('click', () => {
      ui.playing = !ui.playing;
      playBtn.textContent = ui.playing ? '❚❚' : '▶';
      lastT = 0;
      if (ui.playing) raf = requestAnimationFrame(tick);
      else apply(true);
    });
    const bar = h(
      'div',
      { class: 'overlay-bar', style: 'pointer-events:auto' },
      playBtn,
      h('div', null, timeEl, subEl),
      slider,
      speedSel,
      h('div', { style: 'flex-basis:100%;height:0' }),
      chips,
    );
    // 視点
    const c = v.state!.meta.bbox.getCenter(new THREE.Vector3());
    const size = v.state!.meta.bbox.getSize(new THREE.Vector3());
    const R = Math.max(size.x, size.z);
    const views = h(
      'div',
      { class: 'view-tools', style: 'pointer-events:auto' },
      h('button', { class: 'btn', onclick: () => v.flyTo({ pos: c.clone().add(new THREE.Vector3(R * 1.6, R * 1.7, R * 2.1)), target: c.clone().setY(1), fov: 45 }) }, '鳥瞰'),
      h('button', { class: 'btn', onclick: () => v.flyTo({ pos: c.clone().add(new THREE.Vector3(26, 30, 38)), target: c.clone().setY(2), fov: 45 }) }, '太陽軌道'),
      h('button', { class: 'btn', onclick: () => v.flyTo({ pos: c.clone().add(new THREE.Vector3(0.01, R * 4.2, 0.02)), target: c.clone(), fov: 40 }) }, '真上から'),
      h('button', { class: 'btn', onclick: () => v.flyTo({ pos: c.clone().add(new THREE.Vector3(R * 3.5, R * 2.2, R * 4.5)), target: c.clone(), fov: 45 }) }, '広域'),
      ...v.shots().filter((s) => s.kind === 'interior').slice(0, 5).map((s) => h('button', { class: 'btn', onclick: () => v.flyTo(s.view) }, s.title.replace(/内観パース|[（）]/g, ''))),
    );
    const attribution = h('div', { class: 'attribution' });
    ctx.stage.append(views, badge, bar, attribution);
    if (!v.userData.sunViewed) {
      v.userData.sunViewed = true;
      v.applyView({ pos: c.clone().add(new THREE.Vector3(26, 30, 38)), target: c.clone().setY(2), fov: 45 });
    }
    apply(true);

    // ---- サイドパネル ----
    const side = ctx.side;
    side.append(h('h2', null, '日照シミュレーション'), h('p', { class: 'lead' }, '建設地の住所を入れると、航空写真と周辺の建物を読み込み、実際の太陽の動きで日当たりを確認できます。季節・時刻を動かして、部屋ごとの日当たりや日影図も自動で作成します。'));

    // 敷地
    const googleKeyInput = h('input', {
      type: 'password',
      placeholder: 'Google Maps API キー（任意）',
      value: (() => {
        try {
          return localStorage.getItem('googleMapsKey') ?? '';
        } catch {
          return '';
        }
      })(),
      onchange: (e: Event) => {
        try {
          localStorage.setItem('googleMapsKey', (e.target as HTMLInputElement).value.trim());
        } catch {
          // 保存できない環境では入力中だけ使う
        }
      },
    }) as HTMLInputElement;
    const addr = h('input', { type: 'text', placeholder: '例: 愛知県小牧市小牧4-213（番地まで。Google マップの URL や緯度,経度でも可）', value: state.site.address.includes('（仮）') ? '' : state.site.address }) as HTMLInputElement;
    const results = h('div');
    const locEl = h('div', { class: 'hint' });
    const showLoc = () => {
      const { lat, lon } = siteLatLon(state.site);
      locEl.textContent = `${state.site.address}（緯度 ${lat.toFixed(5)}／経度 ${lon.toFixed(5)}）`;
    };
    showLoc();
    const reloadContext = async () => {
      sc.state.site = state.site;
      sc.buildSunPath();
      apply(true);
      if (sc.state.aerialLoaded) await loadAerial();
      if (sc.state.neighbors.some((n) => n.source !== 'manual')) await loadNeighbors('gsi');
    };
    const search = async () => {
      if (!addr.value.trim()) return;
      clear(results);
      results.appendChild(h('p', { class: 'hint' }, '検索中…（番地の照合に数秒かかることがあります）'));
      try {
        const rs = await geocode(addr.value.trim(), { googleKey: googleKeyInput.value.trim() || undefined });
        clear(results);
        if (!rs.length) {
          results.appendChild(h('p', { class: 'hint' }, '見つかりませんでした'));
          return;
        }
        for (const r of rs.slice(0, 6))
          results.appendChild(
            h(
              'button',
              {
                class: 'btn sm block',
                style: 'justify-content:flex-start;margin:3px 0',
                onclick: async () => {
                  state.site = { lat: r.lat, lon: r.lon, address: r.title, offsetE: 0, offsetN: 0 };
                  clear(results);
                  showLoc();
                  if (r.precision === 'town' || r.precision === 'chome')
                    toast('番地までは特定できませんでした。「航空写真の上で敷地をクリック」で建物の位置を合わせてください', 'info', 8000);
                  await reloadContext();
                  if (!sc.state.aerialLoaded) await loadAerial();
                  await loadNeighbors('gsi');
                  // 周辺を読み込んだら、建物と周りが見渡せる広域の視点へ
                  v.flyTo({ pos: c.clone().add(new THREE.Vector3(R * 3.5, R * 2.2, R * 4.5)), target: c.clone(), fov: 45 });
                },
              },
              h('span', null, r.title, ' ', h('span', { class: 'hint', style: 'margin-left:6px' }, PRECISION_LABEL[r.precision])),
            ),
          );
      } catch (e) {
        clear(results);
        toast((e as Error).message, 'error');
      }
    };
    addr.addEventListener('keydown', (e) => e.key === 'Enter' && search());
    const nudge = (de: number, dn: number) => {
      state.site = { ...state.site, offsetE: state.site.offsetE + de, offsetN: state.site.offsetN + dn };
      showLoc();
      reloadContext();
    };
    const rotate = (d: number) => {
      state.model!.northAngleDeg += d;
      emit('model');
      ctx.app.ensureScene();
      sc.buildSunPath();
      sc.buildNeighbors();
      if (sc.state.aerialLoaded) loadAerial();
      apply(true);
    };
    // 航空写真をクリックして、建物を実際の敷地の位置に置く（住所検索は町・丁目の代表点になることが多いため）
    let placing = false;
    const placeBtn = h('button', { class: 'btn sm block', style: 'margin-top:8px' }, '📍 航空写真の上で敷地をクリックして位置を合わせる') as HTMLButtonElement;
    const canvasEl = v.renderer.domElement;
    const onPlace = async (e: PointerEvent) => {
      if (!placing || e.button !== 0) return;
      const r = canvasEl.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const hit = sc.pickAerial(ndc);
      if (!hit) {
        toast('航空写真の上をクリックしてください');
        return;
      }
      e.stopPropagation();
      const d = sc.fromWorld(hit);
      placing = false;
      placeBtn.classList.remove('dark');
      placeBtn.textContent = '📍 航空写真の上で敷地をクリックして位置を合わせる';
      canvasEl.style.cursor = '';
      state.site = { ...state.site, offsetE: state.site.offsetE + d.e, offsetN: state.site.offsetN + d.n };
      showLoc();
      await reloadContext();
      v.flyTo({ pos: c.clone().add(new THREE.Vector3(0.01, R * 4.2, 0.02)), target: c.clone(), fov: 40 });
      toast('建物の位置を合わせました（細かいずれは下の「北へ2m」などで調整できます）', 'ok');
    };
    cleanupPlace?.();
    canvasEl.addEventListener('pointerdown', onPlace, true);
    cleanupPlace = () => {
      canvasEl.removeEventListener('pointerdown', onPlace, true);
      canvasEl.style.cursor = '';
    };
    placeBtn.addEventListener('click', async () => {
      if (!sc.state.aerialLoaded) {
        await loadAerial();
        if (!sc.state.aerialLoaded) return;
      }
      placing = !placing;
      placeBtn.classList.toggle('dark', placing);
      placeBtn.textContent = placing ? '航空写真の上で、建てる敷地をクリックしてください（もう一度押すと中止）' : '📍 航空写真の上で敷地をクリックして位置を合わせる';
      canvasEl.style.cursor = placing ? 'crosshair' : '';
      if (placing) v.flyTo({ pos: c.clone().add(new THREE.Vector3(0.01, 160, 0.02)), target: c.clone(), fov: 45 });
    });
    side.append(
      section(
        '建設地',
        h('div', { style: 'display:flex;gap:6px' }, addr, h('button', { class: 'btn dark', onclick: search }, '検索')),
        results,
        h(
          'details',
          { style: 'margin:6px 0' },
          h('summary', { class: 'hint', style: 'cursor:pointer' }, '番地まで出ないときは Google の住所検索を使う（API キーを設定）'),
          googleKeyInput,
          h('span', { class: 'hint' }, 'Google Cloud で「Geocoding API」を有効にしたキーを貼ると、住居表示の無い地域や新しい番地も特定できます。キーはこのパソコンにだけ保存されます'),
        ),
        locEl,
        placeBtn,
        h('div', { class: 'field-label', style: 'margin-top:8px' }, '位置・向きの微調整（航空写真に合わせてください）'),
        h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn sm', onclick: () => nudge(0, 2) }, '北へ2m'),
          h('button', { class: 'btn sm', onclick: () => nudge(0, -2) }, '南へ2m'),
          h('button', { class: 'btn sm', onclick: () => nudge(2, 0) }, '東へ2m'),
          h('button', { class: 'btn sm', onclick: () => nudge(-2, 0) }, '西へ2m'),
          h('button', { class: 'btn sm', onclick: () => rotate(-2) }, '↺ 2°'),
          h('button', { class: 'btn sm', onclick: () => rotate(2) }, '↻ 2°'),
        ),
      ),
    );

    // 周辺環境
    const loadAerial = async () => {
      try {
        attribution.textContent = await sc.loadAerial('photo');
      } catch {
        toast(
          /localhost|127\.0\.0\.1/.test(location.hostname)
            ? '航空写真を取得できませんでした（インターネット接続を確認してください）'
            : '航空写真を取得できませんでした。公開プレビュー版では外部の地図サーバーへの接続が制限されることがあります。お手元のパソコンで start.bat から起動してお試しください',
          'error',
          8000,
        );
      }
      v.invalidate();
    };
    const loadNeighbors = async (src: 'gsi' | 'osm') => {
      const pm = progressModal('周辺の建物を取得しています', false);
      try {
        const n = await sc.loadNeighbors(src);
        toast(`周辺の建物を ${n} 棟取得しました`, 'ok');
      } catch (e) {
        toast(`周辺建物の取得に失敗しました: ${(e as Error).message}`, 'error');
      } finally {
        pm.close();
      }
    };
    const dirSel = h('select', null, ['北', '北東', '東', '南東', '南', '南西', '西', '北西'].map((d, i) => h('option', { value: i * 45, selected: d === '南' }, d))) as HTMLSelectElement;
    const distIn = h('input', { type: 'number', value: 9, min: 2, max: 60 }) as HTMLInputElement;
    const hIn = h('input', { type: 'number', value: 7, min: 2, max: 60 }) as HTMLInputElement;
    const toggles = h(
      'div',
      null,
      ...(['showAerial', 'showNeighbors', 'showSunPath'] as const).map((k) =>
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: sc.state[k],
            onchange: (e: Event) => {
              sc.state[k] = (e.target as HTMLInputElement).checked;
              sc.applyVisibility();
              apply(true);
            },
          }),
          { showAerial: '航空写真', showNeighbors: '周辺の建物', showSunPath: '太陽の通り道（冬至・春秋分・夏至）' }[k],
        ),
      ),
    );
    side.append(
      section(
        '周辺環境',
        h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn sm', onclick: loadAerial }, '🛰 航空写真を表示'),
          h('button', { class: 'btn sm', onclick: () => loadNeighbors('gsi') }, '🏘 周辺建物（国土地理院）'),
          h('button', { class: 'btn sm', onclick: () => loadNeighbors('osm') }, '🏘 周辺建物（OSM）'),
        ),
        toggles,
        h('div', { class: 'field-label', style: 'margin-top:8px' }, '隣家を手動で追加'),
        h('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px' }, field('方向', dirSel), field('距離 m', distIn), field('高さ m', hIn)),
        h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn sm', onclick: () => { sc.addManualNeighbor(+dirSel.value, +distIn.value, 8, 8, +hIn.value); apply(true); } }, '＋ 隣家を追加'),
          h('button', { class: 'btn sm ghost', onclick: () => { sc.clearNeighbors(); apply(true); } }, '周辺建物をすべて消す'),
        ),
        h('p', { class: 'hint' }, '周辺建物の高さは、国土地理院データでは建物の種類から推定（普通建物 約7m）しています。実際の高さが分かる場合は手動で追加してください。'),
      ),
    );

    // 解析
    const out = h('div');
    const renderResults = () => {
      clear(out);
      for (const hl of state.sun.highlights) out.appendChild(h('div', { class: `highlight ${hl.tone}` }, h('b', null, hl.title), hl.body));
      if (state.sun.seasons.length) {
        const sel = h('select', null, state.sun.seasons.map((s, i) => h('option', { value: i }, `${s.label}（${s.dateLabel}）`))) as HTMLSelectElement;
        const chart = h('div', { html: sunTimelineSvg(state.sun.seasons[0]) });
        sel.addEventListener('change', () => (chart.innerHTML = sunTimelineSvg(state.sun.seasons[+sel.value])));
        out.append(field('部屋ごとの日当たり（オレンジが濃いほど床の広い範囲に日が当たる）', sel), chart);
      }
    };
    const runRooms = async () => {
      const pm = progressModal('部屋ごとの日当たりを解析しています');
      try {
        const seasons: SeasonResult[] = [];
        const dates = keyDates(ui.year).filter((d) => d.id !== 'autumn');
        for (let i = 0; i < dates.length; i++) {
          const d = dates[i];
          const day = { ...sunDay(), month: d.month, day: d.day };
          const rooms = await analyzeRooms(v, day, { onProgress: (r) => pm.set((i + r) / dates.length, `${d.label}の解析中…`) });
          if (pm.signal.aborted) break;
          seasons.push({ id: d.id as SeasonResult['id'], label: d.label, dateLabel: `${d.month}月${d.day}日`, rooms });
        }
        const order = ['winter', 'spring', 'summer'];
        seasons.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        state.sun.seasons = seasons;
        state.sun.highlights = sunHighlights(seasons);
        renderResults();
        toast('日当たりの解析が完了しました', 'ok');
      } catch (e) {
        console.error(e);
        toast('解析に失敗しました', 'error');
      } finally {
        pm.close();
      }
    };
    const runHeat = async () => {
      if (heat) {
        v.groups.overlay.remove(heat);
        heat = null;
        v.invalidate();
        heatLegend.style.display = 'none';
        return;
      }
      const pm = progressModal(`${ui.month}月${ui.day}日の日照時間マップを計算しています`);
      try {
        const d = sunDay();
        const rs = sunriseSunset(ui.year, ui.month, ui.day, d.lat, d.lon);
        const g = await groundSunHours(v, d, { onProgress: (r) => pm.set(r) });
        const max = Math.max(1, rs.sunset - rs.sunrise);
        const b = v.state!.meta.bbox;
        heat = heatmapMesh(g, max, 0.08, (x, z) => !(x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z));
        v.groups.overlay.add(heat);
        heatLegend.style.display = 'flex';
        heatMax.textContent = `${max.toFixed(1)}時間`;
        v.invalidate();
        toast('日照時間マップを作成しました', 'ok');
      } catch (e) {
        if ((e as Error).name !== 'AbortError') toast(`日照時間マップの作成に失敗しました: ${(e as Error).message}`, 'error');
      } finally {
        pm.close();
      }
    };
    const heatMax = h('span');
    const heatLegend = h('div', { class: 'legend', style: 'display:none;margin:6px 0' }, h('span', null, '0時間'), h('div', { class: 'grad' }), heatMax);
    const runDiagram = async (height: number) => {
      const pm = progressModal(`日影図（測定面 GL+${height}m）を作成しています`);
      try {
        const d = sunDay();
        const res = await shadowDiagram(v, { lat: d.lat, lon: d.lon, northAngleDeg: d.northAngleDeg, year: ui.year }, height, (r) => pm.set(r));
        state.sun.diagramSvg = res.svg;
        pm.close();
        const body = h('div', null, h('div', { html: res.svg }), h('p', { class: 'hint' }, res.summary.map((s) => `${s.hour}時間日影: 敷地境界から最大 約${s.maxDist.toFixed(1)}m`).join('／')));
        modal('日影図', body, [
          { label: 'SVG で保存', onClick: () => download(svgToDataUrl(res.svg), `${state.name}_日影図.svg`) },
          { label: 'PNG で保存', onClick: async () => download(await svgToPng(res.svg, 2400), `${state.name}_日影図.png`) },
          { label: '閉じる', primary: true },
        ], true);
      } catch (e) {
        pm.close();
        toast(`日影図の作成に失敗しました: ${(e as Error).message}`, 'error');
      }
    };
    const captureSeasons = async () => {
      const pm = progressModal('季節ごとの日当たりを撮影しています');
      const prev = { ...ui };
      try {
        const shots: { label: string; m: number; d: number; hour: number }[] = [
          { label: '冬至 10:00', m: 12, d: 22, hour: 10 },
          { label: '冬至 12:00', m: 12, d: 22, hour: 12 },
          { label: '冬至 14:00', m: 12, d: 22, hour: 14 },
          { label: '夏至 12:00', m: 6, d: 21, hour: 12 },
        ];
        state.sun.images = [];
        for (let i = 0; i < shots.length; i++) {
          const s = shots[i];
          ui.month = s.m;
          ui.day = s.d;
          ui.hour = s.hour;
          apply(true);
          pm.set(i / shots.length, s.label);
          const url = await v.capture(1600, 900);
          state.sun.images.push({ label: s.label, url });
        }
        toast('日当たりの比較画像を保存しました（プレゼン資料に入ります）', 'ok');
      } finally {
        Object.assign(ui, prev);
        apply(true);
        renderChips();
        pm.close();
      }
    };
    side.append(
      section(
        '日当たりの解析',
        h('button', { class: 'btn primary block', onclick: runRooms }, '☀ 部屋ごとの日当たりを解析（冬至・春分・夏至）'),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: runHeat }, '🌡 日照時間マップ（表示中の日付）'), h('button', { class: 'btn sm', onclick: () => runDiagram(1.5) }, '📐 日影図（GL+1.5m）'), h('button', { class: 'btn sm', onclick: () => runDiagram(4) }, '日影図（GL+4m）')),
        heatLegend,
        h('button', { class: 'btn sm block', onclick: captureSeasons }, '📷 季節の日当たり比較を撮影（プレゼン用）'),
        out,
      ),
    );
    renderResults();
    // 影の網羅
    void clearGroup;
  },
};
