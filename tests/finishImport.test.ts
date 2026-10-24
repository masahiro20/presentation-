import { describe, it, expect } from 'vitest';
import { guessShot, cutToken } from '../src/app/finishImport';
import type { Shot } from '../src/scene/shots';

const shot = (id: string, title: string): Shot => ({ id, title, caption: '', kind: 'interior', view: {} as Shot['view'], sunDir: null }) as Shot;
const shots = [shot('ext-road', '外観パース（道路側）'), shot('int-ldk', '内観パース（LDK）'), shot('int-court-F1-R3', '内観パース（LDKから中庭）')];

describe('仕上げた写真の取り込み: ファイル名からカットを推し量る', () => {
  it('ファイル名の目印（__c-…）で確実に対応する', () => {
    const t = cutToken(shots[1]);
    expect(guessShot(`whatever_${t}.png`, shots, [])?.id).toBe('int-ldk');
  });
  it('題名が含まれていれば、長い題名を優先して対応する', () => {
    expect(guessShot('03_内観パース（LDKから中庭） (1).png', shots, [])?.id).toBe('int-court-F1-R3');
    expect(guessShot('内観パース（LDK）_photo.jpg', shots, [])?.id).toBe('int-ldk');
  });
  it('名前が付け替えられても、カット集の通し番号と控えで戻せる', () => {
    const manifest = [{ no: 1, id: 'ext-road', token: cutToken(shots[0]), title: shots[0].title }];
    expect(guessShot('01_image.png', shots, manifest)?.id).toBe('ext-road');
  });
  it('手がかりが無ければ null（一覧で人が選ぶ）', () => {
    expect(guessShot('IMG_1234.png', shots, [])).toBeNull();
  });
});
