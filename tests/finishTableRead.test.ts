// 立面図の外部仕上表を読み、コーディネートの初期値にする（parser/finishTable・coordinate/fromFinishTable）・PDF のページの中身（parser/pageMap）
import { describe, expect, it } from 'vitest';
import { readExteriorFinishTable } from '../src/parser/finishTable';
import { finishesFromTable } from '../src/coordinate/fromFinishTable';
import { classifyPage, titleBlockName } from '../src/parser/pageMap';
import type { PageVectors, RawText } from '../src/parser/pdfExtract';

const t = (str: string, cx: number, cy: number, size = 7.1, width?: number): RawText => ({ str, cx, cy, size, width: width ?? str.length * size, angle: 0 });

/** 御社の立面図の上の帯（田添様邸の意匠図と同じ並び） */
function page(): PageVectors {
  const texts = [
    t('外', 47, 45, 8.5), t('部', 47, 62, 8.5), t('仕', 47, 79, 8.5), t('上', 47, 96, 8.5), t('表', 47, 113, 8.5),
    t('屋 根', 66, 42, 7.1, 20), t('金属屋根', 91, 36), t('ｶﾗｰｶﾞﾙﾊﾞﾘｳﾑ鋼板', 124, 36), t('ｔ0.35 立平葺', 163, 36), t('色：コゲチャ', 250, 35), t('防火：ＮＭ－8697', 244, 50),
    t('破風・鼻隠', 66, 71, 7.1, 35), t('ｶﾞﾙﾊﾘｳﾑ鋼板', 96, 64), t('色：コゲチャ', 250, 64),
    t('軒樋', 281, 42), t('塩化ビニル製軒樋', 316, 36), t('色：モダンベージュ', 460, 50),
    t('外壁', 280, 93), t('③', 280, 103), t('ガルバリウム鋼板張り', 322, 92), t('4Kスパン', 361, 92), t('色：スターゴールド（K055）', 451, 92),
    t('玄関ドア', 710, 43), t('断熱玄関片開きドア', 750, 36), t('【YKK】ヴェナートD30', 750, 50), t('色：プラチナステン', 890, 50),
    t('外建具', 710, 71), t('樹脂アルミ複合サッシ3+16+3', 759, 64), t('【LIXIL】TW', 739, 78), t('色：外', 866, 64), t('シャイングレー', 895, 64),
    t('断熱材', 710, 99), t('屋根：セルロースファイバーｔ200 +', 768, 93),
  ];
  return { pageIndex: 8, width: 1191, height: 842, segments: [], curves: [], fills: [], texts };
}

describe('外部仕上表', () => {
  it('欄の名前ごとに、同じ行の帯で右の列の手前までの文字をつなぐ（「外壁」「③」はつなぐ・断熱材の欄は混ぜない）', () => {
    const rows = readExteriorFinishTable([page()]);
    const by = (p: string) => rows.find((r) => r.part === p);
    expect(by('屋根')?.text).toContain('立平葺');
    expect(by('屋根')?.color).toBe('コゲチャ');
    expect(by('外壁③')?.color).toBe('スターゴールド');
    expect(by('玄関ドア')?.text).toContain('ヴェナート');
    expect(by('外建具')?.color).toBe('シャイングレー');
    expect(by('外建具')?.text).not.toContain('セルロース');
  });
  it('コーディネートに当てる: 色の近い商品を選び、図面の文言は品番メモに。色が未定（〇〇〇〇）なら商品は変えない', () => {
    const ft = finishesFromTable(readExteriorFinishTable([page()]));
    expect(ft.finishes.roof).toBe('roof.gl.black');
    expect(ft.finishes.extWall).toBe('ext.gl.silver');
    expect(ft.wallColor).toBeTruthy();
    expect(ft.finishes.sash).toBe('sash.tw.silver');
    expect(ft.finishes.entDoor).toBe('door.venato.grey');
    expect(ft.notes.roof).toContain('立平葺');
    expect(ft.notes.roof).not.toContain('防火');
    const undecided = finishesFromTable([{ part: '屋根', text: 'ｶﾗｰｶﾞﾙﾊﾞﾘｳﾑ鋼板 立平葺 色：〇〇〇〇' }]);
    expect(undecided.finishes.roof).toBeUndefined();
    expect(undecided.notes.roof).toContain('立平葺');
  });
});

describe('PDF のページの中身', () => {
  it('図面枠の「図面名」の欄の名前で種類を決める', () => {
    const texts = [t('図面名', 42, 795), t('立面図', 167, 804, 10)];
    expect(titleBlockName(texts.map((x) => ({ str: x.str, x: x.cx, y: x.cy, size: x.size })))).toBe('立面図');
    expect(classifyPage(texts, 5000, []).kind).toBe('elevation');
    expect(classifyPage([t('図面名', 42, 795), t('配置図', 120, 800, 10)], 5000, []).kind).toBe('site');
  });
  it('平面図として読んだページは「N 階 平面図」、図面リストは図面名が並ぶ線の少ないページ', () => {
    expect(classifyPage([], 20000, [1, 2]).title).toBe('1・2階 平面図');
    const list = ['付近見取り図', '配置図', '立面図', '矩計図', '展開図①', '建具表'].map((s, i) => t(s, 100, 100 + i * 20));
    expect(classifyPage(list, 3000, []).kind).toBe('index');
  });
  it('図面名の欄が無くても「南 側」「北 側」の見出しが 2 つあれば立面図', () => {
    expect(classifyPage([t('南 側', 332, 372), t('立 面 図', 376, 372), t('北 側', 330, 662), t('立 面 図', 374, 662)], 4000, []).kind).toBe('elevation');
  });
});
