/**
 * ステップ 1「建設地」: 住所検索／地図クリックでピン、敷地の輪郭、周辺環境（地形・航空写真・周辺建物）の読み込み、
 * プロジェクトの保存／読込
 *
 * 画面: ステージに 2D 地図（MapPicker）とその上のツール・状態表示、サイドに住所検索・敷地・周辺環境・プロジェクト。
 * 状態の更新は必ず study を書き換えて emit し、表示を refresh*() で作り直す。
 * ピンを動かしたとき: 周辺環境が読み込み済みで移動が小さければ（150m 未満）、格子・航空写真・周辺建物を新しいピン基準に
 * ずらして使い続ける（座標系の原点 = ピン）。大きく動いたときは破棄し、再読み込みを促す。
 * 建物と測定点の追従は周辺環境とは別に followPinMove（alignment.ts）で決める: 位置合わせ・手で置いた記録がある建物は
 * 地球上の同じ所に留まり、読み込んだだけの建物はピンに付いて動く。測定点は建物と同じだけ動く。
 * 3D の pivot は placement を書き換えた後に必ず applyTransform() で同期する（日照画面が古い位置で描かないように）。
 */
import { h, clear, toast, progressModal, section, segmented } from '../../app/dom';
import { geocode, PRECISION_LABEL } from '../../sun/geo';
import type { StudyStep, StudyCtx } from '../shell';
import { study, emit, on, visibleNeighbors } from '../state';
import type { GeoFrame, LatLon, NeighborSource } from '../types';
import { frameToLocal } from '../types';
import { MapPicker, MAP_LAYER_LABEL, polygonAreaM2, type MapLayer } from '../map';
import { loadEnvironment, NEIGHBOR_RADIUS } from '../environment';
import { DEM_LABEL, gridStats, sampleHeight } from '../terrain';
import { buildingEavesOutlineEN, buildingFootprintEN, buildingOutlineEN, currentPlaced, ensurePlacedData } from '../building';
import { followPinMove } from '../alignment';
import { downloadProject, loadProjectFile, loadProjectFromUrl, saveRecent, readRecent, envIsFromSavedProject, markEnvFetched } from '../project';

/** 初期表示（東京駅付近） */
const TOKYO: LatLon = { lat: 35.681236, lon: 139.767125 };
/** 検索した住所をピンの住所として使い続ける距離 (m) */
const ADDRESS_KEEP_M = 300;
/** これ以上ピンを動かしたら周辺環境を破棄する (m) */
const ENV_SHIFT_MAX_M = 150;
/** 1 坪 (㎡) */
const TSUBO = 3.305785;
/** 高低差を見る半径 (m) */
const STATS_RADIUS = 60;

let map: MapPicker | null = null;

/** 地図タイルが読めないときに地図上へ出す案内 */

let offlineNote: HTMLElement | null = null;
let disposers: (() => void)[] = [];
/** 住所の基準点（検索結果・読み込んだプロジェクトの住所）。ピンが近ければこの住所を使う */
let anchor: { lat: number; lon: number; address: string } | null = null;
/** この起動で周辺環境を取得したか（保存データの復元と区別） */
let fetchedThisSession = false;
/** 描いている途中の輪郭の頂点数 */
let drawCount = 0;
/** 周辺環境を取得（復元）したときのピン位置。ここから ENV_SHIFT_MAX_M 以上離れたら周辺環境を捨てる（ドラッグの積算） */
let envOrigin: LatLon | null = null;

const fmtDeg = (v: number) => v.toFixed(5);
const coordAddress = (p: LatLon) => `緯度 ${fmtDeg(p.lat)}, 経度 ${fmtDeg(p.lon)} 付近`;
const isCoordAddress = (s: string) => /^緯度 .* 付近$/.test(s);
const signedM = (v: number, d = 1) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(d)}m`;
const tpText = (v: number) => `T.P.${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)} m`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function distM(a: LatLon, b: LatLon): number {
  const d = frameToLocal(a, b);
  return Math.hypot(d.e, d.n);
}

function siteArea(): number | null {
  if (study.sitePolygon.length < 3) return null;
  try {
    const a = polygonAreaM2(study.sitePolygon);
    return Number.isFinite(a) ? a : null;
  } catch {
    return null;
  }
}

const areaText = (a: number) => `${a.toFixed(1)}㎡（${(a / TSUBO).toFixed(1)}坪）`;

const SOURCE_TAG: Record<NeighborSource, { cls: string; label: string }> = {
  plateau: { cls: 'measured', label: 'PLATEAU・実測の高さ' },
  gsi: { cls: 'estimated', label: '国土地理院・高さは推定' },
  osm: { cls: 'estimated', label: 'OpenStreetMap・高さは推定' },
  manual: { cls: 'manual', label: '手動で追加' },
};

/** 外部サーバーに届かなかったときの案内（既存アプリと同じ文言） */
function networkHint(): string {
  return /localhost|127\.0\.0\.1/.test(location.hostname)
    ? 'インターネット接続を確認してください。取得できなかった項目は平地・写真なし・建物なしとして続行できます'
    : '公開プレビュー版では外部の地図サーバーへの接続が制限されることがあります。お手元のパソコンで start.bat から起動してお試しください';
}

// ---------------------------------------------------------------------------
// 状態の更新
// ---------------------------------------------------------------------------

/** 周辺環境を破棄する（ピンが大きく動いた・場所を変えた） */
function invalidateEnv() {
  envOrigin = null;
  study.grid = null;
  study.aerial = null;
  study.horizon = null;
  study.neighbors = study.neighbors.filter((n) => n.source === 'manual');
  study.neighborSources = [];
  study.neighborNotes = [];
  study.env = { loaded: false, loading: false, error: null, attribution: '' };
  markEnvFetched();
  emit('env');
  emit('neighbors');
}

/** ピンが prev → next に動いた: 周辺環境を新しい原点にずらす（小さな移動）か破棄する */
function relocateEnvironment(prev: GeoFrame, next: GeoFrame) {
  const d = frameToLocal(prev, next);
  const dist = Math.hypot(d.e, d.n);
  if (dist < 0.01) {
    next.groundElev = prev.groundElev;
    return;
  }
  // 取得したときの位置からの累積の移動量で判定する（ドラッグで少しずつ動かしても遠くへ行けば捨てる）
  const origin = envOrigin ?? prev;
  const total = distM(origin, next);
  if (!study.env.loaded || !study.grid || total > ENV_SHIFT_MAX_M) {
    invalidateEnv();
    return;
  }
  const shift = (o: { west: number; east: number; south: number; north: number }) => {
    o.west -= d.e;
    o.east -= d.e;
    o.south -= d.n;
    o.north -= d.n;
  };
  shift(study.grid);
  if (study.aerial) shift(study.aerial);
  for (const n of study.neighbors) {
    n.ring = n.ring.map((q) => ({ e: q.e - d.e, n: q.n - d.n }));
    // PLATEAU の中庭などの穴も同じ座標系なので一緒にずらす
    const x = n as typeof n & { holes?: { e: number; n: number }[][] };
    if (x.holes) x.holes = x.holes.map((h) => h.map((q) => ({ e: q.e - d.e, n: q.n - d.n })));
  }
  // 建物と測定点は周辺環境とは別に followPinMove（setFrame）で追従させる（周辺環境を捨てる分岐でも同じ規則になるように）
  const h0 = sampleHeight(study.grid, 0, 0);
  next.groundElev = Number.isFinite(h0) ? h0 : prev.groundElev;
  emit('env');
  emit('neighbors');
}

/** ピンの位置と住所を確定する */
function setFrame(p: LatLon, address: string) {
  const prev = study.frame;
  const next: GeoFrame = { lat: p.lat, lon: p.lon, address, groundElev: null };
  if (prev) relocateEnvironment(prev, next);
  else if (study.env.loaded) invalidateEnv();
  const moved = !prev || distM(prev, next) >= 0.01;
  study.frame = next;
  if (moved) {
    // 建物: 位置合わせ・手で置いた記録があれば地球上の同じ所に保つ（2 点合わせは対応点から解き直す）。
    // 新しいピンから周辺環境の半径より遠くなるときは（建設地そのものが変わった）ピンの位置に戻して記録を外す。
    // 記録が無い（読み込んだだけの）建物はピンに付いて動く。測定点は建物と同じだけ動く
    const r = followPinMove(prev, next, study.model ? study.placement : null, study.points, NEIGHBOR_RADIUS);
    if (r.kind === 'reset') toast('建設地が大きく変わったため、建物をピンの位置に戻しました。「建物を置く」で位置合わせをやり直してください', 'info', 8000);
    // 3D の pivot は placement を書き換えただけでは動かないので、ここで同期する（日照画面に直接進んでも正しい位置で描く・解析する）
    currentPlaced()?.applyTransform();
  }
  emit('frame');
  // 建物の位置（ピンからの相対）が変わったので、地図の足跡・日照画面の視点などに知らせる
  if (study.model && moved) emit('placement');
  saveRecent();
}

/** 地図上でピンが置かれた・動いた */
function pinFromMap(p: LatLon) {
  const addr = anchor && distM(anchor, p) < ADDRESS_KEEP_M ? anchor.address : coordAddress(p);
  setFrame(p, addr);
}

/** 敷地ポリゴンを状態に反映（閉じた 3 点以上だけを敷地とみなす） */
function applyPolygon(poly: LatLon[], closed: boolean) {
  drawCount = poly.length;
  const next = closed && poly.length >= 3 ? poly.map((q) => ({ lat: q.lat, lon: q.lon })) : [];
  const same = next.length === study.sitePolygon.length && next.every((q, i) => Math.abs(q.lat - study.sitePolygon[i].lat) < 1e-9 && Math.abs(q.lon - study.sitePolygon[i].lon) < 1e-9);
  if (!same) {
    study.sitePolygon = next;
    emit('site');
    saveRecent();
  }
}

// ---------------------------------------------------------------------------
// ステップ
// ---------------------------------------------------------------------------

export const placeStep: StudyStep = {
  id: 'place',
  label: '建設地',
  enabled: () => true,
  uses3d: false,
  unmount() {
    for (const f of disposers.splice(0)) f();
    try {
      map?.dispose();
    } catch {
      /* 地図が初期化できていない */
    }
    map = null;
    offlineNote = null;
  },
  mount(ctx: StudyCtx) {
    const { stage, side, shell } = ctx;
    drawCount = 0;
    // 保存データから周辺環境が復元されている場合は、今のピン位置を取得位置として扱う
    if (study.env.loaded && study.frame && !envOrigin) envOrigin = { lat: study.frame.lat, lon: study.frame.lon };
    if (study.frame && study.frame.address && !isCoordAddress(study.frame.address)) anchor = { lat: study.frame.lat, lon: study.frame.lon, address: study.frame.address };

    // ---- ステージ: 地図 ----
    const root = h('div', { class: 'map-root' });
    stage.appendChild(root);
    const status = h('div', { class: 'map-status' });
    const attrib = h('div', { class: 'map-attrib' });
    const hint = h('div', { class: 'map-hint' });
    const toolbar = h('div', { class: 'map-tools' });
    const zoom = h(
      'div',
      { class: 'map-zoom' },
      h('button', { title: '拡大', onclick: () => map?.zoomBy(1) }, '＋'),
      h('button', { title: '縮小', onclick: () => map?.zoomBy(-1) }, '－'),
    );
    root.append(toolbar, zoom, status, attrib, hint);

    // 地図レイヤー
    const layerSeg = segmented<MapLayer>(
      [
        { value: 'std', label: MAP_LAYER_LABEL.std },
        { value: 'photo', label: MAP_LAYER_LABEL.photo },
        { value: 'pale', label: MAP_LAYER_LABEL.pale },
      ],
      'std',
      (v) => {
        map?.setLayer(v);
        refreshAttrib();
      },
    );

    // 敷地の輪郭のボタン（地図上とサイドの 2 か所に同じものを置く）
    const polyButtons: { toggle: HTMLButtonElement; clearBtn: HTMLButtonElement }[] = [];
    const makePolyButtons = () => {
      const toggle = h('button', {
        class: 'btn',
        onclick: () => {
          if (!map) return;
          if (map.polygonMode) {
            if (drawCount >= 3) map.finishPolygon();
            map.setPolygonMode(false);
          } else {
            map.setPolygonMode(true);
          }
          refreshAll();
        },
      });
      const clearBtn = h('button', {
        class: 'btn',
        onclick: () => {
          if (!map) return;
          map.clearPolygon();
          map.setPolygonMode(false);
          applyPolygon([], false);
          refreshAll();
        },
      }, '輪郭を消す');
      polyButtons.push({ toggle, clearBtn });
      return [toggle, clearBtn];
    };

    const locateBtn = h('button', {
      class: 'btn',
      title: 'この端末の現在地にピンを置く',
      onclick: () => {
        if (!navigator.geolocation) {
          toast('この環境では現在地を取得できません', 'error');
          return;
        }
        locateBtn.disabled = true;
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            locateBtn.disabled = false;
            const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
            anchor = null;
            setFrame(p, coordAddress(p));
            map?.setCenter(p, 17);
            map?.setPin(p, true);
            refreshAll();
          },
          () => {
            locateBtn.disabled = false;
            toast('現在地を取得できませんでした（位置情報の許可を確認してください）', 'error');
          },
          { enableHighAccuracy: true, timeout: 10000 },
        );
      },
    }, '📍 現在地');
    toolbar.append(layerSeg, ...makePolyButtons(), locateBtn);

    // ---- サイド ----
    side.append(h('h2', null, '建設地を指定'), h('p', { class: 'lead' }, '住所で探すか、地図をクリックして建設地にピンを置きます。ピンの位置が 3D の原点（建物を置く場所・地盤高の基準）になります。「建物を置く」で位置を合わせた建物は、ピンを動かしても地球上の同じ所に留まります。航空写真に切り替えると敷地の形がよく分かります。'));

    // 住所で探す
    const q = h('input', { type: 'text', placeholder: '例: 愛知県小牧市小牧4-213（番地まで。Google マップの URL や緯度,経度でも可）', autocomplete: 'off' });
    // Google Geocoding API のキー（任意）。国土地理院・アドレス・ベース・レジストリで番地まで出ないときの補助
    const googleKeyInput = h('input', {
      type: 'password',
      placeholder: 'Google Maps API キー（任意）',
      autocomplete: 'off',
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
    });
    const results = h('div', { class: 'geo-results' });
    const searchBtn = h('button', { class: 'btn', onclick: () => void search() }, '検索');
    const search = async () => {
      const text = q.value.trim();
      if (!text) {
        toast('住所を入力してください', 'error');
        return;
      }
      searchBtn.disabled = true;
      clear(results);
      results.appendChild(h('div', { class: 'hint' }, '検索中…（番地の照合に数秒かかることがあります）'));
      try {
        const list = (await geocode(text, { googleKey: googleKeyInput.value.trim() || undefined })).slice(0, 6);
        clear(results);
        if (!list.length) {
          results.appendChild(h('div', { class: 'warn' }, '見つかりませんでした。番地を省く、または市区町村から入力してみてください。地図を直接クリックしてピンを置くこともできます'));
          return;
        }
        for (const r of list) {
          // 番地・号・座標まで特定できた候補はピンが正確なので一段寄せる（MAX_ZOOM = 18）
          const precise = r.precision === 'point' || r.precision === 'go' || r.precision === 'ban';
          results.appendChild(
            h('button', {
              class: 'btn sm',
              onclick: () => {
                anchor = { lat: r.lat, lon: r.lon, address: r.title };
                setFrame(r, r.title);
                map?.setCenter(r, precise ? 18 : 17);
                map?.setPin(r, true);
                refreshAll();
                if (r.precision === 'town' || r.precision === 'chome')
                  toast('番地までは特定できませんでした。地図上でピンをドラッグ（または航空写真でクリック）して建設地に合わせてください', 'info', 8000);
              },
            }, r.title, h('span', { class: 'hint', style: 'margin-left:6px' }, PRECISION_LABEL[r.precision])),
          );
        }
        results.appendChild(h('div', { class: 'hint' }, '候補を選ぶとピンが置かれます。番地まで一致しない場合は、地図上でピンをドラッグして合わせてください'));
      } catch (e) {
        clear(results);
        results.appendChild(h('div', { class: 'warn' }, errMsg(e)));
      } finally {
        searchBtn.disabled = false;
      }
    };
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void search();
      }
    });
    side.appendChild(
      section(
        '住所で探す',
        h('div', { class: 'btn-row', style: 'margin:0' }, h('div', { class: 'field', style: 'flex:1;margin:0' }, q), searchBtn),
        h(
          'details',
          { style: 'margin:6px 0' },
          h('summary', { class: 'hint', style: 'cursor:pointer' }, '番地まで出ないときは Google の住所検索を使う（API キーを設定）'),
          h('div', { class: 'field', style: 'margin:6px 0 0' }, googleKeyInput),
          h('span', { class: 'hint' }, 'Google Cloud で「Geocoding API」を有効にしたキーを貼ると、住居表示の無い地域や新しい番地も特定できます。キーはこのパソコンにだけ保存されます'),
        ),
        results,
      ),
    );

    // 敷地（任意）
    const areaOut = h('div', { class: 'ok-box', style: 'display:none' });
    const polyInfo = h('div', { class: 'info-box' });
    const footprintHint = h('p', { class: 'hint', style: 'margin:4px 0 0;display:none' }, '地図上の建物: 濃い線 = 壁、薄い面 = 軒先（航空写真で見えるのは軒先です）');
    side.appendChild(
      section(
        '敷地（任意）',
        h('p', { class: 'hint', style: 'margin:0 0 8px' }, '敷地の輪郭を描いておくと、日影図の 5m／10m ラインの基準になり、敷地内にある既存の建物（取り壊す家など）を周辺建物から自動で除外できます。「建物を置く」の「敷地の輪郭に合わせる」でも使います。'),
        areaOut,
        polyInfo,
        h('div', { class: 'btn-row' }, ...makePolyButtons()),
        footprintHint,
      ),
    );

    // 周辺環境
    const envBox = h('div');
    side.appendChild(section('周辺環境の読み込み', envBox));

    // プロジェクト
    const fileIn = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files?.[0];
      fileIn.value = '';
      if (!f) return;
      const pm = progressModal('プロジェクトを開いています', false);
      pm.set(0.3, f.name);
      try {
        await loadProjectFile(f);
        fetchedThisSession = false;
        anchor = null;
        toast(`「${study.name}」を開きました`, 'ok');
        pm.close();
        await shell.go('place');
      } catch (e) {
        pm.close();
        toast(`プロジェクトを開けませんでした: ${errMsg(e)}`, 'error', 9000);
      }
    });
    side.appendChild(
      section(
        'プロジェクト',
        h(
          'div',
          { class: 'btn-row' },
          h('button', {
            class: 'btn',
            onclick: () => {
              try {
                downloadProject();
              } catch (e) {
                toast(`保存できませんでした: ${errMsg(e)}`, 'error', 8000);
              }
            },
          }, '💾 保存（JSON）'),
          h('button', { class: 'btn', onclick: () => fileIn.click() }, '📂 開く'),
          fileIn,
        ),
        h('p', { class: 'hint', style: 'margin:0' }, '場所・敷地・建物の 3D データ・配置に加えて、取得した周辺環境（地形・航空写真・周辺建物）も 1 つの JSON に同梱します。保存したファイルは、インターネットに接続できない場所でも開いて検討を続けられます。'),
        h(
          'button',
          {
            class: 'btn sm block',
            style: 'margin-top:10px',
            onclick: async () => {
              const pm = progressModal('デモのプロジェクトを開いています', false);
              try {
                // 同梱のデモ（世田谷区奥沢・地形/航空写真/周辺建物/サンプル住宅入り）。地図サーバーに接続できない環境でも 3D と解析を試せる
                await loadProjectFromUrl(new URL('demo/okusawa.json', document.baseURI).toString());
                pm.close();
                toast('デモのプロジェクトを開きました（世田谷区奥沢・サンプル住宅）', 'ok');
                await shell.go('model');
              } catch (e) {
                pm.close();
                toast(`デモを開けませんでした: ${errMsg(e)}`, 'error', 8000);
              }
            },
          },
          '▶ デモを開く（世田谷区奥沢・サンプル住宅・周辺環境入り）',
        ),
      ),
    );

    // ---- 表示の更新 ----
    const refreshStatus = () => {
      clear(status);
      const f = study.frame;
      status.appendChild(h('b', null, f ? f.address : '地図をクリックして建設地を指定してください'));
      if (f) {
        status.append(h('br'), `緯度 ${fmtDeg(f.lat)}　経度 ${fmtDeg(f.lon)}`);
        if (study.env.loaded && f.groundElev != null) status.append(h('br'), `地盤高 ${tpText(f.groundElev)}（出典: ${DEM_LABEL[study.grid?.source ?? ''] ?? study.grid?.source ?? '不明'}）`);
      }
      const a = siteArea();
      if (a != null) status.append(h('br'), `敷地面積 ${areaText(a)}`);
    };

    const refreshAttrib = () => {
      let a = '';
      try {
        a = map?.attribution ?? '';
      } catch {
        a = '';
      }
      attrib.textContent = a.includes('国土地理院') ? a : `${a ? a + '／' : ''}出典: 国土地理院`;
    };

    const refreshHint = () => {
      const mode = !!map?.polygonMode;
      if (mode) hint.textContent = drawCount >= 3 ? `頂点 ${drawCount} 点。最初の点をクリックするか「描き終える（完了）」で輪郭を閉じます。右クリック／Backspace で 1 点戻す` : '敷地の角を順にクリックしてください（3 点以上）。頂点はドラッグで動かせます';
      else if (!study.frame) hint.textContent = '地図をクリックすると建設地のピンを置けます。ドラッグで地図を動かし、ホイールで拡大・縮小';
      else hint.textContent = 'ピンはドラッグで微調整できます。「航空写真」に切り替えると建物や敷地の形が見えます';
    };

    const refreshPolyUI = () => {
      const mode = !!map?.polygonMode;
      const has = study.sitePolygon.length >= 3;
      for (const b of polyButtons) {
        b.toggle.textContent = mode ? (drawCount >= 3 ? '✓ 描き終える（完了）' : '▭ 描いています…（やめる）') : has ? '▭ 敷地の輪郭を描き直す' : '▭ 敷地の輪郭を描く';
        b.toggle.classList.toggle('on', mode);
        b.toggle.disabled = !map;
        b.clearBtn.disabled = !map || (!has && drawCount === 0);
      }
      const a = siteArea();
      areaOut.style.display = a != null ? '' : 'none';
      if (a != null) areaOut.textContent = `敷地面積 ${areaText(a)}（${study.sitePolygon.length} 点の輪郭。地図上で計算した概算です）`;
      polyInfo.style.display = has ? 'none' : '';
      polyInfo.textContent = mode ? '地図上で敷地の角を順にクリックしてください。' : '敷地の輪郭はまだありません。描かなくても検討はできます（日影図の 5m／10m ラインは建物の外形 +2m の矩形を使います）。';
      footprintHint.style.display = study.model ? '' : 'none';
      if (map) {
        try {
          // 建物の外形: 塗り = 軒先（全高さの凸包。航空写真に写るのはこれ）、濃い線 = 壁。外形が取れなければ足跡の矩形
          if (study.model) {
            ensurePlacedData();
            map.setFootprint(buildingEavesOutlineEN() ?? buildingFootprintEN(), buildingOutlineEN());
          } else map.setFootprint(null);
        } catch {
          /* 地図未実装 */
        }
      }
    };

    const refreshEnv = () => {
      clear(envBox);
      const f = study.frame;
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (offline) envBox.appendChild(h('div', { class: 'warn' }, 'オフラインです。保存済みのプロジェクトを開けば検討を続けられます'));
      if (study.env.loading) {
        envBox.appendChild(h('div', { class: 'info-box' }, '地形・航空写真・周辺建物を取得しています…'));
        return;
      }
      if (!study.env.loaded) {
        envBox.appendChild(h('p', { class: 'hint', style: 'margin:0 0 8px' }, f ? `ピンの位置を中心に、地形（標高）・航空写真・周辺建物（半径約 ${NEIGHBOR_RADIUS}m）を国土地理院・PLATEAU の公開データから自動で取得します。` : 'まず地図でピンを置いてください。'));
        envBox.appendChild(h('button', { class: 'btn primary block', disabled: !f || offline, onclick: () => void loadEnv() }, 'この場所で周辺環境を読み込む →'));
        return;
      }
      const saved = envIsFromSavedProject() && !fetchedThisSession;
      if (saved) envBox.appendChild(h('div', { class: 'ok-box' }, '周辺環境: 保存データを使用（プロジェクトに同梱されていた地形・航空写真・周辺建物）'));
      const rows = h('div', { class: 'env-status' });
      const g = study.grid;
      if (g) {
        const st = gridStats(g, f?.groundElev ?? 0, STATS_RADIUS);
        rows.append(h('span', { class: 'k' }, '地形'), h('span', null, DEM_LABEL[g.source] ?? g.source, h('br'), g.source === 'flat' ? '高低差は考慮されません' : `敷地周辺の高低差 ${signedM(st.relMin)} 〜 ${signedM(st.relMax)}`));
      } else rows.append(h('span', { class: 'k' }, '地形'), h('span', null, 'なし（平地として扱います）'));
      rows.append(h('span', { class: 'k' }, '航空写真'), h('span', null, study.aerial ? '取得（国土地理院 シームレス空中写真）' : 'なし'));
      const vis = visibleNeighbors();
      const auto = vis.filter((n) => n.source !== 'manual');
      const manualCount = vis.length - auto.length;
      const tags = study.neighborSources.filter((s) => s !== 'manual').map((s) => h('span', { class: `src-tag ${SOURCE_TAG[s]?.cls ?? ''}` }, SOURCE_TAG[s]?.label ?? s));
      rows.append(h('span', { class: 'k' }, '周辺建物'), h('span', null, `${auto.length}棟`, ...tags, manualCount ? `（手動 ${manualCount}棟）` : null));
      envBox.appendChild(rows);
      for (const n of study.neighborNotes) envBox.appendChild(h('div', { class: 'info-box' }, n));
      if (study.env.error) {
        for (const line of study.env.error.split('\n').filter(Boolean)) envBox.appendChild(h('div', { class: 'warn' }, line));
        envBox.appendChild(h('p', { class: 'hint', style: 'margin:0 0 6px' }, networkHint()));
      }
      envBox.appendChild(
        h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn', disabled: !f || offline, onclick: () => void loadEnv() }, study.env.error ? '再取得' : saved ? '最新を再取得' : '周辺環境を再読み込み'),
          study.model
            ? h('button', { class: 'btn primary', onclick: () => void shell.go('model') }, 'つぎへ: 建物 →')
            : h('button', { class: 'btn primary', onclick: () => void shell.go('model') }, 'つぎへ: 3D データを読み込む →'),
        ),
      );
    };

    const refreshRings = () => {
      if (!map) return;
      try {
        if (study.env.loaded) {
          map.setNeighborRings(visibleNeighbors().map((n) => n.ring));
          map.setRadiusRing(NEIGHBOR_RADIUS);
        } else {
          map.setNeighborRings(null);
          map.setRadiusRing(null);
        }
      } catch {
        /* 地図未実装 */
      }
    };

    const refreshAll = () => {
      refreshStatus();
      refreshPolyUI();
      refreshEnv();
      refreshHint();
      refreshAttrib();
    };

    const loadEnv = async () => {
      if (!study.frame) {
        toast('先に地図でピンを置いてください', 'error');
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        toast('オフラインです。保存済みのプロジェクトを開けば検討を続けられます', 'error', 6000);
        return;
      }
      const pm = progressModal('地形・航空写真・周辺建物を取得しています', false);
      let report: Awaited<ReturnType<typeof loadEnvironment>>;
      try {
        report = await loadEnvironment({ onProgress: (msg, ratio) => pm.set(ratio, msg) });
        envOrigin = study.frame ? { lat: study.frame.lat, lon: study.frame.lon } : null;
      } catch (e) {
        study.env.loading = false;
        emit('env');
        toast(`周辺環境を取得できませんでした: ${errMsg(e)}`, 'error', 9000);
        refreshAll();
        return;
      } finally {
        pm.close();
      }
      fetchedThisSession = true;
      markEnvFetched();
      saveRecent();
      if (map) {
        try {
          study.results.mapUrl = map.snapshot();
        } catch {
          /* 画像化できない */
        }
      }
      refreshRings();
      refreshAll();
      if (report.errors.length) toast(`一部のデータを取得できませんでした（${report.errors.length} 件）。詳細はサイドパネルをご覧ください`, 'error', 7000);
      else toast('周辺環境を読み込みました', 'ok');
      if (!study.model) {
        toast('つぎに、建物の 3D データを読み込みます', 'info');
        void shell.go('model');
      }
    };

    // ---- 地図を作る（表示の更新関数を定義した後に。コンストラクタ内で onView が呼ばれても良いように） ----
    const recent = readRecent();
    const initial: LatLon = study.frame ?? (recent?.frame && Number.isFinite(recent.frame.lat) && Number.isFinite(recent.frame.lon) ? recent.frame : TOKYO);
    try {
      map = new MapPicker(root, {
        initial: { lat: initial.lat, lon: initial.lon },
        zoom: study.frame ? 17 : 16,
        layer: 'std',
        onPin: (p) => {
          pinFromMap(p);
          refreshAll();
        },
        onPolygonChange: (poly, closed) => {
          applyPolygon(poly, closed);
          refreshAll();
        },
        onView: () => refreshAttrib(),
        onPolygonModeChange: () => {
          drawCount = 0;
          refreshAll();
        },
        // 地図サーバー（国土地理院）に接続できない環境（社内の制限・オフライン・外部通信を遮断するホスティング）では
        // 地図が灰色のままになる。原因と回避策（同梱デモ／制限のない環境で開く）を地図の上に示す
        onTilesUnavailable: () => {
          if (offlineNote) return;
          offlineNote = h(
            'div',
            { class: 'warn map-offline-note' },
            h('b', null, navigator.onLine ? '地図サーバー（国土地理院）に接続できません' : 'インターネットに接続されていません'),
            h(
              'div',
              { style: 'margin-top:4px' },
              navigator.onLine
                ? 'この環境では外部サーバーへの通信が制限されているため、地図・住所検索・周辺環境（地形・周辺建物）を取得できません。サイドの「▶ デモを開く」で同梱のデモを試すか、制限のないパソコン（start-sun.bat）や公開版の URL でこのページを開いてください。保存済みのプロジェクト（JSON）は周辺環境ごと開けます。'
                : '接続が戻ると自動で再読み込みします。保存済みのプロジェクト（JSON）や「▶ デモを開く」はオフラインでも開けます。',
            ),
          );
          root.appendChild(offlineNote);
        },
        onTilesAvailable: () => {
          offlineNote?.remove();
          offlineNote = null;
        },
      });
    } catch (e) {
      map = null;
      root.appendChild(h('div', { class: 'warn', style: 'position:absolute;left:14px;top:60px;z-index:3;max-width:420px' }, `地図を表示できませんでした: ${errMsg(e)}`));
    }

    // ---- 初期状態を地図へ ----
    if (map) {
      try {
        if (study.frame) map.setPin(study.frame, true);
        if (study.sitePolygon.length >= 3) map.setPolygon(study.sitePolygon);
      } catch {
        /* 地図未実装 */
      }
      refreshRings();
    }
    refreshAll();

    // ---- 他所からの変更に追従 ----
    disposers.push(
      on('env', () => {
        refreshEnv();
        refreshStatus();
        refreshRings();
      }),
      on('frame', refreshStatus),
      on('site', refreshPolyUI),
      on('model', refreshPolyUI),
      // 位置合わせ・ピンの移動で建物の外形が変わったら地図の足跡も追従
      on('placement', refreshPolyUI),
    );
    const onLine = () => refreshEnv();
    window.addEventListener('online', onLine);
    window.addEventListener('offline', onLine);
    disposers.push(() => {
      window.removeEventListener('online', onLine);
      window.removeEventListener('offline', onLine);
    });
  },
};
