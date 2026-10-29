import { describe, it, expect } from 'vitest';
import { parseWishes, checkWishes } from '../src/core/wishes';
import { parseSample } from './pdfNode';

const TEXT = `実家の建て替えに当たって
基本の考え方 ①長期にわたって住めること: 父＋自分30年、周作30年＋α。
収納関係は、基本すべて造作家具とする
部屋数は、居間、食堂、和室、寝室、個人部屋 2 つ(父存命中の卓志、明里の部屋)
平屋で、上記部屋数が満たせれば、平屋、不可なら、2階建て。
車いすで移動できるよう、通路幅を確保、また、可能な限り、ドアは引き戸。
高齢時を考え、寝室とトイレは出来るだけ、近くに。
居間 ６～８畳
収納棚のある造作家具を据え付ける
玄関
姿見、置き場確保
台所・食堂
居間とは、離したい。食器洗浄機の音などうるさい。
土間を設定して、そこに資源ごみ箱を置けるようにしたい。
場所は、東側で、朝日が入るようにしたい
駐車 2 台`;

describe('ご要望との照合', () => {
  it('要望の文章から照合できる項目を拾う', () => {
    const ws = parseWishes(TEXT);
    const kinds = ws.map((w) => `${w.kind}:${w.type ?? w.pair?.join('-') ?? w.dir ?? ''}`);
    expect(kinds).toContain('room:living');
    expect(kinds).toContain('room:kids');
    expect(ws.find((w) => w.kind === 'room' && w.type === 'kids')?.count).toBe(2);
    expect(ws.find((w) => w.kind === 'storeys')?.fallbackOk).toBe(true);
    expect(kinds).toContain('sliding:');
    expect(kinds).toContain('corridor:');
    expect(kinds).toContain('adjacent:bedroom-toilet');
    const size = ws.find((w) => w.kind === 'size' && w.type === 'living');
    expect(size?.minTatami).toBe(6);
    expect(size?.maxTatami).toBe(8);
    expect(kinds).toContain('feature:doma');
    // 「台所・食堂」の見出しの下の「東側で朝日が入るように」: 台所か食堂の向きの要望として拾う
    expect(kinds.some((k) => k === 'orientation:kitchen' || k === 'orientation:dining')).toBe(true);
    expect(ws.find((w) => w.kind === 'orientation')?.dir).toBe('E');
    expect(ws.find((w) => w.kind === 'parking')?.cars).toBe(2);
    // 判定できない行は打合せ事項として残る
    expect(ws.some((w) => w.kind === 'note' && /姿見/.test(w.raw))).toBe(true);
  });

  it('サンプルの間取りと突き合わせて、例外なく結果が出る', async () => {
    const model = await parseSample('sample_house_A3.pdf');
    const ws = parseWishes(TEXT);
    const rs = checkWishes(model, ws, { narrowIssues: [] });
    expect(rs.length).toBe(ws.length);
    for (const r of rs) expect(['ok', 'ng', 'check', 'na']).toContain(r.status);
    // 2 階建てのサンプルなので「平屋（不可なら 2 階建て）」は要確認
    const st = rs.find((r) => r.wish.kind === 'storeys');
    expect(st?.status).toBe(model.floors.length === 1 ? 'ok' : model.floors.length === 2 ? 'check' : 'ng');
    const corridor = rs.find((r) => r.wish.kind === 'corridor');
    expect(corridor?.status).toBe('ok');
  });
});
