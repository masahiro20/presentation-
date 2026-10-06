/**
 * 日照ステップ（プレゼン側）の「座標で指定（緯度・経度）」の純粋な補助関数のテスト。DOM 無しで動く部分だけ:
 *  - 2 つの欄の読み取りと、緯度・経度を取り違えたときの入れ替えの検出（readCoordInput）
 *  - 座標で指定した建設地の住所文字列（coordAddress / isCoordAddress）
 *  - 「コピー」の文字列（coordClipText）が住所欄・緯度欄に貼り直して読める形であること
 * 角度の読み取り自体（parseDegrees / parseLatLonFields）は tests/geo.test.ts にある
 */
import { describe, expect, it } from 'vitest';
import { parseLatLonFields, parsePoint } from '../src/sun/geo';
import { COORD_PARSE_ERROR, COORD_SWAPPED_MSG, coordAddress, coordClipText, isCoordAddress, readCoordInput } from '../src/app/steps/sunStep';

const LAT = 35.21058;
const LON = 136.93831;

describe('readCoordInput: 緯度・経度の 2 つの欄を読む', () => {
  it('10 進の 2 欄 → そのまま（入れ替え無し）', () => {
    const r = readCoordInput('35.21058', '136.93831');
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(LAT, 9);
    expect(r!.lon).toBeCloseTo(LON, 9);
    expect(r!.swapped).toBe(false);
  });
  it('度分秒（N/E 付き・′″）→ 1e-5 以内', () => {
    const r = readCoordInput('35°12′38.1″N', '136°56′17.9″E');
    expect(r).not.toBeNull();
    expect(Math.abs(r!.lat - LAT)).toBeLessThan(1e-5);
    expect(Math.abs(r!.lon - LON)).toBeLessThan(1e-5);
    expect(r!.swapped).toBe(false);
  });
  it('漢字の度分秒・全角数字でも読める', () => {
    const r = readCoordInput('３５度１２分３８．１秒', '136度56分17.9秒');
    expect(r).not.toBeNull();
    expect(Math.abs(r!.lat - LAT)).toBeLessThan(1e-5);
    expect(Math.abs(r!.lon - LON)).toBeLessThan(1e-5);
  });
  it('日本国内でない座標（ロンドン 51.5 / -0.12）は null', () => {
    expect(readCoordInput('51.5', '-0.12')).toBeNull();
  });
  it('空欄・読めない文字は null', () => {
    expect(readCoordInput('', '')).toBeNull();
    expect(readCoordInput('abc', '136.93831')).toBeNull();
    expect(readCoordInput('35.21058', '')).toBeNull(); // 経度が無い（1 行でもない）
  });
  it('緯度と経度が逆（136.93831 / 35.21058）→ 入れ替えて swapped: true', () => {
    const r = readCoordInput('136.93831', '35.21058');
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(LAT, 9);
    expect(r!.lon).toBeCloseTo(LON, 9);
    expect(r!.swapped).toBe(true);
  });
  it('緯度欄だけに "緯度, 経度" の 1 行（経度欄は空）→ 読める（入れ替え無し）', () => {
    const r = readCoordInput('35.21058, 136.93831', '');
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(LAT, 9);
    expect(r!.lon).toBeCloseTo(LON, 9);
    expect(r!.swapped).toBe(false);
  });
  it('1 行で逆順（"136.93831, 35.21058"）→ 入れ替えて swapped: true', () => {
    const r = readCoordInput('136.93831, 35.21058', '  ');
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(LAT, 9);
    expect(r!.lon).toBeCloseTo(LON, 9);
    expect(r!.swapped).toBe(true);
  });
  it('1 行の度分秒（カンマ区切り）も読める', () => {
    const r = readCoordInput('35°12′38.1″N, 136°56′17.9″E', '');
    expect(r).not.toBeNull();
    expect(Math.abs(r!.lat - LAT)).toBeLessThan(1e-5);
    expect(Math.abs(r!.lon - LON)).toBeLessThan(1e-5);
    expect(r!.swapped).toBe(false);
  });
  it('緯度欄に Google マップの URL → 読める（入れ替え扱いにしない）', () => {
    const r = readCoordInput('https://www.google.com/maps/@35.21058,136.93831,17z', '');
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(LAT, 9);
    expect(r!.lon).toBeCloseTo(LON, 9);
    expect(r!.swapped).toBe(false);
  });
  it('案内の文言は入力の例と「日本国内」を含む', () => {
    expect(COORD_PARSE_ERROR).toContain('35.21058');
    expect(COORD_PARSE_ERROR).toContain('35°12′38.1″');
    expect(COORD_PARSE_ERROR).toContain('日本国内');
    expect(COORD_SWAPPED_MSG).toBe('緯度と経度が逆だったので入れ替えました');
  });
});

describe('coordAddress / isCoordAddress: 座標で指定した建設地の住所文字列', () => {
  it('住所検索の緯度経度貼り付け（parsePoint）の題名と同じ形に「付近」を添える', () => {
    expect(coordAddress(LAT, LON)).toBe('緯度 35.21058／経度 136.93831 付近');
    expect(coordAddress(LAT, LON).startsWith(parsePoint('35.21058, 136.93831')!.title)).toBe(true);
  });
  it('5 桁に丸める（≈ 1 m）', () => {
    expect(coordAddress(35.2105849, 136.9383149)).toBe('緯度 35.21058／経度 136.93831 付近');
  });
  it('coordAddress の文字列と parsePoint の題名は座標の住所、ふつうの住所や（仮）は違う', () => {
    expect(isCoordAddress(coordAddress(LAT, LON))).toBe(true);
    expect(isCoordAddress(parsePoint('35.21058, 136.93831')!.title)).toBe(true);
    expect(isCoordAddress('東京都千代田区丸の内（仮）')).toBe(false);
    expect(isCoordAddress('愛知県小牧市小牧4-213')).toBe(false);
    expect(isCoordAddress('')).toBe(false);
  });
});

describe('coordClipText: 「コピー」の文字列', () => {
  it('"緯度, 経度"（10 進 5 桁）', () => {
    expect(coordClipText(LAT, LON)).toBe('35.21058, 136.93831');
  });
  it('住所欄（parsePoint）にも緯度欄（parseLatLonFields の 1 行）にも貼り直して同じ座標に戻る', () => {
    const t = coordClipText(35.681236, 139.767121);
    expect(t).toBe('35.68124, 139.76712');
    const p = parsePoint(t)!;
    expect(p.lat).toBeCloseTo(35.68124, 9);
    expect(p.lon).toBeCloseTo(139.76712, 9);
    const q = parseLatLonFields(t)!;
    expect(q.lat).toBeCloseTo(35.68124, 9);
    expect(q.lon).toBeCloseTo(139.76712, 9);
    const r = readCoordInput(t, '')!;
    expect(r.swapped).toBe(false);
  });
});
