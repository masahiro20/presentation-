/**
 * 太陽位置の計算（NOAA Solar Calculator の式、誤差 ±0.01° 程度）
 */
import * as THREE from 'three';

const rad = Math.PI / 180;
const deg = 180 / Math.PI;

export interface SunPos {
  /** 方位角: 真北から時計回り (度) */
  azimuth: number;
  /** 高度角 (度, 大気差補正込み) */
  elevation: number;
  declination: number;
  /** 均時差 (分) */
  eqTime: number;
}

export function julianDay(d: Date) {
  return d.getTime() / 86400000 + 2440587.5;
}

export function sunPosition(date: Date, lat: number, lon: number): SunPos {
  const jd = julianDay(date);
  const T = (jd - 2451545) / 36525;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * rad) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * rad) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * rad) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad)) * deg;
  const y = Math.tan((eps / 2) * rad) ** 2;
  const eqTime =
    4 *
    deg *
    (y * Math.sin(2 * L0 * rad) -
      2 * e * Math.sin(M * rad) +
      4 * e * y * Math.sin(M * rad) * Math.cos(2 * L0 * rad) -
      0.5 * y * y * Math.sin(4 * L0 * rad) -
      1.25 * e * e * Math.sin(2 * M * rad));
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  let tst = utcMin + eqTime + 4 * lon;
  tst = ((tst % 1440) + 1440) % 1440;
  let ha = tst / 4 - 180;
  if (ha < -180) ha += 360;
  const cosZ = Math.sin(lat * rad) * Math.sin(decl * rad) + Math.cos(lat * rad) * Math.cos(decl * rad) * Math.cos(ha * rad);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZ))) * deg;
  let az: number;
  const denom = Math.cos(lat * rad) * Math.sin(zenith * rad);
  if (Math.abs(denom) > 1e-6) {
    const cosAz = (Math.sin(lat * rad) * Math.cos(zenith * rad) - Math.sin(decl * rad)) / denom;
    const a = Math.acos(Math.max(-1, Math.min(1, cosAz))) * deg;
    az = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
  } else {
    az = lat > 0 ? 180 : 0;
  }
  let elev = 90 - zenith;
  // 大気差
  if (elev > -0.575) {
    const te = Math.tan(elev * rad);
    let r: number;
    if (elev > 5) r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
    else r = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
    elev += r / 3600;
  } else {
    elev += -20.774 / Math.tan(elev * rad) / 3600;
  }
  return { azimuth: az, elevation: elev, declination: decl, eqTime };
}

/** 指定日（ローカル日付）・ローカル時刻 → Date。tz は UTC からの時差（時間） */
export function localDate(year: number, month: number, day: number, hours: number, tz = 9): Date {
  const ms = Date.UTC(year, month - 1, day, 0, 0, 0) + (hours - tz) * 3600000;
  return new Date(ms);
}

/** 真太陽時 (時) → ローカル時刻 (時)。日影規制は冬至日の真太陽時 8〜16 時で判定する */
export function trueSolarToLocal(year: number, month: number, day: number, solarHours: number, lon: number, tz = 9): number {
  // 均時差は日中ほぼ一定なので正午付近で評価
  const noon = sunPosition(localDate(year, month, day, 12, tz), 0, lon);
  const offsetMin = noon.eqTime + 4 * lon - tz * 60;
  return solarHours - offsetMin / 60;
}

export function sunriseSunset(year: number, month: number, day: number, lat: number, lon: number, tz = 9): { sunrise: number; sunset: number; noon: number } {
  // 高度 -0.833° を二分探索
  const elevAt = (h: number) => sunPosition(localDate(year, month, day, h, tz), lat, lon).elevation + 0.833;
  const noonLocal = trueSolarToLocal(year, month, day, 12, lon, tz);
  const find = (a: number, b: number) => {
    let fa = elevAt(a);
    for (let i = 0; i < 40; i++) {
      const m = (a + b) / 2;
      const fm = elevAt(m);
      if (fa * fm <= 0) b = m;
      else {
        a = m;
        fa = fm;
      }
    }
    return (a + b) / 2;
  };
  return { sunrise: find(noonLocal - 12, noonLocal), sunset: find(noonLocal + 12, noonLocal), noon: noonLocal };
}

/**
 * 太陽方向をワールド座標（建物の平面座標系）で返す。
 * northAngleDeg: 図面の上方向から真北への時計回り角
 */
export function sunDirectionWorld(az: number, elev: number, northAngleDeg: number): THREE.Vector3 {
  const a = northAngleDeg * rad;
  const north = { x: Math.sin(a), y: -Math.cos(a) };
  const east = { x: Math.cos(a), y: Math.sin(a) };
  const hx = north.x * Math.cos(az * rad) + east.x * Math.sin(az * rad);
  const hy = north.y * Math.cos(az * rad) + east.y * Math.sin(az * rad);
  const ce = Math.cos(elev * rad);
  return new THREE.Vector3(hx * ce, Math.sin(elev * rad), hy * ce).normalize();
}

export function formatHM(h: number) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${hh + (mm === 60 ? 1 : 0)}:${String(mm === 60 ? 0 : mm).padStart(2, '0')}`;
}

/** 二十四節気の主な日付 */
export function keyDates(year: number) {
  return [
    { id: 'winter', label: '冬至', month: 12, day: 22 },
    { id: 'spring', label: '春分', month: 3, day: 20 },
    { id: 'summer', label: '夏至', month: 6, day: 21 },
    { id: 'autumn', label: '秋分', month: 9, day: 23 },
  ].map((d) => ({ ...d, year }));
}
