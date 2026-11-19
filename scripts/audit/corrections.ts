/**
 * 修正履歴の分析: 修正画面の「正解データとして保存」で集まったファイル（自動の読み取り auto と、直した結果 truth）を比べ、
 * どの種類の手直しが多いか（窓・戸の追加／削除／種類の変更、部屋名の変更、壁の追加／削除、階段の変更）と、操作の回数・時間を集計する。
 *
 *   npx tsx scripts/audit/corrections.ts <正解データ.json> [...]
 *
 * 1 件の手直しをそのまま全案件に当てはめないため、図面の作り方（CAD・縮尺）ごとに分けて数える。
 * ファイルはお客様の図面から作ったものなので、作業用の場所に置き、リポジトリに入れない。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

type V = { x: number; y: number };
type F = { level: number; walls: { a: V; b: V }[]; openings: { kind: string; width: number; center: V | null }[]; rooms: { name: string }[]; stairs?: { kind: string; minX: number; minY: number; maxX: number; maxY: number }[] };
const near = (a: V | null, b: V | null, tol = 300) => !!a && !!b && Math.hypot(a.x - b.x, a.y - b.y) <= tol;
const wkey = (w: { a: V; b: V }) => [w.a, w.b].map((p) => `${Math.round(p.x / 50)},${Math.round(p.y / 50)}`).sort().join('|');

const total: Record<string, number> = {};
const add = (k: string, n = 1) => (total[k] = (total[k] ?? 0) + n);
for (const file of process.argv.slice(2)) {
  const d = JSON.parse(readFileSync(file, 'utf8'));
  const auto: F[] = d.auto;
  const truth: F[] = d.truth ?? d.floors;
  const per: Record<string, number> = {};
  const inc = (k: string, n = 1) => {
    per[k] = (per[k] ?? 0) + n;
    add(k, n);
  };
  for (const t of truth) {
    const a = auto.find((x) => x.level === t.level);
    if (!a) {
      inc('階を足した');
      continue;
    }
    const used = new Set<number>();
    for (const o of t.openings) {
      const j = a.openings.findIndex((x, i) => !used.has(i) && near(x.center, o.center));
      if (j < 0) inc(`建具を足した(${o.kind})`);
      else {
        used.add(j);
        if (a.openings[j].kind !== o.kind) inc(`建具の種類を変えた(${a.openings[j].kind}→${o.kind})`);
        else if (Math.abs(a.openings[j].width - o.width) > 100) inc('建具の幅を変えた');
      }
    }
    a.openings.forEach((x, i) => !used.has(i) && inc(`建具を消した(${x.kind})`));
    const aw = new Set(a.walls.map(wkey));
    const tw = new Set(t.walls.map(wkey));
    inc('壁を足した', [...tw].filter((k) => !aw.has(k)).length);
    inc('壁を消した', [...aw].filter((k) => !tw.has(k)).length);
    const an = a.rooms.map((r) => r.name).sort().join(',');
    const tn = t.rooms.map((r) => r.name).sort().join(',');
    if (an !== tn) inc('部屋名・部屋の数を変えた');
    if (JSON.stringify(a.stairs ?? []) !== JSON.stringify(t.stairs ?? [])) inc('階段を変えた');
  }
  const e = d.edits;
  console.log(`${path.basename(file)}: ${d.partial == null ? '確認状況不明（旧形式）' : d.partial ? '一部の正解' : '確認済み'}・縮尺 1/${d.scale ?? '?'}・操作 ${e?.ops ?? '?'} 回・${e?.activeSec != null ? Math.round(e.activeSec / 60) + ' 分' : '時間不明'}｜${Object.entries(per).map(([k, v]) => `${k} ${v}`).join('・') || '手直しなし'}`);
}
console.log('合計:', Object.entries(total).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('・'));
