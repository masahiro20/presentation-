import { describe, expect, it } from 'vitest';
import { pageDrawingKind } from '../src/parser/assemble';

const T = (...s: string[]) => s.map((str) => ({ str }));

describe('ページが何の図面か（立面図のページを階として読まない）', () => {
  it('立面図 4 面のページ（吉田様邸 1st プランの 2 ページ目）は elevation', () => {
    const texts = T('南側', '立面図', '東側', '立面図', '北側', '立面図', '西側', '立面図', '2階軒高', '1階ＦＬ', '2階ＦＬ', '3,200（階高）', '2,800（階高）', '7,009（最高高さ）', 'ＧＬ', '立面図', 'R8.11.07', '1/100');
    expect(pageDrawingKind(texts, { docHasRooms: true, multiPage: true })).toBe('elevation');
    // 1 ページだけの PDF でも立面図は立面図
    expect(pageDrawingKind(texts, { docHasRooms: false, multiPage: false })).toBe('elevation');
  });

  it('平面図のページは plan（室名・帖数がある）', () => {
    const texts = T('1階', '平面図', 'ＬＤＫ', '16.0帖', '玄関', '洋室', 'ＵＢ', 'トイレ', '階段');
    expect(pageDrawingKind(texts, { docHasRooms: true, multiPage: true })).toBe('plan');
  });

  it('配置図兼平面図に立面図が添えられたページは plan（平面図の見出しがある）', () => {
    const texts = T('配置図兼1階平面図', '南立面図', 'ＬＤＫ', '玄関', '洋室', '1階ＦＬ');
    expect(pageDrawingKind(texts, { docHasRooms: true, multiPage: true })).toBe('plan');
  });

  it('室名の無い表・図面枠のページは other（他のページに室名があるとき）', () => {
    const texts = T('外部仕上表', '屋根', 'ガルバリウム鋼板', '外壁', 'ジョリパット', 'R8.11.07');
    expect(pageDrawingKind(texts, { docHasRooms: true, multiPage: true })).toBe('other');
    // 1 ページだけなら平面図として試す（室名が画像の図面もある）
    expect(pageDrawingKind(texts, { docHasRooms: false, multiPage: false })).toBe('plan');
  });

  it('スキャン図面（画像）は見出しが読めないので plan のまま', () => {
    expect(pageDrawingKind([], { raster: true, docHasRooms: true, multiPage: true })).toBe('plan');
  });
});
