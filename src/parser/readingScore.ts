/**
 * 読み取りの点数（100 点満点）と「まず直す 3 つ」。
 * 図面に書いてある数字（帖数・面積表）と読み取った結果を突き合わせ、上下階の整合・戸と窓の有無・壁の読み取りの疑いを点にする。
 * 設計の注意（梁のスパン・直下率など）は点数に入れない（読み取りの出来だけを見る）。
 */
import { type BuildingModel, type Floor, type Room } from '../core/types';
import { woodCheck, type WoodIssue } from './woodCheck';
import { entranceDoorOf } from '../core/entrance';
import { floorAreaOf } from '../core/floorArea';
import { overlay } from '../estimate/areas';

export interface ScorePart {
  id: 'tatami' | 'areaTable' | 'floors' | 'openings' | 'walls' | 'rooms';
  label: string;
  max: number;
  got: number;
  /** 根拠（短く） */
  note: string;
}

export interface ScoreFix {
  /** 失った点（大きい順に「まず直す」へ） */
  lost: number;
  title: string;
  detail: string;
  level?: number;
  /** 木造チェックの項目（直すボタン・図面で見るに使う） */
  issue?: WoodIssue;
}

export interface ReadingScore {
  score: number;
  parts: ScorePart[];
  fixes: ScoreFix[];
  /** 点数の見方（80 以上: そのまま提案に使える、60〜79: 直してから、60 未満: 読み直し） */
  grade: 'good' | 'fair' | 'poor';
}

/** 読み取りミスの疑いとして点数に入れる木造チェックの項目（設計の注意は入れない） */
const WALL_IDS = /^(stub|dup|merged|jog|narrow|ub|wc|door|offgrid)-\d/;
const r1 = (v: number) => Math.round(v * 10) / 10;
const tatamiOf = (r: Room) => r.area / 1.62;
const isLivingRoom = (r: Room) => ['ldk', 'living', 'dining', 'kitchen', 'bedroom', 'japanese', 'study', 'kids'].includes(r.type);
const floorArea = (f: Floor, floors: Floor[]) => floorAreaOf(f, floors);

export function readingScore(model: BuildingModel, issuesIn?: WoodIssue[]): ReadingScore {
  const issues = issuesIn ?? woodCheck(model);
  const parts: ScorePart[] = [];
  const fixes: ScoreFix[] = [];
  const floors = model.floors;
  const rooms = floors.flatMap((f) => f.rooms.filter((r) => r.type !== 'void'));
  // ほとんど読めていない（画像の図面など）ときは、検算できない項目に点を付けない。LDK が見つからない読み取りは半分だけ
  const readable = floors.length > 0 && rooms.length >= 3;
  const hasLdk = rooms.some((r) => r.type === 'ldk' || r.type === 'living');
  const unverified = readable ? (hasLdk ? 1 : 0.5) : 0;

  // 1. 帖数の照合（25）: 図面の帖数と読み取った面積（±0.35 帖または ±6%）
  {
    const labeled = floors.flatMap((f) => f.rooms.filter((r) => r.labeledTatami && r.labeledTatami > 0).map((r) => ({ f, r })));
    const bad = labeled.filter(({ r }) => {
      const t = tatamiOf(r);
      return Math.abs(t - r.labeledTatami!) > Math.max(0.45, r.labeledTatami! * 0.07);
    });
    let got: number;
    let note: string;
    if (!labeled.length) {
      got = 15 * unverified;
      note = readable ? `帖数の表記が無いので検算できません${hasLdk ? '' : '（LDK が無いので読み取りが部分的な疑い）'}` : '部屋が読めていません';
    } else {
      got = 25 * ((labeled.length - bad.length) / labeled.length);
      if (!readable) got = Math.min(got, 5);
      note = bad.length ? `帖数の表記 ${labeled.length} 室のうち ${labeled.length - bad.length} 室が一致。ずれ: ${bad.slice(0, 3).map(({ f, r }) => `${f.level}階 ${r.name} ${r.labeledTatami!.toFixed(1)}→${tatamiOf(r).toFixed(1)}帖`).join('、')}${bad.length > 3 ? '…' : ''}` : `帖数の表記 ${labeled.length} 室すべて一致`;
    }
    parts.push({ id: 'tatami', label: '帖数', max: 25, got: r1(got), note });
    for (const { f, r } of bad) {
      const diff = tatamiOf(r) - r.labeledTatami!;
      fixes.push({
        lost: r1(25 / labeled.length),
        level: f.level,
        title: `${f.level}階 ${r.name}: 図面は ${r.labeledTatami!.toFixed(1)} 帖、読み取りは ${tatamiOf(r).toFixed(1)} 帖（${diff > 0 ? '広い' : '狭い'}）`,
        detail: diff > 0 ? '隣の部屋・収納と区画がつながっているか、壁を読み落としています。方眼でその部屋の壁を確認してください' : '壁を余分に読んでいるか、部屋名の位置の区画が違います。方眼で壁を消すか部屋名を動かしてください',
      });
    }
  }

  // 2. 面積表との照合（15）: 階ごとの床面積（±3% で満点、±8% で半分）
  {
    const table = model.report.areaTable ?? {};
    const rows = floors.filter((f) => table[f.level] > 5).map((f) => ({ f, want: table[f.level], got: floorArea(f, floors) }));
    let got: number;
    let note: string;
    if (!rows.length) {
      got = 10 * unverified;
      note = readable ? '面積表が無いので検算できません' : '部屋が読めていません';
    } else {
      let s = 0;
      const notes: string[] = [];
      for (const row of rows) {
        const err = Math.abs(row.got - row.want) / row.want;
        const pt = err <= 0.03 ? 1 : err <= 0.08 ? 0.5 : 0;
        s += pt;
        notes.push(`${row.f.level}階 ${row.want.toFixed(2)}→${row.got.toFixed(2)}㎡${pt === 1 ? '' : pt === 0.5 ? '（やや差）' : '（差が大きい）'}`);
        if (pt < 1)
          fixes.push({
            lost: r1((15 / rows.length) * (1 - pt)),
            level: row.f.level,
            title: `${row.f.level}階の床面積: 面積表 ${row.want.toFixed(2)} ㎡に対して読み取り ${row.got.toFixed(2)} ㎡（${Math.round(err * 100)}% の差）`,
            detail: row.got > row.want ? 'バルコニー・ポーチ・ガレージが床面積に入っているか、外形が広く読めています。部屋の種類と外周の壁を確認してください' : '外周の壁が欠けて部屋が読めていない可能性があります。方眼で外周を確認してください',
          });
      }
      got = (15 * s) / rows.length;
      note = notes.join('、');
    }
    parts.push({ id: 'areaTable', label: '面積表', max: 15, got: r1(got), note });
  }

  // 3. 上下階の整合（15）: 上の階が下の階より広くない（8。面積表でも上の階が広い家＝ガレージの上に LDK などは除く）、階段が上下でつながる（7）
  {
    let got = readable ? 15 : 0;
    const notes: string[] = [];
    const table = model.report.areaTable ?? {};
    if (floors.length >= 2) {
      let widerIssue = false;
      for (let i = 1; i < floors.length; i++) {
        const lo = floorArea(floors[i - 1], floors);
        const hi = floorArea(floors[i], floors);
        const byDesign = table[floors[i].level] > 0 && table[floors[i - 1].level] > 0 && table[floors[i].level] > table[floors[i - 1].level];
        if (lo > 0 && hi > lo * 1.1 && !byDesign) {
          got -= 8;
          widerIssue = true;
          notes.push(`${floors[i].level}階（${hi.toFixed(1)}㎡）が${floors[i - 1].level}階（${lo.toFixed(1)}㎡）より広い`);
          fixes.push({ lost: 8, level: floors[i].level, title: `${floors[i].level}階が${floors[i - 1].level}階より広く読めています`, detail: '下の階の外周の壁の読み落とし（部屋が欠けている）か、上の階に屋外（バルコニー）が部屋として入っています。方眼で両方の階の外形を見比べてください' });
          break;
        }
      }
      // 建築面積（各階の外形を真上から重ねた面積）が図面の面積表と合わない → 上下階の重ね位置がずれている疑い
      // （有元様邸: 3 階を 2 階ではなく 1 階に合わせていて 1.82m ずれ、建築面積 68.31 → 82.2 ㎡・屋根と軒天が 2 割増しになっていた）
      if (!widerIssue && table.build != null && table.build > 5) {
        const union = overlay(floors).union;
        const err = Math.abs(union - table.build) / table.build;
        if (err > 0.08) {
          got -= 8;
          notes.push(`建築面積が面積表 ${table.build.toFixed(2)}㎡ に対して ${union.toFixed(2)}㎡`);
          fixes.push({ lost: 8, title: `建築面積: 面積表 ${table.build.toFixed(2)} ㎡に対して読み取り ${union.toFixed(2)} ㎡（${Math.round(err * 100)}% の差）`, detail: union > table.build ? '上の階と下の階の重ね位置がずれているか、上の階にバルコニー・屋根が部屋として入っています。3D で上下階のずれを確かめ、方眼で外形を見直してください。屋根・軒天・断熱の数量に効きます' : '外周の壁が欠けて外形が小さく読めている階があります。方眼で外周を確認してください' });
        }
      }
      const stairIssue = issues.find((i) => /^stair-/.test(i.id));
      const f1 = floors[0];
      if (!f1.stairs.some((s) => s.goesUp)) {
        got -= 7;
        notes.push('1階に上り階段が無い');
        fixes.push({ lost: 7, level: f1.level, title: '1階に上り階段が読めていません', detail: '階段の記号（段割り・UP）が読めていないか、ホールと一緒になっています。方眼の「階段」で描いてください' });
      } else if (stairIssue) {
        const lost = stairIssue.severity === 'warn' ? 7 : 3;
        got -= lost;
        notes.push(stairIssue.title);
        fixes.push({ lost, level: stairIssue.level, title: stairIssue.title, detail: stairIssue.detail, issue: stairIssue });
      }
      if (!notes.length) notes.push(`${floors.length} 階の広さと階段の位置が合っています`);
    } else notes.push(readable ? '平屋（1 階のみ）' : '階が読めていません');
    parts.push({ id: 'floors', label: '上下階', max: 15, got: r1(Math.max(0, got)), note: notes.join('、') });
  }

  // 4. 戸・窓（20）: 出入口の無い部屋（10）、窓の無い居室（7）、玄関ドア（3）
  {
    const nodoor = issues.filter((i) => /^nodoor-/.test(i.id));
    const nowin = issues.filter((i) => /^nowin-/.test(i.id));
    const living = rooms.filter(isLivingRoom);
    // 1 階が無い読み取り（2 階だけの図面）は玄関ドアを問わない
    const hasEntrance = floors.some((f) => !!entranceDoorOf(f)) || !floors.some((f) => f.level === 1);
    const doorPt = !readable ? 0 : 10 * Math.max(0, 1 - (nodoor.length * 1.5) / rooms.length);
    const winPt = !readable ? 0 : living.length ? 7 * Math.max(0, 1 - (nowin.length * 1.5) / living.length) : 7;
    const entPt = hasEntrance ? 3 : 0;
    const notes: string[] = [];
    if (nodoor.length) notes.push(`出入口の無い部屋 ${nodoor.length}`);
    if (nowin.length) notes.push(`窓の無い居室 ${nowin.length}`);
    if (!hasEntrance) notes.push('玄関ドアが無い');
    if (!notes.length) notes.push(`戸・窓 ${floors.reduce((s, f) => s + f.openings.length, 0)} か所、玄関あり`);
    parts.push({ id: 'openings', label: '戸・窓', max: 20, got: r1(doorPt + winPt + entPt), note: notes.join('、') });
    for (const it of nodoor) fixes.push({ lost: r1(Math.min(10, 15 / Math.max(1, rooms.length))), level: it.level, title: it.title, detail: it.detail, issue: it });
    for (const it of nowin) fixes.push({ lost: r1(Math.min(7, 10.5 / Math.max(1, living.length))), level: it.level, title: it.title, detail: it.detail, issue: it });
    if (!hasEntrance) fixes.push({ lost: 3, title: '玄関ドアが読めていません', detail: '方眼の「開き戸」で外壁に置くと玄関ドアになります（道路側の外観・ポーチの位置に使います）' });
  }

  // 5. 壁の読み取り（15）: 短い断片・重なり・部屋の結合・外壁の段差・通れない幅・UB と便所の寸法・幅 550 未満の戸（種類ごとに −6 まで）
  {
    const wall = issues.filter((i) => WALL_IDS.test(i.id));
    let got = readable ? 15 : 0;
    const lostByKind = new Map<string, number>();
    for (const it of wall) {
      const kind = it.id.split('-')[0];
      const base = it.severity === 'warn' ? 4 : 1.5;
      const lost = Math.min(base, 6 - (lostByKind.get(kind) ?? 0));
      if (lost <= 0) continue;
      lostByKind.set(kind, (lostByKind.get(kind) ?? 0) + lost);
      got -= lost;
      fixes.push({ lost, level: it.level, title: it.title, detail: it.detail, issue: it });
    }
    parts.push({ id: 'walls', label: '壁', max: 15, got: r1(Math.max(0, got)), note: wall.length ? `疑わしい所 ${wall.length}（${wall.slice(0, 3).map((i) => i.title.replace(/ — .*$/, '')).join('、')}${wall.length > 3 ? '…' : ''}）` : '壁の端・重なり・区画に不自然な所はありません' });
  }

  // 6. 階と部屋名（10）: 各階に 3 室以上（5）、用途の分からない部屋が無い（3）、LDK がある（2）
  {
    const thin = floors.filter((f) => f.rooms.filter((r) => r.type !== 'void').length < 3);
    // EV（エレベーター）は用途が分かっている（部屋の種類は other のまま）
    const unnamed = rooms.filter((r) => (r.type === 'other' && !/^(EV|ＥＶ|ELV|ＥＬＶ|エレベーター|エレベータ)$/i.test(r.name.replace(/\s/g, ''))) || /^室$|^部屋$/.test(r.name.trim()));
    const got = readable ? (floors.length && !thin.length ? 5 : 0) + (unnamed.length ? Math.max(0, 3 - unnamed.length) : 3) + (hasLdk ? 2 : 0) : 0;
    const notes: string[] = [];
    if (!floors.length) notes.push('階が読めていない');
    else if (thin.length) notes.push(`${thin.map((f) => `${f.level}階`).join('・')}の部屋がほとんど読めていない`);
    if (unnamed.length) notes.push(`用途の分からない部屋 ${unnamed.length}`);
    if (!hasLdk) notes.push('LDK／リビングが無い');
    if (!notes.length) notes.push(`${floors.length} 階 ${rooms.length} 室、LDK あり`);
    parts.push({ id: 'rooms', label: '階・部屋', max: 10, got: r1(got), note: notes.join('、') });
    for (const f of thin) fixes.push({ lost: 5, level: f.level, title: `${f.level}階の部屋がほとんど読めていません`, detail: '縮尺か壁線の太さが合っていません。読み込みのやり直しで縮尺を指定するか、方眼で壁を描いてください' });
    for (const r of unnamed.slice(0, 3)) {
      const f = floors.find((x) => x.rooms.includes(r));
      fixes.push({ lost: 1, level: f?.level, title: `${f?.level ?? ''}階 「${r.name}」の用途が分かりません`, detail: '部屋名の文字が読めていないか、一般的でない名前です。方眼で部屋名を直してください（LDK・洋室・WIC など）' });
    }
    if (!hasLdk) fixes.push({ lost: 2, title: 'LDK／リビングが見つかりません', detail: '部屋名の読み取りがずれています。方眼で部屋名を直してください' });
  }

  const score = Math.max(0, Math.min(100, Math.round(parts.reduce((s, p) => s + p.got, 0))));
  // 同じ見出し（同じ部屋名の UB が 3 つなど）は 1 つに
  const seen = new Set<string>();
  const uniq = fixes.filter((f) => (seen.has(f.title) ? false : (seen.add(f.title), true)));
  uniq.sort((a, b) => b.lost - a.lost);
  if (!readable) uniq.unshift({ lost: 50, title: '間取りがほとんど読めていません', detail: '画像の図面（スキャン・写真）か、縮尺・壁線の太さが合っていません。ARCHITREND などの CAD から書き出した PDF を読み込むか、読み込みのやり直しで縮尺を指定してください' });
  return { score, parts, fixes: uniq, grade: score >= 80 ? 'good' : score >= 60 ? 'fair' : 'poor' };
}

export const GRADE_LABEL: Record<ReadingScore['grade'], string> = { good: 'そのまま提案に使えます', fair: '「まず直す」を直してから提案へ', poor: '読み直し（縮尺・PDF の種類）をおすすめします' };
