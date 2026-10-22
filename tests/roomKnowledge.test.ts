import { describe, it, expect } from 'vitest';
import { canShareSpace, mustSeparate, inferNamelessRoom, doorSwingFor, isCirculation } from '../src/parser/roomKnowledge';
import { classifyRoomName } from '../src/parser/labels';

describe('部屋の知識（用途・構造・動線）', () => {
  it('一続きでよい組み合わせと、分かれているべき組み合わせ', () => {
    expect(canShareSpace('entrance', 'hall')).toBe(true);
    expect(canShareSpace('ldk', 'dining')).toBe(true);
    expect(canShareSpace('hall', 'stairs')).toBe(true);
    expect(canShareSpace('washroom', 'washroom')).toBe(true);
    expect(mustSeparate('ldk', 'storage')).toBe(true);
    expect(mustSeparate('hall', 'toilet')).toBe(true);
    expect(mustSeparate('bedroom', 'kids')).toBe(true);
    expect(mustSeparate('bedroom', 'closet')).toBe(true);
    expect(mustSeparate('entrance', 'hall')).toBe(false);
    expect(mustSeparate('ldk', 'other')).toBe(false);
  });

  it('室名の無い区画を隣から推定する', () => {
    expect(inferNamelessRoom(['entrance'], 2.5)).toEqual({ name: 'シューズクローク', type: 'storage' });
    expect(inferNamelessRoom(['kitchen', 'ldk'], 2.0)).toEqual({ name: 'パントリー', type: 'storage' });
    expect(inferNamelessRoom(['bedroom'], 3.3)).toEqual({ name: 'WIC', type: 'closet' });
    expect(inferNamelessRoom(['bedroom'], 1.2)).toEqual({ name: 'CL', type: 'closet' });
    expect(inferNamelessRoom(['stairs'], 1.5)).toEqual({ name: '階段下収納', type: 'storage' });
    expect(inferNamelessRoom(['hall'], 1.4)).toEqual({ name: '物入', type: 'closet' });
    expect(inferNamelessRoom(['hall'], 9, { level: 2 })).toEqual({ name: '洋室', type: 'bedroom' });
    expect(inferNamelessRoom(['hall'], 9, { level: 1 })).toBeNull();
    expect(inferNamelessRoom([], 12)).toBeNull();
    // 細長い区画: 幅 1m 未満で長ければ通路、幅 70cm 未満は隙間（名前なし）
    expect(inferNamelessRoom(['ldk'], 2.0, { level: 1, width: 900, length: 2300 })).toEqual({ name: '通路', type: 'hall' });
    expect(inferNamelessRoom(['ldk'], 1.0, { level: 1, width: 300, length: 2000 })).toEqual({ name: '', type: 'other' });
    expect(inferNamelessRoom(['ldk'], 1.5, { level: 1, width: 500, length: 3000 })).toEqual({ name: '', type: 'other' });
    // 奥行 60cm の押入・クローゼットは収納のまま
    expect(inferNamelessRoom(['bedroom'], 1.1, { level: 1, width: 600, length: 1820 })).toEqual({ name: 'CL', type: 'closet' });
    expect(inferNamelessRoom(['bedroom'], 1.2, { level: 1, width: 900, length: 1300 })).toEqual({ name: 'CL', type: 'closet' });
  });

  it('戸の開く向き: 個室・浴室は中へ、トイレ・収納は外へ、通路からは部屋へ', () => {
    expect(doorSwingFor('hall', 'bedroom')).toBe('b');
    expect(doorSwingFor('bedroom', 'hall')).toBe('a');
    expect(doorSwingFor('hall', 'toilet')).toBe('a');
    expect(doorSwingFor('bedroom', 'closet')).toBe('a');
    expect(doorSwingFor('washroom', 'bath')).toBe('b');
    expect(doorSwingFor('ldk', 'japanese')).toBe('b');
    expect(doorSwingFor(null, null)).toBeNull();
    expect(isCirculation('hall')).toBe(true);
    expect(isCirculation('ldk')).toBe(true);
    expect(isCirculation('bedroom')).toBe(false);
  });

  it('室名辞書の追加: 玄関ホールは通路、パウダーは洗面、ウォークスルーは収納', () => {
    expect(classifyRoomName('玄関ホール')).toBe('hall');
    expect(classifyRoomName('玄関')).toBe('entrance');
    expect(classifyRoomName('パウダールーム')).toBe('washroom');
    expect(classifyRoomName('ウォークスルークローゼット')).toBe('closet');
    expect(classifyRoomName('ファミリーホール')).toBe('living');
    expect(classifyRoomName('ワークスペース')).toBe('study');
    expect(classifyRoomName('シューズクローク')).toBe('storage');
  });
});
