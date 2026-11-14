/**
 * 立面図のシートに添える「外部数量表」: 外壁面積・屋根面積・軒天・基礎外周・軒先・バルコニーなど、見積の拾いと同じ計算（estimate/areas.ts の takeoff）。
 * 設計士が立面図を見ながら見積の数量を確かめられるように、図面に数字を残す（御社の要望: 壁の面積と屋根の面積を図面のどこかに）。
 */
import type { BuildingModel } from '../core/types';
import { takeoff, type TakeoffOptions } from '../estimate/areas';
import { esc } from './sheet';

/** 外部数量の行（項目・数量・備考）。拾えない図面では 1 行だけ */
export function exteriorQuantityRows(model: BuildingModel, opts: TakeoffOptions): string[][] {
  const rows: string[][] = [];
  try {
    const a = takeoff(model, opts);
    const roofName = opts.roofType === 'flat' ? '陸屋根' : opts.roofType === 'shed' ? `片流れ ${opts.pitch} 寸` : opts.roofType === 'gable' ? `切妻 ${opts.pitch} 寸` : `寄棟 ${opts.pitch} 寸`;
    rows.push(['外壁面積', `${a.extWall.toFixed(1)} ㎡`, '開口を引かない']);
    rows.push(['屋根面積', `${a.roofArea.toFixed(1)} ㎡`, roofName]);
    rows.push(['軒天面積', `${a.soffitArea.toFixed(1)} ㎡`, `軒の出 ${opts.eavesMm} mm`]);
    rows.push(['軒先（鼻隠し）', `${a.eaveLen.toFixed(1)} m`, '']);
    rows.push(['基礎外周', `${a.foundPerim.toFixed(1)} m`, '']);
    rows.push(['建築面積', `${a.buildArea.toFixed(2)} ㎡`, '']);
    rows.push(['施工面積', `${a.constArea.toFixed(2)} ㎡`, `${a.constTsubo.toFixed(2)} 坪`]);
    if (a.balconyArea > 0) rows.push(['バルコニー', `${a.balconyArea.toFixed(2)} ㎡`, '']);
    if (a.garageArea > 0) rows.push(['ガレージ（土間）', `${a.garageArea.toFixed(2)} ㎡`, '施工面積に']);
    rows.push(['断熱 天井＆外部床', `${a.insulArea.toFixed(1)} ㎡`, '']);
  } catch {
    rows.push(['外壁面積', '—', '拾えませんでした']);
  }
  return rows;
}

/**
 * 外部数量の帯（立面図シートの外部仕上表のすぐ下に置く 1 段の表）。左上 (x, y)、幅 w。
 * 右の列に縦長の表を置くと、立面図 4 面が 1/100 で入らず 1/150 に縮んで紙の右と下が大きく空いていた。
 * 帯にして紙の幅いっぱいを立面図に使う（数字は同じ。備考は項目名の右に小さく）。
 */
export function exteriorQuantityStripSvg(model: BuildingModel, opts: TakeoffOptions, x: number, y: number, w: number): { svg: string; w: number; h: number } {
  const rows = exteriorQuantityRows(model, opts);
  const h = 760;
  const headW = 2500;
  const sw = 12;
  const thin = 6;
  const cw = (w - headW) / Math.max(1, rows.length);
  const em = (t: string) => [...t].reduce((a, ch) => a + (/[\x20-\x7e｡-ﾟ]/.test(ch) ? 0.55 : 1), 0);
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff" stroke="#111" stroke-width="${sw}"/>`;
  s += `<line x1="${x + headW}" y1="${y}" x2="${x + headW}" y2="${y + h}" stroke="#111" stroke-width="${sw}"/>`;
  s += `<text x="${x + headW / 2}" y="${y + h * 0.44}" font-size="250" text-anchor="middle" fill="#111" letter-spacing="30">外部数量</text>`;
  s += `<text x="${x + headW / 2}" y="${y + h * 0.82}" font-size="170" text-anchor="middle" fill="#555">（見積の拾い）</text>`;
  rows.forEach((r, i) => {
    const cx = x + headW + i * cw;
    if (i > 0) s += `<line x1="${cx.toFixed(0)}" y1="${y}" x2="${cx.toFixed(0)}" y2="${y + h}" stroke="#111" stroke-width="${thin}"/>`;
    const [label, value, note] = r;
    // 項目名（左上）と備考（右上・小さく）。幅に収まらない備考は縮める
    s += `<text x="${(cx + 90).toFixed(0)}" y="${y + h * 0.36}" font-size="190" fill="#444">${esc(label)}</text>`;
    if (note) {
      const room = cw - 180 - em(label) * 190 - 80;
      const need = em(note) * 160;
      if (room > 500) s += `<text x="${(cx + cw - 90).toFixed(0)}" y="${y + h * 0.36}" font-size="160" text-anchor="end" fill="#777"${need > room ? ` textLength="${room.toFixed(0)}" lengthAdjust="spacingAndGlyphs"` : ''}>${esc(note)}</text>`;
    }
    s += `<text x="${(cx + cw - 110).toFixed(0)}" y="${y + h * 0.84}" font-size="270" text-anchor="end" fill="#111">${esc(value)}</text>`;
  });
  return { svg: s, w, h };
}
