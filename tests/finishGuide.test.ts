// 写真と動画の仕上げ: 決めカットを動画にする指示文と手引き
import { describe, expect, it } from 'vitest';
import { cutVideoPrompt } from '../src/app/cuts';
import { FINISH_GUIDE_LINES } from '../src/app/finishGuide';
import type { Shot } from '../src/scene/shots';

const shot = (kind: Shot['kind']) => ({ id: 'x', kind, title: 't' }) as unknown as Shot;

describe('決めカットを動画にする指示文', () => {
  it('内観は目線の高さでゆっくり前進するだけ・建物を変えない・人を出さない', () => {
    const p = cutVideoPrompt(shot('interior'));
    expect(p.en).toContain('dolly-in');
    expect(p.en).toContain('No people');
    expect(p.en).toContain('5-second');
    expect(p.ja).toContain('ゆがませない');
  });
  it('鳥瞰は回り込み、外観は玄関へ前進（動きは 1 つだけ）', () => {
    expect(cutVideoPrompt(shot('aerial')).en).toContain('orbit');
    expect(cutVideoPrompt(shot('exterior')).en).toContain('toward the entrance');
  });
  it('手引きに静止画・動画・取り込みの手順と個人情報の注意がある', () => {
    const t = FINISH_GUIDE_LINES.join('\n');
    for (const w of ['Nano Banana Pro', 'Kling', 'Runway', 'Veo 3.1', '仕上がりを取り込む', 'お客様のお名前']) expect(t).toContain(w);
  });
});
