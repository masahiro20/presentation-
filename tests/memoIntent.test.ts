// 設計士のメモ（図面の吹き出し）から、こだわりの参考資料の下書きを作る（core/memoIntent.ts）
import { describe, expect, it } from 'vitest';
import { intentOfNote, intentToFocus, memoIntents, pendingIntents } from '../src/core/memoIntent';
import { normalizeFocus } from '../src/core/focus';
import type { BuildingModel, Floor } from '../src/core/types';

const floor = (level: number, notes: string[]): Floor =>
  ({ level, elevation: 500 + (level - 1) * 2900, height: 2900, ceilingHeight: 2400, walls: [], openings: [], rooms: [{ id: `F${level}-R1`, name: 'ＬＤＫ', type: 'ldk', polygon: [], area: 30, labelPos: { x: 0, y: 0 } }], stairs: [], outline: [], notes: notes.map((text, i) => ({ text, x: i * 100, y: 0, roomId: `F${level}-R1` })) }) as unknown as Floor;
const model = (...floors: Floor[]): BuildingModel => ({ name: 't', floors, northAngleDeg: 0 }) as unknown as BuildingModel;

describe('メモの言葉から部位と受け取り方を読む', () => {
  it('階段: つくりを言葉から決められるもの・決められないもの', () => {
    const a = intentOfNote('デザイン性の高い階段で素敵に!', 1)!;
    expect(a.part).toBe('stair');
    expect(a.stairBuild).toBeUndefined();
    expect(a.actionable).toBe(true);
    expect(intentOfNote('片持ち階段で軽やかに', 1)!.stairBuild).toBe('cantilever');
    expect(intentOfNote('黒の鉄骨階段がリビングのアクセント', 1)!.stairBuild).toBe('steel');
    expect(intentOfNote('階段下も使える箱階段です', 1)!.stairBuild).toBe('box');
    expect(intentOfNote('ガラスの手すりで抜け感のある階段に', 1)!.part).toBe('stair');
  });

  it('造作・照明・形の見せ場', () => {
    expect(intentOfNote('R壁を使ったニッチが素敵です', 1)).toMatchObject({ part: 'joinery', joinery: 'openShelf', actionable: true });
    expect(intentOfNote('家族で並べるスタディカウンター', 1)).toMatchObject({ part: 'joinery', joinery: 'counter' });
    expect(intentOfNote('窓辺の造作ベンチでひと休み', 1)).toMatchObject({ part: 'joinery', joinery: 'bench' });
    expect(intentOfNote('間接照明でホテルライクな寝室に', 2)).toMatchObject({ part: 'lighting', lighting: { indirect: true } });
    // 3D の形にはまだ無いもの: 部位だけ決めて、説明文に入れる
    expect(intentOfNote('丸柱は藤で巻いても素敵です!', 1)).toMatchObject({ part: 'living', actionable: false });
    expect(intentOfNote('湯船につかりながら自分だけのお庭を楽しめます!', 1)).toMatchObject({ part: 'bath', actionable: false });
    expect(intentOfNote('門をくぐって進むアプローチデザイン', 1)).toMatchObject({ part: 'entrance' });
    // 当たる言葉が無いメモも捨てない（その他として説明文に）
    expect(intentOfNote('ここがこの家のいちばんの見どころです', 1)).toMatchObject({ part: 'other', actionable: false });
  });

  it('読み取りが自分で足した注記・仕様書の決まり文句・短すぎる文は、設計士のメモとして扱わない', () => {
    expect(intentOfNote('玄関: ホールとの間が壁で閉じていたので、上がり框の位置に開口を置きました（違えば方眼で直せます）', 1)).toBeNull();
    expect(intentOfNote('子供室①: 戸が読めなかったので、WICとの壁に戸を置きました（違えば方眼で位置・種類を直せます）', 2)).toBeNull();
    expect(intentOfNote('車庫: 車の出入口が読めなかったので、外に面した 7,400mm の辺にシャッターを置きました（違えば方眼の「シャッター」で直せます）', 1)).toBeNull();
    expect(intentOfNote('LDK: 天井高 2700 mm（図面の注記）', 1)).toBeNull();
    expect(intentOfNote('くぎ N50・@150mm以下', 2)).toBeNull();
    expect(intentOfNote('サッシ性能値:別紙自己宣言書によるLOW-Eとする。', 2)).toBeNull();
    expect(intentOfNote('全ての配管系を13A以下とする', 2)).toBeNull();
    expect(intentOfNote('階段', 1)).toBeNull();
    // 設計の作業メモ（検討・納まりの申し送り）も、こだわりの下書きにはしない
    expect(intentOfNote('階段は1~2、2~3Fの蹴上をそろえる', 2)).toBeNull();
    expect(intentOfNote('建具は柱の位置で何枚割りにするか検討', 1)).toBeNull();
  });

  it('場所の言葉が 2 つある文は、文の終わりの言葉が主役', () => {
    // 御社の図面のメモ（吉田様邸の次の版）
    expect(intentOfNote('お庭を囲むようにつながる緩やかなL字のLDKです', 1)!.part).toBe('living');
    expect(intentOfNote('お庭を眺め、LDKにいる家族の気配も感じながら自分時間を楽しめるトレーニングガレージ', 1)!.part).toBe('exterior');
    expect(intentOfNote('奥行きのある広々玄関', 1)!.part).toBe('entrance');
    expect(intentOfNote('ただ自分だけの空を眺める中庭', 1)!.part).toBe('exterior');
    // 終わりが場所の言葉でなければ、立っている部屋の側（庭はそこから見えるもの）
    expect(intentOfNote('湯船につかりながら自分だけのお庭を楽しめます!', 1)!.part).toBe('bath');
    expect(intentOfNote('玄関からもツリーが見えます!', 1)!.part).toBe('entrance');
  });

  it('どの部屋にもある話（光・窓・壁の仕上げ・天井）は、メモが書かれている部屋のこだわりにする', () => {
    expect(intentOfNote('東から光を取り込みます', 2, { roomName: '洋室', roomType: 'bedroom' })).toMatchObject({ part: 'living', reading: '光・風の入り方', roomName: '洋室' });
    expect(intentOfNote('猫が見える地窓+天井付け窓', 1, { roomName: 'ポーチ', roomType: 'porch' })!.part).toBe('entrance');
    expect(intentOfNote('タイル貼り(ふかし壁)', 1, { roomName: '洗面', roomType: 'washroom' })!.part).toBe('bath');
    expect(intentOfNote('折上げ天井', 2)!.part).toBe('living');
    // 当たる言葉が無くても、部屋が分かればその部屋のこだわり（説明文に入る）
    expect(intentOfNote('家族の置物を飾る場所', 1, { roomName: 'トイレ', roomType: 'toilet' })).toMatchObject({ part: 'bath', actionable: false });
    // 位置と部屋を持ち回る（3D でその場所を見せる・その部屋のこだわりにするため）
    expect(intentOfNote('背面収納として活用', 1, { roomName: 'キッチン', roomType: 'kitchen', roomId: 'F1-R3', x: 1200, y: 3400 })).toMatchObject({ part: 'kitchen', roomId: 'F1-R3', x: 1200, y: 3400 });
  });

  it('玄関の足元の間接照明・造作の机は、3D に反映できる', () => {
    expect(intentOfNote('かまち下靴入れ・間接照明', 1)).toMatchObject({ part: 'lighting', lighting: { indirect: true }, actionable: true });
    expect(intentOfNote('机W2500~D500ほど', 1)).toMatchObject({ part: 'joinery', joinery: 'counter', actionable: true });
    expect(intentOfNote('可動棚D450*5段:クロス色合わせ', 1)).toMatchObject({ part: 'joinery', actionable: false });
    expect(intentOfNote('TV周り作りこむ', 1)).toMatchObject({ part: 'joinery', joinery: 'floatTv' });
    expect(intentOfNote('階段一段目と兼ねたベンチ', 1)).toMatchObject({ part: 'stair', actionable: true });
    expect(intentOfNote('アートなど飾る飾り棚', 2)).toMatchObject({ part: 'joinery', joinery: 'openShelf' });
  });

  it('同じ図面を読み直しても id は同じ。階が違えば別', () => {
    const a = intentOfNote('デザイン性の高い階段で素敵に!', 1)!;
    expect(intentOfNote(' デザイン性の高い階段で素敵に! ', 1)!.id).toBe(a.id);
    expect(intentOfNote('デザイン性の高い階段で素敵に!', 2)!.id).not.toBe(a.id);
    expect(a.id.startsWith('memo-1-')).toBe(true);
  });
});

describe('図面のメモの一覧と、こだわり指定への取り込み', () => {
  const m = model(floor(1, ['お庭を囲むようにつながる緩やかなL字のLDKです', 'デザイン性の高い階段で素敵に!', 'デザイン性の高い階段で素敵に!']), floor(2, ['間接照明で落ち着く寝室に']));

  it('3D に反映できるメモが先。同じ文は 1 つに', () => {
    const list = memoIntents(m);
    expect(list.map((it) => it.part)).toEqual(['stair', 'lighting', 'living']);
    expect(memoIntents(null)).toEqual([]);
    // 各階に同じ文が書かれていても 1 つ（階段の指定だけは、階ごとに別）
    const same = model(floor(1, ['東から光を取り込みます', '片持ち階段で軽やかに']), floor(2, ['東から光を取り込みます', '片持ち階段で軽やかに']));
    expect(memoIntents(same).map((it) => `${it.level}${it.part}`)).toEqual(['1stair', '2stair', '1living']);
  });

  it('取り込んだもの・見送ったものは、下書きの一覧から消える', () => {
    const all = memoIntents(m);
    const stair = all[0];
    const note = intentToFocus(stair, '2026-11-14T00:00:00Z');
    expect(note).toMatchObject({ id: stair.id, part: 'stair', level: 1, note: 'デザイン性の高い階段で素敵に!', images: [] });
    // こだわり指定として、そのまま保存できる形
    expect(normalizeFocus([note])[0]).toMatchObject({ id: stair.id, part: 'stair', level: 1 });
    expect(pendingIntents(m, [note]).map((it) => it.id)).not.toContain(stair.id);
    expect(pendingIntents(m, [], [all[1].id]).map((it) => it.id)).toEqual([all[0].id, all[2].id]);
    // 階段の無い階のメモは「すべての階段」の指定にする
    expect(intentToFocus(stair, '', () => false).level).toBeUndefined();
  });

  it('造作のメモは、形を持ったこだわり指定になる', () => {
    const it2 = intentOfNote('R壁を使ったニッチが素敵です', 1)!;
    expect(intentToFocus(it2, '')).toMatchObject({ part: 'joinery', joinery: 'openShelf' });
  });
});
