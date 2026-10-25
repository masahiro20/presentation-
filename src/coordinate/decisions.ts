/**
 * コーディネートの「決める段取り」: 部位ごとの状態（未着手 → 候補を提示 → お客様が選択 → 決定）と、
 * 決める順番（外まわり → LDK → 水まわり・設備）、候補の絞り込み、お客様の選択の受け取り。
 *
 * 打ち合わせが長引く・回数が増える原因は、(1) その場で全商品から探す (2) 決めたことが後で崩れる（床を変えたら建具も…）
 * (3) 何が決まって何が残っているか分からない、の 3 つ。ここでは
 *   - 先に 2〜3 案に絞ってお客様に見せる（お客様は家で、自分の家の 3D で見比べて選べる）
 *   - 決める順番を依存関係の順にする（外壁 → サッシ・玄関ドア、床 → 建具・キッチン）
 *   - 決まったものは日付つきで固定し、仕様決定書（署名欄つき）にする
 * で、打ち合わせを「決める場」にする。
 */
import { FINISH_CATEGORIES, selectedProduct, type FinishCategory } from './catalog';
import type { DesignOptions } from '../styles/presets';
import type { Shot } from '../scene/shots';
import { yen } from '../estimate/calc';

export type DecisionStatus = 'open' | 'proposed' | 'picked' | 'decided';

export const STATUS_LABEL: Record<DecisionStatus, string> = {
  open: '未着手',
  proposed: '候補をご提示',
  picked: 'お客様が選択',
  decided: '決定',
};

export interface DecisionItem {
  status: DecisionStatus;
  /** お客様に見せる候補（商品 id。2〜3 案） */
  candidates?: string[];
  /** 決定した日（YYYY-MM-DD） */
  decidedAt?: string;
  /** お客様が選んだ候補とひとこと（共有リンクから） */
  customerPick?: string;
  customerComment?: string;
  customerAt?: string;
}

export interface CoordState {
  items: Record<string, DecisionItem>;
  /** 最後に作った体験リンク（お客様の選択の受け取り先） */
  shareUrl?: string;
  /** お客様への全体のひとこと（共有リンクから） */
  customerNote?: string;
}

export interface DecisionRound {
  no: number;
  title: string;
  /** なぜこの順番か（コーディネーターがお客様に話せる言葉） */
  why: string;
  cats: string[];
  /** 決めておきたい時期 */
  deadline: string;
  /** 打ち合わせの前に見ておくもの */
  prepare: string;
}

/** 決める順番。前の回で決めたものが次の回の選び方を決める（依存の向き） */
export const ROUNDS: DecisionRound[] = [
  {
    no: 1,
    title: '外まわり',
    why: '外壁の色が決まると、サッシ・玄関ドア・軒天の「合う色」が自然に絞れます。確認申請・サッシの発注にも関わるので最初に。',
    cats: ['extWall', 'accent', 'roof', 'soffit', 'sash', 'entDoor'],
    deadline: '着工の約 2 か月前（サッシの発注）',
    prepare: '外壁は A4 より大きいサンプルを屋外の光で（室内の照明では濃く見えます）',
  },
  {
    no: 2,
    title: 'LDK の床・キッチン・建具',
    why: '床がいちばん面積が大きく、建具・キッチンの扉・カップボード・階段の踏板の色は床に合わせて決まります。床から順に。',
    cats: ['floor', 'kitchen', 'cupboard', 'door', 'stair', 'wall', 'light'],
    deadline: '着工の約 1 か月前（キッチンの発注）',
    prepare: 'キッチンはショールームで高さ（850／900）と引き出しの使い勝手を確認。床はサンプルを自然光で',
  },
  {
    no: 3,
    title: '水まわり・設備',
    why: '浴室・洗面・トイレ・給湯・換気は標準で決まっていることが多く、変える所だけ話せば短時間で終わります。',
    cats: ['wetFloor', 'bath', 'vanity', 'toilet', 'water', 'vent', 'ac', 'pv'],
    deadline: '上棟の頃（内装・設備の発注）',
    prepare: '浴室は TOTO ショールームでサイズ（1616／1620）と浴槽の形を',
  },
];

/** 先に決めてほしい部位（この部位はあの部位が決まってから） */
export const DEPENDS: Record<string, string[]> = {
  accent: ['extWall'],
  soffit: ['extWall'],
  sash: ['extWall'],
  entDoor: ['extWall', 'sash'],
  door: ['floor', 'wall'],
  kitchen: ['floor'],
  cupboard: ['kitchen'],
  stair: ['floor'],
  wetFloor: ['floor'],
};

export function categoryById(id: string): FinishCategory | undefined {
  return FINISH_CATEGORIES.find((c) => c.id === id);
}

export function newCoord(): CoordState {
  return { items: {} };
}

export function itemOf(c: CoordState, catId: string): DecisionItem {
  return c.items[catId] ?? { status: 'open' };
}

/** 選択肢が 1 つしかない（標準で決まっている）部位 */
export function isFixed(catId: string): boolean {
  return (categoryById(catId)?.products.length ?? 0) <= 1;
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 候補を入れ替える（今の選択は必ず候補に含める。最大 3 案） */
export function setCandidates(c: CoordState, catId: string, ids: string[]): CoordState {
  const uniq = [...new Set(ids)].slice(0, 3);
  const it = itemOf(c, catId);
  const status: DecisionStatus = it.status === 'decided' ? 'decided' : uniq.length >= 2 ? 'proposed' : it.status === 'proposed' ? 'open' : it.status;
  return { ...c, items: { ...c.items, [catId]: { ...it, candidates: uniq, status } } };
}

export function decide(c: CoordState, catId: string, on = true): CoordState {
  const it = itemOf(c, catId);
  const status: DecisionStatus = on ? 'decided' : it.customerPick ? 'picked' : (it.candidates?.length ?? 0) >= 2 ? 'proposed' : 'open';
  return { ...c, items: { ...c.items, [catId]: { ...it, status, decidedAt: on ? today() : undefined } } };
}

/** 決まり具合（全体・回ごと） */
export function progress(c: CoordState): { decided: number; total: number; byRound: { no: number; decided: number; total: number }[] } {
  const byRound = ROUNDS.map((r) => ({ no: r.no, decided: r.cats.filter((id) => itemOf(c, id).status === 'decided').length, total: r.cats.length }));
  return { decided: byRound.reduce((s, r) => s + r.decided, 0), total: byRound.reduce((s, r) => s + r.total, 0), byRound };
}

/** まだ決まっていない部位のうち、先に決めるべき部位が決まっていないもの（順番の注意） */
export function blockedBy(c: CoordState, catId: string): string[] {
  return (DEPENDS[catId] ?? []).filter((d) => itemOf(c, d).status !== 'decided');
}

/** 決定した後に、先に決めた部位（依存元）が変わった部位: 見直しが要る */
export function needsReview(c: CoordState, changedCat: string): string[] {
  return Object.entries(DEPENDS)
    .filter(([cat, deps]) => deps.includes(changedCat) && itemOf(c, cat).status === 'decided')
    .map(([cat]) => cat);
}

/** お客様の共有リンクからの選択（picks.json） */
export interface CustomerPicks {
  at: string;
  picks: Record<string, { id: string; comment?: string }>;
  note?: string;
}

/** お客様の選択を取り込む: design の選択を入れ替え、状態を「お客様が選択」に。決定済みの部位は変えない（変えたい場合は差分として返す） */
export function applyCustomerPicks(c: CoordState, d: DesignOptions, p: CustomerPicks): { coord: CoordState; finishes: Record<string, string>; changed: string[]; conflicts: string[] } {
  const items = { ...c.items };
  const finishes = { ...(d.finishes ?? {}) };
  const changed: string[] = [];
  const conflicts: string[] = [];
  for (const [catId, pick] of Object.entries(p.picks)) {
    const cat = categoryById(catId);
    if (!cat || !cat.products.some((x) => x.id === pick.id)) continue;
    const it = items[catId] ?? { status: 'open' as DecisionStatus };
    if (it.status === 'decided' && selectedProduct(cat, d).id !== pick.id) {
      conflicts.push(catId);
      items[catId] = { ...it, customerPick: pick.id, customerComment: pick.comment, customerAt: p.at };
      continue;
    }
    if (selectedProduct(cat, d).id !== pick.id) changed.push(catId);
    finishes[catId] = pick.id;
    items[catId] = { ...it, status: it.status === 'decided' ? 'decided' : 'picked', customerPick: pick.id, customerComment: pick.comment, customerAt: p.at };
  }
  return { coord: { ...c, items, customerNote: p.note ?? c.customerNote }, finishes, changed, conflicts };
}

/** 共有リンク（view.html?p=<project.json の URL>）から、お客様の選択の置き場所（同じフォルダの picks.json） */
export function picksUrlFor(shareOrProjectUrl: string): string | null {
  try {
    const u = new URL(shareOrProjectUrl);
    const p = u.searchParams.get('p');
    const proj = p ? new URL(p) : u;
    if (!/project\.json$/.test(proj.pathname)) return null;
    proj.pathname = proj.pathname.replace(/project\.json$/, 'picks.json');
    proj.search = '';
    return proj.toString();
  } catch {
    return null;
  }
}

/** 3D で見比べられない部位（設備は見た目が変わらない） */
export const NON_VISUAL = new Set(['bath', 'vanity', 'toilet', 'water', 'vent', 'ac', 'pv']);

/** 部位の見える構図（外部 → 道路側の外観、内部 → LDK、玄関・水まわりの床 → 玄関、階段 → 階段・ホール） */
export function shotFor(catId: string, shots: Shot[]): Shot | undefined {
  const cat = categoryById(catId);
  if (!cat || NON_VISUAL.has(catId)) return undefined;
  if (cat.part === '外部') return shots.find((s) => s.id === 'ext-front') ?? shots.find((s) => s.kind === 'exterior');
  const ints = shots.filter((s) => s.kind === 'interior');
  if (catId === 'wetFloor') return ints.find((s) => /玄関|洗面|脱衣/.test(s.title)) ?? ints[0];
  if (catId === 'stair') return ints.find((s) => /階段|ホール/.test(s.title)) ?? ints.find((s) => /LDK|リビング/.test(s.title)) ?? ints[0];
  return ints.find((s) => /LDK|リビング|キッチン/.test(s.title)) ?? ints[0];
}

/** 差額の表示（税込） */
export function deltaText(v: number | null | undefined): string {
  if (v == null) return '見積に影響なし';
  if (Math.abs(v) < 1000) return '差額なし';
  return `${v > 0 ? '＋' : '−'}${yen(Math.abs(v))} 円`;
}

/** 選択がまとめて変わった（雰囲気・テイストの切り替え）とき、中身が変わった決定済みの部位の決定を外す */
export function reconcileDecided(c: CoordState, before: DesignOptions, after: DesignOptions): { coord: CoordState; undone: string[] } {
  let coord = c;
  const undone: string[] = [];
  for (const cat of FINISH_CATEGORIES)
    if (itemOf(coord, cat.id).status === 'decided' && selectedProduct(cat, before).id !== selectedProduct(cat, after).id) {
      coord = decide(coord, cat.id, false);
      undone.push(cat.label);
    }
  return { coord, undone };
}
