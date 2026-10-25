/**
 * 日照ステップ: 点群（航空レーザの LAS/LAZ・iPhone の LiDAR スキャンの PLY など）で周辺建物の高さ・屋根を実測にする欄。
 *
 * - ファイルを選ぶ → 敷地の周り（半径 RADIUS m）の点だけ読む → 周辺建物ごとに屋根の形を当てはめ、木を見つける（SunContext.applyPointCloud）。
 * - 航空レーザは平面直角座標系なので自動で置ける。スキャン（ローカル座標）は、ずらし（東・北）と回転・上向きの軸を入れて置き直す。
 * - 点群のデータは端末の中だけで処理する（サーバーへ送らない）。
 */
import { h, toast, progressModal, field } from '../dom';
import type { PointCloudSummary, SunContext } from '../../sun/context';
import { readPointCloud, type RawCloud } from '../../sun/pointcloud/read';
import { planPlacement, siteFilter, toSiteCloud, type Placement } from '../../sun/pointcloud/place';
import { ROOF_KIND_LABEL } from '../../sun/plateau';

/** 読む範囲の半径 (m)。周辺建物の取得範囲と同じくらい */
const RADIUS = 150;

/** 公開されている航空レーザ点群（LAS）の入手先。都道府県・市の単位で整備が進んでいる */
export const OPEN_LIDAR_SOURCES: { name: string; url: string; note: string }[] = [
  { name: '東京都デジタルツイン（区部・多摩・島しょ）', url: 'https://www.geospatial.jp/ckan/dataset/tokyopc-23ku-2024', note: '16 点/㎡ 以上・1/500 図郭ごとの LAS（第 9 系）' },
  { name: '静岡県 VIRTUAL SHIZUOKA', url: 'https://www.geospatial.jp/ckan/dataset?q=%E9%9D%99%E5%B2%A1%E7%9C%8C+%E7%82%B9%E7%BE%A4', note: '県全域の航空レーザ点群（LAS・第 8 系）' },
  { name: '大阪府・大阪市の点群', url: 'https://www.geospatial.jp/ckan/dataset?q=%E7%82%B9%E7%BE%A4+%E5%A4%A7%E9%98%AA', note: 'G 空間情報センターで検索' },
  { name: 'G 空間情報センター（全国の点群）', url: 'https://www.geospatial.jp/ckan/dataset?q=%E7%82%B9%E7%BE%A4+LAS', note: '北海道・広島・兵庫など。地域名と「点群」で検索' },
  { name: '国土地理院 点群データ', url: 'https://www.gsi.go.jp/johofukyu/johofukyu_index.html', note: '整備済みの地域から順次（有償の区画あり）' },
];

export function createPointCloudBlock(sc: SunContext, onApplied: () => void): HTMLElement {
  let lastRaw: RawCloud | null = null;
  let lastName = '';
  const status = h('p', { class: 'hint pc-status', style: 'margin:4px 0 0' });
  const fileIn = h('input', { type: 'file', accept: '.las,.laz,.ply,.xyz,.txt,.csv,.pts', style: 'display:none' }) as HTMLInputElement;
  const pointsChk = h('input', { type: 'checkbox', checked: sc.showCloudPoints, onchange: () => { sc.showCloudPoints = pointsChk.checked; sc.buildNeighbors(); } }) as HTMLInputElement;
  const treesChk = h('input', { type: 'checkbox', checked: sc.showCloudTrees, onchange: () => { sc.showCloudTrees = treesChk.checked; sc.buildNeighbors(); } }) as HTMLInputElement;
  // スキャン（ローカル座標）の置き方
  const offE = h('input', { type: 'number', step: 0.1, value: 0 }) as HTMLInputElement;
  const offN = h('input', { type: 'number', step: 0.1, value: 0 }) as HTMLInputElement;
  const rot = h('input', { type: 'number', step: 1, value: 0, min: -360, max: 360 }) as HTMLInputElement;
  const upSel = h('select', null, h('option', { value: 'z' }, 'Z が上'), h('option', { value: 'y' }, 'Y が上（Polycam・3d Scanner App など）')) as HTMLSelectElement;
  const localBox = h(
    'div',
    { style: 'display:none;margin-top:6px' },
    h('p', { class: 'hint', style: 'margin:0 0 4px' }, 'スキャンの座標は端末の任意の向きです。原点（スキャンを始めた位置）を敷地の中心からずらす量と、スキャンの「北」が真北から時計回りに何度かを入れて「置き直す」を押してください。'),
    h('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px' }, field('東へ m', offE), field('北へ m', offN), field('回転 °', rot)),
    field('上向きの軸', upSel),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => lastRaw && place(lastRaw, true) }, '置き直す')),
  );
  const clearBtn = h('button', { class: 'btn sm ghost', style: 'display:none', onclick: () => { sc.clearPointCloud(); lastRaw = null; showSummary(null, null); onApplied(); toast('点群の実測をやめました（屋根・高さは元のデータに戻しました）', 'ok'); } }, '実測をやめる') as HTMLButtonElement;

  const placementText = (p: Placement) =>
    p.kind === 'plane'
      ? `平面直角座標系 第 ${p.zone} 系${p.datum !== '不明' ? `（${p.datum}）` : ''}${p.zoneFrom === 'guess' ? '・範囲から推定' : ''}`
      : `スキャンの座標（ずらし 東 ${p.offsetE} m・北 ${p.offsetN} m、回転 ${p.rotDeg}°、${p.up.toUpperCase()} が上）`;

  const showSummary = (s: PointCloudSummary | null, p: Placement | null) => {
    clearBtn.style.display = s ? '' : 'none';
    localBox.style.display = p?.kind === 'local' ? '' : 'none';
    if (!s || !p) {
      status.textContent = '';
      return;
    }
    const kinds = Object.entries(s.kinds)
      .map(([k, n]) => `${ROOF_KIND_LABEL[k as keyof typeof ROOF_KIND_LABEL]} ${n}`)
      .join('・');
    const kept = [s.lod2 ? `PLATEAU の実形状 ${s.lod2}` : '', s.user ? `手で直した ${s.user}` : ''].filter(Boolean).join('・');
    const lacking = [s.few ? `点が足りない ${s.few}` : '', s.low ? `2m より低い（解体済み・空き地かも）${s.low}` : '', s.outOfRange ? `点群の範囲外 ${s.outOfRange}` : ''].filter(Boolean).join('・');
    status.textContent =
      `${lastName}: ${s.points.toLocaleString()} 点（${placementText(p)}）。` +
      `実測にした建物 ${s.fitted} 棟${kinds ? `（${kinds}）` : ''}` +
      (kept ? `、そのまま ${kept} 棟` : '') +
      (lacking ? `、当てはめなし: ${lacking} 棟` : '') +
      `。木 ${s.trees} 本（影・解析に入ります）。`;
  };

  const place = (raw: RawCloud, forceLocal = false) => {
    const origin = sc.cloudOrigin();
    const local = forceLocal || sc.cloudData?.cloud.placement.kind === 'local' ? { up: upSel.value as 'z' | 'y', offsetE: +offE.value || 0, offsetN: +offN.value || 0, rotDeg: +rot.value || 0 } : null;
    const p = planPlacement(raw.header, origin, local);
    if (p.kind === 'local' && !local) upSel.value = p.up;
    const cloud = toSiteCloud(raw, p, origin, RADIUS);
    if (cloud.count < 100) throw new Error(`敷地の周り ${RADIUS}m に点がほとんどありません（${cloud.count} 点）。敷地を含む区画のファイルか確かめてください`);
    const s = sc.applyPointCloud(cloud, origin);
    showSummary(s, p);
    onApplied();
    return s;
  };

  const load = async (file: File) => {
    const pm = progressModal('点群を読み込んでいます', false);
    try {
      pm.set(0.02, `${file.name}（${(file.size / 1e6).toFixed(0)} MB）を開いています`);
      const buf = await file.arrayBuffer();
      const origin = sc.cloudOrigin();
      pm.set(0.1, '敷地の周りの点を読んでいます');
      const raw = await readPointCloud(buf, file.name, {
        // 航空レーザ（平面直角座標）は読みながら敷地の周りだけ残す。スキャンは全部
        filter: (hd) => {
          try {
            return siteFilter(planPlacement(hd, origin), origin, RADIUS);
          } catch {
            return null;
          }
        },
        onProgress: (r) => pm.set(0.1 + r * 0.7, '敷地の周りの点を読んでいます'),
      });
      lastRaw = raw;
      lastName = file.name;
      pm.set(0.85, '建物ごとに屋根の形を当てはめています');
      await new Promise((r) => setTimeout(r, 30));
      const s = place(raw);
      if (!sc.state.neighbors.length) toast('周辺建物がまだありません。先に周辺建物を取得すると、建物ごとの高さ・屋根を実測にできます（点と木は表示しました）', 'info', 8000);
      else toast(`点群で ${s.fitted} 棟の高さ・屋根を実測にしました・木 ${s.trees} 本`, 'ok');
    } catch (e) {
      toast(`点群を読めませんでした: ${(e as Error).message}`, 'error', 9000);
    } finally {
      pm.close();
    }
  };
  fileIn.onchange = () => {
    const f = fileIn.files?.[0];
    fileIn.value = '';
    if (f) void load(f);
  };

  if (sc.cloudData) {
    lastName = '読み込み済みの点群';
    showSummary(sc.cloudData.summary, sc.cloudData.cloud.placement);
  }

  return h(
    'div',
    { class: 'pc-block', style: 'margin-top:10px' },
    h('div', { class: 'field-label' }, '点群で周辺を実測（航空レーザ・iPhone LiDAR）'),
    h('p', { class: 'hint', style: 'margin:2px 0 4px' }, '自治体が公開している航空レーザの点群（LAS・LAZ）や、iPhone の LiDAR でスキャンした点群（PLY など）から、周辺建物の高さと屋根の形（切妻・寄棟・片流れ・陸屋根）を実測にし、木も影に入れます。ファイルは端末の中だけで処理します。'),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => fileIn.click() }, '点群ファイルを選ぶ'), clearBtn, fileIn),
    h('div', { style: 'display:flex;gap:12px;flex-wrap:wrap' }, h('label', { class: 'check', style: 'font-size:12px' }, pointsChk, '点を表示'), h('label', { class: 'check', style: 'font-size:12px' }, treesChk, '点群の木を表示')),
    status,
    localBox,
    h(
      'details',
      { style: 'margin-top:4px' },
      h('summary', { class: 'hint', style: 'cursor:pointer' }, '公開されている点群の入手先'),
      h(
        'ul',
        { class: 'hint', style: 'margin:4px 0 0;padding-left:18px' },
        ...OPEN_LIDAR_SOURCES.map((s) => h('li', null, h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.name), `: ${s.note}`)),
        h('li', null, '愛知県（一宮市など）は、いまのところ公開された点群が見つかっていません。iPhone のスキャンか、PLATEAU・国土地理院の建物をお使いください。'),
      ),
    ),
  );
}
