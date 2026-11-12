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
import type { BuildingModel, RoomType, Stair, StairBuild, StairLook, StairRail } from './types';

export type FocusPart = 'stair' | 'kitchen' | 'living' | 'entrance' | 'void' | 'bath' | 'exterior' | 'other';

export const FOCUS_PART_LABEL: Record<FocusPart, string> = {
  stair: '階段',
  kitchen: 'キッチン',
  living: 'リビング・内装',
  entrance: '玄関',
  void: '吹抜',
  bath: '洗面・浴室',
  exterior: '外観',
  other: 'その他',
};
export const FOCUS_PARTS = Object.keys(FOCUS_PART_LABEL) as FocusPart[];
const PART_EN: Record<FocusPart, string> = { stair: 'Staircase', kitchen: 'Kitchen', living: 'Living room / interior', entrance: 'Entrance', void: 'Double-height void', bath: 'Washroom / bathroom', exterior: 'Exterior', other: 'Note' };

export const STAIR_BUILD_LABEL: Record<StairBuild, string> = {
  steel: '鉄骨（中央の桁＋踏板）',
  woodSkeleton: '木のスケルトン（両側の側板）',
  box: '箱階段（蹴込みあり）',
  cantilever: '片持ち（踏板だけ）',
};
export const STAIR_RAIL_LABEL: Record<StairRail, string> = {
  bar: 'アイアン（細い支柱＋丸パイプ）',
  glass: 'ガラス',
  wall: '腰壁',
  wood: '木の手すり',
  none: '手すりなし',
};
export const STAIR_BUILDS = Object.keys(STAIR_BUILD_LABEL) as StairBuild[];
export const STAIR_RAILS = Object.keys(STAIR_RAIL_LABEL) as StairRail[];

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
  /** 階段のつくり・手すり・段数（3D と図面に反映） */
  stair?: StairLook;
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
  return out.rail || out.steps ? out : undefined;
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
    if (!note && !images.length && !stair) continue;
    out.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : `fc${out.length + 1}`,
      part,
      ...(part === 'stair' && typeof raw.level === 'number' && raw.level >= 1 ? { level: Math.round(raw.level) } : {}),
      note,
      images,
      ...(stair ? { stair } : {}),
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

const sameLook = (a: StairLook | undefined, b: StairLook | undefined): boolean => (a?.rail ?? '') === (b?.rail ?? '') && (a?.steps ?? 0) === (b?.steps ?? 0);

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
  steel: '黒い鉄骨の中央の桁に踏板を載せた、蹴込みの無いストリップ階段',
  woodSkeleton: '両側の側板で踏板を支える、蹴込みの無い木のスケルトン階段',
  box: '蹴込み板のある箱階段（段の下は閉じている）',
  cantilever: '壁から踏板だけが出る片持ち階段（桁・側板が見えない）',
};
const BUILD_EN: Record<StairBuild, string> = {
  steel: 'an open-riser staircase with treads on a single black steel center stringer',
  woodSkeleton: 'an open-riser timber staircase with treads between two side stringers',
  box: 'a closed-riser boxed staircase (enclosed underneath)',
  cantilever: 'a cantilevered staircase with floating treads projecting from the wall (no visible stringer)',
};
const RAIL_JA: Record<StairRail, string> = {
  bar: '手すりは細い鉄のフラットバーの支柱に丸パイプ',
  glass: '手すりは透明なガラスのパネル',
  wall: '手すりは腰壁（壁の仕上げ）',
  wood: '手すりは木の支柱と木の笠木',
  none: '手すりは付けない',
};
const RAIL_EN: Record<StairRail, string> = {
  bar: 'a slim steel flat-bar balustrade with a round handrail',
  glass: 'a frameless clear glass balustrade',
  wall: 'a solid half-height wall as the balustrade',
  wood: 'a timber balustrade with a timber handrail',
  none: 'no balustrade',
};

/** 手すりの言い方（仕上げの説明文の「階段」の項に足す） */
export const stairRailText = (rail: StairRail, lang: 'ja' | 'en' = 'ja'): string => (lang === 'ja' ? RAIL_JA[rail] : RAIL_EN[rail]);

/**
 * 階段の指定を言葉にする（仕上げの説明文・一覧の表示）
 * @param build 階段のつくり（家に 1 つ。コーディネートの「階段」の品目から）。渡すと先頭に入る
 */
export function stairLookText(look: StairLook | undefined, lang: 'ja' | 'en' = 'ja', build?: StairBuild): string {
  const l = cleanStairLook(look);
  const parts: string[] = [];
  if (build) parts.push(lang === 'ja' ? BUILD_JA[build] : BUILD_EN[build]);
  if (l?.rail) parts.push(lang === 'ja' ? RAIL_JA[l.rail] : RAIL_EN[l.rail]);
  if (l?.steps) parts.push(lang === 'ja' ? `${l.steps} 段` : `${l.steps} risers`);
  return parts.join(lang === 'ja' ? '、' : ', ');
}

/** 一覧に出す短い言い方（「鉄骨・ガラス・14 段」） */
export function stairLookShort(look: StairLook | undefined, build?: StairBuild): string {
  const l = cleanStairLook(look);
  const short = (s: string) => s.replace(/（.*）/, '');
  return [build ? short(STAIR_BUILD_LABEL[build]) : '', l?.rail ? short(STAIR_RAIL_LABEL[l.rail]) : '', l?.steps ? `${l.steps} 段` : ''].filter(Boolean).join('・');
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
    case 'bath':
      return interior && ((!!shot.roomType && WET.includes(shot.roomType)) || /洗面|浴室|脱衣/.test(title));
    default:
      // その他: 断面・輪切りを除く全部のカットに、言葉だけ
      return interior || ext;
  }
}

/** このカットに効く指定（登録の順） */
export function focusForShot(notes: FocusNote[], shot: FocusShot): FocusNote[] {
  return notes.filter((n) => (n.note || n.images.length || cleanStairLook(n.stair)) && focusHitsShot(n, shot));
}

/** 同梱する参考画像の名前（カット集の ZIP の中・AI 仕上げの添付の説明）。notes は登録の順 */
export function focusImageName(notes: FocusNote[], n: FocusNote, index: number): string {
  const same = notes.filter((x) => x.part === n.part);
  const k = same.indexOf(n);
  const tag = same.length > 1 ? `${FOCUS_PART_LABEL[n.part]}${k + 1}` : FOCUS_PART_LABEL[n.part];
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
    const look = n.part === 'stair' ? stairLookText(n.stair, lang, stairBuild) : '';
    const names = withImages ? n.images.map((_, i) => focusImageName(all, n, i)) : [];
    if (lang === 'ja') {
      const head = `${FOCUS_PART_LABEL[n.part]}のこだわり: `;
      const body = [look, n.note].filter(Boolean).join('。');
      const ref = names.length ? `同梱の参考画像（${names.join('・')}）の${FOCUS_PART_LABEL[n.part]}の形・素材・納まりを手本にしてください（位置・大きさ・段数・向きは下絵のまま。参考画像の部屋や建物は真似しない）` : '';
      out.push(head + [body, ref].filter(Boolean).join('。') + '。');
    } else {
      const head = `${PART_EN[n.part]} — design intent: `;
      const body = [look, n.note].filter(Boolean).join('. ');
      const ref = names.length ? `Use the attached reference image(s) (${names.join(', ')}) as the model for the shape, materials and detailing of this element only — keep its position, size, number of steps and direction exactly as in the base image, and do not copy the room or building in the reference` : '';
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
