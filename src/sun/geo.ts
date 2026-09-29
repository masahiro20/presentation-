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

export interface GeocodeResult {
  title: string;
  lat: number;
  lon: number;
}

/** 国土地理院 住所検索 API */
export async function geocode(q: string): Promise<GeocodeResult[]> {
  const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`住所検索に失敗しました (${res.status})`);
  const js = (await res.json()) as { geometry: { coordinates: [number, number] }; properties: { title: string } }[];
  return js.slice(0, 10).map((f) => ({ title: f.properties.title, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
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
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      jobs.push(
        loadImage(`https://cyberjapandata.gsi.go.jp/xyz/${layer}/${zoom}/${tx}/${ty}.${ext}`).then((img) => {
          if (img) ctx.drawImage(img, (tx - x0) * 256, (ty - y0) * 256);
        }),
      );
    }
  await Promise.all(jobs);
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
}

/** 国土地理院 最適化ベクトルタイル（建物 BldA）から周辺建物の外形を取得 */
export async function fetchGsiBuildings(lat: number, lon: number, radius = 120): Promise<NeighborBuilding[]> {
  const z = 16;
  const { mLat, mLon } = metersPerDegree(lat);
  const t0 = lonLatToTile(lon - radius / mLon, lat + radius / mLat, z);
  const t1 = lonLatToTile(lon + radius / mLon, lat - radius / mLat, z);
  const out: NeighborBuilding[] = [];
  for (let ty = Math.floor(t0.y); ty <= Math.floor(t1.y); ty++)
    for (let tx = Math.floor(t0.x); tx <= Math.floor(t1.x); tx++) {
      const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${tx}/${ty}.pbf`);
      if (!res.ok) continue;
      const layers = decodeMvt(new Uint8Array(await res.arrayBuffer()));
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
