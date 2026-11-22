// プロンプト集: 形を変えない指示がそろっていること・ZIP 用のテキストにすべて入ること
import { describe, expect, it } from 'vitest';
import { PROMPT_GROUPS, promptLibraryText } from '../src/app/promptLibrary';

describe('プロンプト集', () => {
  it('共通の文は窓・ドアを増減させない指示を含む', () => {
    for (const it of PROMPT_GROUPS[0].items) expect(it.text).toContain('Do not add or remove windows');
  });
  it('X シリーズの写り（外観・内観）がある', () => {
    const labels = PROMPT_GROUPS.flatMap((g) => g.items.map((i) => i.label));
    expect(labels.some((l) => l.includes('外観: X シリーズ'))).toBe(true);
    expect(labels.some((l) => l.includes('内観: X シリーズ'))).toBe(true);
  });
  it('動画の文は 5 秒・形を崩さない指示を含む', () => {
    const video = PROMPT_GROUPS.find((g) => g.title.includes('動画'))!;
    for (const it of video.items) {
      expect(it.text).toMatch(/5-second/);
      expect(it.text).toMatch(/morphing|invent new rooms/);
    }
  });
  it('テキスト版にすべての文が入り、お客様の名前・住所の欄は無い', () => {
    const t = promptLibraryText();
    for (const g of PROMPT_GROUPS) for (const it of g.items) expect(t).toContain(it.text);
    expect(t).not.toMatch(/様邸|様_/);
  });
});
