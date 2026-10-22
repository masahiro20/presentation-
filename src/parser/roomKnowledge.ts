/**
 * 部屋の知識: 室名から分かる「用途・住宅の構造・人の動線」の常識。読み取りの判断に使う。
 *  - 水まわり／収納／通路／個室 の区別
 *  - 壁なしで一続きでよい組み合わせ（玄関とホール、LDK とダイニング、ホールと階段、脱衣とランドリー）
 *  - 隣にあるべき部屋（浴室は脱衣室の隣、パントリーはキッチンの隣、SIC は玄関の隣、WIC は寝室の隣）
 *  - 戸の開く向き（個室・浴室は部屋の中へ、トイレ・収納は外へ）
 *  - 典型的な広さ（帖）
 */
import type { RoomType } from '../core/types';

export interface RoomKnowledge {
  /** 水まわり */
  wet: boolean;
  /** 収納（人が居る部屋ではない） */
  storage: boolean;
  /** 通路（玄関・ホール・廊下・階段） */
  circulation: boolean;
  /** 個室（戸で閉じる） */
  private: boolean;
  /** 壁なしで一続きでよい相手 */
  openTo: RoomType[];
  /** 隣にあることが多い部屋（動線） */
  adjacent: RoomType[];
  /** 典型的な広さ（帖） */
  tatami: [number, number];
  /** 戸の開く向き: 'in' = この部屋の中へ、'out' = 部屋の外へ、'none' = 戸が無いのが普通 */
  door: 'in' | 'out' | 'none';
}

const K = (p: Partial<RoomKnowledge>): RoomKnowledge => ({ wet: false, storage: false, circulation: false, private: false, openTo: [], adjacent: [], tatami: [1, 40], door: 'in', ...p });

export const ROOM_KNOWLEDGE: Record<RoomType, RoomKnowledge> = {
  ldk: K({ openTo: ['living', 'dining', 'kitchen', 'hall', 'stairs', 'japanese', 'study'], adjacent: ['kitchen', 'storage', 'hall', 'balcony'], tatami: [12, 40], door: 'in' }),
  living: K({ openTo: ['ldk', 'dining', 'kitchen', 'hall', 'stairs', 'japanese', 'study'], adjacent: ['dining', 'hall', 'balcony'], tatami: [6, 20] }),
  dining: K({ openTo: ['ldk', 'living', 'kitchen', 'hall'], adjacent: ['kitchen', 'living'], tatami: [4, 12] }),
  kitchen: K({ wet: true, openTo: ['ldk', 'living', 'dining'], adjacent: ['dining', 'storage', 'washroom'], tatami: [3, 8] }),
  japanese: K({ private: true, openTo: ['ldk', 'living'], adjacent: ['ldk', 'hall', 'closet'], tatami: [3, 8] }),
  bedroom: K({ private: true, adjacent: ['closet', 'hall', 'balcony'], tatami: [4.5, 12] }),
  kids: K({ private: true, adjacent: ['closet', 'hall'], tatami: [4, 8] }),
  study: K({ private: true, openTo: ['ldk', 'living', 'hall', 'bedroom'], adjacent: ['hall', 'ldk', 'bedroom'], tatami: [1.5, 6] }),
  bath: K({ wet: true, private: true, adjacent: ['washroom'], tatami: [1, 2.5], door: 'in' }),
  washroom: K({ wet: true, openTo: ['washroom'], adjacent: ['bath', 'toilet', 'kitchen', 'hall', 'closet'], tatami: [1.5, 5] }),
  toilet: K({ wet: true, private: true, adjacent: ['hall', 'washroom'], tatami: [0.5, 1.5], door: 'out' }),
  entrance: K({ circulation: true, openTo: ['hall', 'storage'], adjacent: ['hall', 'storage', 'porch'], tatami: [1, 4], door: 'none' }),
  hall: K({ circulation: true, openTo: ['entrance', 'stairs', 'ldk', 'living', 'dining', 'hall', 'washroom', 'study'], adjacent: ['stairs', 'toilet', 'washroom', 'bedroom', 'closet'], tatami: [1, 8], door: 'none' }),
  stairs: K({ circulation: true, openTo: ['hall', 'ldk', 'living', 'entrance'], adjacent: ['hall', 'storage'], tatami: [1.5, 4], door: 'none' }),
  closet: K({ storage: true, adjacent: ['bedroom', 'kids', 'hall', 'washroom', 'japanese'], tatami: [0.5, 4], door: 'out' }),
  storage: K({ storage: true, openTo: ['entrance'], adjacent: ['entrance', 'kitchen', 'hall', 'stairs', 'ldk'], tatami: [0.3, 4], door: 'out' }),
  balcony: K({ door: 'in', adjacent: ['ldk', 'living', 'bedroom', 'washroom'], tatami: [1, 12] }),
  porch: K({ circulation: true, adjacent: ['entrance'], tatami: [0.5, 4], door: 'none' }),
  garage: K({ adjacent: ['entrance', 'storage'], tatami: [6, 20], door: 'out' }),
  void: K({ door: 'none', tatami: [1, 20] }),
  other: K({}),
};

/** 壁なしで一続きになっていてもおかしくない組み合わせ（玄関とホール、LDK とダイニング、ホールと階段 …） */
export function canShareSpace(a: RoomType, b: RoomType): boolean {
  if (a === b) return true;
  return ROOM_KNOWLEDGE[a].openTo.includes(b) || ROOM_KNOWLEDGE[b].openTo.includes(a);
}

/** 必ず壁か戸で分かれているべき組み合わせ（収納・トイレ・浴室・個室が他の部屋と一続き） */
export function mustSeparate(a: RoomType, b: RoomType): boolean {
  if (canShareSpace(a, b)) return false;
  const ka = ROOM_KNOWLEDGE[a];
  const kb = ROOM_KNOWLEDGE[b];
  if (a === 'other' || b === 'other' || a === 'void' || b === 'void') return false;
  return ka.storage || kb.storage || ka.private || kb.private || ka.wet || kb.wet;
}

/**
 * 室名の無い区画を、隣の部屋から推定する（玄関の隣の小さな区画 → SIC、キッチンの隣 → パントリー、寝室の隣 → WIC …）
 * 分からなければ null
 */
export function inferNamelessRoom(neighbors: RoomType[], areaM2: number, opts: { level: number; width?: number; length?: number } = { level: 1 }): { name: string; type: RoomType } | null {
  const tatami = areaM2 / 1.62;
  const has = (...ts: RoomType[]) => ts.some((t) => neighbors.includes(t));
  // 細長い区画: 幅 35cm 未満、または幅 70cm 未満で 2.5m 以上の帯は線の読み違いの隙間（名前なし）。
  // 幅 70cm〜1m で 1.8m 以上あり、通路や LDK に接するものは通路。奥行 455〜600 の収納はここでは決めず下へ
  if (opts.width != null) {
    const len = opts.length ?? 0;
    if (opts.width < 350 || (opts.width < 700 && len >= 2500)) return { name: '', type: 'other' };
    if (opts.width >= 700 && opts.width < 1000 && len >= 1800 && has('hall', 'entrance', 'stairs', 'ldk', 'living', 'dining', 'kitchen')) return { name: '通路', type: 'hall' };
  }
  if (tatami <= 4.5) {
    if (has('entrance') && tatami >= 0.7) return { name: tatami >= 1.5 ? 'シューズクローク' : '玄関収納', type: 'storage' };
    if (has('kitchen', 'ldk', 'dining') && tatami <= 2.5 && tatami >= 0.7) return { name: 'パントリー', type: 'storage' };
    if (has('bedroom', 'kids', 'japanese')) return { name: tatami >= 1.5 ? 'WIC' : 'CL', type: 'closet' };
    if (has('stairs') && tatami <= 1.5) return { name: '階段下収納', type: 'storage' };
    if (has('washroom', 'bath') && tatami <= 2) return { name: 'リネン庫', type: 'storage' };
    if (has('hall') && tatami <= 2) return { name: '物入', type: 'closet' };
    if (tatami <= 2) return { name: '収納', type: 'storage' };
  }
  // 2 階以上の 4.5 帖以上でホールに接する名前の無い区画は、室名の読めなかった洋室の可能性が高い
  if (opts.level >= 2 && tatami >= 4.5 && tatami <= 12 && has('hall', 'stairs')) return { name: '洋室', type: 'bedroom' };
  return null;
}

/**
 * 戸の開く向き: 両側の部屋の種類から、どちらの部屋の中へ開くか。
 * 戻り値 'a' = a の部屋の中へ、'b' = b の中へ、null = 決められない
 */
export function doorSwingFor(a: RoomType | null, b: RoomType | null): 'a' | 'b' | null {
  if (!a && !b) return null;
  const ka = a ? ROOM_KNOWLEDGE[a] : null;
  const kb = b ? ROOM_KNOWLEDGE[b] : null;
  // トイレ・収納の戸は外へ（相手の部屋の中へ）
  if (ka?.door === 'out' && kb?.door !== 'out') return 'b';
  if (kb?.door === 'out' && ka?.door !== 'out') return 'a';
  // 個室・浴室・和室の戸はその部屋の中へ（通路側へは開かない）
  if (ka && (ka.private || ka.wet) && kb && (kb.circulation || !kb.private)) return 'a';
  if (kb && (kb.private || kb.wet) && ka && (ka.circulation || !ka.private)) return 'b';
  // 通路から部屋へ
  if (ka?.circulation && kb && !kb.circulation) return 'b';
  if (kb?.circulation && ka && !ka.circulation) return 'a';
  return null;
}

/** 通路（玄関・ホール・階段）か、人が通る大きな部屋（LDK など）か */
export function isCirculation(t: RoomType | null | undefined): boolean {
  return !!t && (ROOM_KNOWLEDGE[t].circulation || t === 'ldk' || t === 'living' || t === 'dining');
}
