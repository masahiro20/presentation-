import * as THREE from 'three';
import { h, clear, toast, progressModal, section, field, modal, download, svgToDataUrl, svgToPng } from '../dom';
import { state, emit, type ProjectState } from '../state';
import type { Step, StepCtx } from '../app';
import { SunContext, keysInRect, ringArea, HIDE_MODES, HIDE_MODE_NAME, HIDE_MODE_SHORT, HIDE_REASONS, HIDE_REASON_LABEL, hideReasonText, type HideMode, type HideReason, type HideRecord } from '../../sun/context';
import { geocode, siteLatLon, PRECISION_LABEL, parseDegrees, parseLatLonFields, formatDeg, formatDms } from '../../sun/geo';
import { sunPosition, sunDirectionWorld, localDate, sunriseSunset, formatHM, keyDates } from '../../sun/solar';
import { analyzeRooms, groundSunHours, heatmapMesh, shadowDiagram, SHADOW_REGULATION_PRESETS, SHADOW_REGION_HOURS, shadowRegulationPreset, type ShadowDiagramOptions, type ShadowDiagramSummary, type SunDay } from '../../sun/analysis';
import { sunHighlights, sunTimelineSvg, type SeasonResult } from '../../sun/report';
import { clearGroup } from '../../scene/viewer';
import { normDeg180 } from '../../sun/align';
import { externalController, externalSampleY } from '../externalBuilding';
import { createExternalPanel, twoPointBlock, isClick, type ExternalPanel } from './sunExternal';
import { pointInPolygon } from '../../core/geometry';
import { NEIGHBOR_SOURCE_LABEL, appendSvgFootnote, collectDisclosure, disclosureLines, neighborTitle, neighborWhere, type SunDisclosure } from '../sunDisclosure';

export { NEIGHBOR_SOURCE_LABEL, neighborTitle, neighborWhere };

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
/** 日影図の描き方の選択（ステップを出入りしても覚える） */
const diagramChoice = { regulationId: '', halfHour: false };

/** 最後に使った日照ステップの周辺環境（プレゼン資料の注記用。日照ステップを開いていなければ null） */
let activeSc: SunContext | null = null;
export function activeSunContext(): SunContext | null {
  return activeSc;
}

function getCtx(ctx: StepCtx): SunContext {
  const v = ctx.app.viewer;
  let sc = v.userData.sunCtx as SunContext | undefined;
  if (!sc) {
    sc = new SunContext(v, state.site);
    v.userData.sunCtx = sc;
  }
  sc.state.site = state.site;
  activeSc = sc;
  return sc;
}

function sunDay(): SunDay {
  const { lat, lon } = siteLatLon(state.site);
  return { year: ui.year, month: ui.month, day: ui.day, lat, lon, northAngleDeg: state.model!.northAngleDeg };
}

let cleanupPlace: (() => void) | null = null;
/** 周辺建物のクリック（案内・選んで隠す）の後始末 */
let cleanupNeighborUI: (() => void) | null = null;
let extPanel: ExternalPanel | null = null;

// ---------------------------------------------------------------- 周辺建物を選んで隠す／戻す（文言・表示の純粋な部分）

export const HIDE_MODE_LABEL = '🏠 建物を選んで隠す';
export const HIDE_MODE_ARMED = '建物をクリックして選んでください（Shift+ドラッグで範囲選択。もう一度押すと終了・Esc でも終了）';
export const HIDE_MODE_GUIDE = '建物をクリックすると選択（もう一度で解除）、Shift を押しながらドラッグすると範囲で選べます。隠し方（計算から除外／表示だけ隠す）と理由を選んで、画面上の「隠す」を押してください。薄く見えているのは隠した建物（青は表示だけ隠した建物）で、選んで「戻す」で戻せます';
export const NO_NEIGHBORS_MSG = '周辺の建物がありません。先に「🏘 周辺建物（国土地理院）」で読み込んでください';
/** 隠し方の説明（選択肢のツールチップ・一覧の見出し） */
export const HIDE_MODE_HINT: Readonly<Record<HideMode, string>> = {
  exclude: '画面に出さず、影も落とさず、部屋の日当たり・日照時間マップにも入れません（解体予定の既存建物・もう無い建物など）',
  view: '画面には出しませんが、影は落とし、部屋の日当たり・日照時間マップにも入れます（プレゼンで視点を遮る建物など）',
};
/** 理由の選択肢の名前（その他は自由記述の欄が出る） */
export function hideReasonOption(r: HideReason): string {
  return r === 'other' ? 'その他（自由記述）' : HIDE_REASON_LABEL[r];
}

/** 隠した後の案内（隠し方ごと） */
export function hiddenToastText(n: number, mode: HideMode = 'exclude'): string {
  return mode === 'view'
    ? `${n} 棟を表示だけ隠しました（影・解析には残しています。「隠した建物」から戻せます）`
    : `${n} 棟を隠しました（影・解析からも外しています。「隠した建物」から戻せます）`;
}
/** 隠し方を変えた後の案内 */
export function modeChangedToastText(n: number, mode: HideMode): string {
  return mode === 'view' ? `${n} 棟を「表示だけ隠す」にしました（影・解析に戻しています）` : `${n} 棟を「計算から除外」にしました（影・解析から外しています）`;
}
export function restoredToastText(n: number, viewOnly = false): string {
  return viewOnly ? `${n} 棟を戻しました（3D に表示します。影・解析には元から含めています）` : `${n} 棟を戻しました（影・解析にも戻しています）`;
}
/** 「隠した建物」の一覧の見出し */
export function hiddenListTitle(n: number): string {
  return `隠した建物（${n} 棟）`;
}
/** 選択中の数（隠す対象 = 見えている建物、戻す対象 = 隠した建物） */
export function selectionText(visible: number, hidden: number): string {
  const n = visible + hidden;
  return hidden ? `選択 ${n} 棟（うち隠した建物 ${hidden} 棟）` : `選択 ${n} 棟`;
}
/** 「隠した建物」の一覧の隠し方ごとの見出し */
export function hiddenGroupTitle(mode: HideMode, n: number): string {
  return `${HIDE_MODE_SHORT[mode]}（${n} 棟）`;
}

/** 日影図の規制値の選択（'' = なし: 参考の 2〜5 時間） */
export const REGULATION_NONE_LABEL = 'なし（参考の 2〜5 時間）';
export const HALF_HOUR_LABEL = '時刻日影線を 30 分ごと';
/**
 * 日影図の描き方（規制値のプリセット・30 分ごとの時刻日影線）。北海道のプリセットは真太陽時 9〜15 時、ほかは 8〜16 時
 */
export function diagramOptions(regulationId: string, halfHour: boolean): ShadowDiagramOptions {
  const pre = regulationId ? shadowRegulationPreset(regulationId) : undefined;
  const o: ShadowDiagramOptions = { timeLineIntervalMin: halfHour ? 30 : 60 };
  if (pre) {
    o.regulation = pre;
    o.hours = [...pre.hours] as [number, number];
  } else o.hours = [...SHADOW_REGION_HOURS.general] as [number, number];
  return o;
}
/** 日影図の下に出す等時間日影線の集計（規制の線は「5〜10m の規制」「10m 超の規制」と添える） */
export function diagramSummaryText(summary: ShadowDiagramSummary[]): string {
  return summary
    .map((s) => `${s.hour}時間日影${s.role === 'limitNear' ? '（5〜10m の規制）' : s.role === 'limitFar' ? '（10m 超の規制）' : ''}: 敷地境界から最大 約${s.maxDist.toFixed(1)}m`)
    .join('／');
}

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
  return { sun: { ...sun, seasons: [], highlights: [], diagramSvg: undefined, images: [], disclosure: undefined }, hadImages: sun.images.length > 0 };
}

/** 注記の行を DOM の段落にする（日照の結果の下に添える） */
function disclosureBox(d: SunDisclosure, target: 'rooms' | 'heatmap'): HTMLElement {
  return h('div', { class: 'sun-disclosure', 'data-target': target }, ...disclosureLines(d, target).map((t) => h('div', null, t)));
}

/** 隠し方・理由の選択（「建物を選んで隠す」のバーと建物の案内で共通。最後に選んだものを覚える） */
const hideChoice: { mode: HideMode; reason: HideReason; note: string } = { mode: 'exclude', reason: 'other', note: '' };
let hideChoiceSeq = 0;
function hideChoiceRecord(): HideRecord {
  return { mode: hideChoice.mode, reason: hideChoice.reason, note: hideChoice.reason === 'other' ? hideChoice.note.trim() : undefined };
}
/**
 * 隠し方（ラジオ）と理由（選択・その他は自由記述）の欄。選んだ値は hideChoice に書く（バーと案内で共有）。
 * sync: 欄を hideChoice に合わせ直す（案内で選び直した後にバーを出すとき）
 */
function hideChoiceUI(): { el: HTMLElement; sync: () => void } {
  const name = `sunnb-mode-${++hideChoiceSeq}`;
  const radios: HTMLInputElement[] = [];
  const modes = h(
    'div',
    { class: 'sunnb-modes', role: 'radiogroup', 'aria-label': '隠し方' },
    ...HIDE_MODES.map((m) => {
      const r = h('input', { type: 'radio', name, value: m, checked: hideChoice.mode === m }) as HTMLInputElement;
      r.addEventListener('change', () => {
        if (r.checked) hideChoice.mode = m;
      });
      radios.push(r);
      return h('label', { class: `sunnb-radio ${m}`, title: HIDE_MODE_HINT[m] }, r, HIDE_MODE_NAME[m]);
    }),
  );
  const reasonSel = h('select', { class: 'sunnb-reason', title: '隠す理由（日影図・資料の注記に入ります）' }, ...HIDE_REASONS.map((r) => h('option', { value: r, selected: hideChoice.reason === r }, hideReasonOption(r)))) as HTMLSelectElement;
  const noteIn = h('input', { type: 'text', class: 'sunnb-note', placeholder: '理由を入力（例: 車庫の屋根）', value: hideChoice.note, maxlength: 200 }) as HTMLInputElement;
  const syncNote = () => (noteIn.style.display = reasonSel.value === 'other' ? '' : 'none');
  reasonSel.addEventListener('change', () => {
    hideChoice.reason = reasonSel.value as HideReason;
    syncNote();
  });
  noteIn.addEventListener('input', () => (hideChoice.note = noteIn.value));
  // 理由の欄で Esc・Enter を押しても 3D の操作（Esc でモード終了）に渡さない
  noteIn.addEventListener('keydown', (e) => e.stopPropagation());
  const sync = () => {
    for (const r of radios) r.checked = r.value === hideChoice.mode;
    reasonSel.value = hideChoice.reason;
    noteIn.value = hideChoice.note;
    syncNote();
  };
  sync();
  return { el: h('div', { class: 'sunnb-choice' }, modes, h('div', { class: 'sunnb-reason-row' }, h('span', null, '理由'), reasonSel, noteIn)), sync };
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
    cleanupNeighborUI?.();
    cleanupNeighborUI = null;
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
    // 「建物を選んで隠す」を終える・建物の案内を閉じる（実体は周辺環境のセクションで入れる。敷地をクリック・2 点合わせと同時に効かせない）
    let stopNeighborUI: () => void = () => {};
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
      // 住所と並ぶ指定方法なので最初から開いておく（閉じれば畳める）
      { style: 'margin:6px 0', open: true },
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
      // 2 点合わせ・建物を選んで隠すと同時に有効にしない（1 クリックが両方に効いてしまう）
      extPanel?.cancelTwoPoint();
      stopNeighborUI();
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
      cancelPlacing: () => {
        setPlacing(false);
        stopNeighborUI();
      },
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
        const kept = sc.hiddenList().length;
        toast(`周辺の建物を ${n} 棟取得しました${kept ? `（隠した ${kept} 棟は隠したままです）` : ''}`, 'ok');
      } catch (e) {
        toast(`周辺建物の取得に失敗しました: ${(e as Error).message}`, 'error');
      } finally {
        pm.close();
      }
    };
    const dirSel = h('select', null, ['北', '北東', '東', '南東', '南', '南西', '西', '北西'].map((d, i) => h('option', { value: i * 45, selected: d === '南' }, d))) as HTMLSelectElement;
    const distIn = h('input', { type: 'number', value: 9, min: 2, max: 60 }) as HTMLInputElement;
    const hIn = h('input', { type: 'number', value: 7, min: 2, max: 60 }) as HTMLInputElement;
    const toggleInputs: Partial<Record<'showAerial' | 'showNeighbors' | 'showSunPath', HTMLInputElement>> = {};
    const toggles = h(
      'div',
      null,
      ...(['showAerial', 'showNeighbors', 'showSunPath'] as const).map((k) =>
        h(
          'label',
          { class: 'check' },
          (toggleInputs[k] = h('input', {
            type: 'checkbox',
            checked: sc.state[k],
            onchange: (e: Event) => {
              sc.state[k] = (e.target as HTMLInputElement).checked;
              sc.applyVisibility();
              apply(true);
            },
          }) as HTMLInputElement),
          { showAerial: '航空写真', showNeighbors: '周辺の建物', showSunPath: '太陽の通り道（冬至・春秋分・夏至）' }[k],
        ),
      ),
    );

    // ---- 周辺建物を選んで隠す／戻す・クリックで高さを直す ----
    // 隠した建物は実体を作らない（3D に出ない・影を落とさない・部屋の日当たり・日照時間マップに入らない）。
    // 記録はキー（出典 + 重心 + 面積）と外形で残し、周辺建物を取り直しても同じ建物に当て直す（src/sun/context.ts）
    cleanupNeighborUI?.();
    const hideBtn = h('button', { class: 'btn sm block', style: 'margin-top:8px' }, HIDE_MODE_LABEL) as HTMLButtonElement;
    const hiddenBox = h('div');
    const selInfo = h('b');
    const barHide = h('button', { class: 'btn sm primary' }, '隠す') as HTMLButtonElement;
    const barRestore = h('button', { class: 'btn sm' }, '戻す') as HTMLButtonElement;
    const barClear = h('button', { class: 'btn sm ghost' }, '選択を解除') as HTMLButtonElement;
    const barExit = h('button', { class: 'btn sm ghost' }, '終了') as HTMLButtonElement;
    const barChoice = hideChoiceUI();
    const hideBar = h(
      'div',
      { class: 'sunnb-bar', style: 'display:none' },
      h('div', { class: 'sunnb-bar-row' }, selInfo, barHide, barRestore, barClear, barExit),
      // 隠し方・理由は 1 行に（バーが 3D の建物を覆う高さを増やさないように。操作の説明はバーのツールチップと案内のトーストに）
      barChoice.el,
    );
    hideBar.title = 'クリックで選択・Shift+ドラッグで範囲選択・薄い建物は隠した建物（灰色 = 計算から除外、青 = 表示だけ隠す。選んで「戻す」）・Esc で終了';
    const selRect = h('div', { class: 'sunnb-rect', style: 'display:none' });
    ctx.stage.append(hideBar, selRect);
    let hideMode = false;
    const selected = new Set<string>();
    let pop: HTMLElement | null = null;
    let popKey: string | null = null;
    let hiddenOpen = false;
    const syncHighlight = () => sc.setHighlight(popKey ? [...selected, popKey] : selected);
    const afterEdit = () => {
      invalidateResults();
      apply(true);
    };
    const hideKeys = (keys: string[]) => {
      const rec = hideChoiceRecord();
      const n = sc.setHidden(keys, true, rec);
      if (!n) return;
      afterEdit();
      toast(hiddenToastText(n, rec.mode), 'ok', 6000);
    };
    const changeMode = (keys: string[], mode: HideMode) => {
      const n = sc.setHideMode(keys, mode);
      if (!n) return;
      afterEdit();
      toast(modeChangedToastText(n, mode), 'ok');
    };
    const restoreKeys = (keys: string[]) => {
      const viewOnly = keys.length > 0 && keys.every((k) => sc.hideRecord(k)?.mode === 'view');
      const n = sc.setHidden(keys, false);
      if (!n) return;
      afterEdit();
      toast(restoredToastText(n, viewOnly), 'ok');
    };
    const restoreAllHidden = () => {
      const n = sc.restoreAll();
      if (!n) return;
      afterEdit();
      toast(restoredToastText(n), 'ok');
    };
    const renderBar = () => {
      hideBar.style.display = hideMode ? '' : 'none';
      let vis = 0;
      let hid = 0;
      for (const k of selected) {
        const b = sc.findByKey(k);
        if (!b) continue;
        if (b.hidden) hid++;
        else vis++;
      }
      selInfo.textContent = selectionText(vis, hid);
      barHide.disabled = vis === 0;
      barRestore.disabled = hid === 0;
      barClear.disabled = selected.size === 0;
    };
    const renderHiddenList = () => {
      // 作り直す行の上にマウスがあっても mouseleave は来ないので、薄い表示の指し示しはここで外す
      sc.setPreview(null);
      clear(hiddenBox);
      const list = sc.hiddenList();
      if (!list.length) return;
      const row = (b: (typeof list)[number]) => {
        const k = sc.keyOf(b);
        const rec = sc.hideRecord(k);
        const mode = rec?.mode ?? 'exclude';
        const other: HideMode = mode === 'view' ? 'exclude' : 'view';
        return h(
          'div',
          { class: `sunnb-hidden-row ${mode}`, 'data-mode': mode, onmouseenter: () => sc.setPreview(k), onmouseleave: () => sc.setPreview(null) },
          h(
            'div',
            { class: 'sunnb-hidden-name' },
            h('b', null, neighborTitle(b)),
            h('span', { class: 'hint' }, `${neighborWhere(b)}・高さ 約 ${sc.heightOf(b).toFixed(1)} m・${NEIGHBOR_SOURCE_LABEL[b.source]}`),
            h('span', { class: 'hint sunnb-hidden-reason' }, `理由: ${rec ? hideReasonText(rec) : HIDE_REASON_LABEL.other}`),
          ),
          h(
            'div',
            { class: 'sunnb-hidden-acts' },
            h('button', { class: 'btn sm', title: mode === 'view' ? 'この建物を 3D に戻します' : 'この建物を戻します（影・解析にも戻ります）', onclick: () => restoreKeys([k]) }, '戻す'),
            h(
              'button',
              { class: 'btn sm ghost', title: HIDE_MODE_HINT[other], onclick: () => changeMode([k], other) },
              other === 'view' ? '表示だけにする' : '除外にする',
            ),
          ),
        );
      };
      const groups = (['exclude', 'view'] as const)
        .map((m) => ({ m, items: list.filter((b) => (sc.hideRecord(sc.keyOf(b))?.mode ?? 'exclude') === m) }))
        .filter((g) => g.items.length)
        .map((g) =>
          h(
            'div',
            { class: `sunnb-hidden-group ${g.m}`, 'data-mode': g.m },
            h('div', { class: 'sunnb-hidden-head' }, h('b', null, hiddenGroupTitle(g.m, g.items.length)), h('span', { class: 'hint' }, g.m === 'view' ? '影・解析には含めています' : '影・解析から外しています')),
            ...g.items.map(row),
          ),
        );
      const det = h(
        'details',
        { class: 'sunnb-hidden', open: hiddenOpen },
        h('summary', null, hiddenListTitle(list.length)),
        h('div', { class: 'sunnb-hidden-list' }, ...groups),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: restoreAllHidden }, 'すべて戻す')),
        h('span', { class: 'hint' }, '行に重ねると、その建物を 3D に薄く表示します。計算から除外した建物は理由ごとの棟数、表示だけ隠した建物は棟数を、日影図・解析結果・プレゼン資料に注記します'),
      ) as HTMLDetailsElement;
      det.addEventListener('toggle', () => (hiddenOpen = det.open));
      hiddenBox.appendChild(det);
    };
    const closePop = () => {
      if (!pop) return;
      pop.remove();
      pop = null;
      popKey = null;
      syncHighlight();
    };
    /** 建物の案内（出典・高さを直す・隠す）。クリックした所の近くに出す */
    const openPop = (key: string, cx: number, cy: number) => {
      closePop();
      const b = sc.findByKey(key);
      if (!b) return;
      popKey = key;
      syncHighlight();
      const s = ctx.stage.getBoundingClientRect();
      const left = Math.max(8, Math.min(s.width - 330, cx - s.left + 12));
      const top = Math.max(8, Math.min(s.height - 340, cy - s.top + 12));
      const cur = sc.heightOf(b);
      const overridden = sc.edits.heights.has(key);
      const hIn = h('input', { type: 'number', min: 1, max: 300, step: 0.1, value: cur.toFixed(1) }) as HTMLInputElement;
      const applyH = () => {
        const val = Math.round(+hIn.value * 10) / 10;
        if (!(val >= 1 && val <= 300)) {
          toast('高さは 1〜300 m の数字で入力してください', 'error');
          return;
        }
        closePop();
        if (Math.abs(val - cur) < 1e-9) return;
        sc.setHeight(key, Math.abs(val - b.height) < 1e-9 ? null : val);
        afterEdit();
        toast(`高さを ${val.toFixed(1)} m にしました（影・解析にも使います。周辺建物を取り直しても残ります）`, 'ok');
      };
      hIn.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          applyH();
        }
      });
      pop = h(
        'div',
        { class: 'pop sunnb-pop', style: `left:${left}px;top:${top}px` },
        h('div', { class: 'sunnb-pop-head' }, h('h5', null, neighborTitle(b)), h('button', { class: 'icon-btn', title: '閉じる', onclick: closePop }, '×')),
        h('div', { class: 'hint' }, `出典: ${NEIGHBOR_SOURCE_LABEL[b.source]}${b.source === 'gsi' ? '（高さは建物の種類からの推定）' : ''}`),
        h('div', { class: 'hint' }, `${neighborWhere(b)}・建築面積 約 ${Math.round(ringArea(b.ring))} m²`),
        h('div', { class: 'row' }, h('span', null, '高さ (m)'), hIn, h('button', { class: 'btn sm dark', onclick: applyH }, '適用')),
        overridden
          ? h(
              'div',
              { class: 'row' },
              h('span', { class: 'hint' }, `元のデータ ${b.height.toFixed(1)} m`),
              h(
                'button',
                {
                  class: 'btn sm ghost',
                  onclick: () => {
                    closePop();
                    sc.setHeight(key, null);
                    afterEdit();
                    toast(`高さを元のデータ（${b.height.toFixed(1)} m）に戻しました`, 'ok');
                  },
                },
                '元に戻す',
              ),
            )
          : null,
        hideChoiceUI().el,
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn sm',
              title: '選んだ隠し方で隠します（計算から除外: 影・解析からも外す／表示だけ隠す: 影・解析には残す）',
              onclick: () => {
                closePop();
                hideKeys([key]);
              },
            },
            'この建物を隠す',
          ),
        ),
      );
      ctx.stage.appendChild(pop);
    };
    const setHideMode = (on: boolean) => {
      if (on === hideMode) return;
      if (on) {
        if (!sc.state.neighbors.length) {
          toast(NO_NEIGHBORS_MSG, 'info', 8000);
          return;
        }
        // 敷地をクリック・2 点合わせと同時に有効にしない（1 クリックが両方に効いてしまう）
        setPlacing(false);
        extPanel?.cancelTwoPoint();
        closePop();
        if (!sc.state.showNeighbors) {
          sc.state.showNeighbors = true;
          if (toggleInputs.showNeighbors) toggleInputs.showNeighbors.checked = true;
          sc.applyVisibility();
        }
        hideMode = true;
        selected.clear();
        // 建物の案内で選び直した隠し方・理由をバーにも出す
        barChoice.sync();
        sc.setGhosts(true);
        syncHighlight();
        hideBtn.classList.add('dark');
        hideBtn.textContent = HIDE_MODE_ARMED;
        canvasEl.style.cursor = 'crosshair';
        toast(HIDE_MODE_GUIDE, 'info', 8000);
      } else {
        hideMode = false;
        cancelRect();
        selected.clear();
        sc.setGhosts(false);
        syncHighlight();
        hideBtn.classList.remove('dark');
        hideBtn.textContent = HIDE_MODE_LABEL;
        canvasEl.style.cursor = '';
      }
      renderBar();
    };
    stopNeighborUI = () => {
      setHideMode(false);
      closePop();
    };
    hideBtn.addEventListener('click', () => setHideMode(!hideMode));
    const toggleSel = (key: string) => {
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      syncHighlight();
      renderBar();
    };
    barHide.addEventListener('click', () => {
      const keys = [...selected].filter((k) => sc.findByKey(k) && !sc.findByKey(k)!.hidden);
      selected.clear();
      syncHighlight();
      hideKeys(keys);
      renderBar();
    });
    barRestore.addEventListener('click', () => {
      const keys = [...selected].filter((k) => !!sc.findByKey(k)?.hidden);
      selected.clear();
      syncHighlight();
      restoreKeys(keys);
      renderBar();
    });
    barClear.addEventListener('click', () => {
      selected.clear();
      syncHighlight();
      renderBar();
    });
    barExit.addEventListener('click', () => setHideMode(false));
    // 周辺建物を作り直したとき（取り直し・位置の調整・隠す／戻す）: 無くなった建物の選択・案内を外し、一覧を作り直す
    sc.onNeighborsChange = () => {
      for (const k of [...selected]) if (!sc.findByKey(k)) selected.delete(k);
      if (popKey && !sc.findByKey(popKey)) closePop();
      // 周辺建物が無くなった（すべて消す）ら選ぶものが無いので終える
      if (hideMode && !sc.state.neighbors.length) setHideMode(false);
      renderBar();
      renderHiddenList();
    };
    // 3D のクリック: 押した所から動かさずに離したときだけ（ドラッグは視点の操作）。「建物を選んで隠す」の間は Shift+ドラッグで範囲選択
    let nbDown: { x: number; y: number; busy: boolean } | null = null;
    let rect: { x0: number; y0: number; x1: number; y1: number; pointerId: number; controls: boolean } | null = null;
    /** 敷地をクリック・2 点合わせの待ち受け中（そのクリックは建物の選択・案内に使わない） */
    const otherModeArmed = () => placing || !!extPanel?.twoPointArmed();
    const ndcAt = (x: number, y: number) => {
      const r = canvasEl.getBoundingClientRect();
      return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    };
    const pickAt = (x: number, y: number) => sc.pickNeighbor(ndcAt(x, y), [v.groups.building, v.groups.roof, v.groups.external]);
    const drawRect = () => {
      if (!rect) {
        selRect.style.display = 'none';
        return;
      }
      const s = ctx.stage.getBoundingClientRect();
      selRect.style.display = 'block';
      selRect.style.left = `${Math.min(rect.x0, rect.x1) - s.left}px`;
      selRect.style.top = `${Math.min(rect.y0, rect.y1) - s.top}px`;
      selRect.style.width = `${Math.abs(rect.x1 - rect.x0)}px`;
      selRect.style.height = `${Math.abs(rect.y1 - rect.y0)}px`;
    };
    function cancelRect() {
      if (!rect) return;
      // 範囲選択を途中でやめた（Esc・モードの終了）後の pointerup をクリックとして扱わない
      nbDown = null;
      try {
        canvasEl.releasePointerCapture(rect.pointerId);
      } catch {
        // 既に外れている
      }
      v.controls.enabled = rect.controls;
      rect = null;
      drawRect();
    }
    const selectInRect = (r: { x0: number; y0: number; x1: number; y1: number }) => {
      const cr = canvasEl.getBoundingClientRect();
      const pts = sc.selectableCentroids().map((c) => {
        const p = c.world.clone().project(v.camera);
        // カメラの後ろ（z > 1）は投影が裏返るので除く
        if (p.z < -1 || p.z > 1) return { key: c.key, x: NaN, y: NaN };
        return { key: c.key, x: cr.left + ((p.x + 1) / 2) * cr.width, y: cr.top + ((1 - p.y) / 2) * cr.height };
      });
      const keys = keysInRect(pts, { x: r.x0, y: r.y0 }, { x: r.x1, y: r.y1 });
      for (const k of keys) selected.add(k);
      syncHighlight();
      renderBar();
      if (!keys.length) toast('範囲の中に建物がありません（建物の中心が入るように囲んでください）');
    };
    const onNbDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      nbDown = { x: e.clientX, y: e.clientY, busy: otherModeArmed() };
      if (hideMode && e.shiftKey) {
        // Shift+ドラッグは範囲選択（視点の移動にしない: OrbitControls はこの後の pointerdown で enabled を見る）
        rect = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, pointerId: e.pointerId, controls: v.controls.enabled };
        v.controls.enabled = false;
        try {
          canvasEl.setPointerCapture(e.pointerId);
        } catch {
          // 合成イベントなど
        }
        drawRect();
      }
    };
    const onNbMove = (e: PointerEvent) => {
      if (!rect || e.pointerId !== rect.pointerId) return;
      rect.x1 = e.clientX;
      rect.y1 = e.clientY;
      drawRect();
    };
    const onNbUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const d = nbDown;
      nbDown = null;
      const up = { x: e.clientX, y: e.clientY };
      if (rect) {
        const r = { ...rect, x1: up.x, y1: up.y };
        cancelRect();
        if (d && !isClick(d, up)) {
          selectInRect(r);
          return;
        }
      }
      if (!d || d.busy || otherModeArmed() || !isClick(d, up)) return;
      const hit = pickAt(up.x, up.y);
      if (hideMode) {
        if (hit) toggleSel(hit.key);
        return;
      }
      if (hit && !hit.hidden) openPop(hit.key, up.x, up.y);
      else closePop();
    };
    const onNbKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      closePop();
      setHideMode(false);
    };
    canvasEl.addEventListener('pointerdown', onNbDown, true);
    canvasEl.addEventListener('pointermove', onNbMove, true);
    canvasEl.addEventListener('pointerup', onNbUp, true);
    canvasEl.addEventListener('pointercancel', cancelRect, true);
    window.addEventListener('keydown', onNbKey);
    cleanupNeighborUI = () => {
      canvasEl.removeEventListener('pointerdown', onNbDown, true);
      canvasEl.removeEventListener('pointermove', onNbMove, true);
      canvasEl.removeEventListener('pointerup', onNbUp, true);
      canvasEl.removeEventListener('pointercancel', cancelRect, true);
      window.removeEventListener('keydown', onNbKey);
      cancelRect();
      closePop();
      hideMode = false;
      selected.clear();
      sc.onNeighborsChange = null;
      sc.setGhosts(false);
      sc.setPreview(null);
      sc.setHighlight([]);
      hideBar.remove();
      selRect.remove();
      canvasEl.style.cursor = '';
    };
    // 検証用（E2E）
    const dbg = (window as unknown as { __sunDebug?: Record<string, unknown> }).__sunDebug;
    if (dbg)
      dbg.neighborHide = {
        armed: () => hideMode,
        selected: () => [...selected],
        popKey: () => popKey,
        pick: (cx: number, cy: number) => pickAt(cx, cy),
      };
    renderBar();
    renderHiddenList();
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
        hideBtn,
        h('p', { class: 'hint', style: 'margin:2px 0 0' }, '隠し方は 2 通りです。「計算から除外」は解体予定の既存建物・もう無い建物・データの誤りなどに（画面に出さず、影も落とさず、日当たりの解析にも入りません）。「表示だけ隠す」はプレゼンで視点を遮る建物などに（画面には出しませんが、影・解析には残します）。理由と棟数は日影図・解析結果・プレゼン資料に注記されます。いつでも戻せます。ふだんは建物をクリックすると、高さを直したり 1 棟だけ隠したりできます'),
        hiddenBox,
        h('div', { class: 'field-label', style: 'margin-top:8px' }, '隣家を手動で追加'),
        h('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px' }, field('方向', dirSel), field('距離 m', distIn), field('高さ m', hIn)),
        h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn sm', onclick: () => { sc.addManualNeighbor(+dirSel.value, +distIn.value, 8, 8, +hIn.value); invalidateResults(); apply(true); } }, '＋ 隣家を追加'),
          h('button', { class: 'btn sm ghost', onclick: () => { sc.clearNeighbors(); invalidateResults(); apply(true); } }, '周辺建物をすべて消す'),
        ),
        h('p', { class: 'hint' }, '周辺建物の高さは、国土地理院データでは建物の種類から推定（普通建物 約7m）しています。実際の高さが分かる場合は、建物をクリックして直すか手動で追加してください（直した高さ・隠した建物は、周辺建物を取り直しても残ります）。'),
      ),
    );
    // 3DS のパネルは 建設地 の直後に置く
    const siteSection = side.querySelector('section.panel-section');
    if (siteSection) siteSection.after(extPanel.section);
    else side.appendChild(extPanel.section);

    // 解析
    const out = h('div');
    /** 今の周辺建物の扱い（計算から除外・表示だけ隠した建物）。結果を作るときに state.sun.disclosure に写す */
    const disclosureNow = () => collectDisclosure(sc);
    const renderResults = () => {
      clear(out);
      for (const hl of state.sun.highlights) out.appendChild(h('div', { class: `highlight ${hl.tone}` }, h('b', null, hl.title), hl.body));
      if (state.sun.seasons.length) {
        const sel = h('select', null, state.sun.seasons.map((s, i) => h('option', { value: i }, `${s.label}（${s.dateLabel}）`))) as HTMLSelectElement;
        const chart = h('div', { html: sunTimelineSvg(state.sun.seasons[0]) });
        sel.addEventListener('change', () => (chart.innerHTML = sunTimelineSvg(state.sun.seasons[+sel.value])));
        // 解析した時点の周辺建物の扱い（除外・表示だけ隠した建物）を必ず添える
        out.append(field('部屋ごとの日当たり（オレンジが濃いほど床の広い範囲に日が当たる）', sel), chart, disclosureBox(state.sun.disclosure ?? disclosureNow(), 'rooms'));
      }
    };
    const runRooms = async () => {
      // 選択のオレンジ・薄い表示はそのまま解析に影響しないが、案内は閉じる
      closePop();
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
        state.sun.disclosure = disclosureNow();
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
        clear(heatNote);
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
        // 計算した時点の周辺建物の扱い（除外・表示だけ隠した建物）
        clear(heatNote);
        heatNote.appendChild(disclosureBox(disclosureNow(), 'heatmap'));
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
    const heatNote = h('div');
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
        const opts = diagramOptions(diagramChoice.regulationId, diagramChoice.halfHour);
        const res = await shadowDiagram(v, { lat: d.lat, lon: d.lon, northAngleDeg: d.northAngleDeg, year: ui.year }, height, (r) => pm.set(r), { ...over, ...opts });
        // 周辺建物の扱い（この版の日影図は計画建物だけ。除外・表示だけ隠した建物は部屋の日当たり・日照時間マップでの扱い）を図に印字する
        const disc = disclosureNow();
        const svg = appendSvgFootnote(res.svg, disclosureLines(disc, 'diagram'));
        state.sun.diagramSvg = svg;
        if (!state.sun.disclosure) state.sun.disclosure = disc;
        pm.close();
        const body = h('div', null, h('div', { html: svg }), h('p', { class: 'hint' }, diagramSummaryText(res.summary)));
        modal('日影図', body, [
          { label: 'SVG で保存', onClick: () => download(svgToDataUrl(svg), `${state.name}_日影図.svg`) },
          { label: 'PNG で保存', onClick: async () => download(await svgToPng(svg, 2400), `${state.name}_日影図.png`) },
          { label: '閉じる', primary: true },
        ], true);
      } catch (e) {
        pm.close();
        toast(`日影図の作成に失敗しました: ${(e as Error).message}`, 'error');
      }
    };
    /** 日影図の規制値（プリセット）と 30 分ごとの時刻日影線 */
    const diagramControls = () => {
      const regSel = h(
        'select',
        { class: 'sun-reg', title: '日影規制の規制時間（建築基準法 別表第 4）。選ぶと 5〜10m・10m 超の規制時間の等時間日影線を太く描きます（適否の判定はしません）。北海道は真太陽時 9〜15 時' },
        h('option', { value: '', selected: !diagramChoice.regulationId }, REGULATION_NONE_LABEL),
        h('optgroup', { label: '一般（真太陽時 8〜16 時）' }, ...SHADOW_REGULATION_PRESETS.filter((p) => p.region === 'general').map((p) => h('option', { value: p.id, selected: diagramChoice.regulationId === p.id }, p.title))),
        h('optgroup', { label: '北海道（真太陽時 9〜15 時）' }, ...SHADOW_REGULATION_PRESETS.filter((p) => p.region === 'hokkaido').map((p) => h('option', { value: p.id, selected: diagramChoice.regulationId === p.id }, p.title))),
      ) as HTMLSelectElement;
      regSel.addEventListener('change', () => (diagramChoice.regulationId = regSel.value));
      const half = h('input', { type: 'checkbox', class: 'sun-halfhour', checked: diagramChoice.halfHour }) as HTMLInputElement;
      half.addEventListener('change', () => (diagramChoice.halfHour = half.checked));
      return h(
        'div',
        { class: 'sun-diagram-opts' },
        h('label', { class: 'field', style: 'margin:6px 0 2px' }, h('span', { class: 'field-label' }, '日影図の規制値'), regSel),
        h('label', { class: 'check' }, half, HALF_HOUR_LABEL),
      );
    };
    const captureSeasons = async () => {
      // 選択のオレンジ・隠した建物の薄い表示を写さない
      stopNeighborUI();
      sc.setPreview(null);
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
        if (!state.sun.disclosure) state.sun.disclosure = disclosureNow();
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
        diagramControls(),
        heatLegend,
        heatNote,
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
        clear(heatNote);
        v.invalidate();
      }
      renderResults();
    };
    // 影の網羅
    void clearGroup;
  },
};
