// 図面のメモの出どころ（設計士のメモ／読み取りが足した注記／仕様書の決まり文句）を見分ける（core/planNotes.ts）
import { describe, expect, it } from 'vitest';
import { designerNotes, labelNotes, noteKind } from '../src/core/planNotes';
import { detectNotes } from '../src/parser/symbols';
import type { Room } from '../src/core/types';

const N = (text: string) => ({ text, x: 0, y: 0 });

describe('図面のメモの出どころ', () => {
  it('設計士が書いた言葉は memo', () => {
    for (const t of ['デザイン性の高い階段で素敵に!', 'R壁を使ったニッチが素敵です', '湯船につかりながら自分だけのお庭を楽しめます!', '家族の置物', '横滑り出し', '少しスペースいただきます', '机W2500~D500ほど'])
      expect(noteKind(t), t).toBe('memo');
  });

  it('読み取りが自分で足した注記は tool（社内の作業用）', () => {
    for (const t of [
      '子供室①: 戸が読めなかったので、WICとの壁に戸を置きました（違えば方眼で位置・種類を直せます）',
      '玄関: ホールとの間が壁で閉じていたので、上がり框の位置に開口を置きました（違えば方眼で直せます）',
      '車庫: 車の出入口が読めなかったので、外に面した 7,400mm の辺にシャッターを置きました（違えば方眼の「シャッター」で直せます）',
      '玄関: 外に面した窓（幅 1,200）を玄関ドアとして扱いました（違えば方眼で直せます）',
      'LDK: 天井高 2700 mm（図面の注記）',
    ])
      expect(noteKind(t), t).toBe('tool');
  });

  it('仕様書・申請図の決まり文句は spec（メモではない）', () => {
    for (const t of [
      'くぎ N50・@150mm以下',
      'サッシ性能値:別紙自己宣言書によるLOW-Eとする。',
      '※内部建具はアンダーカット仕様とする。※石綿及びクロルピリホスを含む建築材料は使用しない。',
      'コンクリート内埋め込み配管なし。横引き配管にて施工。',
      '壁PB12.5mm貼り 天井PB9.5mm準不燃ビニルクロス仕上げ(QM認定品)',
      '全ての配管系を13A以下とする',
      '開口部の断熱性能(各階共通)',
      '壁付(天井より下方0.15m以上0.5m以内とする)',
      '非常用進入口に代わる窓',
    ])
      expect(noteKind(t), t).toBe('spec');
  });

  it('設計の作業メモ（検討・納まりの申し送り）は work（お客様には出さない）', () => {
    for (const t of ['建具は柱の位置で何枚割りにするか検討', '階段は1~2、2~3Fの蹴上をそろえる', '袖壁控える。', '乾太くんダクト経路', '(玄関ドア天端合わせ)', '構造計算により天井高が変更になる可能性があります', '寝室の手前にしてもいいかもしれません。', 'ピタッと合わせて面にする'])
      expect(noteKind(t), t).toBe('work');
  });

  it('お客様に出すのは設計士のメモだけ。社内の 3D の札には読み取りの注記も出す（仕様の決まり文句は出さない）', () => {
    const f = { notes: [N('デザイン性の高い階段で素敵に!'), N('洋室: 戸が読めなかったので、ホールとの壁に戸を置きました（違えば方眼で位置・種類を直せます）'), N('くぎ N50・@150mm以下'), N('袖壁控える。')] };
    expect(designerNotes(f).map((n) => n.text)).toEqual(['デザイン性の高い階段で素敵に!']);
    expect(labelNotes(f, true).length).toBe(3);
    expect(labelNotes(f, false).length).toBe(1);
    expect(designerNotes(null)).toEqual([]);
    expect(designerNotes({})).toEqual([]);
  });
});

describe('図面からメモを拾う（detectNotes）', () => {
  const T = (str: string, x: number, y: number, size: number) => ({ str, x, y, size, angle: 0 }) as never;
  const room = (name: string, x: number, y: number): Room => ({ id: `R-${name}`, name, type: 'other', polygon: [{ x: x - 900, y: y - 900 }, { x: x + 900, y: y - 900 }, { x: x + 900, y: y + 900 }, { x: x - 900, y: y + 900 }], area: 3.2, labelPos: { x, y } }) as unknown as Room;

  it('室名より小さい文字の文を拾い、続く行はつなぐ', () => {
    const notes = detectNotes([T('湯船につかりながら', 2600, 10900, 182), T('自分だけのお庭を楽しめます!', 3000, 11100, 182), T('玄関', 11600, 5700, 199)], 199, [room('玄関', 11600, 5700)]);
    expect(notes.map((n) => n.text)).toEqual(['湯船につかりながら自分だけのお庭を楽しめます!']);
  });

  it('室名と同じ大きさで書かれた文も拾う（吉田様邸の次の版）。室名そのものは拾わない', () => {
    const rooms = [room('階段', 6600, 2700), room('玄関', 11600, 5700), room('こども部屋', 3000, 3000)];
    const notes = detectNotes([T('デザイン性の高い階段で素敵に!', 8200, 4000, 199), T('奥行きのある広々玄関', 14200, 5200, 199), T('階段', 6600, 2700, 199), T('玄関', 11600, 5700, 199), T('こども部屋', 3000, 3000, 199)], 199, rooms);
    expect(notes.map((n) => n.text).sort()).toEqual(['デザイン性の高い階段で素敵に!', '奥行きのある広々玄関'].sort());
  });

  it('見出しのような大きい文字・仕様書の決まり文句は拾わない', () => {
    const notes = detectNotes([T('家づくりのご提案をいたします', 5000, 500, 420), T('全ての配管系を13A以下とする', 5000, 9000, 150), T('くぎ N50・@150mm以下', 5000, 9500, 150)], 199, []);
    expect(notes).toEqual([]);
  });
});
