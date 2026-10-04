/**
 * 地理情報: 住所検索（国土地理院）、航空写真タイル、周辺建物（国土地理院ベクトルタイル / OpenStreetMap）
 */
import { decodeMvt } from './mvt';

export interface SiteLocation {
  lat: number;
  lon: number;
  address: string;
  /** 建物中心を住所点から東・北へずらす量 (m) */
  offsetE: number;
  offsetN: number;
}

export const DEFAULT_SITE: SiteLocation = { lat: 35.681236, lon: 139.767125, address: '東京都千代田区丸の内（仮）', offsetE: 0, offsetN: 0 };

export function siteLatLon(s: SiteLocation) {
  const { mLat, mLon } = metersPerDegree(s.lat);
  return { lat: s.lat + s.offsetN / mLat, lon: s.lon + s.offsetE / mLon };
}

export function metersPerDegree(lat: number) {
  const r = (lat * Math.PI) / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * r) + 1.175 * Math.cos(4 * r);
  const mLon = 111412.84 * Math.cos(r) - 93.5 * Math.cos(3 * r);
  return { mLat, mLon };
}

export function toLocal(lat: number, lon: number, oLat: number, oLon: number) {
  const { mLat, mLon } = metersPerDegree(oLat);
  return { e: (lon - oLon) * mLon, n: (lat - oLat) * mLat };
}

export function lonLatToTile(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x, y };
}

export function tileToLonLat(x: number, y: number, z: number) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lon, lat };
}

export type GeocodePrecision = 'point' | 'go' | 'ban' | 'chome' | 'town';

export interface GeocodeResult {
  title: string;
  lat: number;
  lon: number;
  /** どこまで特定できたか（point: 緯度経度の直接指定、go: 号、ban: 番地、chome: 丁目、town: 町名） */
  precision: GeocodePrecision;
}

export const PRECISION_LABEL: Record<GeocodePrecision, string> = {
  point: '座標を直接指定',
  go: '号まで特定',
  ban: '番地まで特定',
  chome: '丁目まで（番地は未特定）',
  town: '町名まで（番地は未特定）',
};

const KANJI_NUM: Record<string, number> = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function kanjiToNum(k: string): number {
  // 一〜十九程度（丁目に使われる範囲）
  if (/^\d+$/.test(k)) return +k;
  let n = 0;
  if (k.includes('十')) {
    const [a, b] = k.split('十');
    n = (a ? KANJI_NUM[a] : 1) * 10 + (b ? KANJI_NUM[b] : 0);
  } else n = [...k].reduce((v, c) => v * 10 + (KANJI_NUM[c] ?? 0), 0);
  return n;
}

/** 検索結果の文字列から、どこまで特定できているかを判定 */
function precisionOf(title: string): GeocodePrecision {
  const t = title.normalize('NFKC');
  if (/\d+号$/.test(t)) return 'go';
  if (/\d+番地?(\d+)?$/.test(t) || /\d+(-\d+)*$/.test(t)) return 'ban';
  if (/丁目$/.test(t)) return 'chome';
  return 'town';
}

/** 緯度経度の直接入力（"35.288, 136.924"）や Google マップの URL（@35.288,136.924 / q=35.288,136.924） */
function parsePoint(q: string): GeocodeResult | null {
  const m = q.match(/@?(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/);
  if (!m) return null;
  const lat = +m[1];
  const lon = +m[2];
  if (lat < 20 || lat > 46 || lon < 122 || lon > 154) return null;
  return { title: `緯度 ${lat.toFixed(5)}／経度 ${lon.toFixed(5)}`, lat, lon, precision: 'point' };
}

/** 入力の末尾の番号（丁目・番地・号）を取り出す。例 "4-213-1" "4丁目213番地1号" "宮前50" */
function tailNumbers(q: string): number[] {
  const t = q.replace(/\s.*$/, '');
  const m = t.match(/((?:\d+(?:丁目|番地?|号|[-ー−‐の])?)+)$/);
  if (!m) return [];
  return (m[1].match(/\d+/g) ?? []).map(Number);
}

let prefCache: { pref: string; cities: { city: string; ward?: string }[] }[] | null = null;
const GEOLONIA = 'https://japanese-addresses-v2.geoloniamaps.com/api/ja';

/**
 * アドレス・ベース・レジストリ（デジタル庁）由来の住所データ（Geolonia 配信, CC BY 4.0）で番地・号の座標を引く。
 * 国土地理院の検索が町名・丁目までで止まったときの2段目。住居表示の実施地域では号まで、地番地域は座標がある所のみ
 */
async function lookupAbr(townTitle: string, nums: number[]): Promise<GeocodeResult | null> {
  if (!nums.length) return null;
  if (!prefCache) {
    const r = await fetch(`${GEOLONIA}.json`);
    if (!r.ok) return null;
    prefCache = ((await r.json()) as { data: { pref: string; cities: { city: string; ward?: string }[] }[] }).data;
  }
  const t = townTitle.normalize('NFKC');
  const pref = prefCache.find((p) => t.startsWith(p.pref));
  if (!pref) return null;
  const rest = t.slice(pref.pref.length);
  // 市区町村（政令市は「市＋区」）: 長い名前から照合
  const cities = pref.cities.map((c) => ({ ...c, full: c.city + (c.ward ?? '') })).sort((a, b) => b.full.length - a.full.length);
  const city = cities.find((c) => rest.startsWith(c.full));
  if (!city) return null;
  let town = rest.slice(city.full.length).replace(/^大字/, '').replace(/[\d０-９]+番地?.*$/, '');
  const hasChome = /丁目/.test(town);
  const cr = await fetch(`${GEOLONIA}/${encodeURIComponent(pref.pref)}/${encodeURIComponent(city.full)}.json`);
  if (!cr.ok) return null;
  const towns = ((await cr.json()) as { data: { oaza_cho?: string; chome?: string; koaza?: string; csv_ranges?: Record<string, { start: number; length: number }> }[] }).data;
  const name = (x: (typeof towns)[number]) => `${x.oaza_cho ?? ''}${x.chome ?? ''}${x.koaza ?? ''}`.normalize('NFKC');
  let cand = towns.find((x) => name(x) === town);
  let rem = nums;
  if (!cand && !hasChome && nums.length >= 2) {
    // 「小牧4-213」のように丁目が数字で入っている → 町名＋丁目で探す
    const kan = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    const c = nums[0];
    const ch = c <= 10 ? kan[c] : c < 20 ? `十${kan[c - 10]}` : String(c);
    cand = towns.find((x) => (x.oaza_cho ?? '').normalize('NFKC') === town && (x.chome ?? '') === `${ch}丁目`);
    if (cand) rem = nums.slice(1);
  }
  if (!cand || !cand.csv_ranges) return null;
  const read = async (kind: '住居表示' | '地番') => {
    const rg = cand!.csv_ranges![kind];
    if (!rg) return null;
    const r = await fetch(`${GEOLONIA}/${encodeURIComponent(pref.pref)}/${encodeURIComponent(city.full)}-${encodeURIComponent(kind)}.txt`, { headers: { Range: `bytes=${rg.start}-${rg.start + rg.length - 1}` } });
    if (!r.ok) return null;
    return (await r.text()).split('\n').slice(2);
  };
  const label = `${pref.pref}${city.full}${name(cand)}`;
  for (const kind of ['住居表示', '地番'] as const) {
    const rows = await read(kind);
    if (!rows) continue;
    const parsed = rows.map((l) => l.split(',')).filter((c) => c.length >= 5 && c[3] && c[4]);
    const n1 = rem[0];
    const n2 = rem[1];
    // 号（枝番）まで一致 → 番だけ一致（その番の平均位置）
    const exact = n2 != null ? parsed.filter((c) => +c[0] === n1 && +c[1] === n2) : [];
    const block = parsed.filter((c) => +c[0] === n1);
    const hit = exact.length ? exact : block;
    if (!hit.length) continue;
    const lon = hit.reduce((s, c) => s + +c[3], 0) / hit.length;
    const lat = hit.reduce((s, c) => s + +c[4], 0) / hit.length;
    const suffix = kind === '住居表示' ? (exact.length ? `${n1}番${n2}号` : `${n1}番`) : exact.length ? `${n1}番地${n2}` : `${n1}番地`;
    return { title: `${label}${suffix}`, lat, lon, precision: exact.length && kind === '住居表示' ? 'go' : 'ban' };
  }
  return null;
}

/**
 * 住所検索。国土地理院の住所検索 → 番地・号が未特定ならアドレス・ベース・レジストリで引き直し →
 * それでも無ければ OpenStreetMap。緯度経度や Google マップの URL の貼り付けにも対応
 */
export async function geocode(q: string, opts: { googleKey?: string } = {}): Promise<GeocodeResult[]> {
  const pt = parsePoint(q);
  if (pt) return [pt];
  const query = q.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const compact = query.replace(/\s+/g, '');
  // Google（ゼンリン由来の住所データ）: API キーがあれば最優先。地番地域・新しい番地にも強い
  if (opts.googleKey) {
    try {
      const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&region=jp&language=ja&key=${encodeURIComponent(opts.googleKey)}`);
      const js = (await res.json()) as { status: string; error_message?: string; results: { formatted_address: string; geometry: { location: { lat: number; lng: number }; location_type: string }; types: string[] }[] };
      if (js.status === 'OK' && js.results.length) {
        const g = js.results.slice(0, 5).map((r) => {
          const fine = r.geometry.location_type === 'ROOFTOP' || r.types.some((t) => ['street_address', 'premise', 'subpremise'].includes(t));
          const mid = r.geometry.location_type === 'RANGE_INTERPOLATED' || r.types.includes('route');
          const precision: GeocodePrecision = fine ? (/\d+号|-\d+-\d+/.test(r.formatted_address) ? 'go' : 'ban') : mid ? 'ban' : r.types.some((t) => /sublocality_level_[2-5]/.test(t)) ? 'chome' : 'town';
          return { title: r.formatted_address.replace(/^日本、?\s*/, '').replace(/^〒?\d{3}-\d{4}\s*/, ''), lat: r.geometry.location.lat, lon: r.geometry.location.lng, precision };
        });
        if (g.some((r) => r.precision === 'go' || r.precision === 'ban')) return g;
        // Google でも町名止まりなら、下の検索結果と合わせて返す
        const rest = await geocode(q);
        return [...g, ...rest];
      }
      if (js.status !== 'OK' && js.status !== 'ZERO_RESULTS') console.warn('Google geocoding:', js.status, js.error_message);
    } catch (e) {
      console.warn('Google geocoding failed', e);
    }
  }
  const tries: string[] = [compact];
  // 番地・号・建物名を後ろから外していく（「1丁目2-3」→「1丁目」→ 町名）
  let t = compact;
  for (let i = 0; i < 4; i++) {
    const next = t.replace(/[-ー−‐の]?[0-9]+(番地?|号)?[^0-9]*$/, '').replace(/[0-9]+丁目$/, (m) => (m === t ? '' : m));
    if (!next || next === t) break;
    tries.push(next);
    t = next;
  }
  let netErr: Error | null = null;
  const out: GeocodeResult[] = [];
  for (const qq of [...new Set(tries)]) {
    try {
      const res = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(qq)}`);
      if (!res.ok) throw new Error(`住所検索サーバーの応答がありません (${res.status})`);
      const js = (await res.json()) as { geometry: { coordinates: [number, number] }; properties: { title: string } }[];
      if (js.length) {
        out.push(...js.slice(0, 10).map((f) => ({ title: f.properties.title, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], precision: precisionOf(f.properties.title) })));
        break;
      }
    } catch (e) {
      netErr = e as Error;
    }
  }
  // 町名・丁目で止まった → 番地・号の座標を持つデータで引き直す
  const nums = tailNumbers(compact);
  if (nums.length && (!out.length || (out[0].precision !== 'go' && out[0].precision !== 'ban'))) {
    try {
      const base = out[0]?.title ?? compact;
      const abr = await lookupAbr(base, nums);
      if (abr) out.unshift(abr);
    } catch {
      // 2段目は補助なので失敗しても続ける
    }
  }
  if (!out.length || out[0].precision === 'town' || out[0].precision === 'chome') {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=jp&limit=8&accept-language=ja&q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const js = (await res.json()) as { lat: string; lon: string; display_name: string; class?: string; type?: string }[];
        for (const r of js) {
          const title = r.display_name.split(',').reverse().map((x) => x.trim()).filter((x) => x && x !== '日本' && !/^[0-9-]+$/.test(x)).join('');
          const p = r.class === 'building' || r.type === 'house' || /\d+$/.test(title) ? 'ban' : precisionOf(title);
          out.push({ title, lat: +r.lat, lon: +r.lon, precision: p });
        }
      }
    } catch (e) {
      netErr = netErr ?? (e as Error);
    }
  }
  if (!out.length && netErr) throw new Error(`住所検索サーバーに接続できませんでした（インターネット接続を確認してください）: ${netErr.message}`);
  // 精度の高いものを先に、同じ場所の重複は除く
  const rank: Record<GeocodePrecision, number> = { point: 0, go: 1, ban: 2, chome: 3, town: 4 };
  out.sort((a, b) => rank[a.precision] - rank[b.precision]);
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface AerialImage {
  canvas: HTMLCanvasElement;
  /** 画像の範囲（中心からの東西・南北 m） */
  west: number;
  east: number;
  south: number;
  north: number;
  attribution: string;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** 国土地理院 シームレス空中写真（最新）を中心から半径 radius m の範囲で取得 */
export async function fetchAerial(lat: number, lon: number, radius = 200, zoom = 18, kind: 'photo' | 'map' = 'photo'): Promise<AerialImage> {
  const { mLat, mLon } = metersPerDegree(lat);
  const dLat = radius / mLat;
  const dLon = radius / mLon;
  const t0 = lonLatToTile(lon - dLon, lat + dLat, zoom);
  const t1 = lonLatToTile(lon + dLon, lat - dLat, zoom);
  const x0 = Math.floor(t0.x);
  const y0 = Math.floor(t0.y);
  const x1 = Math.floor(t1.x);
  const y1 = Math.floor(t1.y);
  const nx = x1 - x0 + 1;
  const ny = y1 - y0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = nx * 256;
  canvas.height = ny * 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#8a9078';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const layer = kind === 'photo' ? 'seamlessphoto' : 'pale';
  const ext = kind === 'photo' ? 'jpg' : 'png';
  const jobs: Promise<void>[] = [];
  let ok = 0;
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      jobs.push(
        loadImage(`https://cyberjapandata.gsi.go.jp/xyz/${layer}/${zoom}/${tx}/${ty}.${ext}`).then((img) => {
          if (img) {
            ctx.drawImage(img, (tx - x0) * 256, (ty - y0) * 256);
            ok++;
          }
        }),
      );
    }
  await Promise.all(jobs);
  if (!ok) throw new Error('航空写真のタイルを1枚も取得できませんでした');
  const nw = tileToLonLat(x0, y0, zoom);
  const se = tileToLonLat(x1 + 1, y1 + 1, zoom);
  const a = toLocal(nw.lat, nw.lon, lat, lon);
  const b = toLocal(se.lat, se.lon, lat, lon);
  return { canvas, west: a.e, north: a.n, east: b.e, south: b.n, attribution: '出典: 国土地理院 地理院タイル（シームレス空中写真）' };
}

export interface NeighborBuilding {
  /** 中心からの東・北 (m) のリング */
  ring: { e: number; n: number }[];
  height: number;
  source: 'gsi' | 'osm' | 'manual';
  label?: string;
  /** 手で「消す」にした */
  hidden?: boolean;
  /** 手で「残す」にした（敷地に近くても自動では消さない） */
  keep?: boolean;
}

/** 国土地理院 最適化ベクトルタイル（建物 BldA）から周辺建物の外形を取得 */
export async function fetchGsiBuildings(lat: number, lon: number, radius = 120): Promise<NeighborBuilding[]> {
  const z = 16;
  const { mLat, mLon } = metersPerDegree(lat);
  const t0 = lonLatToTile(lon - radius / mLon, lat + radius / mLat, z);
  const t1 = lonLatToTile(lon + radius / mLon, lat - radius / mLat, z);
  const out: NeighborBuilding[] = [];
  let tiles = 0;
  let failed = 0;
  for (let ty = Math.floor(t0.y); ty <= Math.floor(t1.y); ty++)
    for (let tx = Math.floor(t0.x); tx <= Math.floor(t1.x); tx++) {
      tiles++;
      let layers: ReturnType<typeof decodeMvt>;
      try {
        const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${tx}/${ty}.pbf`);
        if (!res.ok) {
          if (res.status !== 404) failed++;
          continue;
        }
        layers = decodeMvt(new Uint8Array(await res.arrayBuffer()));
      } catch {
        failed++;
        continue;
      }
      const bld = layers['BldA'];
      if (!bld) continue;
      for (const f of bld.features) {
        if (f.type !== 3) continue;
        const code = Number(f.props['vt_code'] ?? 0);
        // 3101/3111 普通建物, 3102/3112 堅ろう建物, 3103/3113 高層建物
        const kind = code % 10;
        const height = kind === 3 ? 30 : kind === 2 ? 12 : 6.8;
        for (const ring of f.rings) {
          if (ring.length < 4) continue;
          // MVT の外周リングはタイル座標（y 下向き）で時計回り = 面積が正
          let tileArea = 0;
          for (let i = 0; i < ring.length; i++) {
            const [ax, ay] = ring[i];
            const [bx, by] = ring[(i + 1) % ring.length];
            tileArea += ax * by - bx * ay;
          }
          if (tileArea <= 0) continue; // 穴
          const pts = ring.map(([px, py]) => {
            const ll = tileToLonLat(tx + px / bld.extent, ty + py / bld.extent, z);
            return toLocal(ll.lat, ll.lon, lat, lon);
          });
          const c = pts.reduce((s, p) => ({ e: s.e + p.e / pts.length, n: s.n + p.n / pts.length }), { e: 0, n: 0 });
          if (Math.hypot(c.e, c.n) > radius) continue;
          out.push({ ring: pts, height, source: 'gsi' });
        }
      }
    }
  if (tiles && failed === tiles) throw new Error('国土地理院のサーバーに接続できませんでした');
  return dedupe(out);
}

/** OpenStreetMap（Overpass API）から建物を取得。高さ・階数タグがあれば利用 */
export async function fetchOsmBuildings(lat: number, lon: number, radius = 120): Promise<NeighborBuilding[]> {
  const q = `[out:json][timeout:25];way["building"](around:${radius},${lat},${lon});out geom tags;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q),
  });
  if (!res.ok) throw new Error(`OpenStreetMap の取得に失敗しました (${res.status})`);
  const js = (await res.json()) as { elements: { geometry?: { lat: number; lon: number }[]; tags?: Record<string, string> }[] };
  const out: NeighborBuilding[] = [];
  for (const el of js.elements) {
    if (!el.geometry || el.geometry.length < 4) continue;
    const tags = el.tags ?? {};
    let h = parseFloat(tags['height'] ?? '');
    if (!isFinite(h)) {
      const lv = parseFloat(tags['building:levels'] ?? '');
      h = isFinite(lv) ? lv * 3.1 + 0.6 : 6.8;
    }
    out.push({ ring: el.geometry.map((g) => toLocal(g.lat, g.lon, lat, lon)), height: h, source: 'osm', label: tags['name'] });
  }
  return out;
}

function dedupe(bs: NeighborBuilding[]): NeighborBuilding[] {
  const seen = new Set<string>();
  return bs.filter((b) => {
    const c = b.ring.reduce((s, p) => ({ e: s.e + p.e, n: s.n + p.n }), { e: 0, n: 0 });
    const k = `${Math.round(c.e / b.ring.length)}:${Math.round(c.n / b.ring.length)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
