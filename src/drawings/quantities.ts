/**
 * 立面図のシートに添える「外部数量表」: 外壁面積・屋根面積・軒天・基礎外周・軒先・バルコニーなど、見積の拾いと同じ計算（estimate/areas.ts の takeoff）。
 * 設計士が立面図を見ながら見積の数量を確かめられるように、図面に数字を残す（御社の要望: 壁の面積と屋根の面積を図面のどこかに）。
 */
import type { BuildingModel } from '../core/types';
import { takeoff, type TakeoffOptions } from '../estimate/areas';
import { svgTable } from './sheet';

export function exteriorQuantityTableSvg(model: BuildingModel, opts: TakeoffOptions, x: number, y: number): { svg: string; w: number; h: number } {
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
  return svgTable(x, y, '外部数量（見積の拾い）', [{ label: '項目', w: 3600 }, { label: '数量', w: 2600, align: 'right' }, { label: '備考', w: 3000 }], rows, { fontSize: 240, rowH: 420 });
}
