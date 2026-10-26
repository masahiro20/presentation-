// 平面の家具記号: 図面から短く読まれた家具（ミニキッチンなど）でも幅・奥行が負にならない
import { test, expect } from 'vitest';
import { furnitureSymbol } from '../src/app/furnitureSymbols';
test('short kitchen has no negative rects', () => {
  for (const kitchenType of ['wall', 'peninsula', 'island'] as const)
    for (const len of [0.6, 0.78, 0.9, 1.2, 3])
      for (const p of furnitureSymbol({ id: 'k', kind: 'kitchen', x: 0, y: 0, rot: 0, len, kitchenType } as never))
        if (p.t === 'rect') expect(p.w > 0 && p.d > 0).toBe(true);
});
