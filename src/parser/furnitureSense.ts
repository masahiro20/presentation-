/**
 * 家具の常識チェック。
 * 図面の記号を読んだ結果に「LDK に食卓が 2 つ」「寝室にベッドが 3 つ」「玄関に便器」のような
 * ふつうでは無い組み合わせがあれば、もっともらしい 1 つを残して落とす。
 */
import type { FurnitureItem, FurnitureKind, Room, RoomType } from '../core/types';

/** どの部屋でも、ふつう 1 つしか無いもの */
const ONE_ANYWHERE: FurnitureKind[] = ['kitchen', 'dining', 'sofa', 'coffeeTable', 'tv', 'bath', 'toilet', 'washer', 'fridge', 'cupboard', 'shoeCabinet', 'lowTable'];

/** 部屋の種類ごとの上限（ONE_ANYWHERE 以外） */
function capOf(kind: FurnitureKind, type: RoomType | undefined): number {
  if (kind === 'bed') return type === 'bedroom' || type === 'kids' || type === 'japanese' ? 2 : 1;
  if (kind === 'desk') return type === 'study' || type === 'kids' || type === 'bedroom' ? 2 : 1;
  if (kind === 'washstand') return type === 'washroom' ? 2 : 1;
  if (ONE_ANYWHERE.includes(kind)) return 1;
  return Infinity;
}

/** その部屋には無いはずのもの */
const NOT_IN: Partial<Record<RoomType, FurnitureKind[]>> = {
  toilet: ['kitchen', 'dining', 'sofa', 'coffeeTable', 'tv', 'bed', 'nightstand', 'desk', 'bookshelf', 'lowTable', 'bath', 'washer', 'fridge', 'cupboard', 'shoeCabinet'],
  bath: ['kitchen', 'dining', 'sofa', 'coffeeTable', 'tv', 'bed', 'nightstand', 'desk', 'bookshelf', 'lowTable', 'toilet', 'washer', 'fridge', 'cupboard', 'shoeCabinet', 'cabinet'],
  washroom: ['kitchen', 'dining', 'sofa', 'coffeeTable', 'tv', 'bed', 'nightstand', 'desk', 'bookshelf', 'lowTable', 'fridge', 'cupboard', 'shoeCabinet'],
  entrance: ['kitchen', 'dining', 'sofa', 'coffeeTable', 'tv', 'bed', 'nightstand', 'desk', 'bath', 'toilet', 'washstand', 'washer', 'fridge', 'cupboard', 'lowTable'],
  hall: ['kitchen', 'dining', 'bed', 'nightstand', 'bath', 'toilet', 'washer', 'fridge', 'cupboard'],
  closet: ['kitchen', 'dining', 'sofa', 'coffeeTable', 'tv', 'bed', 'nightstand', 'bath', 'toilet', 'washstand', 'washer', 'fridge', 'cupboard', 'lowTable'],
  storage: ['kitchen', 'dining', 'sofa', 'coffeeTable', 'tv', 'bed', 'nightstand', 'bath', 'toilet', 'washstand', 'fridge', 'lowTable'],
  bedroom: ['kitchen', 'bath', 'toilet', 'washer', 'fridge', 'cupboard', 'shoeCabinet'],
  kids: ['kitchen', 'bath', 'toilet', 'washer', 'fridge', 'cupboard', 'shoeCabinet'],
  japanese: ['kitchen', 'bath', 'toilet', 'washer', 'fridge', 'cupboard', 'shoeCabinet'],
  living: ['bed', 'bath', 'toilet', 'washer', 'shoeCabinet'],
  ldk: ['bed', 'bath', 'toilet', 'washer', 'shoeCabinet'],
  dining: ['bed', 'bath', 'toilet', 'washer', 'shoeCabinet'],
  kitchen: ['bed', 'bath', 'toilet', 'washer', 'sofa', 'tv', 'shoeCabinet'],
  stairs: ['kitchen', 'dining', 'sofa', 'coffeeTable', 'tv', 'bed', 'bath', 'toilet', 'washstand', 'washer', 'fridge', 'cupboard'],
  garage: ['kitchen', 'dining', 'sofa', 'bed', 'bath', 'toilet', 'washstand', 'tv'],
};

const KIND_JA: Partial<Record<FurnitureKind, string>> = {
  kitchen: 'キッチン', dining: '食卓', sofa: 'ソファ', coffeeTable: 'センターテーブル', tv: 'テレビ', bed: 'ベッド', desk: '机', bath: '浴槽', toilet: '便器', washstand: '洗面台', washer: '洗濯機', fridge: '冷蔵庫', cupboard: 'カップボード', shoeCabinet: '下駄箱', lowTable: 'ローテーブル', nightstand: 'ナイトテーブル', bookshelf: '本棚', cabinet: '収納', chair: '椅子', rug: 'ラグ', plant: '植栽', mirror: '鏡',
};
export const furnitureKindJa = (k: FurnitureKind) => KIND_JA[k] ?? k;

export interface SenseResult {
  items: FurnitureItem[];
  /** 落とした理由（確認カード・トレース用） */
  removed: string[];
}

/** 部屋ごとに常識で家具を整理する。順番は保つ（先に読めたもの＝文脈読みの結果を優先） */
function roomArea(room: Room | undefined): number {
  if (!room) return 0;
  const p = room.polygon;
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return Math.abs(a) / 2 / 1e6;
}

export function senseFurniture(items: FurnitureItem[], rooms: Room[]): SenseResult {
  const removed: string[] = [];
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const drop = new Set<FurnitureItem>();
  const byRoom = new Map<string, FurnitureItem[]>();
  for (const it of items) {
    const k = it.roomId ?? '';
    if (!byRoom.has(k)) byRoom.set(k, []);
    byRoom.get(k)!.push(it);
  }
  const d = (a: FurnitureItem, b: FurnitureItem) => Math.hypot(a.x - b.x, a.y - b.y);
  for (const [rid, list] of byRoom) {
    const room = roomById.get(rid);
    const type = room?.type;
    const name = room?.name ?? '（部屋なし）';
    // 1. その部屋には無いはずのもの
    const banned = type ? NOT_IN[type] ?? [] : [];
    for (const it of list) {
      if (banned.includes(it.kind)) {
        drop.add(it);
        removed.push(`${name}の${furnitureKindJa(it.kind)}（この部屋には無いはず）`);
      }
    }
    // 2. 数の上限
    const kinds = new Set(list.map((it) => it.kind));
    for (const kind of kinds) {
      const cap = capOf(kind, type);
      const have = list.filter((it) => it.kind === kind && !drop.has(it));
      if (have.length <= cap) continue;
      let keep: FurnitureItem[];
      if (kind === 'dining') {
        // 食卓はキッチンに近いもの（無ければ大きいもの）
        const kit = list.find((it) => it.kind === 'kitchen' && !drop.has(it)) ?? items.find((it) => it.kind === 'kitchen' && !drop.has(it));
        keep = [kit ? [...have].sort((a, b) => d(a, kit) - d(b, kit))[0] : [...have].sort((a, b) => (b.w ?? 0) - (a.w ?? 0))[0]];
      } else if (kind === 'bed' && cap === 2) {
        // ツインは「平行で隣り合う 2 台」だけ。それ以外は大きい 1 台
        const sorted = [...have].sort((a, b) => (b.w ?? 0) - (a.w ?? 0));
        const first = sorted[0];
        const twin = sorted.slice(1).find((b) => Math.abs(((b.rot - first.rot) % 180) + 180) % 180 < 10 && d(first, b) < 2600);
        keep = twin ? [first, twin] : [first];
      } else if (kind === 'sofa' && (type === 'ldk' || type === 'living') && roomArea(room) >= 25) {
        // 広い LDK のソファセット（3 人掛け＋2 人掛け・L 字に置いた 2 台）は 2 台まで
        const sorted = [...have].sort((a, b) => (b.w ?? 0) - (a.w ?? 0));
        const pair = sorted.slice(1).find((b) => d(sorted[0], b) < 3500);
        keep = pair ? [sorted[0], pair] : [sorted[0]];
      } else if (kind === 'sofa' || kind === 'kitchen' || kind === 'bath') {
        keep = [...have].sort((a, b) => (b.w ?? b.len ?? 0) - (a.w ?? a.len ?? 0)).slice(0, cap);
      } else {
        keep = have.slice(0, cap);
      }
      for (const it of have) {
        if (keep.includes(it)) continue;
        drop.add(it);
        removed.push(`${name}の${furnitureKindJa(kind)}が${have.length}つ → ${keep.length}つに`);
      }
    }
  }
  return { items: items.filter((it) => !drop.has(it)), removed };
}
