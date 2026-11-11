/**
 * 住まいの成立チェック: 読み取った間取りが「人が住む家」として成り立っているかを、動線・戸・窓・階段の常識で確かめる。
 * 木造の常識チェック（woodCheck）が構造と寸法の違和感を見るのに対して、こちらは「使えるか」を見る:
 *  - 玄関から戸・開口・階段をたどって行けない部屋
 *  - 戸の向き先: 個室・トイレ・浴室・階段の戸が外に直接開く（掃き出し窓・勝手口の読み違い）、浴室が脱衣室以外に開く、
 *    トイレが居室・食事の場に直接開く、個室どうしが戸でつながる
 *  - 階段の昇り口・降り口が外・壁・収納に向いている（矢印の読み違いで向きが逆）
 *  - 部屋と部屋の間の壁にある窓（室内窓か、戸の読み違い）
 *  - 居室の採光（窓の面積が床面積の 1/7 未満）
 * WoodIssue で返し、木造チェックと同じ一覧に出る（id は live- で始まる。読み取りの点数には入れない）。
 * 御社の図面（コーパス）と方眼で直した正解データで誤検出を見ながらルールを増やす（docs/HOUSE_SENSE.md）
 */
import { OUTDOOR_TYPES, type BuildingModel, type Floor, type Opening, type Room, type RoomType, type Vec2, type Wall } from '../core/types';
import { pointInPolygon } from '../core/geometry';
import { roomGraph } from '../core/circulation';
import type { WoodIssue, WoodMark } from './woodCheck';

const len = (w: { a: Vec2; b: Vec2 }) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
const rectOf = (poly: Vec2[]) => ({ minX: Math.min(...poly.map((p) => p.x)), minY: Math.min(...poly.map((p) => p.y)), maxX: Math.max(...poly.map((p) => p.x)), maxY: Math.max(...poly.map((p) => p.y)) });
const roomAt = (f: Floor, p: Vec2): Room | null => f.rooms.find((r) => pointInPolygon(p, r.polygon)) ?? null;
/** 外・吹抜（部屋の間の窓・採光の判定で「外」とみなす） */
const OUTSIDE: readonly RoomType[] = [...OUTDOOR_TYPES, 'void'];
/** 個室（戸で閉じる部屋） */
const PRIVATE: readonly RoomType[] = ['bedroom', 'kids', 'study', 'japanese'];
/** 居室・食事の場（トイレの戸が直接開くのは避ける） */
const LIVING: readonly RoomType[] = ['ldk', 'living', 'dining', 'kitchen', 'bedroom', 'kids', 'japanese', 'study'];
/** 採光（1/7）を見る居室 */
const DAYLIGHT: readonly RoomType[] = ['ldk', 'living', 'dining', 'bedroom', 'kids', 'japanese', 'study'];
/** 玄関から行けなくても問題にしない区画 */
const SKIP_REACH: readonly RoomType[] = ['void', 'other', ...OUTDOOR_TYPES];
const SIDE_LABEL: Record<'n' | 's' | 'e' | 'w', string> = { n: '図面の上', s: '図面の下', e: '図面の右', w: '図面の左' };

/** 建物の外形（外壁芯）の中か。外形が読めていない図面は「中」とみなす（外と断定しない） */
const insideOutline = (f: Floor, p: Vec2): boolean => !f.outline.length || f.outline.some((loop) => pointInPolygon(p, loop));

/**
 * 戸・窓の位置（壁の上の線分）と、壁の法線の両側 250 mm 先にある部屋。
 * 外なら null、建物の中なのに部屋が読めていない所（読み取りの抜け）は undefined（外と断定しない）
 */
export function openingSides(f: Floor, w: Wall, o: Opening): { a: Room | null | undefined; b: Room | null | undefined; line: { a: Vec2; b: Vec2 } } {
  const L = len(w) || 1;
  const ux = (w.b.x - w.a.x) / L;
  const uy = (w.b.y - w.a.y) / L;
  const P = (t: number) => ({ x: w.a.x + ux * t, y: w.a.y + uy * t });
  const c = P((o.t0 + o.t1) / 2);
  const off = w.thickness / 2 + 250;
  const side = (p: Vec2) => roomAt(f, p) ?? (insideOutline(f, p) ? undefined : null);
  return { a: side({ x: c.x - uy * off, y: c.y + ux * off }), b: side({ x: c.x + uy * off, y: c.y - ux * off }), line: { a: P(o.t0), b: P(o.t1) } };
}

/** 線分 ab と cd が交わるか */
function segCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** (1) 玄関から戸・開口・階段をたどって行けない部屋 */
function reachIssues(model: BuildingModel): WoodIssue[] {
  const out: WoodIssue[] = [];
  const floors = model.floors.slice().sort((a, b) => a.level - b.level);
  if (!floors.length) return out;
  const base = floors[0];
  const g = roomGraph(model);
  // 出発点: 玄関の部屋と、玄関ドアの両側の部屋
  const starts = new Set<string>();
  for (const r of base.rooms) if (r.type === 'entrance') starts.add(`${base.level}:${r.id}`);
  const entranceRooms = [...starts];
  /** 外に面した戸・開口（玄関ドア・勝手口・テラス戸）の内側の部屋 */
  const exteriorDoorRooms = (onlyEntrance: boolean): string[] => {
    const keys: string[] = [];
    for (const o of base.openings) {
      if (o.kind === 'window' || (onlyEntrance && o.kind !== 'entrance')) continue;
      const w = base.walls.find((x) => x.id === o.wallId);
      if (!w) continue;
      const s = openingSides(base, w, o);
      if (o.kind !== 'entrance' && (s.a === null) === (s.b === null)) continue;
      for (const r of [s.a, s.b]) if (r && r.type !== 'void') keys.push(`${base.level}:${r.id}`);
    }
    return keys;
  };
  for (const k of exteriorDoorRooms(true)) starts.add(k);
  // 玄関の部屋がどこにもつながっていない（上がり框の線が壁に読まれた・ホールとの戸が読めない）: 1 件だけ言い、
  // 残りの判定は外に面した戸（勝手口・テラス戸）の内側から始める（全部屋を「行けない」と言わないため）
  if (entranceRooms.length && entranceRooms.every((k) => !(g.edges.get(k)?.length))) {
    const rooms = entranceRooms.map((k) => g.nodes.get(k)!.room);
    out.push({ id: `live-reach-entrance`, level: base.level, severity: 'warn', title: `${base.level}階 玄関: ホールへの出入口が読めていません`, detail: '玄関とホールの間が壁で閉じて読まれています（上がり框の線が壁になった、戸・開口が読めなかった）。方眼でその壁を消すか、開口を置いてください', marks: [{ level: base.level, rects: rooms.map((r) => rectOf(r.polygon)), label: '玄関がつながらない' }] });
    for (const k of exteriorDoorRooms(false)) starts.add(k);
  }
  // 玄関が読めていない図面は判定しない（玄関ドアの有無は読み取りの点数が出す）
  if (!starts.size) return out;
  const seen = new Set(starts);
  const queue = [...starts];
  while (queue.length) {
    const k = queue.shift()!;
    for (const e of g.edges.get(k) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  for (const f of floors) {
    const rooms = f.rooms.filter((r) => !SKIP_REACH.includes(r.type) && r.area >= 1.2);
    // 戸も開口も無い部屋は木造チェックの「出入口が読めていません」が出すので、ここでは「どこかにはつながるが玄関から届かない」部屋だけ
    const miss = rooms.filter((r) => !seen.has(`${f.level}:${r.id}`) && (g.edges.get(`${f.level}:${r.id}`)?.length ?? 0) > 0);
    if (!miss.length) continue;
    const marks: WoodMark[] = [{ level: f.level, rects: miss.map((r) => rectOf(r.polygon)), label: '玄関から行けない' }];
    const reachable = rooms.filter((r) => seen.has(`${f.level}:${r.id}`));
    if (f !== base && !reachable.length) {
      out.push({ id: `live-reach-${f.level}`, level: f.level, severity: 'warn', title: `${f.level}階へ階段でつながっていません`, detail: `${f.level}階のどの部屋にも、玄関から戸と階段をたどって行けません。下の階の階段の真上の区画（階段・ホール）が ${f.level}階で読めていないか、階段ホールが壁で閉じて読まれています。方眼の「階段」か「上下階」で確認してください`, marks });
      continue;
    }
    const names = miss
      .slice(0, 4)
      .map((r) => r.name)
      .join('・');
    out.push({ id: `live-reach-${f.level}`, level: f.level, severity: 'warn', title: `${f.level}階 ${names}${miss.length > 4 ? ` ほか ${miss.length - 4} 室` : ''}: 玄関から戸をたどって行けません`, detail: '戸が別の部屋にしか開いていないか、ホール・廊下との壁の戸が読めていません。方眼でその壁に戸を置くと直ります。読み取りが正しくて本当に行けない間取りなら、設計の見直しです', marks });
  }
  return out;
}

/** (2) 戸の向き先 */
function doorIssues(model: BuildingModel): WoodIssue[] {
  const out: WoodIssue[] = [];
  for (const f of model.floors) {
    for (const o of f.openings) {
      if (o.kind !== 'door' && o.kind !== 'sliding') continue;
      const w = f.walls.find((x) => x.id === o.wallId);
      if (!w) continue;
      const { a, b, line } = openingSides(f, w, o);
      const mark = (label: string): WoodMark[] => [{ level: f.level, lines: [line], label }];
      if (!a !== !b) {
        const r = (a ?? b)!;
        if (['bedroom', 'kids', 'study', 'japanese', 'toilet', 'bath', 'closet', 'stairs'].includes(r.type))
          out.push({ id: `live-doorout-${f.level}-${o.id}`, level: f.level, severity: 'info', title: `${f.level}階 ${r.name}: 戸が外に直接開いています`, detail: '個室・トイレ・浴室・階段の戸が外壁にあるのは珍しい形です。掃き出し窓・勝手口・隣の部屋の戸を読み違えている可能性があります。方眼で種類（窓・引戸）か位置を直してください', marks: mark('外に開く戸') });
        continue;
      }
      if (!a || !b || a === b) continue;
      const other = (t: RoomType) => (a.type === t ? b : b.type === t ? a : null);
      const bathOther = other('bath');
      if (bathOther && !['washroom', 'toilet', 'hall', 'bath', 'other'].includes(bathOther.type))
        out.push({ id: `live-bath-${f.level}-${o.id}`, level: f.level, severity: 'info', title: `${f.level}階 浴室: 戸が${bathOther.name}に開いています`, detail: '浴室は洗面脱衣室を介して入るのが普通です。脱衣室の室名が読めていない（洗面と結合している）か、戸の位置が隣の壁にずれている可能性があります', marks: mark('浴室の戸') });
      const wcOther = other('toilet');
      if (wcOther && LIVING.includes(wcOther.type))
        out.push({ id: `live-wc-${f.level}-${o.id}`, level: f.level, severity: 'info', title: `${f.level}階 トイレ: 戸が${wcOther.name}に直接開いています`, detail: 'トイレはホール・廊下・洗面から入るのが普通です。読み取りの戸が隣の壁にずれているか、間取りの意図（寝室の専用トイレなど）か確認してください', marks: mark('トイレの戸') });
      if (PRIVATE.includes(a.type) && PRIVATE.includes(b.type))
        out.push({ id: `live-private-${f.level}-${o.id}`, level: f.level, severity: 'info', title: `${f.level}階 ${a.name}と${b.name}: 個室どうしが戸でつながっています`, detail: '将来間仕切る子供室や、寝室と書斎なら自然です。そうでなければ廊下側の戸が隣の部屋側に読まれた可能性があります', marks: mark('個室どうしの戸') });
    }
  }
  return out;
}

/** (3) 階段の昇り口・降り口の向き先 */
function stairIssues(model: BuildingModel): WoodIssue[] {
  const out: WoodIssue[] = [];
  for (const f of model.floors) {
    for (const st of f.stairs) {
      const cx = (st.minX + st.maxX) / 2;
      const cy = (st.minY + st.maxY) / 2;
      const dir = st.entry === 'n' ? { x: 0, y: -1 } : st.entry === 's' ? { x: 0, y: 1 } : st.entry === 'e' ? { x: 1, y: 0 } : { x: -1, y: 0 };
      const edge = st.entry === 'n' ? { x: cx, y: st.minY } : st.entry === 's' ? { x: cx, y: st.maxY } : st.entry === 'e' ? { x: st.maxX, y: cy } : { x: st.minX, y: cy };
      const p = { x: edge.x + dir.x * 400, y: edge.y + dir.y * 400 };
      const from = { x: edge.x - dir.x * 30, y: edge.y - dir.y * 30 };
      // 昇り口の前に壁があるか（辺の中心から 400 先までを横切る壁。その壁に戸・開口があれば通れる）
      const blocked = f.walls.some((w) => {
        if (!segCross(from, p, w.a, w.b)) return false;
        const L = len(w) || 1;
        const t = ((edge.x - w.a.x) * (w.b.x - w.a.x) + (edge.y - w.a.y) * (w.b.y - w.a.y)) / L;
        return !f.openings.some((o) => o.wallId === w.id && o.kind !== 'window' && t >= o.t0 - 300 && t <= o.t1 + 300);
      });
      const r = roomAt(f, p);
      let what: string | null = null;
      if (blocked) what = '壁';
      else if (!r) what = '外';
      else if (['closet', 'storage', 'toilet', 'bath', 'shed'].includes(r.type)) what = r.name;
      if (!what) continue;
      const mouth = st.goesUp ? '昇り口' : '降り口';
      out.push({
        id: `live-stair-${f.level}-${st.id}`,
        level: f.level,
        severity: 'warn',
        title: `${f.level}階 階段: ${mouth}（${SIDE_LABEL[st.entry]}）が${what}に向いています`,
        detail: '階段は人の通る所（ホール・廊下・LDK）から上がります。図面の矢印（UP・DN）の読み違いで向きが逆になっているか、階段の範囲が隣の区画まで広がっています。方眼の「階段」ツールで昇り口の辺と範囲を直せます',
        marks: [{ level: f.level, rects: [{ minX: st.minX, minY: st.minY, maxX: st.maxX, maxY: st.maxY }], label: `${mouth}が${what}` }],
      });
    }
  }
  return out;
}

/** (4) 部屋と部屋の間の壁にある窓、(5) 居室の採光 */
function windowIssues(model: BuildingModel): WoodIssue[] {
  const out: WoodIssue[] = [];
  for (const f of model.floors) {
    const wins = f.openings
      .filter((o) => o.kind === 'window')
      .map((o) => {
        const w = f.walls.find((x) => x.id === o.wallId);
        return w ? { o, w, ...openingSides(f, w, o) } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    // 図面の窓の記号から室内窓と読めたもの（interior）は意図どおりなので、知らせない
    const inner = wins.filter((x) => !x.o.interior && x.a && x.b && x.a !== x.b && !OUTSIDE.includes(x.a.type) && !OUTSIDE.includes(x.b.type));
    if (inner.length)
      out.push({ id: `live-winin-${f.level}`, level: f.level, severity: 'info', title: `${f.level}階: 部屋と部屋の間の壁に窓が ${inner.length} か所`, detail: '室内窓（LDK と書斎の間など）なら意図どおりです。そうでなければ、戸や壁の線を窓に読み違えています。方眼で種類を直してください', marks: [{ level: f.level, lines: inner.map((x) => x.line), label: '部屋の間の窓' }] });
    for (const r of f.rooms) {
      if (!DAYLIGHT.includes(r.type) || r.area < 4) continue;
      let area = 0;
      let n = 0;
      for (const x of wins) {
        const other = x.a === r ? x.b : x.b === r ? x.a : undefined;
        if (other === undefined) continue;
        // 室内窓は採光に数えない
        if (other && !OUTSIDE.includes(other.type)) continue;
        area += ((x.o.t1 - x.o.t0) * (x.o.height || 1100)) / 1e6;
        n++;
      }
      // 窓が 1 つも無い居室は木造チェックの「窓が読めていません」が出す
      if (!n) continue;
      const need = r.area / 7;
      if (area < need * 0.9)
        out.push({ id: `live-light-${f.level}-${r.id}`, level: f.level, severity: 'info', title: `${f.level}階 ${r.name}: 窓の面積 ${area.toFixed(1)} ㎡ は床面積の 1/7（${need.toFixed(1)} ㎡）に足りません`, detail: '居室の採光は床面積の 1/7 以上の窓が基準です（建築基準法 28 条。隣地境界が近いと有効面積はさらに減ります）。窓が小さく読めているか、高窓・FIX を読み落としているかもしれません。方眼で窓の幅・高さを直せます', marks: [{ level: f.level, rects: [rectOf(r.polygon)], label: `窓 ${area.toFixed(1)} ㎡ / 必要 ${need.toFixed(1)} ㎡` }] });
    }
  }
  return out;
}

export function livingCheck(model: BuildingModel): WoodIssue[] {
  return [...reachIssues(model), ...doorIssues(model), ...stairIssues(model), ...windowIssues(model)];
}
