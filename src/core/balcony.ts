/**
 * バルコニーの上が空に開いているか（屋根・軒天を掛けないか）
 *
 * 屋根は「その階の外形のうち、上の階が載らない所」に掛ける。バルコニーも外形の内なので、
 * そのままではルーフバルコニー・上の階を欠いて作ったバルコニーの上にも屋根が掛かり、屋根付きの箱に見える
 * （市岡様邸 4 階のルーフバルコニー、田中様邸 2 階の三角のバルコニー）。
 */
import { OUTDOOR_TYPES, type Floor, type Room } from './types';

/**
 * 空に開いたバルコニーか。floors は下の階から順、k はその階の番号（floors の添字）。
 * - 中庭（1 階の光庭）は外形の外なので対象外。インナーバルコニーは屋根の下
 * - 名前がルーフバルコニー・屋上 → 開いている
 * - 2 階以上で、いちばん上の階でなければ開いている（上の階が載る所は屋根の升目で「上の階の下」として別に除かれる。
 *   上の階をわざわざ欠いてあるバルコニーに、下屋の屋根は掛けない）
 * - いちばん上の階: 屋内の広さの半分より広ければ屋上（塔屋の横のルーフバルコニー）。それ以外は大屋根の下のバルコニー
 */
export function isOpenSkyBalcony(floors: Floor[], k: number, r: Room): boolean {
  if (r.type !== 'balcony' || r.polygon.length < 3) return false;
  if (/庭|COURT/i.test(r.name) || /インナー/.test(r.name)) return false;
  if (/ルーフ|屋上|スカイ|ROOF/i.test(r.name)) return true;
  const f = floors[k];
  if (!f || f.level < 2) return false;
  if (k < floors.length - 1) return true;
  const indoor = f.rooms.filter((q) => !OUTDOOR_TYPES.includes(q.type) && q.type !== 'void').reduce((s, q) => s + q.area, 0);
  return r.area > indoor * 0.5;
}
