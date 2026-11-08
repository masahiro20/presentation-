import { describe, expect, it } from 'vitest';
import { newFunding } from '../src/estimate/funding';
import { contractPrecheck, precheckSummary, type PrecheckLine } from '../src/estimate/precheck';

const base = () => newFunding({ series: 'P', address: '', constArea: 120, floors: 2, body: 30000000, fireZone: false, septic: false, waterHeater: 'エコキュート', pv: false, longLife: false, insul: 'セルロースファイバー' });
const L = (desc: string, spec: string, amount = 100000, selected = true): PrecheckLine => ({ desc, spec, amount, selected });

describe('契約前チェック（precheck）', () => {
  it('御社の標準の資金計画（地盤 100 万・外構 200 万・予備費 50 万…）は資金計画の項目が ✓、見積に無い照明・カーテンは ⚠', () => {
    const f = base();
    const items = contractPrecheck([L('空調なし（エアコンは別途）', '空調', 0)], f);
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by.exterior.status).toBe('ok');
    expect(by.exterior.amount).toBe(2000000);
    expect(by.ground.status).toBe('ok');
    expect(by.reserve.status).toBe('ok');
    expect(by.permit.status).toBe('ok');
    expect(by.registration.status).toBe('ok');
    expect(by.insurance.status).toBe('ok');
    expect(by.lighting.status).toBe('warn');
    expect(by.curtain.status).toBe('warn');
    expect(by.ac.status).toBe('warn');
    // 希望が無い仕様（太陽光・長期優良・浄化槽・準防火）は項目に出ない
    expect(by.pv).toBeUndefined();
    expect(by.longlife).toBeUndefined();
    expect(precheckSummary(items).warn).toBe(3);
  });

  it('見積に照明器具・エアコンの行があれば ✓、「対象外」にした項目は na で件数から外れる', () => {
    const f = base();
    const items = contractPrecheck([L('照明器具 ※概算', '照明器具', 500000), L('ダイキン アメニティ エアコン', '空調', 1300000)], f, { curtain: true });
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by.lighting.status).toBe('ok');
    expect(by.lighting.amount).toBe(500000);
    expect(by.ac.status).toBe('ok');
    expect(by.curtain.status).toBe('na');
    const s = precheckSummary(items);
    expect(s.warn).toBe(0);
    expect(s.na).toBe(1);
    expect(s.text).toContain('抜けなし');
  });

  it('希望と費用の食い違い: 太陽光を希望なのに「太陽光なし」、浄化槽なのに費用 0、長期優良を希望なのに申請費 0、外構 0 円', () => {
    const f = base();
    f.site.pv = '希望する';
    f.site.sewer = '浄化槽';
    f.site.longLife = '希望する';
    f.other.find((r) => /外構/.test(r.label))!.amount = 0;
    const items = contractPrecheck([L('太陽光なし', '太陽光', 0)], f);
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by.pv.status).toBe('warn');
    expect(by.septic.status).toBe('warn');
    expect(by.longlife.status).toBe('warn');
    expect(by.exterior.status).toBe('warn');
    f.attached.find((r) => /長期優良/.test(r.label))!.amount = 380000;
    const items2 = contractPrecheck([L('【キューセルズ】4.3kw パワコン込', '太陽光', 1500000), L('5人槽 ※130㎡未満', '浄化槽', 800000)], f);
    const by2 = Object.fromEntries(items2.map((i) => [i.id, i]));
    expect(by2.pv.status).toBe('ok');
    expect(by2.septic.status).toBe('ok');
    expect(by2.longlife.status).toBe('ok');
  });
});
