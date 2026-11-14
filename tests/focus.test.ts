// こだわり指定（参考資料）: 階段のつくり・手すり・段数を 3D と図面に入れる／写るカットの説明文に足す
import { describe, expect, it } from 'vitest';
import { applyFocus, cleanLighting, cleanStairLook, FOCUS_PARTS, focusForShot, focusFromModel, focusImageName, focusLookShort, focusPromptLines, normalizeFocus, stairLookAt, stairLookShort, stairLookText, stairNoteFor, stairNoteIndexToEdit, stairTailText, type FocusNote } from '../src/core/focus';
import { effectiveStepCount, stairStepCount } from '../src/core/stairs';
import type { BuildingModel, Floor, Stair } from '../src/core/types';

const stair = (id: string, goesUp = true, extra: Partial<Stair> = {}): Stair => ({ id, minX: 0, minY: 0, maxX: 910, maxY: 3185, kind: 'straight', entry: 's', goesUp, ...extra });
const floor = (level: number, stairs: Stair[]): Floor => ({ level, elevation: 500 + (level - 1) * 2900, height: 2900, ceilingHeight: 2400, walls: [], openings: [], rooms: [], stairs, outline: [] }) as unknown as Floor;
const model = (): BuildingModel => ({ name: 't', floors: [floor(1, [stair('F1-S1')]), floor(2, [stair('F2-S1'), stair('F2-S2', false)]), floor(3, [stair('F3-S1', false)])], northAngleDeg: 0, report: {} }) as unknown as BuildingModel;
const IMG = 'data:image/jpeg;base64,AAAA';
const note = (p: Partial<FocusNote>): FocusNote => ({ id: 'n1', part: 'stair', note: '', images: [], at: '2026-11-12T00:00:00Z', ...p });

describe('階段の指定をモデルに当てる', () => {
  it('上の階へ上がる階段に、つくり・手すり・段数が入る（降りる側の記録には入れない）', () => {
    const m = model();
    const n = applyFocus(m, [note({ stair: { rail: 'glass', steps: 14 } })]);
    expect(n).toBe(2);
    expect(m.floors[0].stairs[0].look).toEqual({ rail: 'glass', steps: 14 });
    expect(m.floors[1].stairs[0].look).toEqual({ rail: 'glass', steps: 14 });
    expect(m.floors[1].stairs[1].look).toBeUndefined();
    expect(m.floors[2].stairs[0].look).toBeUndefined();
  });

  it('階を決めた指定は、その階の階段だけ。「すべての階段」の指定の上に重なる', () => {
    const m = model();
    applyFocus(m, [note({ id: 'a', level: 2, stair: { rail: 'wall' } }), note({ id: 'b', stair: { rail: 'bar', steps: 14 } })]);
    expect(m.floors[0].stairs[0].look).toEqual({ rail: 'bar', steps: 14 });
    expect(m.floors[1].stairs[0].look).toEqual({ rail: 'wall', steps: 14 });
  });

  it('指定を消して当て直すと、図面の読み取りどおりに戻る', () => {
    const m = model();
    m.floors[0].stairs[0].steps = 13;
    applyFocus(m, [note({ stair: { steps: 15 } })]);
    expect(effectiveStepCount(2900, m.floors[0].stairs[0])).toBe(15);
    applyFocus(m, []);
    expect(m.floors[0].stairs[0].look).toBeUndefined();
    expect(effectiveStepCount(2900, m.floors[0].stairs[0])).toBe(13);
  });

  it('指定の段数は、図面の注記・段の間隔からの段数より優先（図面の表記と 3D の両方）', () => {
    const s = stair('S', true, { steps: 13, treadPitch: 227.5, look: { steps: 16 } });
    expect(effectiveStepCount(2900, s)).toBe(16);
    expect(stairStepCount(2900, s)).toBe(16);
  });

  it('言葉・画像だけの指定（手すり・段数を選んでいない）は、3D を変えない', () => {
    const m = model();
    expect(applyFocus(m, [note({ note: '踏板は無垢のオーク', images: [{ url: IMG }] })])).toBe(0);
    expect(m.floors[0].stairs[0].look).toBeUndefined();
  });

  it('その階段に当たる指定を引ける（階を決めたものが先）', () => {
    const notes = [note({ id: 'all', stair: { rail: 'bar' } }), note({ id: 'f2', level: 2, stair: { rail: 'wall' } })];
    expect(stairNoteFor(notes, 2)?.id).toBe('f2');
    expect(stairNoteFor(notes, 1)?.id).toBe('all');
    expect(stairNoteFor([], 1)).toBeUndefined();
  });
});

describe('3D で階段を直す・元に戻す', () => {
  const twoStory = (): BuildingModel => ({ name: 't', floors: [floor(1, [stair('F1-S1')]), floor(2, [stair('F2-S1', false)])], northAngleDeg: 0, report: {} }) as unknown as BuildingModel;
  let seq = 0;
  const newId = () => `new${++seq}`;

  it('直す指定: その階を決めたもの。階段が 1 か所だけの家は「すべての階段」の指定（同じ階段の指定を 2 つにしない）', () => {
    const all = note({ id: 'all', stair: { rail: 'glass' } });
    expect(stairNoteIndexToEdit([all], 1, [1])).toBe(0);
    expect(stairNoteIndexToEdit([all], 2, [1, 2])).toBe(-1);
    expect(stairNoteIndexToEdit([all, note({ id: 'f2', level: 2 })], 2, [1, 2])).toBe(1);
    expect(stairNoteIndexToEdit([note({ id: 'k', part: 'kitchen', note: 'x' })], 1, [1])).toBe(-1);
  });

  it('その階の階段に入る指定（重ねた結果）', () => {
    const notes = [note({ id: 'f2', level: 2, stair: { rail: 'wall' } }), note({ id: 'all', stair: { rail: 'bar', steps: 14 } })];
    expect(stairLookAt(notes, 1)).toEqual({ rail: 'bar', steps: 14 });
    expect(stairLookAt(notes, 2)).toEqual({ rail: 'wall', steps: 14 });
    expect(stairLookAt([note({ note: '言葉だけ' })], 1)).toBeUndefined();
  });

  it('当て直しても、中身が同じならモデルの写しは変わらない（何もしていないのに「直した」にならない）', () => {
    const m = twoStory();
    const notes = [note({ stair: { rail: 'wall' } })];
    applyFocus(m, notes);
    // 指定のあとに別の項目が足された階段（順番が look → steps）でも、当て直しで順番を入れ替えない
    m.floors[0].stairs[0].steps = 14;
    const before = JSON.stringify(m);
    applyFocus(m, notes);
    expect(JSON.stringify(m)).toBe(before);
  });

  it('元に戻したモデルに指定を合わせる: 手すりだけの指定は消え、言葉・画像のある指定は手すりだけ戻る', () => {
    // 3D で「腰壁」にした（指定ができた）→ 元に戻す（モデルの階段は指定なしに戻る）
    const m = twoStory();
    expect(focusFromModel(m, [note({ id: 'a', stair: { rail: 'wall' } })], newId, 't')).toEqual([]);
    // 参考画像とひとことのある指定（ガラス・14 段）を、3D で腰壁に変えた → 元に戻す
    const m2 = twoStory();
    m2.floors[0].stairs[0].look = { rail: 'glass', steps: 14 };
    const [n] = focusFromModel(m2, [note({ id: 'a', note: '踏板はオーク', images: [{ url: IMG }], stair: { rail: 'wall', steps: 14 } })], newId, 't');
    expect(n).toMatchObject({ id: 'a', note: '踏板はオーク', stair: { rail: 'glass', steps: 14 } });
    expect(n.images).toHaveLength(1);
  });

  it('やり直す: 消えた指定を作り直す。3 階建ては、その階の指定として（「すべての階段」は触らない）', () => {
    const m = twoStory();
    m.floors[0].stairs[0].look = { rail: 'glass' };
    const back = focusFromModel(m, [], newId, 't');
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ part: 'stair', level: 1, stair: { rail: 'glass' } });

    const m3 = model();
    const all = note({ id: 'all', stair: { rail: 'bar', steps: 14 } });
    applyFocus(m3, [all]);
    m3.floors[1].stairs[0].look = { rail: 'wall', steps: 14 };
    const next = focusFromModel(m3, [all], newId, 't');
    expect(next[0]).toEqual(all);
    expect(next[1]).toMatchObject({ level: 2, stair: { rail: 'wall', steps: 14 } });
    expect(stairLookAt(next, 1)).toEqual({ rail: 'bar', steps: 14 });
    expect(stairLookAt(next, 2)).toEqual({ rail: 'wall', steps: 14 });
  });

  it('モデルと指定が合っていれば、何も変えない（同じ配列を返す）', () => {
    const m = model();
    const notes = [note({ stair: { rail: 'wood', steps: 14 } }), note({ id: 'k', part: 'kitchen', note: '黒の天板' })];
    applyFocus(m, notes);
    expect(focusFromModel(m, notes, newId, 't')).toBe(notes);
    expect(focusFromModel(null, notes, newId, 't')).toBe(notes);
  });
});

describe('入力の整え', () => {
  it('知らない値・範囲外の段数は落とす。空の指定は残さない', () => {
    expect(cleanStairLook({ rail: 'glass', steps: 99 })).toEqual({ rail: 'glass' });
    expect(cleanStairLook({ rail: 'x' as never, steps: 3 })).toBeUndefined();
    // つくり（build）は階段ごとには持たない（家に 1 つ = コーディネートの「階段」の品目）。古い値が混ざっていても落とす
    expect(cleanStairLook({ build: 'box', rail: 'wall' } as never)).toEqual({ rail: 'wall' });
    const list = normalizeFocus([
      { id: 'a', part: 'stair', note: ' 軽い階段 ', images: [{ url: IMG, name: 'a.jpg' }, { url: 'https://example.com/x.jpg' }], stair: { rail: 'none' }, level: 2, at: 't' },
      { part: 'unknown', note: 'メモ' },
      { part: 'kitchen', note: '', images: [] },
      null,
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ id: 'a', part: 'stair', level: 2, note: '軽い階段', images: [{ url: IMG, name: 'a.jpg' }], stair: { rail: 'none' }, at: 't' });
    expect(list[1].part).toBe('other');
    expect(normalizeFocus(undefined)).toEqual([]);
  });

  it('画像は 3 枚まで', () => {
    const [n] = normalizeFocus([{ part: 'exterior', note: '', images: Array.from({ length: 5 }, () => ({ url: IMG })) }]);
    expect(n.images).toHaveLength(3);
  });
});

describe('写るカットの説明文に足す', () => {
  const notes: FocusNote[] = [
    note({ id: 's', stair: { rail: 'glass' }, note: '踏板は無垢のオーク', images: [{ url: IMG }, { url: IMG }] }),
    note({ id: 'k', part: 'kitchen', note: 'キッチンは黒のセラミック天板', images: [{ url: IMG }] }),
    note({ id: 'e', part: 'exterior', note: '外壁は塗り壁に木の格子', images: [] }),
    note({ id: 's3', level: 3, stair: { rail: 'wall' } }),
  ];

  it('階段の指定は、階段の写る内観だけ。外観の指定は外観と鳥瞰だけ', () => {
    expect(focusForShot(notes, { kind: 'interior', roomType: 'ldk', title: 'LDK', level: 1, hasStair: true }).map((n) => n.id)).toEqual(['s', 'k']);
    expect(focusForShot(notes, { kind: 'interior', roomType: 'bedroom', title: '寝室', level: 2 }).map((n) => n.id)).toEqual([]);
    expect(focusForShot(notes, { kind: 'exterior' }).map((n) => n.id)).toEqual(['e']);
    expect(focusForShot(notes, { kind: 'aerial' }).map((n) => n.id)).toEqual(['e']);
    expect(focusForShot(notes, { kind: 'cutaway' })).toEqual([]);
  });

  it('階を決めた階段の指定は、その階と、上がった先の階のカットだけ', () => {
    const hall = (level: number) => focusForShot(notes, { kind: 'interior', roomType: 'hall', title: '階段ホール', level, hasStair: true }).map((n) => n.id);
    expect(hall(3)).toEqual(['s', 's3']);
    expect(hall(4)).toEqual(['s', 's3']);
    expect(hall(2)).toEqual(['s']);
  });

  it('説明文: 指定の言葉 ＋ ひとこと ＋ 参考画像の名前。位置・段数は下絵のまま、と必ず添える', () => {
    const hits = focusForShot(notes, { kind: 'interior', roomType: 'ldk', title: 'LDK', level: 1, hasStair: true });
    // つくりは家に 1 つ（コーディネートの「階段」の品目）。渡すと階段の行の先頭に入る
    const [s, k] = focusPromptLines(notes, hits, 'ja', true, 'steel');
    expect(s).toContain('階段のこだわり');
    expect(s).toContain('ささら桁');
    expect(s).toContain('鉄骨階段');
    expect(s).toContain('ガラス');
    expect(k).not.toContain('鉄骨階段');
    expect(focusPromptLines(notes, hits, 'ja', true, 'box')[0]).toContain('箱階段');
    expect(focusPromptLines(notes, hits, 'ja')[0]).not.toContain('階段（段の下');
    expect(s).toContain('踏板は無垢のオーク');
    expect(s).toContain('00_参考_階段1_1.jpg・00_参考_階段1_2.jpg');
    expect(s).toContain('段数・向きは下絵のまま');
    expect(k).toContain('00_参考_キッチン_1.jpg');
    const en = focusPromptLines(notes, hits, 'en', true, 'steel')[0];
    expect(en).toContain('Staircase');
    expect(en).toContain('steel plate side stringers');
    expect(en).toContain('glass balustrade');
    expect(en).toContain('keep its position');
  });

  it('画像を渡さないときは、画像の話をしない', () => {
    const hits = focusForShot(notes, { kind: 'interior', title: '階段', level: 1, hasStair: true });
    expect(focusPromptLines(notes, hits, 'ja', false)[0]).not.toContain('参考画像');
  });

  it('同じ部位の指定が 1 件だけなら、番号を付けない', () => {
    expect(focusImageName(notes, notes[1], 0)).toBe('00_参考_キッチン_1.jpg');
    expect(focusImageName(notes, notes[0], 1)).toBe('00_参考_階段1_2.jpg');
  });
});

describe('言葉にする', () => {
  it('つくり・手すり・段数', () => {
    expect(stairLookText({ rail: 'wall', steps: 14 }, 'ja', 'box')).toBe('蹴込み板のある箱階段（段の下は閉じている）、手すりは腰壁（壁の仕上げ）、14 段');
    expect(stairLookText({ rail: 'wall', steps: 14 })).toBe('手すりは腰壁（壁の仕上げ）、14 段');
    expect(stairLookShort({ rail: 'glass', steps: 15 }, 'steel')).toBe('鉄骨・ガラス・15 段');
    expect(stairLookShort(undefined, 'woodSkeleton')).toBe('木のスケルトン');
    expect(stairLookText(undefined)).toBe('');
  });
});

// 2026-11-12 のご要望: 階段・造作・照明の雰囲気を、参考資料から 3D の表現に効かせる
describe('階段の桁・踏板の色・鉄の色（Stair.look）', () => {
  it('既定と同じ値（床に合わせる・黒）は持たない。知らない値は落とす。桁は選んだものをそのまま持つ', () => {
    expect(cleanStairLook({ tread: 'floor', frame: 'black' })).toBeUndefined();
    // 桁の既定はテイストで変わる（白い塗り壁 × オークは稲妻ささら）ので、「両側のささら桁」を選んだことも持つ
    expect(cleanStairLook({ stringer: 'side', tread: 'floor', frame: 'black' })).toEqual({ stringer: 'side' });
    expect(cleanStairLook({ stringer: 'zigzag' })).toEqual({ stringer: 'zigzag' });
    expect(cleanStairLook({ stringer: 'center', tread: 'walnut', frame: 'white' })).toEqual({ stringer: 'center', tread: 'walnut', frame: 'white' });
    expect(cleanStairLook({ tread: 'gold' as never, rail: 'glass' })).toEqual({ rail: 'glass' });
  });

  it('指定を当てると階段に入り、外すと消える（同じ中身なら触らない）', () => {
    const st = (level: number): Stair => ({ id: `F${level}-S1`, minX: 0, minY: 0, maxX: 910, maxY: 3000, kind: 'straight', entry: 's', goesUp: level === 1 });
    const fl = (level: number): Floor => ({ level, elevation: 500 + (level - 1) * 2900, height: 2900, ceilingHeight: 2400, walls: [], openings: [], rooms: [], stairs: [st(level)], outline: [] });
    const m = { name: 't', floors: [fl(1), fl(2)], northAngleDeg: 0, report: {} } as unknown as BuildingModel;
    const notes: FocusNote[] = [{ id: 'a', part: 'stair', note: '', images: [], stair: { tread: 'walnut', stringer: 'center' }, at: '' }];
    expect(applyFocus(m, notes)).toBe(1);
    const look = m.floors[0].stairs[0].look;
    expect(look).toEqual({ tread: 'walnut', stringer: 'center' });
    applyFocus(m, notes);
    expect(m.floors[0].stairs[0].look).toBe(look);
    // 3D で元に戻したとき: モデルの階段に合わせて、指定のほうを直す
    m.floors[0].stairs[0].look = { tread: 'white' };
    const back = focusFromModel(m, notes, () => 'new', '');
    expect(back[0].stair).toEqual({ tread: 'white' });
    applyFocus(m, []);
    expect(m.floors[0].stairs[0].look).toBeUndefined();
  });

  it('言葉にする: 中央の力桁・踏板の色・白い鉄', () => {
    expect(stairLookText({ stringer: 'center', tread: 'walnut', frame: 'white', rail: 'bar' }, 'ja', 'steel')).toBe('黒い鉄骨の中央の力桁 1 本に木の踏板を載せた、蹴込みの無い鉄骨階段、踏板はウォールナット（濃い茶）、鉄骨と手すりは白、手すりは細い鉄のフラットバー（支柱は少なく、上の手すりと横桟 1 本）');
    // 桁の指定は鉄骨階段だけに効く
    expect(stairLookText({ stringer: 'center' }, 'ja', 'box')).toBe('蹴込み板のある箱階段（段の下は閉じている）');
    expect(stairLookShort({ stringer: 'center', tread: 'mortar', frame: 'white' }, 'steel')).toBe('鉄骨・中央の桁・踏板 モルタル・鉄は白');
    expect(stairLookText({ tread: 'oak' }, 'en', 'steel')).toContain('oak treads');
  });

  it('仕上げの説明文の「階段」の項に足す言葉: 指定が無ければ標準のアイアンの手すりだけ', () => {
    expect(stairTailText(undefined, 'ja', 'steel')).toBe('手すりは細い鉄のフラットバー（支柱は少なく、上の手すりと横桟 1 本）');
    expect(stairTailText({ stringer: 'center', tread: 'black', rail: 'glass' }, 'ja', 'steel')).toBe('桁は両側ではなく中央の力桁 1 本、踏板は黒、手すりは透明なガラスのパネル');
    expect(stairTailText({ stringer: 'center' }, 'ja', 'woodSkeleton')).not.toContain('力桁');
    expect(stairTailText(undefined, 'en')).toContain('single horizontal mid rail');
  });
});

describe('造作・照明の雰囲気（部位）', () => {
  it('部位の一覧に、階段の次に「造作」「照明の雰囲気」がある', () => {
    expect(FOCUS_PARTS.slice(0, 3)).toEqual(['stair', 'joinery', 'lighting']);
  });

  it('造作の形は、知っている形だけを持つ。形だけの指定も残る', () => {
    const list = normalizeFocus([
      { id: 'j', part: 'joinery', note: '', images: [], joinery: 'floatTv' },
      { id: 'x', part: 'joinery', note: '', images: [], joinery: 'spaceship' },
      { id: 'k', part: 'kitchen', note: 'オープン棚', images: [], joinery: 'openShelf' },
    ]);
    expect(list.map((n) => n.id)).toEqual(['j', 'k']);
    expect(list[0].joinery).toBe('floatTv');
    expect(list[1].joinery).toBeUndefined();
    expect(focusLookShort(list[0])).toBe('浮かせたテレビボード＋飾り棚');
    expect(focusLookShort(list[1])).toBe('');
  });

  it('造作・照明は内観のカットすべてに効く（外観・断面には入れない）', () => {
    const notes: FocusNote[] = [
      { id: 'j', part: 'joinery', note: '下に間接照明', images: [{ url: 'data:image/jpeg;base64,AA' }], joinery: 'floatTv', at: '' },
      { id: 'l', part: 'lighting', note: 'ダウンライトは少なく', images: [{ url: 'data:image/jpeg;base64,BB' }], at: '' },
    ];
    const ids = (shot: Parameters<typeof focusForShot>[1]) => focusForShot(notes, shot).map((n) => n.id);
    expect(ids({ kind: 'interior', roomType: 'ldk', title: 'LDK', level: 1 })).toEqual(['j', 'l']);
    expect(ids({ kind: 'interior', roomType: 'bedroom', title: '寝室', level: 2 })).toEqual(['j', 'l']);
    expect(ids({ kind: 'exterior', title: '外観' })).toEqual([]);
    expect(ids({ kind: 'section', title: '断面' })).toEqual([]);
    const [j, l] = focusPromptLines(notes, notes, 'ja');
    expect(j).toContain('造作のこだわり: 浮かせたテレビボード＋飾り棚。下に間接照明');
    expect(j).toContain('00_参考_造作_1.jpg');
    // 照明の参考画像からは、光の雰囲気だけを借りる（器具の位置と数は下絵のまま）
    expect(l).toContain('照明のこだわり: ダウンライトは少なく');
    expect(l).toContain('光の雰囲気');
    expect(l).toContain('照明器具の位置と数・部屋の形は下絵のまま');
    expect(focusPromptLines(notes, notes, 'en')[0]).toContain('a wall-hung floating TV board');
    expect(focusPromptLines(notes, notes, 'en')[1]).toContain('lighting mood only');
  });

  it('照明の読み取り結果は、知っている値だけに整える', () => {
    expect(cleanLighting({ indirect: true, pendant: 'dome', kelvin: 2700, tod: 'evening' })).toEqual({ indirect: true, pendant: 'dome', kelvin: 2700, tod: 'evening' });
    expect(cleanLighting({ indirect: 'yes', pendant: 'chandelier', kelvin: 5000, tod: 'noon' })).toBeUndefined();
    expect(cleanLighting({ kelvin: '3000' })).toEqual({ kelvin: 3000 });
    expect(cleanLighting(null)).toBeUndefined();
  });
});
