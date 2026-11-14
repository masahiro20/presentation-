/**
 * 設計士のメモを読む（図面の吹き出し → こだわりの参考資料の下書き）
 * （部屋のつながりから動線の意味を読む core/designIntent.ts とは別: こちらは図面に書かれた言葉を読む）
 *
 * 平面図には「デザイン性の高い階段で素敵に！」「R 壁を使ったニッチが素敵です」のように、設計士が見せ場を書き込んでいる。
 * 読み取りはこのメモを文字として拾い、3D の札・資料には出していたが、3D の形や仕上げの説明文には使っていなかった。
 * ここでは、メモの言葉から「どの部位の・何をしたいのか」を読んで、こだわりの参考資料（core/focus.ts）の下書きにする。
 *
 *  - 下書きは勝手には入れない。設計士・コーディネーターが確かめて取り込む（言葉からの受け取りは外れることがある）
 *  - 取り込んだ下書きは、ふつうのこだわり指定と同じ: 3D（階段のつくり・手すり、造作、照明）と、仕上げの説明文に効く
 *  - 3D に形として反映できない言葉（ニッチ・丸柱など）も、説明文には入る（AI 仕上げが、その場所をそのように描く）
 *
 * 言葉の決まり（RULES）は、御社の図面のメモから拾ったもの。新しい言い回しを見つけたら、ここに 1 行足す。
 */
import type { BuildingModel, BuiltinVariant, RoomType, StairBuild, StairLook } from './types';
import type { FocusGuard, FocusLighting, FocusNote, FocusPart } from './focus';
import { noteKind } from './planNotes';
import { sizeFromMemo } from './memoPlace';

export interface MemoIntent {
  /** 同じ図面を読み直しても変わらない id（階とメモの文から）。取り込んだこだわり指定の id にもなる */
  id: string;
  level: number;
  /** 図面のメモの文（そのまま） */
  text: string;
  roomName?: string;
  /** メモが書かれている位置（mm）と部屋。3D でその場所を見せる・その部屋のこだわりにするため */
  x?: number;
  y?: number;
  roomId?: string;
  part: FocusPart;
  /** ツールの受け取り方（1 行） */
  reading: string;
  /** 3D へ反映できる選択（取り込むときの初期値。画面で変えられる） */
  stairBuild?: StairBuild;
  stair?: StairLook;
  joinery?: BuiltinVariant;
  /** メモに書かれた造作の寸法（m。「机 W2500〜D500 ほど」→ 幅 2.5・奥行 0.5）。メモの場所に置くときに使う */
  size?: { w?: number; d?: number };
  lighting?: FocusLighting;
  guard?: FocusGuard;
  /** true = 3D の形・仕上げに反映できる選択がある。false = 仕上げの説明文にだけ入る */
  actionable: boolean;
}

interface Rule {
  /** メモの文に当たる言葉 */
  re: RegExp;
  part: FocusPart;
  /** true = メモが書かれている部屋が分かるときは、その部屋の部位にする（光・窓・壁の仕上げなど、どの部屋にもある話） */
  byRoom?: boolean;
  /** true = 場所の言葉だけで決める決まり（玄関・LDK・庭…）。文に場所の言葉が 2 つあるときは、文の終わりの言葉を優先する */
  place?: boolean;
  reading: string;
  stairBuild?: StairBuild;
  stair?: StairLook;
  joinery?: BuiltinVariant;
  lighting?: FocusLighting;
  guard?: FocusGuard;
}

/**
 * 上から順に見て、最初に当たった決まりを使う（具体的な言葉を先に）。
 * 階段の「つくり」を言葉から決められないもの（デザイン性の高い階段 など）は、つくりを入れずに部位だけ決める
 * （取り込むときに、設計士がつくりを選ぶ）
 */
const RULES: Rule[] = [
  // --- 階段 ---
  { re: /片持ち|キャンチ|カンチ|浮いた階段|浮遊/, part: 'stair', reading: '壁から踏板だけが出る片持ち階段', stairBuild: 'cantilever' },
  { re: /箱階段|蹴込み/, part: 'stair', reading: '蹴込みのある箱階段', stairBuild: 'box' },
  { re: /(鉄骨|スチール|アイアン)[^。！!]{0,8}階段|階段[^。！!]{0,12}(鉄骨|スチール|アイアン)/, part: 'stair', reading: '黒い鉄骨の階段', stairBuild: 'steel' },
  { re: /(スケルトン|ストリップ|オープン|シースルー)[^。！!]{0,6}階段|階段[^。！!]{0,12}(スケルトン|オープン|抜け感|透け)/, part: 'stair', reading: '蹴込みの無い、向こうが抜けて見える階段' },
  { re: /階段[^。！!]{0,14}ガラス|ガラス[^。！!]{0,8}手すり/, part: 'stair', reading: 'ガラスの手すりの階段', stair: { rail: 'glass' } },
  { re: /(デザイン|魅せ|見せ|主役|シンボル|オブジェ|アクセント|印象|素敵|かっこ|格好|美し)[^。！!]{0,14}階段|階段[^。！!]{0,14}(デザイン|魅せ|見せ|主役|シンボル|オブジェ|アクセント|印象|素敵|かっこ|格好|美し)/, part: 'stair', reading: '階段を見せ場にする（つくりを選んでください）' },
  { re: /リビング階段|リビングイン階段|階段[^。！!]{0,10}(ヌック|ベンチ|腰掛|ひな壇|ステップ)|(ヌック|ひな壇)[^。！!]{0,10}階段/, part: 'stair', reading: 'リビングとつながる階段（腰掛けられる段・ヌック）' },
  // --- 吹抜 ---
  { re: /吹抜|吹き抜け|吹抜け/, part: 'void', reading: '吹抜を見せ場にする' },
  // --- 照明 ---
  { re: /(かまち|框|靴|下駄箱|シューズ)[^。！!]{0,12}間接照明|間接照明[^。！!]{0,12}(かまち|框|靴|下駄箱)/, part: 'lighting', reading: '玄関の框・靴入れの下の間接照明（足元の光）', lighting: { indirect: true } },
  { re: /間接照明|コーブ|コーニス|ライン照明|建築化照明/, part: 'lighting', reading: '天井際・家具の下の間接照明', lighting: { indirect: true } },
  { re: /ペンダント/, part: 'lighting', reading: 'ダイニングにペンダント照明', lighting: { pendant: 'ph5' } },
  // --- 造作 ---
  { re: /ニッチ/, part: 'joinery', reading: '壁をくぼませた飾り棚（ニッチ）', joinery: 'openShelf' },
  { re: /(スタディ|ワーク|勉強|PC|パソコン|デスク)[^。！!]{0,8}(カウンター|コーナー|スペース)|カウンター[^。！!]{0,10}(勉強|ワーク|作業|デスク)/, part: 'joinery', reading: '壁付けのスタディカウンター', joinery: 'counter' },
  { re: /ベンチ/, part: 'joinery', reading: '造作のベンチ（収納付き）', joinery: 'bench' },
  { re: /本棚|ライブラリ|書棚/, part: 'joinery', reading: '壁一面の造作本棚', joinery: 'wallShelf' },
  { re: /(テレビ|TV|ＴＶ)[^。！!]{0,6}(ボード|台|収納|周り|まわり|廻り|造作|作り込|作りこ)|壁掛け(テレビ|TV)/, part: 'joinery', reading: '浮かせたテレビボードと飾り棚', joinery: 'floatTv' },
  { re: /キャットウォーク|キャットステップ/, part: 'joinery', reading: '猫の通り道を兼ねた棚（キャットウォーク）', joinery: 'openShelf' },
  { re: /飾り棚|ディスプレイ|見せる収納|オープン棚/, part: 'joinery', reading: '飾り棚（浮き棚）', joinery: 'openShelf' },
  { re: /壁面収納/, part: 'joinery', reading: '壁面収納（扉付き・天井まで）', joinery: 'tallStorage' },
  { re: /机|デスク/, part: 'joinery', reading: '造作の机（壁付けのカウンター）', joinery: 'counter' },
  { re: /可動棚|固定棚|棚板/, part: 'joinery', reading: '造作の棚' },
  { re: /造作|カウンター/, part: 'joinery', reading: '造作の家具・カウンター' },
  // --- 形の見せ場（3D の形にはまだ無い。説明文に入る） ---
  { re: /R\s*壁|Ｒ\s*壁|アール|曲面|曲線の壁|丸い壁/, part: 'living', reading: '曲面の壁（R 壁）を見せ場にする' },
  { re: /丸柱|円柱/, part: 'living', reading: '丸い柱を見せる' },
  { re: /勾配天井|下がり天井|折り?上げ|天井[^。！!]{0,6}(板張り|木)/, part: 'living', byRoom: true, reading: '天井の形・仕上げを見せ場にする' },
  { re: /タイル貼り|タイル張り|石貼り|石張り|板張り|板貼り|塗り壁|左官|ふかし壁|エコカラット|アクセント(クロス|ウォール|壁)/, part: 'living', byRoom: true, reading: '壁の仕上げを見せ場にする（タイル・板張りなど）' },
  { re: /小上がり|畳コーナー|ダウンリビング|ダウンフロア|ピットリビング|スキップ/, part: 'living', reading: '床の段差で居場所をつくる' },
  // --- 部位ごと ---
  // 場所の言葉が 2 つ出てくる文は、文の終わりの言葉（「…トレーニングガレージ」「…L字のLDKです」）を優先し、
  // 終わりが場所の言葉でなければ、この並びの順（「湯船につかりながら…お庭を楽しめます」は、立っている浴室の側。庭はそこから見えるもの）
  { re: /キッチン|パントリー|カップボード/, part: 'kitchen', place: true, reading: 'キッチンまわりのこだわり' },
  { re: /玄関|土間|シューズ|アプローチ|(?<!専)門/, part: 'entrance', place: true, reading: '玄関・アプローチのこだわり' },
  { re: /洗面|脱衣|ランドリー|浴室|お風呂|湯船|バス(?!ケ)/, part: 'bath', place: true, reading: '洗面・浴室・ランドリーのこだわり' },
  { re: /リビング|ＬＤＫ|LDK|ダイニング/, part: 'living', place: true, reading: 'リビング・内装のこだわり' },
  { re: /外観|ファサード|庭|中庭|坪庭|植栽|テラス|デッキ|バルコニー|ガレージ|車庫/, part: 'exterior', place: true, reading: '外まわり・庭のこだわり' },
  // --- どの部屋にもある話（部屋が分かれば、その部屋のこだわりに） ---
  { re: /光を取り込|採光|明る|日差し|陽だまり|風が抜け|風通し|通風/, part: 'living', byRoom: true, reading: '光・風の入り方' },
  { re: /地窓|高窓|天窓|トップライト|ハイサイド|ピクチャー|コーナー窓|天井付け窓|窓/, part: 'living', byRoom: true, reading: '窓の取り方（光・視線の抜け）' },
];

/** メモが書かれている部屋の種類 → こだわりの部位（部屋から決められないものは null） */
function partOfRoom(type: RoomType | undefined): FocusPart | null {
  switch (type) {
    case 'ldk':
    case 'living':
    case 'dining':
    case 'japanese':
    case 'bedroom':
    case 'kids':
    case 'study':
      return 'living';
    case 'kitchen':
      return 'kitchen';
    case 'entrance':
    case 'hall':
    case 'porch':
      return 'entrance';
    case 'bath':
    case 'washroom':
    case 'toilet':
      return 'bath';
    case 'balcony':
    case 'deck':
    case 'terrace':
    case 'garage':
    case 'carport':
    case 'parking':
      return 'exterior';
    default:
      return null;
  }
}

/** 図面を読み直しても同じになる短い印（メモの文から） */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** メモが書かれている場所（部屋の名前・種類・位置）。分からなければ省く */
export interface MemoPlace {
  roomName?: string;
  roomType?: RoomType;
  roomId?: string;
  x?: number;
  y?: number;
}

/**
 * 1 つのメモから意図を読む（当たる決まりが無ければ、書かれている部屋のこだわり、それも分からなければ「その他」として説明文にだけ入れる）
 * @param place 部屋の名前（文字）か、メモが書かれている場所
 */
export function intentOfNote(text: string, level: number, place?: string | MemoPlace): MemoIntent | null {
  const t = text.trim();
  // 読み取りが自分で足した注記・仕様書の決まり文句は、設計士のメモではない
  if (t.length < 5 || noteKind(t) !== 'memo') return null;
  const pl: MemoPlace = typeof place === 'string' ? { roomName: place } : (place ?? {});
  let rule = RULES.find((r) => r.re.test(t));
  if (rule?.place) {
    // 日本語は、文の終わりの言葉が主役（「お庭を眺め、LDK にいる家族の気配も感じながら…トレーニングガレージ」はガレージの話）
    const tail = t.replace(/(です|でした|ます)?[!！。\s]*$/, '');
    rule = RULES.find((r) => r.place && new RegExp(`(?:${r.re.source})$`).test(tail)) ?? rule;
  }
  const roomPart = partOfRoom(pl.roomType);
  const base = {
    id: `memo-${level}-${hash(t)}`,
    level,
    text: t,
    ...(pl.roomName ? { roomName: pl.roomName } : {}),
    ...(pl.roomId ? { roomId: pl.roomId } : {}),
    ...(pl.x != null && pl.y != null ? { x: pl.x, y: pl.y } : {}),
  };
  if (!rule) {
    return roomPart
      ? { ...base, part: roomPart, reading: `${pl.roomName ?? 'この部屋'}のこだわり（仕上げの説明文に入れます）`, actionable: false }
      : { ...base, part: 'other', reading: '設計士のメモ（仕上げの説明文に入れます）', actionable: false };
  }
  const { re: _re, byRoom, place: _place, ...rest } = rule;
  void _re;
  void _place;
  const part = byRoom && roomPart ? roomPart : rule.part;
  const size = part === 'joinery' ? sizeFromMemo(t) : {};
  return { ...base, ...rest, part, ...(size.w || size.d ? { size } : {}), actionable: !!(rule.stairBuild || rule.stair || rule.joinery || rule.lighting || rule.guard || part === 'stair') };
}

/** 図面のメモから読んだ意図の一覧（階の順。同じ文は 1 つに） */
export function memoIntents(model: BuildingModel | null | undefined): MemoIntent[] {
  if (!model) return [];
  const out: MemoIntent[] = [];
  const seen = new Set<string>();
  for (const f of [...model.floors].sort((a, b) => a.level - b.level)) {
    for (const n of f.notes ?? []) {
      const room = n.roomId ? f.rooms.find((r) => r.id === n.roomId) : undefined;
      const it = intentOfNote(n.text, f.level, { roomName: room?.name?.normalize('NFKC'), roomType: room?.type, roomId: room?.id, x: n.x, y: n.y });
      // 同じ文は 1 つに（各階に同じ文が書かれている図面がある。階段の指定だけは階ごと）
      const key = it?.part === 'stair' ? it.id : it?.text;
      if (!it || !key || seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
  }
  // 3D に反映できるものを先に
  return out.sort((a, b) => Number(b.actionable) - Number(a.actionable));
}

/** まだ取り込んでいない・見送っていない意図 */
export function pendingIntents(model: BuildingModel | null | undefined, notes: Pick<FocusNote, 'id'>[], skipped: string[] = []): MemoIntent[] {
  const have = new Set([...notes.map((n) => n.id), ...skipped]);
  return memoIntents(model).filter((it) => !have.has(it.id));
}

/**
 * こだわり指定の下書きにする。階段の指定は、その階から上がる階段に当てる。
 * つくり（stairBuild）・吹抜の縁・照明は家全体の設定なので、ここには入れない（取り込むときに画面で入れ替える）
 */
export function intentToFocus(it: MemoIntent, at: string, hasStairAt: (level: number) => boolean = () => true): FocusNote {
  return {
    id: it.id,
    part: it.part,
    ...(it.part === 'stair' && hasStairAt(it.level) ? { level: it.level } : {}),
    note: it.text,
    images: [],
    ...(it.part === 'stair' && it.stair ? { stair: { ...it.stair } } : {}),
    ...(it.part === 'joinery' && it.joinery ? { joinery: it.joinery } : {}),
    at,
  };
}
