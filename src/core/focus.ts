/**
 * こだわり指定（参考資料）
 *
 * 階段・キッチン・外観など、設計士・コーディネーターのこだわりが出る所に「この仕様・この写真のように提案したい」を添える。
 * 1 件 = 部位 ＋ ひとこと ＋ 参考画像（3 枚まで）＋（階段なら）つくり・手すり・段数。
 *
 * 効き先:
 *  1. 3D と図面（読み取りの補正）: 階段のつくり・手すり・段数を、その階段に入れる（applyFocus → Stair.look）
 *  2. パースの仕上げ（カット集・AI 仕上げ）: その部位が写るカットの説明文に足し、参考画像を添える（focusForShot・focusPromptLines）
 *
 * 図面を読み直しても残るように、モデルではなくプロジェクトに持ち、モデルが変わるたびに当て直す。
 * 参考画像は社内の作業用（仕上げの AI に渡す）。お客様の体験リンクには出さない。
 */
import type { BuildingModel, BuiltinVariant, RoomType, Stair, StairBuild, StairFrame, StairLook, StairRail, StairStringer, StairTread } from './types';

/** 部位。造作（造作家具・カウンター）と照明は、階段と並んでこだわりの出る所（2026-11-12 のご要望） */
export type FocusPart = 'stair' | 'joinery' | 'lighting' | 'kitchen' | 'living' | 'entrance' | 'void' | 'bath' | 'exterior' | 'other';

export const FOCUS_PART_LABEL: Record<FocusPart, string> = {
  stair: '階段',
  joinery: '造作（家具・カウンター）',
  lighting: '照明の雰囲気',
  kitchen: 'キッチン',
  living: 'リビング・内装',
  entrance: '玄関',
  void: '吹抜',
  bath: '洗面・浴室',
  exterior: '外観',
  other: 'その他',
};
export const FOCUS_PARTS = Object.keys(FOCUS_PART_LABEL) as FocusPart[];
const PART_EN: Record<FocusPart, string> = {
  stair: 'Staircase',
  joinery: 'Built-in joinery (shelves, counters, TV board)',
  lighting: 'Lighting mood',
  kitchen: 'Kitchen',
  living: 'Living room / interior',
  entrance: 'Entrance',
  void: 'Double-height void',
  bath: 'Washroom / bathroom',
  exterior: 'Exterior',
  other: 'Note',
};
/** 説明文の中での短い呼び名（「同梱の参考画像の◯◯の形・素材…」） */
const PART_SHORT: Record<FocusPart, string> = { ...FOCUS_PART_LABEL, joinery: '造作', lighting: '照明' };

export const STAIR_BUILD_LABEL: Record<StairBuild, string> = {
  steel: '鉄骨（黒い鋼板の桁＋木の踏板）',
  woodSkeleton: '木のスケルトン（両側の側板）',
  box: '箱階段（蹴込みあり）',
  cantilever: '片持ち（踏板だけ）',
};
export const STAIR_RAIL_LABEL: Record<StairRail, string> = {
  bar: 'アイアン（細い支柱＋横桟）',
  glass: 'ガラス',
  wall: '腰壁',
  wood: '木の手すり',
  none: '手すりなし',
};
export const STAIR_STRINGER_LABEL: Record<StairStringer, string> = {
  side: '両側のささら桁',
  center: '中央の力桁 1 本',
  zigzag: '稲妻ささら（蹴込み板あり）',
};
export const STAIR_TREAD_LABEL: Record<StairTread, string> = {
  floor: '床に合わせる',
  oak: 'オーク',
  walnut: 'ウォールナット',
  white: '白',
  black: '黒',
  mortar: 'モルタル（左官調）',
};
export const STAIR_FRAME_LABEL: Record<StairFrame, string> = {
  black: '黒',
  white: '白',
};
export const STAIR_BUILDS = Object.keys(STAIR_BUILD_LABEL) as StairBuild[];
export const STAIR_RAILS = Object.keys(STAIR_RAIL_LABEL) as StairRail[];
export const STAIR_STRINGERS = Object.keys(STAIR_STRINGER_LABEL) as StairStringer[];
export const STAIR_TREADS = Object.keys(STAIR_TREAD_LABEL) as StairTread[];
export const STAIR_FRAMES = Object.keys(STAIR_FRAME_LABEL) as StairFrame[];

/** 造作の形（3D の「家具」の道具で置ける造作家具と同じ 9 つ）。言葉は仕上げの説明文と一覧に使う */
export const JOINERY_LABEL: Record<BuiltinVariant, string> = {
  floatTv: '浮かせたテレビボード＋飾り棚',
  wallShelf: '壁一面の造作本棚',
  openShelf: '飾り棚（浮き棚）',
  shelfDesk: '本棚＋デスク（スタディコーナー）',
  counter: 'スタディカウンター（壁付け）',
  bench: '造作ベンチ（収納付き）',
  tallStorage: '壁面収納（扉付き・天井まで）',
  lowShelf: '腰高のオープン棚',
  shelves: '可動棚（収納の中）',
};
const JOINERY_EN: Record<BuiltinVariant, string> = {
  floatTv: 'a wall-hung floating TV board with floating shelves above it',
  wallShelf: 'a full-height built-in open bookshelf covering the wall',
  openShelf: 'floating open shelves made of thick boards',
  shelfDesk: 'a built-in study counter with open shelves above',
  counter: 'a wall-mounted floating desk counter',
  bench: 'a built-in bench with storage underneath',
  tallStorage: 'full-height flush-door wall storage that blends into the wall',
  lowShelf: 'a waist-high open shelf',
  shelves: 'adjustable open storage shelves',
};
export const JOINERY_VARIANTS = Object.keys(JOINERY_LABEL) as BuiltinVariant[];

/**
 * 吹抜の縁（落下防止）の家全体の選択。styles/spec の VoidGuardSpec と同じ値
 * （指定そのものはデザインの「納まり」に 1 つだけ持つ。ここは AI の読み取り結果と画面の選択肢に使う）
 */
export type FocusGuard = 'rail' | 'half' | 'glass' | 'halfGlass' | 'wall';
export const FOCUS_GUARDS: FocusGuard[] = ['rail', 'half', 'glass', 'halfGlass', 'wall'];

/**
 * 照明の雰囲気として 3D に反映できる項目（AI の読み取り結果）。
 * 指定そのものはデザイン（納まりの間接照明・コーディネートの「ダイニングの照明」「照明の色」・時間帯）に 1 つだけ持つ
 */
export interface FocusLighting {
  /** 天井際の間接照明 */
  indirect?: boolean;
  /** ダイニングのペンダント: 白い多層シェード／黒いドーム／乳白ガラスの小さな球 */
  pendant?: 'ph5' | 'dome' | 'globes';
  /** 光の色（色温度 K） */
  kelvin?: 2700 | 3000 | 3500;
  /** パースの時間帯 */
  tod?: 'day' | 'evening' | 'night';
}
/** 知っている値だけに整える。何も無ければ undefined */
export function cleanLighting(l: unknown): FocusLighting | undefined {
  if (!l || typeof l !== 'object') return undefined;
  const r = l as Record<string, unknown>;
  const out: FocusLighting = {};
  if (typeof r.indirect === 'boolean') out.indirect = r.indirect;
  if (r.pendant === 'ph5' || r.pendant === 'dome' || r.pendant === 'globes') out.pendant = r.pendant;
  const k = Number(r.kelvin);
  if (k === 2700 || k === 3000 || k === 3500) out.kelvin = k;
  if (r.tod === 'day' || r.tod === 'evening' || r.tod === 'night') out.tod = r.tod;
  return Object.keys(out).length ? out : undefined;
}

export interface FocusImage {
  /** 縮小した画像（data: URL） */
  url: string;
  name?: string;
}

export interface FocusNote {
  id: string;
  part: FocusPart;
  /** 階段: その階から上がる階段だけに当てる。無ければすべての階段 */
  level?: number;
  /** ひとこと（設計の意図。仕上げの AI にもそのまま伝える。例「黒い鉄骨に無垢の踏板。手すりは細いフラットバーで軽く」） */
  note: string;
  /** 参考画像（3 枚まで） */
  images: FocusImage[];
  /** 階段の手すり・桁・踏板の色・鉄の色・段数（3D と図面に反映） */
  stair?: StairLook;
  /** 造作の形（仕上げの説明文に入る。3D には「家具」の道具で置く） */
  joinery?: BuiltinVariant;
  /** 登録した日時（ISO） */
  at: string;
}

export const FOCUS_MAX_IMAGES = 3;

const validSteps = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 6 && n <= 30 ? Math.round(n) : undefined);

/** 中身のある指定だけに整える（空の項目を落とす）。何も無ければ undefined */
export function cleanStairLook(l: StairLook | undefined | null): StairLook | undefined {
  if (!l) return undefined;
  const out: StairLook = {};
  if (l.rail && STAIR_RAILS.includes(l.rail)) out.rail = l.rail;
  const steps = validSteps(l.steps);
  if (steps) out.steps = steps;
  // 既定と同じ値（床に合わせる・黒）は持たない: 「指定なし」と同じ見た目なので、空の指定として扱う。
  // 桁は、指定が無ければテイストの決まり（両側のささら桁か稲妻ささら）なので、選んだ値はそのまま持つ
  if (l.stringer && STAIR_STRINGERS.includes(l.stringer)) out.stringer = l.stringer;
  if (l.tread && l.tread !== 'floor' && STAIR_TREADS.includes(l.tread)) out.tread = l.tread;
  if (l.frame === 'white') out.frame = 'white';
  return Object.keys(out).length ? out : undefined;
}

/** 読み込んだプロジェクト・手入力の値を、決まった形に整える（知らない部位は「その他」、画像は 3 枚まで） */
export function normalizeFocus(list: unknown): FocusNote[] {
  if (!Array.isArray(list)) return [];
  const out: FocusNote[] = [];
  for (const raw of list as Partial<FocusNote>[]) {
    if (!raw || typeof raw !== 'object') continue;
    const part: FocusPart = FOCUS_PARTS.includes(raw.part as FocusPart) ? (raw.part as FocusPart) : 'other';
    const images = (Array.isArray(raw.images) ? raw.images : []).filter((im) => im && typeof im.url === 'string' && im.url.startsWith('data:image/')).slice(0, FOCUS_MAX_IMAGES).map((im) => ({ url: im.url, ...(im.name ? { name: String(im.name) } : {}) }));
    const note = typeof raw.note === 'string' ? raw.note.trim() : '';
    const stair = part === 'stair' ? cleanStairLook(raw.stair) : undefined;
    const joinery = part === 'joinery' && JOINERY_VARIANTS.includes(raw.joinery as BuiltinVariant) ? (raw.joinery as BuiltinVariant) : undefined;
    if (!note && !images.length && !stair && !joinery) continue;
    out.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : `fc${out.length + 1}`,
      part,
      ...(part === 'stair' && typeof raw.level === 'number' && raw.level >= 1 ? { level: Math.round(raw.level) } : {}),
      note,
      images,
      ...(stair ? { stair } : {}),
      ...(joinery ? { joinery } : {}),
      at: typeof raw.at === 'string' ? raw.at : '',
    });
  }
  return out;
}

/**
 * 階段の指定をモデルに当てる（model を書き換える）。戻り値: 指定の入った階段の数。
 * いったん全部の階段から外してから入れ直すので、指定を消せば図面の読み取りどおりに戻る。
 * 「すべての階段」の指定の上に、階を決めた指定を重ねる（同じ項目は階を決めたほう・後から足したほうが勝つ）
 */
export function applyFocus(model: BuildingModel | null | undefined, notes: FocusNote[]): number {
  if (!model) return 0;
  let count = 0;
  for (const f of model.floors) {
    const want = stairLookAt(notes, f.level);
    for (const st of f.stairs) {
      const look = st.goesUp ? want : undefined;
      if (look) count++;
      // 同じ中身なら触らない（モデルの写しを比べる「元に戻す」が、当て直すだけで「変わった」と見ないように）
      if (sameLook(st.look, look)) continue;
      if (look) st.look = { ...look };
      else delete st.look;
    }
  }
  return count;
}

/** その階から上がる階段に、いまの指定から入るつくり・手すり・段数（「すべての階段」の上に、階を決めた指定を重ねる） */
export function stairLookAt(notes: FocusNote[], level: number): StairLook | undefined {
  const mine = notes.filter((n) => n.part === 'stair' && cleanStairLook(n.stair));
  let look: StairLook = {};
  for (const n of [...mine.filter((x) => x.level == null), ...mine.filter((x) => x.level != null)]) {
    if (n.level != null && n.level !== level) continue;
    look = { ...look, ...cleanStairLook(n.stair) };
  }
  return cleanStairLook(look);
}

const sameLook = (a: StairLook | undefined, b: StairLook | undefined): boolean =>
  (a?.rail ?? '') === (b?.rail ?? '') && (a?.steps ?? 0) === (b?.steps ?? 0) && (a?.stringer ?? 'side') === (b?.stringer ?? 'side') && (a?.tread ?? 'floor') === (b?.tread ?? 'floor') && (a?.frame ?? 'black') === (b?.frame ?? 'black');

/**
 * モデルの階段に入っているつくり・手すり・段数に、指定のほうを合わせる
 * （3D の「元に戻す／やり直す」でモデルが前の状態に戻ったとき。戻したのに指定が当て直して元に戻らない、を防ぐ）。
 * 変わった階だけ、3D で直すときと同じ指定（stairNoteIndexToEdit）を書き換える。中身が空になった指定は消える。
 * 変わりが無ければ、渡した配列をそのまま返す
 */
export function focusFromModel(model: BuildingModel | null | undefined, notes: FocusNote[], newId: () => string, at: string): FocusNote[] {
  if (!model) return notes;
  const levels = stairLevels(model);
  let list = notes;
  for (const level of levels) {
    const st = model.floors.find((f) => f.level === level)?.stairs.find((s) => s.goesUp);
    const want = cleanStairLook(st?.look);
    if (sameLook(want, stairLookAt(list, level))) continue;
    const i = stairNoteIndexToEdit(list, level, levels);
    if (i < 0 && !want) continue;
    list = list.slice();
    if (i >= 0) {
      const next: FocusNote = { ...list[i] };
      if (want) next.stair = want;
      else delete next.stair;
      list[i] = next;
    } else list.push({ id: newId(), part: 'stair', level, note: '', images: [], stair: want, at });
  }
  return list === notes ? notes : normalizeFocus(list);
}

/** その階段に当たる指定（3D の階段のパネルで「いまの指定」を出す）: 階を決めた指定が先、無ければ「すべての階段」 */
export function stairNoteFor(notes: FocusNote[], level: number): FocusNote | undefined {
  const mine = notes.filter((n) => n.part === 'stair');
  return [...mine].reverse().find((n) => n.level === level) ?? [...mine].reverse().find((n) => n.level == null);
}

/**
 * 3D で階段を選んで直すときに書き換える指定の位置。
 * その階を決めた指定 → 無ければ、上がる階段が 1 か所だけの家（2 階建て）では「すべての階段」の指定
 * （同じ階段の指定が一覧に 2 つ並ばないように）。どちらも無ければ -1（その階の指定を新しく作る）
 * @param levels 上の階へ上がる階段のある階（stairLevels）
 */
export function stairNoteIndexToEdit(notes: FocusNote[], level: number, levels: number[]): number {
  const last = (ok: (n: FocusNote) => boolean) => {
    for (let i = notes.length - 1; i >= 0; i--) if (notes[i].part === 'stair' && ok(notes[i])) return i;
    return -1;
  };
  const own = last((n) => n.level === level);
  if (own >= 0) return own;
  return levels.length <= 1 ? last((n) => n.level == null) : -1;
}

const BUILD_JA: Record<StairBuild, string> = {
  steel: '両側の黒い鋼板のささら桁で木の踏板を挟んだ、蹴込みの無い鉄骨階段',
  woodSkeleton: '両側の側板で踏板を支える、蹴込みの無い木のスケルトン階段',
  box: '蹴込み板のある箱階段（段の下は閉じている）',
  cantilever: '壁から踏板だけが出る片持ち階段（桁・側板が見えない）',
};
const BUILD_EN: Record<StairBuild, string> = {
  steel: 'an open-riser steel staircase with timber treads between two slim black steel plate side stringers',
  woodSkeleton: 'an open-riser timber staircase with treads between two side stringers',
  box: 'a closed-riser boxed staircase (enclosed underneath)',
  cantilever: 'a cantilevered staircase with floating treads projecting from the wall (no visible stringer)',
};
/** 鉄骨階段で、桁を中央の力桁 1 本にしたとき */
const BUILD_CENTER_JA = '黒い鉄骨の中央の力桁 1 本に木の踏板を載せた、蹴込みの無い鉄骨階段';
const BUILD_CENTER_EN = 'an open-riser steel staircase with timber treads on a single black steel center stringer';
const RAIL_JA: Record<StairRail, string> = {
  bar: '手すりは細い鉄のフラットバー（支柱は少なく、上の手すりと横桟 1 本）',
  glass: '手すりは透明なガラスのパネル',
  wall: '手すりは腰壁（壁の仕上げ）',
  wood: '手すりは木の支柱と木の笠木',
  none: '手すりは付けない',
};
const RAIL_EN: Record<StairRail, string> = {
  bar: 'a slim black steel flat-bar balustrade: few thin posts, a flat top rail and a single horizontal mid rail (no vertical pickets)',
  glass: 'a frameless clear glass balustrade',
  wall: 'a solid half-height wall as the balustrade',
  wood: 'a timber balustrade with a timber handrail',
  none: 'no balustrade',
};
const TREAD_JA: Record<StairTread, string> = { floor: '', oak: '踏板はオーク', walnut: '踏板はウォールナット（濃い茶）', white: '踏板は白', black: '踏板は黒', mortar: '踏板はモルタル（左官調のグレー）' };
const TREAD_EN: Record<StairTread, string> = { floor: '', oak: 'oak treads', walnut: 'dark walnut treads', white: 'white treads', black: 'black treads', mortar: 'grey mortar / micro-cement finished treads' };

/** 手すりの言い方（仕上げの説明文の「階段」の項に足す） */
export const stairRailText = (rail: StairRail, lang: 'ja' | 'en' = 'ja'): string => (lang === 'ja' ? RAIL_JA[rail] : RAIL_EN[rail]);

/**
 * 階段の指定を言葉にする（仕上げの説明文・一覧の表示）
 * @param build 階段のつくり（家に 1 つ。コーディネートの「階段」の品目から）。渡すと先頭に入る
 */
export function stairLookText(look: StairLook | undefined, lang: 'ja' | 'en' = 'ja', build?: StairBuild): string {
  const l = cleanStairLook(look);
  const ja = lang === 'ja';
  const parts: string[] = [];
  const center = build === 'steel' && l?.stringer === 'center';
  if (build) parts.push(center ? (ja ? BUILD_CENTER_JA : BUILD_CENTER_EN) : ja ? BUILD_JA[build] : BUILD_EN[build]);
  if (l?.tread) parts.push(ja ? TREAD_JA[l.tread] : TREAD_EN[l.tread]);
  // 鉄の色: 鉄骨階段の桁と、アイアンの手すりに効く
  if (l?.frame === 'white') parts.push(ja ? '鉄骨と手すりは白' : 'steel stringers and balustrade painted white');
  if (l?.rail) parts.push(ja ? RAIL_JA[l.rail] : RAIL_EN[l.rail]);
  if (l?.steps) parts.push(ja ? `${l.steps} 段` : `${l.steps} risers`);
  return parts.join(ja ? '、' : ', ');
}

/**
 * 仕上げの説明文の「階段」の項（品目の言葉）の後ろに足す言葉:
 * 桁（中央の力桁のとき）・踏板の色・鉄の色・手すり（指定が無ければ標準のアイアン）
 */
export function stairTailText(look: StairLook | undefined, lang: 'ja' | 'en' = 'ja', build?: StairBuild): string {
  const l = cleanStairLook(look);
  const ja = lang === 'ja';
  const parts: string[] = [];
  if (build === 'steel' && l?.stringer === 'center') parts.push(ja ? '桁は両側ではなく中央の力桁 1 本' : 'with a single centre stringer instead of the two side stringers');
  if (build === 'steel' && l?.stringer === 'zigzag') parts.push(ja ? '桁は段の形に折れた細い鋼板（稲妻ささら）で、木の蹴込み板が付く' : 'with thin zigzag steel stringers following the steps and timber risers');
  if (l?.tread) parts.push(ja ? TREAD_JA[l.tread] : TREAD_EN[l.tread]);
  if (l?.frame === 'white') parts.push(ja ? '鉄骨と手すりは白' : 'steel stringers and balustrade painted white');
  const rail = l?.rail ?? 'bar';
  parts.push(ja ? RAIL_JA[rail] : RAIL_EN[rail]);
  return parts.join(ja ? '、' : ', ');
}

/** 一覧に出す短い言い方（「鉄骨・ガラス・14 段」） */
export function stairLookShort(look: StairLook | undefined, build?: StairBuild): string {
  const l = cleanStairLook(look);
  const short = (s: string) => s.replace(/（.*）/, '');
  return [
    build ? short(STAIR_BUILD_LABEL[build]) : '',
    build === 'steel' && l?.stringer === 'center' ? '中央の桁' : build === 'steel' && l?.stringer === 'zigzag' ? '稲妻ささら' : '',
    l?.tread ? `踏板 ${short(STAIR_TREAD_LABEL[l.tread])}` : '',
    l?.frame === 'white' ? '鉄は白' : '',
    l?.rail ? short(STAIR_RAIL_LABEL[l.rail]) : '',
    l?.steps ? `${l.steps} 段` : '',
  ]
    .filter(Boolean)
    .join('・');
}

/** カットに何が写るか（cuts.ts の見どころカメラから） */
export interface FocusShot {
  kind: 'exterior' | 'interior' | 'aerial' | 'cutaway' | 'section' | 'sun' | 'other';
  /** 内観: その部屋の種類 */
  roomType?: RoomType;
  /** カットの題（「階段ホール」「LDK」など） */
  title?: string;
  /** 内観: その部屋の階 */
  level?: number;
  /** 内観: その部屋（か隣）に階段がある */
  hasStair?: boolean;
  /** 内観: その階に吹抜がある */
  hasVoid?: boolean;
}

const LDK: RoomType[] = ['ldk', 'living', 'dining', 'kitchen'];
const WET: RoomType[] = ['washroom', 'bath', 'toilet'];

/** その指定が、このカットに写る部位のものか */
export function focusHitsShot(n: FocusNote, shot: FocusShot): boolean {
  const title = shot.title ?? '';
  const interior = shot.kind === 'interior';
  const ext = shot.kind === 'exterior' || shot.kind === 'aerial';
  switch (n.part) {
    case 'exterior':
      return ext;
    case 'stair':
      // 階を決めた指定は、その階とひとつ上の階（降り口）のカットだけ
      if (!interior || !(shot.hasStair || /階段/.test(title) || shot.roomType === 'stairs')) return false;
      return n.level == null || shot.level == null || shot.level === n.level || shot.level === n.level + 1;
    case 'kitchen':
      return interior && (shot.roomType === 'ldk' || shot.roomType === 'kitchen' || shot.roomType === 'dining' || /キッチン|LDK|ＬＤＫ|ダイニング/.test(title));
    case 'living':
      return interior && ((!!shot.roomType && LDK.includes(shot.roomType)) || /リビング|LDK|ＬＤＫ/.test(title));
    case 'entrance':
      return interior && (shot.roomType === 'entrance' || /玄関/.test(title));
    case 'void':
      return interior && (!!shot.hasVoid || /吹抜/.test(title));
    case 'joinery':
    case 'lighting':
      // 造作・照明: どの部屋のものかは決めていないので、内観のカットすべてに（外観・断面には入れない）
      return interior;
    case 'bath':
      return interior && ((!!shot.roomType && WET.includes(shot.roomType)) || /洗面|浴室|脱衣/.test(title));
    default:
      // その他: 断面・輪切りを除く全部のカットに、言葉だけ
      return interior || ext;
  }
}

/** このカットに効く指定（登録の順） */
export function focusForShot(notes: FocusNote[], shot: FocusShot): FocusNote[] {
  return notes.filter((n) => (n.note || n.images.length || cleanStairLook(n.stair) || n.joinery) && focusHitsShot(n, shot));
}

/** 一覧に出す、その指定の中身の短い言い方（階段: つくり・手すりなど／造作: 形） */
export function focusLookShort(n: FocusNote, stairBuild?: StairBuild): string {
  if (n.part === 'stair') return stairLookShort(n.stair, stairBuild);
  if (n.part === 'joinery' && n.joinery) return JOINERY_LABEL[n.joinery];
  return '';
}

/** 同梱する参考画像の名前（カット集の ZIP の中・AI 仕上げの添付の説明）。notes は登録の順 */
export function focusImageName(notes: FocusNote[], n: FocusNote, index: number): string {
  const same = notes.filter((x) => x.part === n.part);
  const k = same.indexOf(n);
  const tag = same.length > 1 ? `${PART_SHORT[n.part]}${k + 1}` : PART_SHORT[n.part];
  return `00_参考_${tag.replace(/[・\s]/g, '')}_${index + 1}.jpg`;
}

/**
 * 仕上げの説明文に足す行。構図・位置・数は下絵のまま、という約束は崩さない: 参考画像からは形・素材・納まりだけを借りる。
 * @param withImages 参考画像を一緒に渡すか（渡さないときは言葉だけ）
 * @param stairBuild 階段のつくり（コーディネートの「階段」の品目から）。階段の行の先頭に入れる
 */
export function focusPromptLines(all: FocusNote[], hits: FocusNote[], lang: 'ja' | 'en', withImages = true, stairBuild?: StairBuild): string[] {
  const out: string[] = [];
  for (const n of hits) {
    const look = n.part === 'stair' ? stairLookText(n.stair, lang, stairBuild) : n.part === 'joinery' && n.joinery ? (lang === 'ja' ? JOINERY_LABEL[n.joinery] : JOINERY_EN[n.joinery]) : '';
    const names = withImages ? n.images.map((_, i) => focusImageName(all, n, i)) : [];
    if (lang === 'ja') {
      const head = `${PART_SHORT[n.part]}のこだわり: `;
      const body = [look, n.note].filter(Boolean).join('。');
      const ref = !names.length
        ? ''
        : n.part === 'lighting'
          ? `同梱の参考画像（${names.join('・')}）の光の雰囲気（明るさの落とし方・間接照明の光り方・光の色）を手本にしてください（照明器具の位置と数・部屋の形は下絵のまま。参考画像の部屋や家具は真似しない）`
          : `同梱の参考画像（${names.join('・')}）の${PART_SHORT[n.part]}の形・素材・納まりを手本にしてください（位置・大きさ・段数・向きは下絵のまま。参考画像の部屋や建物は真似しない）`;
      out.push(head + [body, ref].filter(Boolean).join('。') + '。');
    } else {
      const head = `${PART_EN[n.part]} — design intent: `;
      const body = [look, n.note].filter(Boolean).join('. ');
      const ref = !names.length
        ? ''
        : n.part === 'lighting'
          ? `Use the attached reference image(s) (${names.join(', ')}) as the model for the lighting mood only (how dark the room is kept, how the indirect lighting glows, the colour of the light) — keep the position and number of light fittings and the room exactly as in the base image, and do not copy the room or furniture in the reference`
          : `Use the attached reference image(s) (${names.join(', ')}) as the model for the shape, materials and detailing of this element only — keep its position, size, number of steps and direction exactly as in the base image, and do not copy the room or building in the reference`;
      out.push(head + [body, ref].filter(Boolean).join('. ') + '.');
    }
  }
  return out;
}

/** 一覧の 1 行（「階段（2 階から上）: 鉄骨・ガラス ／ 黒い鉄骨に無垢の踏板」） */
export function focusTitle(n: FocusNote): string {
  const where = n.part === 'stair' ? (n.level != null ? `（${n.level} 階から上がる階段）` : '（すべての階段）') : '';
  return `${FOCUS_PART_LABEL[n.part]}${where}`;
}

/** 3D の階段を選ぶときなどに使う: 上の階へ上がる階段のある階 */
export function stairLevels(model: BuildingModel | null | undefined): number[] {
  if (!model) return [];
  return model.floors.filter((f) => f.stairs.some((s: Stair) => s.goesUp)).map((f) => f.level);
}
