/**
 * 立面図の外部仕上表（parser/finishTable）→ コーディネートの選択（屋根・外壁・アクセント・軒天・サッシ・玄関ドア）と品番メモ。
 *
 * 設計士が図面に書いた仕様をそのまま初期値にする（コーディネーターが一から選び直さなくてよい・お客様に図面と違う外観を見せない）。
 * カタログに同じ色が無いもの（「スターゴールド」など）は近い商品を選び、図面の文言は品番メモに残す（資料・仕様決定書の仕上表に出る）。
 * 色が「〇〇〇〇」（未定）の欄は商品を変えず、品番メモだけ残す。
 */
import type { FinishRow } from '../parser/finishTable';

export interface FinishFromTable {
  /** 部位 id → 商品 id */
  finishes: Record<string, string>;
  /** 部位 id → 図面の文言（品番メモ） */
  notes: Record<string, string>;
  /** 外壁の色（カタログに無い色。ガルバの色など） */
  wallColor?: string;
  /** 反映した部位の名前（「屋根」「外壁」…） */
  applied: string[];
}

/** 色の名前 → 明るさの分類 */
const DARK = /ブラック|黒|クロ|ギングロ|銀黒|チャコール|ダーク|コゲチャ|焦げ茶|こげ茶|ブラウン|鉄黒|墨|スミ|ディープ/;
const LIGHT = /ホワイト|白|シロ|アイボリー|オフホワイト/;
const SILVER = /シルバー|銀|ステン|プラチナ|シャイングレー|ライトグレー|パールグレー/;
const WOOD_DARK = /ウォールナット|木目.*濃|濃.*木目|チーク/;
const WOOD_LIGHT = /オーク|木目|メープル|ナチュラル/;

/** カタログに無い外壁色（ガルバ・サイディングの代表的な色名）のおおよその色 */
const WALL_COLOR: [RegExp, string][] = [
  [/スターゴールド|ゴールド|シャンパン/, '#a89670'],
  [/モダンベージュ|ベージュ/, '#bcae96'],
  [/ブリティッシュグリーン|モスグリーン|グリーン/, '#4f5a4a'],
  [/コゲチャ|焦げ茶|ブラウン/, '#4a3b31'],
  [/ネイビー|ブルー/, '#2f3a4a'],
];

/**
 * 図面の文言を品番メモ向けに整える（お客様に出る仕上表・仕様決定書に載るので読みやすく）。
 * 半角カナ・全角英数は普通の文字に、下葺材・防火の告示・下地の構成（PB・構造用合板）・断熱の行は外す
 */
export function shortText(t: string): string {
  return t
    .normalize('NFKC')
    .replace(/下葺材\S*/g, '')
    .replace(/防火[:：]\S*/g, '')
    .replace(/\S*(PB|告示|構造用合板|屋内側)\S*/g, '')
    .replace(/屋根[:：].*$/, '')
    // 日本語の書類らしく「色：」「（K055）」は全角に戻す
    .replace(/色:/g, '色：')
    .replace(/\(([^()]*)\)/g, '（$1）')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function finishesFromTable(rows: Pick<FinishRow, 'part' | 'text' | 'color'>[]): FinishFromTable {
  const out: FinishFromTable = { finishes: {}, notes: {}, applied: [] };
  const done = (cat: string, label: string, product: string | null, row: Pick<FinishRow, 'text'>) => {
    if (product) out.finishes[cat] = product;
    out.notes[cat] = shortText(row.text);
    if (!out.applied.includes(label)) out.applied.push(label);
  };
  // 屋根
  const roof = rows.find((r) => r.part === '屋根');
  if (roof && /ガルバ|ｶﾞﾙﾊﾞ|ｶﾞﾙﾊﾘ|ガルハ|GL鋼板|立平|横葺|金属屋根/.test(roof.text)) {
    const c = roof.color ?? '';
    done('roof', '屋根', !c ? null : DARK.test(c) ? 'roof.gl.black' : SILVER.test(c) || LIGHT.test(c) ? 'roof.gl.silver' : 'roof.gl.black', roof);
  }
  // 外壁: 番号付きの欄のうち、仕上げ材の書いてあるもの（下地の欄は除く）。2 つ目はアクセント
  const walls = rows.filter((r) => /^外壁/.test(r.part) && /ジョリパット|Sto|そとん|塗り壁|ガルバ|ｶﾞﾙﾊﾞ|スパン|サイディング|SOLIDO|タイル|羽目板|杉/.test(r.text) && !/透湿|胴縁/.test(r.text));
  const main = walls[0];
  if (main) {
    const t = main.text;
    const c = main.color ?? '';
    let p: string | null = null;
    if (/ジョリパット/.test(t)) p = !c ? null : LIGHT.test(c) ? 'ext.jp.white' : /ライト/.test(c) ? 'ext.jp.light' : DARK.test(c) ? 'ext.jp.dark' : /ベージュ|サンド/.test(c) ? 'ext.jp.beige' : /グレー/.test(c) ? 'ext.jp.mid' : null;
    else if (/Sto/i.test(t)) p = !c ? null : LIGHT.test(c) ? 'ext.sto.white' : /グレージュ|ベージュ/.test(c) ? 'ext.sto.grey' : 'ext.sto.light';
    else if (/そとん/.test(t)) p = 'ext.soton';
    else if (/ガルバ|ｶﾞﾙﾊﾞ|スパン/.test(t)) {
      p = !c || DARK.test(c) ? 'ext.gl.black' : 'ext.gl.silver';
      const wc = WALL_COLOR.find(([re]) => re.test(c));
      if (wc && !DARK.test(c)) out.wallColor = wc[1];
    }
    done('extWall', '外壁', p, main);
  }
  const acc = walls[1];
  if (acc) {
    const c = acc.color ?? '';
    const p = /SOLIDO|ストレート|窯業/.test(acc.text) ? (!c ? 'acc.solido.black' : DARK.test(c) ? 'acc.solido.black' : 'acc.solido.grey') : /杉|羽目板|木/.test(acc.text) ? 'acc.wood' : null;
    done('accent', 'アクセント外壁', p, acc);
  }
  // 軒天（仕上げの書いてある欄）
  const soffit = rows.find((r) => /^(軒天|軒裏)$/.test(r.part) && /羽目板|杉|ヒノキ|檜|塗装|ケイ酸|ｹｲ酸|石膏|ボード/.test(r.text));
  if (soffit) {
    const c = soffit.color ?? '';
    const p = /杉|ヒノキ|檜|羽目板/.test(soffit.text) ? 'soffit.cedar' : /外観色|外壁同色|色合わせ/.test(c) ? 'soffit.same' : DARK.test(c) ? 'soffit.black' : LIGHT.test(c) ? 'soffit.white' : null;
    done('soffit', '軒天', p, soffit);
  }
  // サッシ
  const sash = rows.find((r) => /^(外建具|外部建具|サッシ)$/.test(r.part));
  if (sash) {
    const c = sash.color ?? '';
    const series = /サーモス/.test(sash.text) ? 'thermos' : /TW/.test(sash.text) ? 'tw' : null;
    let p: string | null = null;
    if (series && c) p = `sash.${series}.${DARK.test(c) ? 'black' : LIGHT.test(c) && series === 'tw' ? 'white' : 'silver'}`;
    done('sash', 'サッシ', p, sash);
  }
  // 玄関ドア
  const door = rows.find((r) => r.part === '玄関ドア');
  if (door) {
    const c = door.color ?? '';
    let p: string | null = null;
    if (/コンコード/.test(door.text)) p = 'door.concord.black';
    else if (/ヴェナート/.test(door.text) && c) p = DARK.test(c) && !/ディープグレ/.test(c) ? 'door.venato.black' : WOOD_DARK.test(c) ? 'door.venato.walnut' : WOOD_LIGHT.test(c) ? 'door.venato.oak' : 'door.venato.grey';
    done('entDoor', '玄関ドア', p, door);
  }
  return out;
}
