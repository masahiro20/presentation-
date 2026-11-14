/**
 * 図面のメモ（Floor.notes）の出どころを見分ける。
 *
 * Floor.notes には 4 種類の文が入る:
 *  - memo: 設計士が図面に書いた見せ場の言葉（「デザイン性の高い階段で素敵に！」「R 壁を使ったニッチが素敵です」）
 *          → お客様に見せてよい（体験リンクの「設計士のメモ」・提案資料・3D の札）。こだわりの下書きにもなる
 *  - work: 設計の作業メモ（「建具は柱の位置で何枚割りにするか検討」「階段は 1〜2、2〜3F の蹴上をそろえる」）
 *          → 社内の 3D の札には出す。お客様には出さない。こだわりの下書きにもしない
 *  - tool: 読み取りが自分で足した注記（「戸が読めなかったので、ホールとの壁に戸を置きました（違えば方眼で直せます）」
 *          「LDK: 天井高 2,700 mm（図面の注記）」）→ 社内の作業用。お客様には出さない
 *  - spec: 仕様書・申請図の決まり文句（くぎ・配管・性能値・「〜とする」）→ メモではない。どこにも出さない
 *
 * 前に保存したプロジェクト・すでに渡した体験リンクのデータにも tool・spec の文が入っているので、
 * 読み取りで印を付けるだけでなく、文面から見分ける（出す側で毎回ふるいに掛ける）。
 */
import type { Floor } from './types';

export type PlanNote = NonNullable<Floor['notes']>[number];
export type PlanNoteKind = 'memo' | 'work' | 'tool' | 'spec';

/** 読み取りが足した注記の言い回し（parser/ensureOpenings.ts・assemble.ts の文面） */
const TOOL_NOTE = /違えば方眼|図面の注記|読めなかったので|として扱いました|壁で閉じていたので/;

/**
 * 仕様書・申請図の決まり文句。設計士の「見せ場のメモ」とは別物なので、メモとして扱わない
 * （申請図: 「くぎ N50・@150mm以下」「サッシ性能値: 別紙自己宣言書による…」「全ての配管系を 13A 以下とする」）
 */
const SPEC_NOTE =
  /くぎ|釘[:：\s]|配管|排水|給水|給湯|トラップ|点検口|PB\s?\d|準不燃|不燃|認定|石綿|クロルピリホス|ロックウール|F☆|性能|仕様とする|とする[。)）]*$|とする[。※]|打設|接合|支持金物|アンダーカット|気流|\d+A以下|自己宣言|各階共通|別紙|告示|建築基準法|施行令|耐力壁|筋かい|ホールダウン|換気回数|シックハウス|24時間換気|省エネ|等級|非常用進入口|代替進入口|排煙|延焼|防火設備|[＠@]\s?\d{2,3}/;

/**
 * 設計の作業メモ（検討中のこと・納まりの申し送り）。図面には書いてあるが、お客様へ「設計士のメモ」として出す言葉ではない
 * （「建具は柱の位置で何枚割りにするか検討」「階段は 1〜2、2〜3F の蹴上をそろえる」「袖壁控える。」「乾太くんダクト経路」）
 */
const WORK_NOTE =
  /検討|要確認|確認中|かもしれません|可能性があります|蹴上|そろえる|揃える|(天端|高さ|芯|通り|ライン|レベル)合わせ|面にする|面一|ツライチ|経路|控える|未定|要相談|打合せ|打ち合わせ|変更になる|にしてあります|心配なため/;

export function noteKind(n: Pick<PlanNote, 'text'> | string): PlanNoteKind {
  const text = (typeof n === 'string' ? n : n.text).normalize('NFKC');
  if (TOOL_NOTE.test(text)) return 'tool';
  if (SPEC_NOTE.test(text)) return 'spec';
  if (WORK_NOTE.test(text)) return 'work';
  return 'memo';
}

/** 設計士が図面に書いたメモだけ（お客様に見せるもの） */
export function designerNotes(f: Pick<Floor, 'notes'> | null | undefined): PlanNote[] {
  return (f?.notes ?? []).filter((n) => noteKind(n) === 'memo');
}

/** 3D の札に出すメモ: 設計士のメモと、社内の画面では作業メモ・読み取りの注記も（補った場所に気づけるように）。仕様の決まり文句は出さない */
export function labelNotes(f: Pick<Floor, 'notes'> | null | undefined, staff: boolean): PlanNote[] {
  return (f?.notes ?? []).filter((n) => {
    const k = noteKind(n);
    return k === 'memo' || (staff && (k === 'tool' || k === 'work'));
  });
}
