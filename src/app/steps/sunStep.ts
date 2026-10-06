import * as THREE from 'three';
import { h, clear, toast, progressModal, section, field, modal, download, svgToDataUrl, svgToPng } from '../dom';
import { state, emit, type ProjectState } from '../state';
import type { Step, StepCtx } from '../app';
import { SunContext } from '../../sun/context';
import { geocode, siteLatLon, PRECISION_LABEL, parseDegrees, parseLatLonFields, formatDeg, formatDms } from '../../sun/geo';
import { sunPosition, sunDirectionWorld, localDate, sunriseSunset, formatHM, keyDates } from '../../sun/solar';
import { analyzeRooms, groundSunHours, heatmapMesh, shadowDiagram, type SunDay } from '../../sun/analysis';
import { sunHighlights, sunTimelineSvg, type SeasonResult } from '../../sun/report';
import { clearGroup } from '../../scene/viewer';
import { normDeg180 } from '../../sun/align';
import { externalController, externalSampleY } from '../externalBuilding';
import { createExternalPanel, twoPointBlock, isClick, type ExternalPanel } from './sunExternal';
import { pointInPolygon } from '../../core/geometry';

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
let extPanel: ExternalPanel | null = null;

/** 建設地の位置・向きを変えたときに、待ち受け中の 2 点合わせを中止する案内（指した角の座標はワールドなので古くなる） */
const TWO_POINT_ABORT_SITE = '位置・向きを変えたので 2 点合わせを中止しました';
/** 撮影済みの季節比較画像も捨てたときの案内 */
export const IMAGES_CLEARED_MSG = '位置・向き・建物・周辺が変わったので、撮影済みの季節の日当たり比較画像も消しました（プレゼン資料に使うなら撮り直してください）';

/**
 * 建物に依存する解析結果（部屋の日当たり・日影図・撮影済みの季節比較画像）を捨てた state.sun。
 * 画像はその時点の建物・影・航空写真の写りなので、位置・向き・3DS・周辺建物が変わると数字と写真が別の建物になる。
 * hadImages: 画像を消した（案内を出す）
 */
export function clearedSunResults(sun: ProjectState['sun']): { sun: ProjectState['sun']; hadImages: boolean } {
  return { sun: { ...sun, seasons: [], highlights: [], diagramSvg: undefined, images: [] }, hadImages: sun.images.length > 0 };
}

/** 座標で指定した建設地の住所文字列（住所検索の緯度経度貼り付け parsePoint の題名と同じ形に「付近」を添える） */
export function coordAddress(lat: number, lon: number): string {
  return `緯度 ${formatDeg(lat)}／経度 ${formatDeg(lon)} 付近`;
}
/** coordAddress で作った住所か（住所欄の初期値には出さない） */
export function isCoordAddress(address: string): boolean {
  return /^緯度 -?\d+(\.\d+)?／経度 -?\d+(\.\d+)?( 付近)?$/.test(address);
}
/** 「コピー」で書き出す "緯度, 経度"（10 進 5 桁。住所欄にそのまま貼り付けても読める形） */
export function coordClipText(lat: number, lon: number): string {
  return `${formatDeg(lat)}, ${formatDeg(lon)}`;
}
/** 読み取れなかったときの案内 */
export const COORD_PARSE_ERROR = '緯度・経度を読み取れませんでした。10 進（35.21058）か度分秒（35°12′38.1″）で、日本国内の座標を入力してください';
export const COORD_SWAPPED_MSG = '緯度と経度が逆だったので入れ替えました';

/**
 * 緯度・経度の 2 つの欄を読む（経度が空なら緯度欄の 1 行 "緯度, 経度"／Google マップの URL も受ける）。
 * swapped: 欄の生の値と比べて、緯度と経度を取り違えていたので入れ替えた
 */
export function readCoordInput(latText: string, lonText: string): { lat: number; lon: number; swapped: boolean } | null {
  const r = parseLatLonFields(latText, lonText);
  if (!r) return null;
  // 入れ替えの検出: 緯度欄の生の値（1 行入力ならカンマの前半）が、結果の経度のほうに一致していれば逆だった
  let a = latText;
  if (!lonText.normalize('NFKC').trim()) {
    const m = latText.split(/[,，]/);
    if (m.length === 2) a = m[0];
  }
  const rawLat = parseDegrees(a);
  const swapped = rawLat != null && Math.abs(rawLat - r.lat) > 1e-9 && Math.abs(rawLat - r.lon) < 1e-9;
  return { lat: r.lat, lon: r.lon, swapped };
}

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
    // 3DS の表示・PDF の建物の非表示は日照ステップの間だけ（他のステップは PDF の建物のまま）
    extPanel?.dispose();
    extPanel = null;
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
    const addr = h('input', { type: 'text', placeholder: '例: 愛知県小牧市小牧4-213（番地まで。Google マップの URL や緯度,経度でも可）', value: state.site.address.includes('（仮）') || isCoordAddress(state.site.address) ? '' : state.site.address }) as HTMLInputElement;
    const results = h('div');
    const locEl = h('div', { class: 'hint' });
    // 座標で指定（緯度・経度）: 欄は入力中でなければ今のピンの位置（基準点 + ずらし量）を 10 進で表示し、下に度分秒とコピー
    const latIn = h('input', { type: 'text', placeholder: '35.21058 または 35°12′38.1″', autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
    const lonIn = h('input', { type: 'text', placeholder: '136.93831', autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
    const dmsEl = h('span', { class: 'hint', style: 'margin-top:0' });
    const showCoords = (force = false) => {
      const { lat, lon } = siteLatLon(state.site);
      const focused = document.activeElement;
      if (force || (focused !== latIn && focused !== lonIn)) {
        latIn.value = formatDeg(lat);
        lonIn.value = formatDeg(lon);
      }
      dmsEl.textContent = `度分秒: ${formatDms(lat, 'lat')} ${formatDms(lon, 'lon')}`;
    };
    const showLoc = () => {
      const { lat, lon } = siteLatLon(state.site);
      locEl.textContent = `${state.site.address}（緯度 ${lat.toFixed(5)}／経度 ${lon.toFixed(5)}）`;
      showCoords();
    };
    showLoc();
    const reloadContext = async () => {
      sc.state.site = state.site;
      sc.buildSunPath();
      apply(true);
      if (sc.state.aerialLoaded) await loadAerial();
      if (sc.state.neighbors.some((n) => n.source !== 'manual')) await loadNeighbors('gsi');
    };
    // 建物に依存する解析結果（部屋の日当たり・日影図・日照時間マップ・撮影済みの季節比較画像）を捨てる。
    // 位置・方位・3DS・周辺建物が変わった後に古い結果（プレゼン資料にも使われる state.sun）が残らないようにする。実体は解析セクションの後で入れる
    let invalidateResults: () => void = () => {};
    // 建設地を新しい地点にする（住所検索の結果・座標の直接指定で共通）: 待ち受け中の 2 点合わせを中止し、前の地点の解析結果を捨て、
    // 航空写真・周辺建物を読み込んで、建物と周りが見渡せる広域の視点へ
    const setSite = async (lat: number, lon: number, address: string) => {
      extPanel?.cancelTwoPoint(TWO_POINT_ABORT_SITE);
      state.site = { lat, lon, address, offsetE: 0, offsetN: 0 };
      clear(results);
      showLoc();
      invalidateResults();
      await reloadContext();
      if (!sc.state.aerialLoaded) await loadAerial();
      await loadNeighbors('gsi');
      v.flyTo({ pos: c.clone().add(new THREE.Vector3(R * 3.5, R * 2.2, R * 4.5)), target: c.clone(), fov: 45 });
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
                  if (r.precision === 'town' || r.precision === 'chome')
                    toast('番地までは特定できませんでした。「航空写真の上で敷地をクリック」で建物の位置を合わせてください', 'info', 8000);
                  await setSite(r.lat, r.lon, r.title);
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
    // 座標で指定: 2 つの欄（または緯度欄だけに "緯度, 経度" の 1 行／Google マップの URL）を読んで、その地点を建設地にする
    const applyCoords = async () => {
      const r = readCoordInput(latIn.value, lonIn.value);
      if (!r) {
        toast(COORD_PARSE_ERROR, 'error', 8000);
        return;
      }
      if (r.swapped) toast(COORD_SWAPPED_MSG, 'info');
      await setSite(r.lat, r.lon, coordAddress(r.lat, r.lon));
      showCoords(true);
    };
    const onCoordKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      void applyCoords();
    };
    latIn.addEventListener('keydown', onCoordKey);
    lonIn.addEventListener('keydown', onCoordKey);
    const copyCoords = async () => {
      const { lat, lon } = siteLatLon(state.site);
      const text = coordClipText(lat, lon);
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(text);
        toast('座標をコピーしました', 'ok');
      } catch {
        toast(`コピーできませんでした。座標: ${text}`, 'info', 8000);
      }
    };
    const coordBlock = h(
      'details',
      { style: 'margin:6px 0' },
      h('summary', { class: 'hint', style: 'cursor:pointer' }, '座標で指定（緯度・経度）'),
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:6px' }, field('緯度', latIn), field('経度', lonIn)),
      h('button', { class: 'btn sm block', onclick: applyCoords }, 'この座標を建設地にする'),
      h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px' }, dmsEl, h('button', { class: 'btn sm ghost', onclick: copyCoords, title: '今の建設地の座標を「緯度, 経度」の形でコピーします' }, 'コピー')),
      h('span', { class: 'hint' }, '10 進（35.21058）でも度分秒（35°12′38.1″・35度12分38.1秒）でも入力できます。緯度欄に「緯度, 経度」の 1 行や Google マップの URL を貼り付けても読み取ります。欄には今の建設地（ピンの位置）の座標が表示されます'),
    );
    const nudge = (de: number, dn: number) => {
      extPanel?.cancelTwoPoint(TWO_POINT_ABORT_SITE);
      state.site = { ...state.site, offsetE: state.site.offsetE + de, offsetN: state.site.offsetN + dn };
      showLoc();
      invalidateResults();
      reloadContext();
    };
    const rotate = (d: number) => {
      extPanel?.cancelTwoPoint(TWO_POINT_ABORT_SITE);
      state.model!.northAngleDeg = normDeg180(state.model!.northAngleDeg + d);
      emit('model');
      ctx.app.ensureScene();
      // PDF の建物を作り直したので、3DS（external）を再同期（影の範囲・隠す設定）
      extPanel?.afterModelRebuilt();
      sc.buildSunPath();
      sc.buildNeighbors();
      if (sc.state.aerialLoaded) loadAerial();
      invalidateResults();
      apply(true);
    };
    // 航空写真をクリックして、建物を実際の敷地の位置に置く（住所検索は町・丁目の代表点になることが多いため）
    let placing = false;
    const placeBtn = h('button', { class: 'btn sm block', style: 'margin-top:8px' }, '📍 航空写真の上で敷地をクリックして位置を合わせる') as HTMLButtonElement;
    const canvasEl = v.renderer.domElement;
    const setPlacing = (on: boolean) => {
      placing = on;
      placeBtn.classList.toggle('dark', on);
      placeBtn.textContent = on ? '航空写真の上で、建てる敷地をクリックしてください（もう一度押すと中止・Esc でも中止）' : '📍 航空写真の上で敷地をクリックして位置を合わせる';
      canvasEl.style.cursor = on ? 'crosshair' : '';
    };
    // 2 点合わせと同じく、押した所から動かさずに離したときだけ置く（ドラッグで視点を動かしても置かない）。イベントは止めずに OrbitControls にも渡す
    let placeDown: { x: number; y: number } | null = null;
    const onPlaceDown = (e: PointerEvent) => {
      if (!placing || e.button !== 0) return;
      placeDown = { x: e.clientX, y: e.clientY };
    };
    const onPlaceUp = async (e: PointerEvent) => {
      if (!placing || e.button !== 0 || !placeDown) return;
      const down = placeDown;
      placeDown = null;
      if (!isClick(down, { x: e.clientX, y: e.clientY })) return;
      const r = canvasEl.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const hit = sc.pickAerial(ndc);
      if (!hit) {
        toast('航空写真の上をクリックしてください');
        return;
      }
      // stopPropagation はしない: pointerup を止めると OrbitControls（document で pointerup を待つ）がドラッグ状態のまま残り、
      // ボタンを離した後のマウス移動だけで視点が回ってしまう。クリックの判定は isClick で済んでいる
      const d = sc.fromWorld(hit);
      setPlacing(false);
      extPanel?.cancelTwoPoint(TWO_POINT_ABORT_SITE);
      state.site = { ...state.site, offsetE: state.site.offsetE + d.e, offsetN: state.site.offsetN + d.n };
      showLoc();
      invalidateResults();
      await reloadContext();
      v.flyTo({ pos: c.clone().add(new THREE.Vector3(0.01, R * 4.2, 0.02)), target: c.clone(), fov: 40 });
      toast('建物の位置を合わせました（細かいずれは下の「北へ2m」などで調整できます）', 'ok');
    };
    cleanupPlace?.();
    canvasEl.addEventListener('pointerdown', onPlaceDown, true);
    canvasEl.addEventListener('pointerup', onPlaceUp, true);
    cleanupPlace = () => {
      canvasEl.removeEventListener('pointerdown', onPlaceDown, true);
      canvasEl.removeEventListener('pointerup', onPlaceUp, true);
      canvasEl.style.cursor = '';
    };
    const ensureAerial = async () => {
      if (!sc.state.aerialLoaded) await loadAerial();
      return sc.state.aerialLoaded;
    };
    placeBtn.addEventListener('click', async () => {
      if (!(await ensureAerial())) return;
      // 2 点合わせと同時に有効にしない（1 クリックが両方に効いてしまう）
      extPanel?.cancelTwoPoint();
      setPlacing(!placing);
      if (placing) v.flyTo({ pos: c.clone().add(new THREE.Vector3(0.01, 160, 0.02)), target: c.clone(), fov: 45 });
    });
    // 設計の 3D データ（3DS）で正確な建物にするパネルと 2 点合わせ。
    // setCutaway / setDesign / ensureScene の後に作る（PDF の建物を隠す設定がそれらで戻されないように）
    extPanel?.dispose();
    extPanel = createExternalPanel({
      ctx,
      sc,
      center: c,
      R,
      reloadContext,
      applySun: () => apply(true),
      invalidateResults: () => invalidateResults(),
      showLoc,
      cancelPlacing: () => setPlacing(false),
      ensureAerial,
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
        coordBlock,
        locEl,
        placeBtn,
        ...twoPointBlock(extPanel),
        h('div', { class: 'field-label', style: 'margin-top:8px' }, '位置・向きの微調整（建物は図面のまま。航空写真と方位のほうを動かして合わせます）'),
        h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn sm', title: '建物を実際の敷地で北へ 2 m 動かします（画面では航空写真が南へずれます）', onclick: () => nudge(0, 2) }, '北へ2m'),
          h('button', { class: 'btn sm', title: '建物を実際の敷地で南へ 2 m 動かします（画面では航空写真が北へずれます）', onclick: () => nudge(0, -2) }, '南へ2m'),
          h('button', { class: 'btn sm', title: '建物を実際の敷地で東へ 2 m 動かします（画面では航空写真が西へずれます）', onclick: () => nudge(2, 0) }, '東へ2m'),
          h('button', { class: 'btn sm', title: '建物を実際の敷地で西へ 2 m 動かします（画面では航空写真が東へずれます）', onclick: () => nudge(-2, 0) }, '西へ2m'),
          // 向き: 回るのは航空写真・方位（太陽の通り道・周辺建物）。建物は図面のまま動かないので、写真に対しては建物が逆向きに回って見える
          h('button', { class: 'btn sm', title: '航空写真と方位（太陽の通り道・周辺建物）を上から見て反時計回りに 2° 回します。建物は図面のまま動かないので、写真に対して建物は時計回りに回って見えます', onclick: () => rotate(-2) }, '↺ 2°'),
          h('button', { class: 'btn sm', title: '航空写真と方位（太陽の通り道・周辺建物）を上から見て時計回りに 2° 回します。建物は図面のまま動かないので、写真に対して建物は反時計回りに回って見えます', onclick: () => rotate(2) }, '↻ 2°'),
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
        // 周辺建物は影を落とす（部屋の日当たり・日影図・日照時間マップに入る）ので、前の結果は捨てる
        invalidateResults();
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
          h('button', { class: 'btn sm', onclick: () => { sc.addManualNeighbor(+dirSel.value, +distIn.value, 8, 8, +hIn.value); invalidateResults(); apply(true); } }, '＋ 隣家を追加'),
          h('button', { class: 'btn sm ghost', onclick: () => { sc.clearNeighbors(); invalidateResults(); apply(true); } }, '周辺建物をすべて消す'),
        ),
        h('p', { class: 'hint' }, '周辺建物の高さは、国土地理院データでは建物の種類から推定（普通建物 約7m）しています。実際の高さが分かる場合は手動で追加してください。'),
      ),
    );
    // 3DS のパネルは 建設地 の直後に置く
    const siteSection = side.querySelector('section.panel-section');
    if (siteSection) siteSection.after(extPanel.section);
    else side.appendChild(extPanel.section);

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
      // 3DS で置き換え中: 測定点は 3DS 自身の床の上から（PDF の床高と違う 3DS でも床下から測らない）
      const sy = externalSampleY(v);
      try {
        const seasons: SeasonResult[] = [];
        const dates = keyDates(ui.year).filter((d) => d.id !== 'autumn');
        for (let i = 0; i < dates.length; i++) {
          const d = dates[i];
          const day = { ...sunDay(), month: d.month, day: d.day };
          const rooms = await analyzeRooms(v, day, { onProgress: (r) => pm.set((i + r) / dates.length, `${d.label}の解析中…`), sampleY: sy?.fn });
          if (pm.signal.aborted) break;
          seasons.push({ id: d.id as SeasonResult['id'], label: d.label, dateLabel: `${d.month}月${d.day}日`, rooms });
        }
        const order = ['winter', 'spring', 'summer'];
        seasons.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        state.sun.seasons = seasons;
        state.sun.highlights = sunHighlights(seasons);
        renderResults();
        toast('日当たりの解析が完了しました', 'ok');
        if (sy && seasons.length && seasons.every((s) => s.rooms.every((r) => r.hours <= 0)))
          toast('3DS の壁に窓の開口が無いと室内に日が入りません。PDF の建物で部屋の日当たりを解析するには「3DS で影を計算する」を外してください', 'info', 8000);
      } catch (e) {
        console.error(e);
        toast('解析に失敗しました', 'error');
      } finally {
        sy?.dispose();
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
        // 3DS で置き換え中は、その外形（壁）の中を抜き、3DS の中心で格子を切る
        const ext = externalController();
        const useExt = !!ext && ext.ext.replaces;
        const extBox = useExt ? ext!.worldBox() : null;
        const extPoly = useExt ? ext!.outlineWorld().map((p) => ({ x: p.x, y: p.y })) : null;
        const center = extBox ? extBox.getCenter(new THREE.Vector3()) : undefined;
        const g = await groundSunHours(v, d, { onProgress: (r) => pm.set(r), center: center ? { x: center.x, z: center.z } : undefined });
        const max = Math.max(1, rs.sunset - rs.sunrise);
        const b = v.state!.meta.bbox;
        const mask = extPoly && extPoly.length >= 3 ? (x: number, z: number) => !pointInPolygon({ x, y: z }, extPoly) : (x: number, z: number) => !(x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z);
        heat = heatmapMesh(g, max, 0.08, mask);
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
        // 3DS で置き換え中は、その外形（壁）と中心・高さで図を作る
        const ext = externalController();
        const over = ext && ext.ext.replaces ? (() => {
          const poly = ext.outlineWorld();
          const box = ext.worldBox();
          const cc = box.getCenter(new THREE.Vector3());
          const pts = poly.map((p) => ({ x: p.x, y: p.y }));
          return { outlines: [poly], insideBuilding: (x: number, z: number) => pointInPolygon({ x, y: z }, pts), center: new THREE.Vector2(cc.x, cc.z), buildingTop: box.max.y };
        })() : {};
        const res = await shadowDiagram(v, { lat: d.lat, lon: d.lon, northAngleDeg: d.northAngleDeg, year: ui.year }, height, (r) => pm.set(r), over);
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
    invalidateResults = () => {
      const { sun, hadImages } = clearedSunResults(state.sun);
      state.sun = sun;
      if (hadImages) toast(IMAGES_CLEARED_MSG, 'info', 7000);
      if (heat) {
        v.groups.overlay.remove(heat);
        heat = null;
        heatLegend.style.display = 'none';
        v.invalidate();
      }
      renderResults();
    };
    // 影の網羅
    void clearGroup;
  },
};
