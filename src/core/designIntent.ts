/**
 * 間取りの読み解き（設計意図・動線の意味）
 *
 * 図面を 3D にするだけでなく、「なぜここにパントリーがあるのか」「水まわりがここに集まっている理由」「帰ってきてからの動き」を
 * 部屋のつながり（戸・開口・隣接）から読み取って、設計士の言葉とお客様の言葉の両方で出す。
 *
 * 使う人（設計士）: 打合せで「この間取りの考え方」を説明する根拠。読み取りが違っていれば（パントリーが玄関から遠い等）気づける。
 * 見る人（お客様）: 「買ってきたものをすぐしまえる」「洗う・干す・しまうが一直線」のように暮らしの言葉で分かる。
 *
 * 知識の出どころ: docs/WOOD_HOUSE_RULES.md §8（暮らしの動線の常識）。新しい読み解きはそこに足してからここに入れる
 */
import { roomGraph } from './circulation';
import { pointInPolygon } from './geometry';
import type { BuildingModel, Room, RoomType, Vec2 } from './types';

export interface DesignIntent {
  id: string;
  /** 見出し（設計の言葉） */
  title: string;
  /** お客様向けのひとこと */
  customer: string;
  /** 設計士向けの根拠（何と何がどうつながっているか） */
  reason: string;
  /** 関わる部屋（「1階 パントリー」） */
  rooms: string[];
  /** 良い点（plus）／気を付ける点（check） */
  kind: 'plus' | 'check';
}

const centroid = (poly: Vec2[]): Vec2 => ({ x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length });
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** 軸平行の多角形が辺を共有する（壁をはさんで背中合わせ）か */
function touches(a: Vec2[], b: Vec2[], tol = 80): boolean {
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i];
    const a1 = a[(i + 1) % a.length];
    const vert = Math.abs(a0.x - a1.x) < tol;
    const horz = Math.abs(a0.y - a1.y) < tol;
    if (!vert && !horz) continue;
    for (let j = 0; j < b.length; j++) {
      const b0 = b[j];
      const b1 = b[(j + 1) % b.length];
      if (vert && Math.abs(b0.x - b1.x) < tol && Math.abs(a0.x - b0.x) < tol) {
        const ov = Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y)) - Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y));
        if (ov > 500) return true;
      } else if (horz && Math.abs(b0.y - b1.y) < tol && Math.abs(a0.y - b0.y) < tol) {
        const ov = Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x)) - Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x));
        if (ov > 500) return true;
      }
    }
  }
  return false;
}

const PANTRY = /パントリー|pantry|食品庫|キッチン収納/i;
const LAUNDRY = /ランドリー|洗濯|物干|ファミクロ|ファミリークローゼット|家事室|脱衣/i;
const SHOES = /土間収納|シューズ|SIC|玄関収納|シュークロ/i;
const WIC = /WIC|ウォークイン|クローゼット|CL/i;
const COURT = /中庭|坪庭|パティオ|ライトコート|テラス|デッキ|ウッドデッキ/i;
const WASH_HAND = /手洗|洗面/;

export function readDesignIntents(model: BuildingModel): DesignIntent[] {
  const out: DesignIntent[] = [];
  const { nodes, edges } = roomGraph(model);
  const keyOf = (level: number, r: Room) => `${level}:${r.id}`;
  const label = (level: number, r: Room) => `${level}階 ${r.name || r.type}`;
  /** 戸・開口でつながる部屋までの手数（最短経路の部屋数） */
  const hops = (from: string, to: string, max = 6): number | null => {
    if (from === to) return 0;
    const seen = new Set([from]);
    let frontier = [from];
    for (let d = 1; d <= max; d++) {
      const next: string[] = [];
      for (const k of frontier)
        for (const e of edges.get(k) ?? []) {
          if (seen.has(e.to)) continue;
          if (e.to === to) return d;
          seen.add(e.to);
          next.push(e.to);
        }
      frontier = next;
      if (!frontier.length) break;
    }
    return null;
  };
  const rooms = model.floors.flatMap((f) => f.rooms.filter((r) => r.type !== 'void').map((r) => ({ f, r, key: keyOf(f.level, r) })));
  const byType = (t: RoomType | RoomType[], level?: number) => rooms.filter((x) => (Array.isArray(t) ? t.includes(x.r.type) : x.r.type === t) && (level == null || x.f.level === level));
  const byName = (re: RegExp, level?: number) => rooms.filter((x) => re.test(x.r.name) && (level == null || x.f.level === level));
  const kitchens = [...byType(['ldk', 'kitchen']), ...byType('dining')].filter((x) => x.r.type !== 'dining' || !byType(['ldk', 'kitchen']).length);
  const entrance = byType('entrance').sort((a, b) => a.f.level - b.f.level)[0];
  const push = (i: DesignIntent) => {
    if (!out.some((o) => o.id === i.id)) out.push(i);
  };

  // 1. 買い物動線: パントリーがキッチンに接し、玄関から近い
  for (const p of byName(PANTRY)) {
    const k = kitchens.find((x) => x.f === p.f && (hops(p.key, x.key, 1) === 1 || touches(p.r.polygon, x.r.polygon)));
    if (!k) continue;
    const toEnt = entrance ? hops(entrance.key, p.key, 4) : null; // 玄関 → ホール → LDK → パントリーの 3 部屋までを「買い物動線」
    push({
      id: `pantry-${p.key}`,
      title: toEnt != null && toEnt <= 3 ? '玄関からキッチンの間にパントリー（買い物動線）' : 'キッチンのそばにパントリー',
      customer: toEnt != null && toEnt <= 3 ? '買ってきたものを、玄関から運んでそのまましまえます。' : 'キッチンのすぐそばにストックの置き場があり、まとめ買いがしやすい間取りです。',
      reason: `${label(p.f.level, p.r)} は ${label(k.f.level, k.r)} に接し${toEnt != null ? `、玄関から ${toEnt} 部屋目` : ''}。`,
      rooms: [label(p.f.level, p.r), label(k.f.level, k.r)],
      kind: 'plus',
    });
  }
  // 2. 洗濯動線: 洗面脱衣（ランドリー）→ 干す場所（バルコニー・ランドリールーム）→ しまう場所（WIC・ファミクロ）
  for (const w of byType('washroom')) {
    const dry = rooms.filter((x) => x.f === w.f && (x.r.type === 'balcony' || /ランドリー|物干|サンルーム/.test(x.r.name)) && x !== w);
    const near = dry.filter((x) => { const h = hops(w.key, x.key, 2); return h != null && h <= 2; });
    const store = rooms.filter((x) => x.f === w.f && (x.r.type === 'closet' || WIC.test(x.r.name)) && x !== w && (() => { const h = hops(w.key, x.key, 1); return (h != null && h <= 1) || touches(w.r.polygon, x.r.polygon); })());
    if (near.length && store.length) {
      push({
        id: `laundry-${w.key}`,
        title: '洗う・干す・しまうが一直線（洗濯動線）',
        customer: '洗濯機から干す場所、しまう場所までが近く、洗濯が一か所で終わります。',
        reason: `${label(w.f.level, w.r)} → ${near.map((x) => x.r.name).join('・')}（干す）→ ${store.map((x) => x.r.name).join('・')}（しまう）が同じ階で続く。`,
        rooms: [label(w.f.level, w.r), ...near.map((x) => label(x.f.level, x.r)), ...store.map((x) => label(x.f.level, x.r))],
        kind: 'plus',
      });
    } else if (near.length) {
      push({
        id: `laundry-${w.key}`,
        title: '洗面脱衣室から干す場所が近い',
        customer: '洗った物をすぐ干せます。',
        reason: `${label(w.f.level, w.r)} から ${near.map((x) => x.r.name).join('・')} まで ${hops(w.key, near[0].key, 2)} 部屋。`,
        rooms: [label(w.f.level, w.r), ...near.map((x) => label(x.f.level, x.r))],
        kind: 'plus',
      });
    }
  }
  // 3. 水まわりの集中: 浴室・洗面・トイレ（同じ階）が 6m 四方に収まる。キッチンも背中合わせなら配管がさらに短い
  for (const f of model.floors) {
    const wet = f.rooms.filter((r) => r.type === 'bath' || r.type === 'washroom' || r.type === 'toilet');
    if (wet.length < 2 || !wet.some((r) => r.type === 'bath')) continue;
    const cs = wet.map((r) => centroid(r.polygon));
    const span = Math.max(Math.max(...cs.map((c) => c.x)) - Math.min(...cs.map((c) => c.x)), Math.max(...cs.map((c) => c.y)) - Math.min(...cs.map((c) => c.y)));
    if (span > 6500) continue;
    const k = kitchens.find((x) => x.f === f && wet.some((r) => touches(r.polygon, x.r.polygon) || dist(centroid(x.r.polygon), centroid(r.polygon)) < 5000));
    push({
      id: `wet-${f.level}`,
      title: k ? 'キッチンと水まわりが背中合わせ（配管が短い）' : `${f.level}階の水まわりが一か所にまとまる`,
      customer: k ? '台所とお風呂・洗面が近く、家事の行き来が短い間取りです。お湯もすぐ出ます。' : 'お風呂・洗面・トイレが近くにまとまり、行き来が楽です。',
      reason: `${wet.map((r) => r.name).join('・')} が ${(span / 1000).toFixed(1)} m 四方${k ? `、${k.r.name} と隣接` : ''}。給排水の配管が短く、将来のメンテナンスもしやすい。`,
      rooms: wet.map((r) => label(f.level, r)),
      kind: 'plus',
    });
  }
  // 4. 帰宅動線: 玄関 → 手洗い（洗面）が近い。土間収納は外の物の置き場
  if (entrance) {
    const wash = byType('washroom', entrance.f.level).map((x) => ({ x, h: hops(entrance.key, x.key, 3) })).filter((o) => o.h != null).sort((a, b) => a.h! - b.h!)[0];
    if (wash && wash.h! <= 2) {
      push({
        id: 'home-wash',
        title: '帰ってすぐ手洗い（帰宅動線）',
        customer: '玄関から洗面までが近く、外から帰ったらまず手を洗ってから部屋に入れます。',
        reason: `玄関 → ${wash.x.r.name} が ${wash.h} 部屋目。`,
        rooms: [label(entrance.f.level, entrance.r), label(wash.x.f.level, wash.x.r)],
        kind: 'plus',
      });
    }
    const sic = byName(SHOES, entrance.f.level).find((x) => { const h = hops(entrance.key, x.key, 1); return (h != null && h <= 1) || touches(entrance.r.polygon, x.r.polygon); });
    if (sic) {
      push({
        id: 'sic',
        title: '玄関に土間収納（外の物の置き場）',
        customer: 'ベビーカー・外遊びの道具・アウトドア用品は玄関の土間にそのまま。玄関がすっきり保てます。',
        reason: `${label(sic.f.level, sic.r)}（${(sic.r.area / 1.62).toFixed(1)} 帖）が玄関に接する。`,
        rooms: [label(entrance.f.level, entrance.r), label(sic.f.level, sic.r)],
        kind: 'plus',
      });
    }
    // 玄関から LDK が直接見えるか
    const ldk = byType(['ldk', 'living'], entrance.f.level)[0];
    if (ldk) {
      const h = hops(entrance.key, ldk.key, 3);
      if (h === 1)
        push({ id: 'ent-ldk', title: '玄関からすぐ LDK', customer: '玄関を開けるとすぐに家族の場所。短い動線で、来客もそのままリビングへ。', reason: `玄関と ${ldk.r.name} が戸でつながる。`, rooms: [label(entrance.f.level, entrance.r), label(ldk.f.level, ldk.r)], kind: 'plus' });
      else if (h != null && h >= 2)
        push({ id: 'ent-ldk', title: '玄関と LDK の間にホール（生活感を見せない）', customer: '玄関からリビングが直接見えないので、急な来客でも落ち着いて迎えられます。', reason: `玄関 → ${ldk.r.name} はホールをはさんで ${h} 部屋目。`, rooms: [label(entrance.f.level, entrance.r), label(ldk.f.level, ldk.r)], kind: 'plus' });
    }
  }
  // 5. 回遊動線: 同じ階で 3 部屋以上の輪（キッチンか洗面を含む）
  for (const f of model.floors) {
    const keys = f.rooms.filter((r) => r.type !== 'void' && r.type !== 'closet' && r.type !== 'storage').map((r) => keyOf(f.level, r));
    const set = new Set(keys);
    let loop: string[] | null = null;
    const walk = (start: string, cur: string, path: string[]) => {
      if (loop) return;
      for (const e of edges.get(cur) ?? []) {
        if (!set.has(e.to)) continue;
        if (e.to === start && path.length >= 3) {
          loop = [...path];
          return;
        }
        if (path.includes(e.to) || path.length >= 6) continue;
        walk(start, e.to, [...path, e.to]);
      }
    };
    for (const k of keys) {
      const n = nodes.get(k);
      if (!n || !['ldk', 'kitchen', 'washroom'].includes(n.room.type)) continue;
      walk(k, k, [k]);
      if (loop) break;
    }
    if (loop) {
      const names = (loop as string[]).map((k) => nodes.get(k)!.room.name);
      push({
        id: `loop-${f.level}`,
        title: `${f.level}階に回遊動線`,
        customer: `${names.join(' → ')} とぐるっと回れるので、家事の行き止まりがなく、朝の混雑も分散します。`,
        reason: `${names.join('・')} が輪になってつながる（戸・開口）。`,
        rooms: (loop as string[]).map((k) => label(nodes.get(k)!.floor.level, nodes.get(k)!.room)),
        kind: 'plus',
      });
    }
  }
  // 6. 階段の位置: リビング階段か、玄関ホール階段か
  for (const s of byType('stairs')) {
    if (s.f.level !== model.floors[0].level) continue;
    const ldkAdj = byType(['ldk', 'living'], s.f.level).find((x) => hops(s.key, x.key, 1) === 1);
    const hallAdj = byType(['hall', 'entrance'], s.f.level).find((x) => hops(s.key, x.key, 1) === 1);
    if (ldkAdj)
      push({ id: `stair-${s.key}`, title: 'リビング階段（家族が必ず顔を合わせる）', customer: '2 階へはリビングを通って上がるので、子どもの帰宅や外出に自然に気づけます。', reason: `${label(s.f.level, s.r)} が ${ldkAdj.r.name} に開く。冷暖房は吹抜・階段の空気の流れに注意。`, rooms: [label(s.f.level, s.r), label(ldkAdj.f.level, ldkAdj.r)], kind: 'plus' });
    else if (hallAdj)
      push({ id: `stair-${s.key}`, title: 'ホール階段（来客と家族の動線を分ける）', customer: 'リビングを通らずに 2 階へ上がれるので、来客中でも家族は気兼ねなく動けます。', reason: `${label(s.f.level, s.r)} が ${hallAdj.r.name} に開く。`, rooms: [label(s.f.level, s.r), label(hallAdj.f.level, hallAdj.r)], kind: 'plus' });
  }
  // 7. 寝室とトイレ・WIC
  for (const b of byType('bedroom')) {
    const t = byType('toilet', b.f.level).map((x) => ({ x, h: hops(b.key, x.key, 3) })).filter((o) => o.h != null).sort((a, b) => a.h! - b.h!)[0];
    if (!byType('toilet', b.f.level).length && byType('toilet').length && model.floors.length > 1) {
      push({ id: `bed-toilet-${b.f.level}`, title: `${b.f.level}階にトイレが無い（${b.r.name}）`, customer: '夜中のトイレは階段を使うことになります。', rooms: [label(b.f.level, b.r)], reason: `${b.f.level}階にトイレの区画が読めていません（読み取り漏れの可能性も）。`, kind: 'check' });
    }
    void t;
    const wic = rooms.find((x) => x.f === b.f && (x.r.type === 'closet' || WIC.test(x.r.name)) && x.r.area >= 2.5 && hops(b.key, x.key, 1) === 1);
    if (wic) push({ id: `bed-wic-${b.key}`, title: `${b.r.name}から直接 WIC へ`, customer: '寝室の中で着替えが完結します。', reason: `${label(b.f.level, b.r)} → ${wic.r.name}（${(wic.r.area / 1.62).toFixed(1)} 帖）。`, rooms: [label(b.f.level, b.r), label(wic.f.level, wic.r)], kind: 'plus' });
  }
  // 8. 吹抜・中庭と LDK のつながり
  for (const f of model.floors) {
    for (const v of f.rooms.filter((r) => r.type === 'void')) {
      const below = model.floors.find((x) => x.level === f.level - 1);
      if (!below) continue;
      const c = centroid(v.polygon);
      const under = below.rooms.find((r) => r.type !== 'void' && pointInPolygon(c, r.polygon));
      if (!under) continue;
      push({ id: `void-${f.level}-${v.id}`, title: `${under.name}の上が吹抜`, customer: `${under.name}は上の階までつながる高い天井で、光と風が上下に通ります。`, reason: `${f.level}階の吹抜（${(v.area / 1.62).toFixed(1)} 帖）が ${below.level}階 ${under.name} の真上。1 階の天井はその範囲で無い。`, rooms: [label(below.level, under), `${f.level}階 吹抜`], kind: 'plus' });
    }
    for (const c of f.rooms.filter((r) => COURT.test(r.name))) {
      const ldk = f.rooms.find((r) => (r.type === 'ldk' || r.type === 'living') && (touches(c.polygon, r.polygon) || hops(keyOf(f.level, c), keyOf(f.level, r), 1) === 1));
      if (ldk) push({ id: `court-${f.level}-${ldk.id}`, title: `${ldk.name}から${c.name}へ`, customer: `${ldk.name}の延長に${c.name}。外とつながる居場所になります。`, reason: `${label(f.level, c)} が ${ldk.name} に接する。`, rooms: [label(f.level, ldk), label(f.level, c)], kind: 'plus' });
    }
  }
  // 9. 2 階ホールが広い（セカンドリビング・物干し）
  for (const hl of byType('hall')) {
    if (hl.f.level < 2 || hl.r.area < 4.5 * 1.62) continue;
    const bal = byType('balcony', hl.f.level).find((x) => hops(hl.key, x.key, 1) === 1);
    push({ id: `hall-${hl.key}`, title: `${hl.f.level}階ホールが広い（${(hl.r.area / 1.62).toFixed(1)} 帖）`, customer: bal ? 'ホールに机や本棚を置けるゆとりがあり、バルコニーにも出られるので室内干しの場所にもなります。' : 'ホールに机や本棚を置けるゆとりがあります。', reason: `${label(hl.f.level, hl.r)}${bal ? ` → ${bal.r.name}` : ''}。`, rooms: [label(hl.f.level, hl.r)], kind: 'plus' });
  }
  return out;
}
