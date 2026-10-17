/**
 * 建設地のステップ「座標で指定（緯度・経度）」の純粋な補助関数（src/sunstudy/steps/placeStep.ts）のテスト。
 * 角度の読み取りそのもの（parseDegrees / parseLatLonFields）は tests/geo.test.ts にあるので、ここでは
 *  - 取り違え（緯度と経度が逆）の判定 swapped が、2 欄・1 行のどちらでも正しく付くこと
 *  - 読めない・国外・片方だけの入力は null
 *  - コピー用の文字列が「緯度, 経度」（10 進 5 桁）で、住所検索の欄にそのまま貼れる形（parseLatLonFields で読める）であること
 */
import { describe, expect, it } from 'vitest';
import { coordClipboardText, readCoordInput } from '../src/sunstudy/steps/placeStep';
import { parseLatLonFields } from '../src/sun/geo';

describe('readCoordInput: 座標の入力欄の読み取りと取り違えの判定', () => {
  it('緯度・経度の 2 欄（10 進）→ 入れ替え無し', () => {
    expect(readCoordInput('35.21058', '136.93831')).toEqual({ lat: 35.21058, lon: 136.93831, swapped: false });
  });
  it('2 欄が逆（経度を緯度の欄に）→ 入れ替えて swapped = true', () => {
    expect(readCoordInput('136.93831', '35.21058')).toEqual({ lat: 35.21058, lon: 136.93831, swapped: true });
  });
  it('度分秒（N/E 付き）→ 1e-5 の精度で読め、入れ替え無し', () => {
    const r = readCoordInput('35°12′38.1″N', '136°56′17.9″E');
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(35.210583, 5);
    expect(r!.lon).toBeCloseTo(136.938306, 5);
    expect(r!.swapped).toBe(false);
  });
  it('度分秒で逆に入れても取り違えと判定する', () => {
    const r = readCoordInput('136度56分17.9秒', '35度12分38.1秒');
    expect(r!.lat).toBeCloseTo(35.210583, 5);
    expect(r!.swapped).toBe(true);
  });
  it('経度の欄が空: 緯度の欄の「緯度, 経度」の 1 行を読む（逆なら swapped）', () => {
    expect(readCoordInput('35.21058, 136.93831', '')).toEqual({ lat: 35.21058, lon: 136.93831, swapped: false });
    expect(readCoordInput('136.93831, 35.21058', '')).toEqual({ lat: 35.21058, lon: 136.93831, swapped: true });
    expect(readCoordInput('３５．２１０５８，１３６．９３８３１')).toEqual({ lat: 35.21058, lon: 136.93831, swapped: false });
  });
  it('経度の欄が空: Google マップの URL を読む（入れ替え無し）', () => {
    expect(readCoordInput('https://www.google.com/maps/@35.21058,136.93831,17z', '')).toEqual({ lat: 35.21058, lon: 136.93831, swapped: false });
    expect(readCoordInput('https://www.google.com/maps?q=35.21058,136.93831')).toEqual({ lat: 35.21058, lon: 136.93831, swapped: false });
  });
  it('読めない・国外・片方だけは null', () => {
    expect(readCoordInput('51.5', '-0.12')).toBeNull(); // ロンドン: 日本国内でない
    expect(readCoordInput('', '')).toBeNull();
    expect(readCoordInput('35.21058', '')).toBeNull(); // 緯度だけ
    expect(readCoordInput('', '136.93831')).toBeNull(); // 経度だけ
    expect(readCoordInput('名古屋市', '')).toBeNull();
    expect(readCoordInput('abc', 'def')).toBeNull();
  });
});

describe('coordClipboardText: コピーする「緯度, 経度」', () => {
  it('10 進 5 桁（≈ 1 m）で、住所検索の欄にそのまま貼って読める', () => {
    const text = coordClipboardText({ lat: 35.210583, lon: 136.938306 });
    expect(text).toBe('35.21058, 136.93831');
    expect(parseLatLonFields(text)).toEqual({ lat: 35.21058, lon: 136.93831 });
  });
});
