/**
 * 日当たりの説明文を自動作成（プレゼン用）
 */
import type { RoomSunResult } from './analysis';
import { formatHM } from './solar';

export interface SeasonResult {
  id: 'winter' | 'spring' | 'summer' | 'autumn' | 'custom';
  label: string;
  dateLabel: string;
  rooms: RoomSunResult[];
}

export interface SunHighlight {
  title: string;
  body: string;
  tone: 'good' | 'info' | 'caution';
}

const MAIN = ['ldk', 'living', 'dining', 'kitchen'];

export function sunHighlights(seasons: SeasonResult[]): SunHighlight[] {
  const out: SunHighlight[] = [];
  const winter = seasons.find((s) => s.id === 'winter');
  const summer = seasons.find((s) => s.id === 'summer');
  const any = winter ?? seasons[0];
  if (!any) return out;
  const main = any.rooms.find((r) => MAIN.includes(r.type)) ?? any.rooms.slice().sort((a, b) => b.hours - a.hours)[0];
  if (main && winter) {
    const w = winter.rooms.find((r) => r.roomId === main.roomId)!;
    if (w.hours >= 3 && w.first != null && w.last != null) {
      out.push({
        title: `冬至でも${main.name}に陽だまり`,
        body: `一年で最も日が短い冬至（${winter.dateLabel}）でも、${main.name}には ${formatHM(w.first)}〜${formatHM(w.last)} の約${w.hours.toFixed(1)}時間、直射日光が差し込みます。最も奥まで光が届くのは ${formatHM(w.peakAt ?? w.first)} ごろ（床面の約${Math.round(w.peak * 100)}%）。冬でも暖かく明るいリビングです。`,
        tone: 'good',
      });
    } else if (w.hours > 0 && w.first != null && w.last != null) {
      out.push({
        title: `冬至の${main.name}の日当たり`,
        body: `冬至（${winter.dateLabel}）の${main.name}は ${formatHM(w.first)}〜${formatHM(w.last)} に日が入ります（約${w.hours.toFixed(1)}時間）。吹抜や高窓で光を取り込む工夫もご提案できます。`,
        tone: 'info',
      });
    } else {
      out.push({
        title: `冬至の${main.name}は直射日光が入りにくい`,
        body: `周辺建物の影響などで、冬至の${main.name}には直射日光がほとんど入りません。窓の位置・大きさの見直しや、2階リビング・高窓などのご提案が考えられます。`,
        tone: 'caution',
      });
    }
  }
  if (main && summer) {
    const s = summer.rooms.find((r) => r.roomId === main.roomId)!;
    const w = winter?.rooms.find((r) => r.roomId === main.roomId);
    if (w && s.peak < w.peak) {
      out.push({
        title: '夏は日差しをカット、冬は取り込む',
        body: `太陽が高い夏至は、軒や庇が日差しをさえぎり${main.name}の床に届く直射光は最大でも約${Math.round(s.peak * 100)}%。太陽が低い冬至は約${Math.round((w.peak ?? 0) * 100)}%まで奥に届きます。季節に合わせて自然に日射をコントロールする設計です。`,
        tone: 'good',
      });
    }
  }
  // 朝日が入る部屋
  if (any) {
    const morning = any.rooms.filter((r) => r.first != null && r.first < 9 && !MAIN.includes(r.type)).map((r) => r.name);
    if (morning.length) {
      out.push({
        title: '朝日で気持ちよく目覚める',
        body: `${uniq(morning).slice(0, 3).join('・')}には朝9時前から日が入ります。朝の光を浴びて、すっきりと一日をスタートできます。`,
        tone: 'good',
      });
    }
  }
  // ランキング
  const ranking = any.rooms.filter((r) => r.hours > 0).sort((a, b) => b.hours - a.hours).slice(0, 3);
  if (ranking.length) {
    out.push({
      title: `${any.label}の日当たりランキング`,
      body: ranking.map((r, i) => `${i + 1}位 ${r.name}（約${r.hours.toFixed(1)}時間）`).join('　'),
      tone: 'info',
    });
  }
  return out;
}

function uniq<T>(a: T[]) {
  return [...new Set(a)];
}

/** 部屋 × 時刻の日射率の表（SVG タイムライン） */
export function sunTimelineSvg(season: SeasonResult, from = 5, to = 19): string {
  const rows = season.rooms.filter((r) => r.series.length);
  const W = 900;
  const rowH = 30;
  const left = 150;
  const top = 36;
  const H = top + rows.length * rowH + 30;
  const x = (h: number) => left + ((h - from) / (to - from)) * (W - left - 70);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="'Noto Sans JP','Hiragino Sans',sans-serif">`;
  s += `<rect width="${W}" height="${H}" fill="#fff"/>`;
  s += `<text x="10" y="22" font-size="15" font-weight="bold" fill="#333">${season.label}（${season.dateLabel}）の部屋ごとの日当たり</text>`;
  for (let h = from; h <= to; h++) {
    s += `<line x1="${x(h)}" y1="${top - 4}" x2="${x(h)}" y2="${top + rows.length * rowH}" stroke="#e6e6e6"/>`;
    if (h % 2 === 0) s += `<text x="${x(h)}" y="${top + rows.length * rowH + 18}" font-size="12" text-anchor="middle" fill="#777">${h}時</text>`;
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    s += `<text x="${left - 10}" y="${y + rowH / 2 + 5}" font-size="13" text-anchor="end" fill="#333">${r.level}F ${r.name}</text>`;
    s += `<rect x="${x(from)}" y="${y + 5}" width="${x(to) - x(from)}" height="${rowH - 10}" fill="#f1f2f4" rx="4"/>`;
    const step = r.series.length > 1 ? r.series[1].h - r.series[0].h : 1 / 6;
    for (const p of r.series) {
      if (p.frac < 0.01) continue;
      const a = Math.min(1, 0.25 + p.frac * 1.6);
      s += `<rect x="${x(p.h - step / 2)}" y="${y + 5}" width="${Math.max(1, x(p.h + step / 2) - x(p.h - step / 2))}" height="${rowH - 10}" fill="rgba(245,160,40,${a.toFixed(2)})"/>`;
    }
    if (r.hours > 0) s += `<text x="${W - 14}" y="${y + rowH / 2 + 5}" font-size="12" text-anchor="end" fill="#b86b00">${r.hours.toFixed(1)}h</text>`;
  });
  s += `</svg>`;
  return s;
}
