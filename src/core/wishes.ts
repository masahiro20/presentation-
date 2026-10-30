/**
 * ご要望との照合: お客様の要望（ヒアリングシート・要望書の文章）を読んで、間取りと突き合わせる。
 *
 * 使う人（設計士）: 要望の抜け・漏れを打合せ前に確かめる（「寝室とトイレは近く」「ドアは引き戸」「台所は東側」が叶っているか）。
 * 見る人（お客様）: 「ご要望との照合」のページで、言ったことが図面に入っているかが一目で分かる → 安心して決められる。
 *
 * 文章は定型でなくてよい。行ごとに「部屋の名前」「広さ（6〜8 畳）」「引き戸」「車いす・通路幅」「〇〇と〇〇は近く」
 * 「〇〇は東側」「平屋」「駐車 2 台」「土間」「パントリー」「吹抜」などの言葉を拾う。拾えない行は「打合せで確認」として残す。
 */
import { ROOM_TYPE_LABEL, type BuildingModel, type Floor, type Room, type RoomType, type Vec2 } from './types';

export type WishKind = 'room' | 'size' | 'adjacent' | 'sliding' | 'corridor' | 'orientation' | 'storeys' | 'parking' | 'feature' | 'furniture' | 'note';

export interface Wish {
  id: string;
  /** 元の文（1 行） */
  raw: string;
  kind: WishKind;
  /** 短い見出し（お客様向けの言葉） */
  label: string;
  /** 部屋の種類（room / size / orientation / feature） */
  type?: RoomType | 'doma' | 'pantry' | 'wic' | 'void' | 'laundry' | 'porch';
  /** room: 必要な数 */
  count?: number;
  /** size: 帖の範囲 */
  minTatami?: number;
  maxTatami?: number;
  /** adjacent: 近くにあってほしい 2 つの部屋 */
  pair?: [RoomType, RoomType];
  /** orientation: 方角 */
  dir?: 'N' | 'E' | 'S' | 'W';
  /** storeys: 希望の階数（平屋 = 1）。fallbackOk = 「不可なら 2 階建て」のような許容 */
  storeys?: number;
  fallbackOk?: boolean;
  /** parking: 台数 */
  cars?: number;
  /** furniture: 持ち込む家具の名前と大きさ（mm）。分解できないもの（ソファ・ピアノ・冷蔵庫）は玄関を通るかも見る */
  furniture?: string;
  fw?: number;
  fd?: number;
  rigid?: boolean;
}

export type WishStatus = 'ok' | 'ng' | 'check' | 'na';

export interface WishResult {
  wish: Wish;
  status: WishStatus;
  /** 根拠（部屋名・帖数・距離など）。お客様にも見せる言葉で */
  evidence: string;
  level?: number;
  roomIds?: string[];
}

/** 要望文に出てくる部屋の言葉 → 部屋の種類 */
const ROOM_WORDS: [RegExp, RoomType][] = [
  [/LDK|ＬＤＫ|リビングダイニング/i, 'ldk'],
  [/居間|リビング|茶の間/, 'living'],
  [/食堂|ダイニング/, 'dining'],
  [/台所|キッチン/, 'kitchen'],
  [/和室|畳の部屋|畳コーナー/, 'japanese'],
  [/主寝室|寝室|夫婦の部屋/, 'bedroom'],
  [/個人部屋|個室|子供部屋|子ども部屋|子供室|子ども室|洋室|趣味部屋|自分の部屋/, 'kids'],
  [/書斎|ワークスペース|仕事部屋|スタディ/, 'study'],
  [/浴室|風呂|バス|UB|ＵＢ/, 'bath'],
  [/洗面|脱衣/, 'washroom'],
  [/トイレ|便所|WC|ＷＣ/, 'toilet'],
  [/玄関/, 'entrance'],
  [/廊下|ホール/, 'hall'],
  [/車庫|ガレージ/, 'garage'],
  [/バルコニー|ベランダ/, 'balcony'],
];

const FEATURE_WORDS: [RegExp, NonNullable<Wish['type']>, string][] = [
  [/土間/, 'doma', '土間'],
  [/パントリー|食品庫/, 'pantry', 'パントリー'],
  [/WIC|ＷＩＣ|ウォークイン/i, 'wic', 'ウォークインクローゼット'],
  [/吹抜|吹き抜け/, 'void', '吹抜'],
  [/ランドリー|室内干し|物干し/, 'laundry', 'ランドリー（室内干し）'],
];

const DIR_WORDS: [RegExp, Wish['dir']][] = [
  [/東側|東向き|朝日/, 'E'],
  [/南側|南向き|南面/, 'S'],
  [/西側|西向き|西日/, 'W'],
  [/北側|北向き/, 'N'],
];

const DIR_LABEL: Record<NonNullable<Wish['dir']>, string> = { N: '北', E: '東', S: '南', W: '西' };

const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[〜～]/g, '~');
const jpNum: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 二つ: 2, 三つ: 3 };
const numAt = (s: string): number | null => {
  const m = /(\d+(?:\.\d+)?)/.exec(s);
  if (m) return parseFloat(m[1]);
  const j = /([一二三四五六七八九十])/.exec(s);
  return j ? jpNum[j[1]] : null;
};

let seq = 0;
const mk = (raw: string, kind: WishKind, label: string, extra: Partial<Wish> = {}): Wish => ({ id: `w${++seq}`, raw, kind, label, ...extra });

/** 要望の文章 → 照合できる要望の一覧。1 行から複数の要望が取れることもある */
/** 持ち込み家具: 名前 → 置く部屋の候補・標準の大きさ（mm）・分解できないか */
const FURNITURE_WORDS: [RegExp, string, RoomType[], number, number, boolean][] = [
  [/グランドピアノ/, 'グランドピアノ', ['ldk', 'living', 'japanese'], 1500, 1800, true],
  [/(アップライト)?ピアノ|電子ピアノ/, 'アップライトピアノ', ['ldk', 'living', 'japanese', 'bedroom', 'kids'], 1500, 650, true],
  [/ソファー?/, 'ソファ', ['ldk', 'living'], 1800, 900, true],
  [/ダイニングテーブル|食卓/, 'ダイニングテーブル', ['ldk', 'dining'], 1600, 850, false],
  [/クイーン(ベッド)?/, 'クイーンベッド', ['bedroom'], 1600, 1950, false],
  [/ダブル(ベッド)?/, 'ダブルベッド', ['bedroom'], 1400, 1950, false],
  [/セミダブル/, 'セミダブルベッド', ['bedroom', 'kids'], 1200, 1950, false],
  [/シングル(ベッド)?|ベッド/, 'シングルベッド', ['bedroom', 'kids'], 970, 1950, false],
  [/冷蔵庫/, '冷蔵庫', ['kitchen', 'ldk'], 700, 700, true],
  [/食器棚|カップボード/, '食器棚', ['kitchen', 'ldk'], 1200, 450, false],
  [/本棚|書棚/, '本棚', ['study', 'bedroom', 'kids', 'ldk', 'living'], 900, 300, false],
  [/学習机|机|デスク/, '机', ['study', 'bedroom', 'kids'], 1200, 600, false],
  [/タンス|箪笥|ドレッサー|チェスト/, 'タンス', ['bedroom', 'japanese', 'closet'], 1000, 450, true],
  [/テレビ(ボード)?|TV/i, 'テレビボード', ['ldk', 'living'], 1800, 450, false],
  [/仏壇/, '仏壇', ['japanese', 'ldk', 'living'], 600, 500, true],
];
const FURNITURE_ROOMS: Record<string, RoomType[]> = Object.fromEntries(FURNITURE_WORDS.map(([, name, rooms]) => [name, rooms]));

export function parseWishes(text: string): Wish[] {
  seq = 0;
  const out: Wish[] = [];
  // 行ごと。長い行は「。」でも区切る
  const lines = toHalf(text)
    .split(/\r?\n|。/)
    .map((l) => l.replace(/^[\s・●○■□◆◇\-－*＊①-⑩]+/, '').trim())
    .filter((l) => l.length >= 2 && !/^【.*】$/.test(l)); // 【…】は取り込み元の見出し（要望ではない）
  // 「居間 6〜8 畳」のような見出し行（部屋名だけ、または部屋名＋帖数）
  let section: RoomType | null = null;
  for (const line of lines) {
    const roomsInLine = ROOM_WORDS.filter(([re]) => re.test(line)).map(([, t]) => t);
    const tatami = /(\d+(?:\.\d+)?)\s*(?:~\s*(\d+(?:\.\d+)?))?\s*(?:畳|帖|j|J)/.exec(line);
    const headerLike = line.length <= 14 && roomsInLine.length >= 1 && !/、|と|は|を|が/.test(line.replace(/\s/g, ''));
    if (headerLike) section = roomsInLine[0];

    // 広さ
    if (tatami && roomsInLine.length) {
      const t = roomsInLine[0];
      const min = parseFloat(tatami[1]);
      const max = tatami[2] ? parseFloat(tatami[2]) : min;
      out.push(mk(line, 'size', `${ROOM_TYPE_LABEL[t]}は ${min}${max !== min ? `〜${max}` : ''} 帖ほど`, { type: t, minTatami: min, maxTatami: max }));
      if (headerLike) continue;
    } else if (tatami && section && headerLike === false && /広さ|帖|畳/.test(line) && !roomsInLine.length) {
      const min = parseFloat(tatami[1]);
      const max = tatami[2] ? parseFloat(tatami[2]) : min;
      out.push(mk(line, 'size', `${ROOM_TYPE_LABEL[section]}は ${min}${max !== min ? `〜${max}` : ''} 帖ほど`, { type: section, minTatami: min, maxTatami: max }));
      continue;
    }

    // 1 行に複数の要望が入っていてよい（「通路幅を確保、また、ドアは引き戸」）: 当てはまるものを全部拾う
    let matched = false;
    // 階数
    if (/平屋/.test(line)) {
      const fallback = /不可なら|だめなら|無理なら|難しければ|満たせなければ/.test(line) && /2\s*階/.test(line);
      out.push(mk(line, 'storeys', fallback ? '平屋が希望（入りきらなければ 2 階建て）' : '平屋', { storeys: 1, fallbackOk: fallback }));
      matched = true;
    } else if (/(\d)\s*階建/.test(line)) {
      const n = parseInt(/(\d)\s*階建/.exec(line)![1], 10);
      out.push(mk(line, 'storeys', `${n} 階建て`, { storeys: n }));
      matched = true;
    }
    // 近さ（「寝室とトイレは近く」）／離す
    if (/近く|近い|隣|すぐ|直結|つなげ|行き来/.test(line) && roomsInLine.length >= 2) {
      const [a, b] = roomsInLine;
      out.push(mk(line, 'adjacent', `${ROOM_TYPE_LABEL[a]}と${ROOM_TYPE_LABEL[b]}は近くに`, { pair: [a, b] }));
      matched = true;
    } else if (/離し|離れ|遠く/.test(line) && roomsInLine.length >= 2) {
      out.push(mk(line, 'note', `${ROOM_TYPE_LABEL[roomsInLine[0]]}と${ROOM_TYPE_LABEL[roomsInLine[1]]}は離す`));
      matched = true;
    }
    // 引き戸
    if (/引き戸|引戸|引き違い/.test(line) && /ドア|戸|扉|建具/.test(line)) {
      out.push(mk(line, 'sliding', 'ドアはできるだけ引き戸'));
      matched = true;
    }
    // 通路幅・車いす・バリアフリー
    if (/車いす|車椅子|通路幅|バリアフリー|段差/.test(line)) {
      out.push(mk(line, 'corridor', '車いすで通れる通路幅（内法 80cm 以上）'));
      matched = true;
    }
    // 駐車台数
    const park = /(?:駐車|車)\s*(\d+|[一二三四五])\s*台/.exec(line);
    if (park) {
      out.push(mk(line, 'parking', `駐車 ${numAt(park[1])} 台`, { cars: numAt(park[1]) ?? 1 }));
      matched = true;
    }
    // 方角
    const dirHit = DIR_WORDS.find(([re]) => re.test(line));
    if (dirHit && (roomsInLine.length || section)) {
      const t = roomsInLine[0] ?? section!;
      out.push(mk(line, 'orientation', `${ROOM_TYPE_LABEL[t]}は${DIR_LABEL[dirHit[1]!]}側に`, { type: t, dir: dirHit[1] }));
      matched = true;
    }
    // 持ち込む家具（「今のソファ 220×95 を持ち込む」「ダブルベッド」）: 寸法は cm（400 以下）か mm。
    // 1 行に複数あれば、寸法はその直前の家具のもの。重なる語（ダブルベッドの「ベッド」）は先に見つかった長い語を優先
    if (!/置き場|買い替え|買い換え|処分|新しく/.test(line)) {
      const hits: { start: number; end: number; entry: (typeof FURNITURE_WORDS)[number] }[] = [];
      for (const entry of FURNITURE_WORDS) {
        const m = new RegExp(entry[0].source, entry[0].flags).exec(line);
        if (m) hits.push({ start: m.index, end: m.index + m[0].length, entry });
      }
      hits.sort((a, b) => a.start - b.start || b.end - a.end);
      const taken: typeof hits = [];
      for (const h of hits) if (!taken.some((t) => h.start < t.end && t.start < h.end)) taken.push(h);
      const dim = /(\d{2,4}(?:\.\d)?)\s*[×xXｘ*]\s*(\d{2,4}(?:\.\d)?)/.exec(line);
      const toMm = (v: number) => (v <= 400 ? Math.round(v * 10) : Math.round(v));
      const owner = dim ? [...taken].reverse().find((t) => t.start < dim.index) ?? taken[0] : null;
      for (const t of taken) {
        const [, name, , sw, sd, rigid] = t.entry;
        const fw = dim && t === owner ? toMm(parseFloat(dim[1])) : sw;
        const fd = dim && t === owner ? toMm(parseFloat(dim[2])) : sd;
        out.push(mk(line, 'furniture', `${name}（${Math.round(fw / 10)}×${Math.round(fd / 10)} cm）を持ち込む`, { furniture: name, fw, fd, rigid }));
      }
      if (taken.length) matched = true;
    }
    // 設備・空間の要望（土間・パントリー・WIC・吹抜・ランドリー）
    const feats = FEATURE_WORDS.filter(([re]) => re.test(line));
    for (const [, type, label] of feats) out.push(mk(line, 'feature', `${label}がほしい`, { type }));
    if (feats.length) matched = true;
    // 部屋の数（「部屋数は、居間、食堂、和室、寝室、個人部屋 2 つ」）
    if (/部屋数|部屋は|必要な部屋|ほしい部屋|欲しい部屋/.test(line) && roomsInLine.length) {
      for (const t of roomsInLine) {
        const seg = new RegExp(`(${ROOM_WORDS.find(([, tt]) => tt === t)![0].source})\\s*(\\d+|[一二三]|二つ|三つ)?`).exec(line);
        const cnt = seg?.[2] ? (jpNum[seg[2]] ?? parseInt(seg[2], 10)) : 1;
        out.push(mk(line, 'room', `${ROOM_TYPE_LABEL[t]}${cnt > 1 ? ` ${cnt} 室` : ''}`, { type: t, count: cnt }));
      }
      matched = true;
    } else if (headerLike && !matched) {
      // 見出しだけの行（「玄関」「廊下」）: その部屋があるかを見る
      out.push(mk(line, 'room', ROOM_TYPE_LABEL[section!], { type: section!, count: 1 }));
      matched = true;
    }
    if (matched) continue;
    // それ以外は打合せで確認する要望として残す（収納の中身・造作・家電の置き場など）
    out.push(mk(line, 'note', line.length > 40 ? line.slice(0, 40) + '…' : line));
  }
  // 同じ要望（同じ種類・同じ部屋）は 1 つに
  const seen = new Set<string>();
  return out.filter((w) => {
    const key = w.kind === 'note' ? `note:${w.raw}` : `${w.kind}:${w.type ?? ''}:${w.furniture ?? ''}:${w.fw ?? ''}:${w.pair?.join('-') ?? ''}:${w.dir ?? ''}:${w.minTatami ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- 照合 ----

const centroid = (poly: Vec2[]): Vec2 => {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / Math.max(1, poly.length), y: y / Math.max(1, poly.length) };
};
const tatamiOf = (r: Room) => r.labeledTatami ?? r.area / 1.62;
const roomsOfType = (model: BuildingModel, t: RoomType): { room: Room; floor: Floor }[] => {
  const out: { room: Room; floor: Floor }[] = [];
  for (const f of model.floors) for (const r of f.rooms) if (r.type === t || (t === 'living' && r.type === 'ldk') || (t === 'dining' && r.type === 'ldk') || (t === 'kitchen' && r.type === 'ldk')) out.push({ room: r, floor: f });
  return out;
};
const nameOf = (r: Room, f: Floor) => `${f.level}階 ${r.name || ROOM_TYPE_LABEL[r.type]}（${tatamiOf(r).toFixed(1)} 帖）`;

/** 図面の上方向から時計回りに north 度が真北 → 部屋の重心が建物の中心からどの方角にあるか */
function compassOf(model: BuildingModel, f: Floor, r: Room): { dir: 'N' | 'E' | 'S' | 'W'; strength: number } {
  const pts = f.outline.flat();
  const c = centroid(pts.length ? pts : f.rooms.flatMap((q) => q.polygon));
  const p = centroid(r.polygon);
  // 図面座標: x 右, y 下。真北は「上から時計回りに north 度」
  const a = (model.northAngleDeg * Math.PI) / 180;
  const north = { x: Math.sin(a), y: -Math.cos(a) };
  const east = { x: north.y * -1, y: north.x }; // 北を 90° 時計回りに
  const v = { x: p.x - c.x, y: p.y - c.y };
  const L = Math.hypot(v.x, v.y) || 1;
  const n = (v.x * north.x + v.y * north.y) / L;
  const e = (v.x * east.x + v.y * east.y) / L;
  const dir = Math.abs(n) >= Math.abs(e) ? (n >= 0 ? 'N' : 'S') : e >= 0 ? 'E' : 'W';
  return { dir, strength: Math.max(Math.abs(n), Math.abs(e)) };
}

export interface WishCheckAids {
  /** 木造チェックの「通れない幅」の指摘（id が narrow- で始まるもの）の題名 */
  narrowIssues?: string[];
}

export function checkWishes(model: BuildingModel, wishes: Wish[], aids: WishCheckAids = {}): WishResult[] {
  const results: WishResult[] = [];
  const floors = model.floors;
  for (const w of wishes) {
    switch (w.kind) {
      case 'room': {
        const t = w.type as RoomType;
        let found = roomsOfType(model, t);
        // 個室は、主寝室（いちばん広い寝室）を除いた寝室・洋室を数える
        if (t === 'kids') {
          const beds = roomsOfType(model, 'bedroom').sort((a, b) => b.room.area - a.room.area);
          found = [...found, ...beds.slice(1)];
        }
        const n = w.count ?? 1;
        results.push({
          wish: w,
          status: found.length >= n ? 'ok' : found.length ? 'check' : 'ng',
          evidence: found.length ? found.map(({ room, floor }) => nameOf(room, floor)).join('、') : `図面に${ROOM_TYPE_LABEL[t]}が見当たりません`,
          roomIds: found.map((x) => x.room.id),
        });
        break;
      }
      case 'size': {
        const t = w.type as RoomType;
        const found = roomsOfType(model, t).sort((a, b) => b.room.area - a.room.area);
        if (!found.length) {
          results.push({ wish: w, status: 'ng', evidence: `図面に${ROOM_TYPE_LABEL[t]}が見当たりません` });
          break;
        }
        const { room, floor } = found[0];
        const tt = tatamiOf(room);
        const lo = (w.minTatami ?? 0) - 0.5;
        const hi = (w.maxTatami ?? 999) + 1.0;
        const status: WishStatus = tt >= lo && tt <= hi ? 'ok' : tt > hi ? 'check' : 'ng';
        results.push({ wish: w, status, evidence: `${nameOf(room, floor)}${status === 'check' ? '　※ご希望より広め' : status === 'ng' ? '　※ご希望より狭め' : ''}`, level: floor.level, roomIds: [room.id] });
        break;
      }
      case 'adjacent': {
        const [a, b] = w.pair!;
        const A = roomsOfType(model, a);
        const B = roomsOfType(model, b);
        if (!A.length || !B.length) {
          results.push({ wish: w, status: 'ng', evidence: `${!A.length ? ROOM_TYPE_LABEL[a] : ROOM_TYPE_LABEL[b]}が図面に見当たりません` });
          break;
        }
        let best: { d: number; ra: Room; rb: Room; f: Floor } | null = null;
        for (const x of A)
          for (const y of B) {
            if (x.floor !== y.floor) continue;
            const pa = centroid(x.room.polygon);
            const pb = centroid(y.room.polygon);
            const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
            if (!best || d < best.d) best = { d, ra: x.room, rb: y.room, f: x.floor };
          }
        if (!best) {
          results.push({ wish: w, status: 'ng', evidence: `${ROOM_TYPE_LABEL[a]}と${ROOM_TYPE_LABEL[b]}が別の階にあります` });
          break;
        }
        const m = best.d / 1000;
        results.push({ wish: w, status: m <= 6 ? 'ok' : m <= 10 ? 'check' : 'ng', evidence: `${best.f.level}階 ${best.ra.name}〜${best.rb.name} 部屋の中心どうしで約 ${m.toFixed(1)} m`, level: best.f.level, roomIds: [best.ra.id, best.rb.id] });
        break;
      }
      case 'sliding': {
        let sliding = 0;
        let hinged = 0;
        const hingedRooms: string[] = [];
        for (const f of floors) {
          for (const o of f.openings) {
            if (o.kind === 'sliding') sliding++;
            else if (o.kind === 'door') {
              hinged++;
              // どの部屋の戸か（戸の位置に近い部屋名）
              const wall = f.walls.find((q) => q.id === o.wallId);
              if (wall) {
                const L = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) || 1;
                const t = (o.t0 + o.t1) / 2 / L;
                const p = { x: wall.a.x + (wall.b.x - wall.a.x) * t, y: wall.a.y + (wall.b.y - wall.a.y) * t };
                const near = f.rooms.filter((r) => r.type !== 'hall' && r.type !== 'ldk').map((r) => ({ r, d: Math.hypot(centroid(r.polygon).x - p.x, centroid(r.polygon).y - p.y) })).sort((u, v) => u.d - v.d)[0];
                if (near && !hingedRooms.includes(near.r.name)) hingedRooms.push(near.r.name);
              }
            }
          }
        }
        const total = sliding + hinged;
        const ratio = total ? sliding / total : 0;
        results.push({
          wish: w,
          status: !total ? 'check' : ratio >= 0.8 ? 'ok' : ratio >= 0.5 ? 'check' : 'ng',
          evidence: total ? `引き戸 ${sliding} か所・開き戸 ${hinged} か所${hinged ? `（開き戸: ${hingedRooms.slice(0, 6).join('・')}${hingedRooms.length > 6 ? ' ほか' : ''}）` : ''}` : '室内の戸を読み取れませんでした',
        });
        break;
      }
      case 'corridor': {
        const narrow = aids.narrowIssues ?? [];
        results.push({ wish: w, status: narrow.length ? 'check' : 'ok', evidence: narrow.length ? `狭い所があります: ${narrow.slice(0, 3).join('／')}` : '廊下・ホールに 910 モジュール（内法 78cm）未満の所はありません。車いすは内法 80cm 以上が目安です' });
        break;
      }
      case 'orientation': {
        const t = w.type as RoomType;
        const found = roomsOfType(model, t).sort((a, b) => b.room.area - a.room.area);
        if (!found.length) {
          results.push({ wish: w, status: 'ng', evidence: `図面に${ROOM_TYPE_LABEL[t]}が見当たりません` });
          break;
        }
        const { room, floor } = found[0];
        const c = compassOf(model, floor, room);
        const ok = c.dir === w.dir;
        results.push({ wish: w, status: ok ? 'ok' : c.strength < 0.35 ? 'check' : 'ng', evidence: `${nameOf(room, floor)} は建物の${DIR_LABEL[c.dir]}寄り${model.report?.northDetected === false ? '（方位は図面の上を北として）' : ''}`, level: floor.level, roomIds: [room.id] });
        break;
      }
      case 'storeys': {
        const n = floors.length;
        const want = w.storeys ?? 1;
        results.push({ wish: w, status: n === want ? 'ok' : w.fallbackOk && n === want + 1 ? 'check' : 'ng', evidence: n === 1 ? '平屋のプランです' : `${n} 階建てのプランです` });
        break;
      }
      case 'parking': {
        let cars = 0;
        const parts: string[] = [];
        for (const f of floors) {
          cars += f.exterior?.cars.length ?? 0;
          for (const r of f.rooms) if (r.type === 'garage' || r.type === 'carport' || r.type === 'parking') {
            const n = Math.max(1, Math.floor(r.area / 14));
            cars += n;
            parts.push(`${r.name} ${r.area.toFixed(0)} ㎡（${n} 台分）`);
          }
        }
        results.push({ wish: w, status: cars >= (w.cars ?? 1) ? 'ok' : cars ? 'check' : 'ng', evidence: cars ? `${cars} 台分: ${parts.join('、') || '図面の車の記号'}` : '駐車スペース・車庫が図面に見当たりません' });
        break;
      }
      case 'furniture': {
        // 置ける部屋: 外接する長方形に、家具＋通路（長い側に 60cm・短い側に 90cm）が入るか
        const fw = w.fw ?? 0;
        const fd = w.fd ?? 0;
        const lo = Math.min(fw, fd);
        const hi = Math.max(fw, fd);
        const cands = (FURNITURE_ROOMS[w.furniture ?? ''] ?? ['ldk']).flatMap((t) => roomsOfType(model, t));
        const uniq = cands.filter((x, i) => cands.findIndex((y) => y.room.id === x.room.id) === i);
        const fits = uniq
          .map(({ room, floor }) => {
            const xs = room.polygon.map((p) => p.x);
            const ys = room.polygon.map((p) => p.y);
            const bw = Math.max(...xs) - Math.min(...xs);
            const bd = Math.max(...ys) - Math.min(...ys);
            const a = Math.min(bw, bd);
            const b = Math.max(bw, bd);
            return { room, floor, ok: a >= lo + 900 && b >= hi + 600 };
          })
          .filter((x) => x.ok);
        if (!fits.length) {
          results.push({ wish: w, status: uniq.length ? 'ng' : 'check', evidence: uniq.length ? `${uniq.slice(0, 2).map((x) => nameOf(x.room, x.floor)).join('、')} には通路を残して置けません（${Math.round(lo / 10)} cm の側に 90 cm の通路が要ります）` : '置く部屋が図面に見当たりません' });
          break;
        }
        // 分解できない家具は玄関の戸を通るか（戸の幅 ≥ 短い側＋ 5cm）
        let doorNote = '';
        let status: WishStatus = 'ok';
        if (w.rigid) {
          const f1 = floors.find((f) => f.level === 1) ?? floors[0];
          const ent = f1?.rooms.find((r) => r.type === 'entrance');
          if (f1 && ent) {
            const c = centroid(ent.polygon);
            let best: { d: number; w: number } | null = null;
            for (const o of f1.openings) {
              if (o.kind !== 'door' && o.kind !== 'sliding') continue;
              const wall = f1.walls.find((q) => q.id === o.wallId);
              if (!wall || !wall.exterior) continue;
              const L = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) || 1;
              const t = (o.t0 + o.t1) / 2 / L;
              const p = { x: wall.a.x + (wall.b.x - wall.a.x) * t, y: wall.a.y + (wall.b.y - wall.a.y) * t };
              const d = Math.hypot(p.x - c.x, p.y - c.y);
              if (!best || d < best.d) best = { d, w: o.t1 - o.t0 };
            }
            if (best) {
              const pass = best.w >= lo + 50;
              doorNote = `。玄関の戸 幅 ${Math.round(best.w / 10)} cm${pass ? 'を通ります' : 'は短い側より狭く、斜めに入れるか窓からの搬入を確認'}`;
              if (!pass) status = 'check';
            }
          }
        }
        results.push({ wish: w, status, evidence: `${fits.slice(0, 2).map((x) => nameOf(x.room, x.floor)).join('、')} に置けます${doorNote}`, level: fits[0].floor.level, roomIds: fits.map((x) => x.room.id) });
        break;
      }
      case 'feature': {
        const re = w.type === 'doma' ? /土間/ : w.type === 'pantry' ? /パントリー|食品庫|pantry/i : w.type === 'wic' ? /WIC|ＷＩＣ|ウォークイン|クローク/i : w.type === 'void' ? /吹抜|吹き抜け/ : /ランドリー|物干|サンルーム/;
        const hit: string[] = [];
        for (const f of floors) for (const r of f.rooms) if (re.test(r.name) || (w.type === 'void' && r.type === 'void')) hit.push(nameOf(r, f));
        results.push({ wish: w, status: hit.length ? 'ok' : 'check', evidence: hit.length ? hit.join('、') : '図面の室名には見当たりません（造作・家具で設けるものは打合せで）' });
        break;
      }
      default:
        results.push({ wish: w, status: 'na', evidence: '打合せで確認（図面では判定できない要望）' });
    }
  }
  return results;
}

export const WISH_STATUS_LABEL: Record<WishStatus, string> = { ok: '叶っています', ng: '入っていません', check: '要確認', na: '打合せで' };
