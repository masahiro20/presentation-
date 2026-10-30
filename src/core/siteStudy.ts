/**
 * 敷地から先に検討（プランが無い段階）: 敷地の大きさ・建蔽率・容積率・希望の広さ・駐車台数から、
 * 「この敷地に、この希望が入るか」を数字と絵で出す。
 *
 * 使う人（設計士・営業）: 土地を見に行った日、図面を描く前に「2 階建てで 35 坪は入る・駐車 2 台は間口がぎりぎり」が言える。
 * 見る人（お客様）: 土地を買う前に、希望の広さと予算の見当がつく。
 *
 * 法規の確定（斜線・防火・地区計画など）はここでは扱わない。建蔽率・容積率は入力値をそのまま使う。
 */
import type { Wish } from './wishes';
import type { RoomType } from './types';

export type RoadSide = 'N' | 'E' | 'S' | 'W';

export interface SiteStudyInput {
  /** 間口（道路に面する辺）m */
  frontage: number;
  /** 奥行 m */
  depth: number;
  /** 敷地面積 ㎡（登記など。無ければ間口 × 奥行） */
  areaM2?: number;
  /** 建蔽率 %・容積率 % */
  bcr: number;
  far: number;
  road: RoadSide;
  /** 希望の延床（坪） */
  wantTsubo: number;
  floors: 1 | 2 | 3;
  cars: number;
  /** 坪単価（万円・税込の目安）。無ければ概算は出さない */
  tsuboPriceMan?: number;
  /** 隣地境界からの離れ m（外壁。民法の 0.5m が目安） */
  setback?: number;
  /** 用途地域などのメモ */
  zone?: string;
}

export interface StudyRow {
  status: 'ok' | 'check' | 'ng' | 'info';
  label: string;
  text: string;
}

export interface SiteStudyResult {
  siteM2: number;
  /** 建蔽率で建てられる建築面積の上限 ㎡ */
  maxFootprintM2: number;
  /** 容積率で建てられる延床の上限 ㎡ */
  maxFloorM2: number;
  wantM2: number;
  /** 希望の延床を階数で割った、必要な建築面積 ㎡ */
  footprintM2: number;
  /** 境界からの離れを引いた、建物を置ける範囲 m */
  buildableW: number;
  buildableD: number;
  /** 置ける最大の階数での延床（容積率と建蔽率の小さい方）㎡ */
  possibleFloorM2: number;
  /** 駐車 1 台 2.5 × 5.0m を道路側に並べたときの幅 m */
  parkingW: number;
  /** 建物の目安の幅・奥行 m（建蔽の範囲に入るように縦横比を決める） */
  bldgW: number;
  bldgD: number;
  /** 建物以外の空き（庭・通路）㎡ */
  openM2: number;
  costMan?: number;
  rows: StudyRow[];
  /** 結論（1 行） */
  verdict: 'ok' | 'check' | 'ng';
  verdictText: string;
}

const TSUBO = 3.30579;
export const tsubo = (m2: number) => m2 / TSUBO;
export const m2 = (t: number) => t * TSUBO;
const r1 = (v: number) => Math.round(v * 10) / 10;
export const floorsLabel = (n: number) => (n === 1 ? '平屋' : `${n} 階建て`);

/** 部屋ごとの目安の広さ（帖）。ご要望の文章から希望の延床を見積もる */
const ROOM_TATAMI: Partial<Record<RoomType, number>> = {
  ldk: 20,
  living: 12,
  dining: 8,
  kitchen: 5,
  bedroom: 8,
  kids: 6,
  japanese: 6,
  study: 4,
  bath: 2,
  washroom: 3,
  toilet: 1,
  entrance: 3,
  hall: 4,
  closet: 2,
  storage: 2,
};

/** ご要望の文章から、希望の延床（坪）と階数・駐車台数を見積もる。部屋が読めなければ null */
export function wantFromWishes(wishes: Wish[]): { tsubo: number; floors?: 1 | 2 | 3; cars?: number; breakdown: string } | null {
  let tat = 0;
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const w of wishes) {
    if (w.kind === 'room' && w.type && (ROOM_TATAMI as Record<string, number>)[w.type] != null) {
      const n = w.count ?? 1;
      const each = w.minTatami ?? (ROOM_TATAMI as Record<string, number>)[w.type];
      tat += each * n;
      parts.push(`${w.label}${n > 1 ? `×${n}` : ''} ${each * n}帖`);
      seen.add(w.type);
    } else if (w.kind === 'size' && w.type && w.minTatami) {
      const base = (ROOM_TATAMI as Record<string, number>)[w.type] ?? 0;
      if (!seen.has(w.type)) {
        tat += w.minTatami;
        parts.push(`${w.label}`);
        seen.add(w.type);
      } else tat += Math.max(0, w.minTatami - base);
    }
  }
  if (!tat) return null;
  // 水まわり・玄関・廊下・階段・収納が無ければ足す（帖）
  const must: [RoomType, number][] = [['bath', 2], ['washroom', 3], ['toilet', 1], ['entrance', 3]];
  for (const [t, v] of must) if (!seen.has(t)) tat += v;
  const circ = tat * 0.18; // 廊下・階段・収納
  const total = tat + circ;
  const storeys = wishes.find((w) => w.kind === 'storeys')?.storeys;
  const cars = wishes.find((w) => w.kind === 'parking')?.cars;
  return {
    tsubo: Math.round(tsubo(total * 1.62) * 2) / 2,
    floors: storeys === 1 || storeys === 2 || storeys === 3 ? storeys : undefined,
    cars,
    breakdown: `${parts.join('・')}＋水まわり・玄関＋廊下・階段・収納 18%`,
  };
}

export function siteStudy(i: SiteStudyInput): SiteStudyResult {
  const siteM2 = i.areaM2 && i.areaM2 > 0 ? i.areaM2 : i.frontage * i.depth;
  const sb = i.setback ?? 0.5;
  const maxFootprintM2 = (siteM2 * i.bcr) / 100;
  const maxFloorM2 = (siteM2 * i.far) / 100;
  const wantM2 = m2(i.wantTsubo);
  const footprintM2 = wantM2 / i.floors;
  const buildableW = Math.max(0, i.frontage - sb * 2);
  // 道路側は駐車・アプローチの分を取る（駐車 1 台 = 奥行 5m。無ければ 1.5m）
  const parkingDepth = i.cars > 0 ? 5 : 1.5;
  const buildableD = Math.max(0, i.depth - sb - parkingDepth);
  const possibleFloorM2 = Math.min(maxFloorM2, maxFootprintM2 * i.floors);
  const parkingW = i.cars * 2.5;
  // 建物の目安の形: 必要な建築面積を、置ける範囲に近い縦横比で
  const ratio = buildableW > 0 && buildableD > 0 ? buildableW / buildableD : 1;
  let bldgD = Math.sqrt(footprintM2 / ratio);
  let bldgW = footprintM2 / bldgD;
  if (bldgW > buildableW && buildableW > 0) {
    bldgW = buildableW;
    bldgD = footprintM2 / bldgW;
  }
  // 910 モジュールに丸める（半間 0.455）
  bldgW = Math.ceil(bldgW / 0.91) * 0.91;
  bldgD = Math.ceil(bldgD / 0.91) * 0.91;
  const openM2 = siteM2 - bldgW * bldgD - parkingW * 5;
  const rows: StudyRow[] = [];
  const fitsBcr = footprintM2 <= maxFootprintM2 + 0.01;
  const fitsFar = wantM2 <= maxFloorM2 + 0.01;
  const fitsShape = bldgW <= buildableW + 0.01 && bldgD <= buildableD + 0.01;
  rows.push({
    status: fitsBcr ? 'ok' : 'ng',
    label: '建蔽率',
    text: `建築面積 ${r1(footprintM2)} ㎡（${floorsLabel(i.floors)}で ${i.wantTsubo} 坪）に対し、上限 ${r1(maxFootprintM2)} ㎡（${i.bcr}%）${fitsBcr ? '' : `。${i.floors + 1} 階建てにするか、${r1(tsubo(maxFootprintM2 * i.floors))} 坪までに`}`,
  });
  rows.push({
    status: fitsFar ? 'ok' : 'ng',
    label: '容積率',
    text: `延床 ${r1(wantM2)} ㎡ に対し、上限 ${r1(maxFloorM2)} ㎡（${i.far}%）${fitsFar ? '' : `。${r1(tsubo(maxFloorM2))} 坪までに`}`,
  });
  rows.push({
    status: fitsShape ? 'ok' : bldgW <= buildableW + 0.01 || bldgD <= buildableD + 0.01 ? 'check' : 'ng',
    label: '形',
    text: `建物の目安 ${r1(bldgW)} × ${r1(bldgD)} m。境界から ${sb} m 離し、道路側に${i.cars > 0 ? `駐車 ${i.cars} 台（奥行 5 m）` : '通路'}を取ると、置ける範囲は ${r1(buildableW)} × ${r1(buildableD)} m${fitsShape ? '' : '。細長い形か、階数を増やす検討を'}`,
  });
  if (i.cars > 0) {
    const okW = parkingW <= i.frontage - 0.5;
    const side = parkingW + bldgW + sb * 2 <= i.frontage + 0.01;
    rows.push({
      status: okW ? (side ? 'ok' : 'info') : 'ng',
      label: '駐車',
      text: okW ? `${i.cars} 台を道路側に並べて幅 ${parkingW} m（間口 ${i.frontage} m）${side ? '。建物の横にも置けます' : '。建物の前に並ぶ形（玄関の位置に注意）'}` : `${i.cars} 台を並べる幅 ${parkingW} m が間口 ${i.frontage} m に入りません。縦列か、台数の見直しを`,
    });
  }
  rows.push({
    status: openM2 >= siteM2 * 0.25 ? 'ok' : openM2 >= siteM2 * 0.12 ? 'check' : 'ng',
    label: '庭・通路',
    text: `建物と駐車を除いた空き 約 ${Math.round(openM2)} ㎡（敷地の ${Math.round((openM2 / siteM2) * 100)}%）${openM2 < siteM2 * 0.12 ? '。物干し・給湯器・エアコンの置き場が厳しい広さです' : ''}`,
  });
  let costMan: number | undefined;
  if (i.tsuboPriceMan && i.tsuboPriceMan > 0) {
    costMan = Math.round(i.wantTsubo * i.tsuboPriceMan);
    rows.push({ status: 'info', label: '概算', text: `${i.wantTsubo} 坪 × 坪単価 ${i.tsuboPriceMan} 万円 ≒ 建物 ${costMan.toLocaleString('ja-JP')} 万円（税込の目安。外構・諸費用は別）` });
  }
  const ngs = rows.filter((r) => r.status === 'ng').length;
  const checks = rows.filter((r) => r.status === 'check').length;
  const verdict: SiteStudyResult['verdict'] = ngs ? 'ng' : checks ? 'check' : 'ok';
  const verdictText = ngs
    ? `このままでは入りません。この敷地なら${floorsLabel(i.floors)}で ${r1(tsubo(possibleFloorM2))} 坪まで（建蔽率・容積率から）`
    : checks
      ? `入りますが、形に工夫が要ります（${floorsLabel(i.floors)}で ${i.wantTsubo} 坪。上限 ${r1(tsubo(possibleFloorM2))} 坪）`
      : `${floorsLabel(i.floors)}で ${i.wantTsubo} 坪は入ります（この敷地の上限 ${r1(tsubo(possibleFloorM2))} 坪）`;
  return { siteM2, maxFootprintM2, maxFloorM2, wantM2, footprintM2, buildableW, buildableD, possibleFloorM2, parkingW, bldgW, bldgD, openM2, costMan, rows, verdict, verdictText };
}

/** 敷地と建物の目安の絵（道路側を下に）。幅 W px */
export function siteStudySvg(i: SiteStudyInput, r: SiteStudyResult, W = 360): string {
  const sb = i.setback ?? 0.5;
  const road = 4; // 道路の帯 m
  const margin = 1;
  const totalW = i.frontage + margin * 2;
  const totalH = i.depth + road + margin * 2;
  const s = W / totalW;
  const H = totalH * s;
  // 回転: road が N なら上下反転、E/W なら 90° 回す。簡単のため、道路を下に描き「道路（南）」などラベルで向きを示す
  const dirLabel = { N: '北', E: '東', S: '南', W: '西' }[i.road];
  const x0 = margin * s;
  const y0 = margin * s;
  const siteW = i.frontage * s;
  const siteH = i.depth * s;
  const parkingDepth = i.cars > 0 ? 5 : 1.5;
  const bx = x0 + ((i.frontage - r.bldgW) / 2) * s;
  // 入らないときは敷地の上にはみ出して描く（入らないことが絵で分かる）
  const by = y0 + (i.depth - parkingDepth - r.bldgD) * s;
  const bw = r.bldgW * s;
  const bh = r.bldgD * s;
  const fits = r.verdict !== 'ng';
  const parts: string[] = [];
  parts.push(`<rect x="${x0}" y="${y0}" width="${siteW}" height="${siteH}" fill="#f6f3ec" stroke="#8a847a" stroke-width="1.5"/>`);
  // 境界からの離れ（点線）
  parts.push(`<rect x="${x0 + sb * s}" y="${y0 + sb * s}" width="${(i.frontage - sb * 2) * s}" height="${(i.depth - sb) * s}" fill="none" stroke="#b9b2a5" stroke-dasharray="4 3"/>`);
  // 道路
  parts.push(`<rect x="0" y="${y0 + siteH}" width="${W}" height="${road * s}" fill="#e3e1dc"/>`);
  parts.push(`<text x="${W / 2}" y="${y0 + siteH + (road * s) / 2 + 4}" text-anchor="middle" font-size="11" fill="#6b665c">道路（${dirLabel}側）</text>`);
  // 駐車
  for (let k = 0; k < i.cars; k++) {
    const px = x0 + sb * s + k * 2.5 * s;
    const py = y0 + siteH - 5 * s;
    parts.push(`<rect x="${px}" y="${py}" width="${2.5 * s}" height="${5 * s}" fill="#ffffff" stroke="#9b9588" stroke-width="1"/>`);
    parts.push(`<text x="${px + 1.25 * s}" y="${py + 2.5 * s + 4}" text-anchor="middle" font-size="10" fill="#6b665c">車</text>`);
  }
  // 建物
  parts.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${fits ? '#c9b99a' : '#d99a90'}" fill-opacity="0.85" stroke="${fits ? '#7d6a44' : '#a3463b'}" stroke-width="1.5"/>`);
  parts.push(`<text x="${bx + bw / 2}" y="${by + bh / 2 - 2}" text-anchor="middle" font-size="11" fill="#2d2a24">${floorsLabel(i.floors)} ${i.wantTsubo} 坪</text>`);
  parts.push(`<text x="${bx + bw / 2}" y="${by + bh / 2 + 12}" text-anchor="middle" font-size="10" fill="#4a463e">${Math.round(r.bldgW * 10) / 10} × ${Math.round(r.bldgD * 10) / 10} m</text>`);
  // 寸法
  parts.push(`<text x="${x0 + siteW / 2}" y="${y0 - 2}" text-anchor="middle" font-size="10" fill="#6b665c">間口 ${i.frontage} m</text>`);
  parts.push(`<text x="${x0 + siteW + 3}" y="${y0 + siteH / 2}" font-size="10" fill="#6b665c" transform="rotate(90 ${x0 + siteW + 3} ${y0 + siteH / 2})" text-anchor="middle">奥行 ${i.depth} m</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="sans-serif">${parts.join('')}</svg>`;
}

/** 用途地域の目安（建蔽率／容積率）。自治体の指定で変わるので、入力の初期値に使うだけ */
export const ZONE_PRESETS: { id: string; label: string; bcr: number; far: number }[] = [
  { id: 'low1-40-80', label: '第一種低層住居専用（40／80）', bcr: 40, far: 80 },
  { id: 'low1-50-100', label: '第一種低層住居専用（50／100）', bcr: 50, far: 100 },
  { id: 'low1-60-150', label: '第一種低層住居専用（60／150）', bcr: 60, far: 150 },
  { id: 'mid-60-200', label: '中高層住居専用（60／200）', bcr: 60, far: 200 },
  { id: 'res-60-200', label: '第一種住居（60／200）', bcr: 60, far: 200 },
  { id: 'quasi-60-200', label: '準住居・準工業（60／200）', bcr: 60, far: 200 },
  { id: 'nb-80-200', label: '近隣商業（80／200）', bcr: 80, far: 200 },
  { id: 'none', label: '無指定（70／200 など。要確認）', bcr: 70, far: 200 },
];
