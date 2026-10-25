/**
 * コーディネートの「プロの目」: 選んだ組み合わせを、ベテランのコーディネーターが打ち合わせで言うこと（色数・金物の色・木の色の喧嘩・
 * 明るさ・汚れやすさ・照明の色）で点検する。お客様に見せても分かる言葉で、良い所（安心材料）も一緒に返す。
 *
 * 判定は 3D に使う実際の色（テイスト＋選んだ商品）から行うので、カタログに無い組み合わせでも働く。
 */
import { stylesFor, FINISH_CATEGORIES, selectedProduct } from './catalog';
import type { DesignOptions } from '../styles/presets';
import type { MatSpec } from '../styles/textures';

export type AdviceLevel = 'good' | 'note' | 'warn';

export interface Advice {
  level: AdviceLevel;
  part: '外部' | '内部' | '全体';
  /** 関係する部位（カテゴリ id） */
  cats: string[];
  title: string;
  why: string;
}

interface Tone {
  /** 明るさ 0〜1（知覚に近い） */
  L: number;
  /** 色相（度）と彩度 */
  hue: number;
  sat: number;
  wood: boolean;
  metal: boolean;
}

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** CIE L*（0〜1）。見た目の明るさの差を比べるため */
export function lightness(hex: string): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const [r, g, b] = rgb(hex).map(lin);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const f = y > 216 / 24389 ? Math.cbrt(y) : (24389 / 27 * y + 16) / 116;
  return (116 * f - 16) / 100;
}

function hueSat(hex: string): { hue: number; sat: number } {
  const [r, g, b] = rgb(hex);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d < 1e-6) return { hue: 0, sat: 0 };
  let hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { hue, sat: d / (1 - Math.abs(mx + mn - 1) || 1) };
}

function tone(m: MatSpec | { color: string; metalness?: number } | undefined | null): Tone | null {
  if (!m?.color) return null;
  const pattern = 'pattern' in m ? (m.pattern ?? '') : '';
  return { L: lightness(m.color), ...hueSat(m.color), wood: /wood/i.test(pattern), metal: (m.metalness ?? 0) >= 0.3 };
}

/** 「同じ色の仲間」か（明るさが近く、有彩色なら色相も近い） */
function sameFamily(a: Tone, b: Tone): boolean {
  if (Math.abs(a.L - b.L) > 0.1) return false;
  if (a.sat < 0.12 && b.sat < 0.12) return true;
  const dh = Math.abs(a.hue - b.hue);
  return Math.min(dh, 360 - dh) < 25;
}

const isDark = (t: Tone) => t.L < 0.42;
const isLight = (t: Tone) => t.L > 0.78;

function picked(d: DesignOptions, catId: string): string {
  const cat = FINISH_CATEGORIES.find((c) => c.id === catId);
  return cat ? selectedProduct(cat, d).id : '';
}

export function harmonyCheck(d: DesignOptions): Advice[] {
  const { ext, int } = stylesFor(d);
  const out: Advice[] = [];
  const add = (a: Advice) => out.push(a);

  // ---------- 外部 ----------
  const wall = tone(ext.wall)!;
  const accent = ext.accent && ext.accentRule !== 'none' ? tone(ext.accent) : null;
  const roof = tone(ext.roof.material);
  const soffit = tone(ext.roof.soffit);
  const sash = tone(ext.frame)!;
  const door = tone(ext.entranceDoor);

  // 色数: ベース・アクセント・締め色の 3 色以内が基本
  {
    const parts = [wall, accent, roof, soffit, sash, door].filter((t): t is Tone => !!t);
    const fam: Tone[] = [];
    for (const t of parts) if (!fam.some((f) => sameFamily(f, t))) fam.push(t);
    if (fam.length >= 5) add({ level: 'warn', part: '外部', cats: ['extWall', 'accent', 'soffit', 'entDoor'], title: `外観の色が ${fam.length} 色あります`, why: '外観は「ベース・アクセント・締め色」の 3 色以内にまとめると、箱の形がきれいに見えて年月が経っても古く見えません。軒天を外壁と同色にする・玄関ドアをサッシと同じ色にすると減らせます。' });
    else if (fam.length === 4) add({ level: 'note', part: '外部', cats: ['extWall', 'accent', 'soffit', 'entDoor'], title: '外観の色は 4 色', why: 'もう 1 色減らすとさらに締まります（軒天を外壁と同色、玄関ドアをサッシと同色など）。今のままでも破綻はしていません。' });
    else add({ level: 'good', part: '外部', cats: ['extWall'], title: `外観は ${fam.length} 色でまとまっています`, why: '色数が少ないので、建物の形と素材感がそのまま伝わる外観です。' });
  }

  // サッシと外壁
  if (isLight(wall) && isDark(sash)) add({ level: 'good', part: '外部', cats: ['extWall', 'sash'], title: '明るい外壁に黒いサッシ', why: '窓の輪郭が締まり、外から見ても室内から見ても線がきれいに出ます。' });
  else if (isDark(wall) && isLight(sash)) add({ level: 'warn', part: '外部', cats: ['extWall', 'sash'], title: '濃い外壁に白いサッシ', why: '窓だけが白く浮いて見えます。濃い外壁には黒（または外壁に近い色）のサッシが落ち着きます。' });
  else if (isDark(wall) && isDark(sash)) add({ level: 'good', part: '外部', cats: ['extWall', 'sash'], title: '濃い外壁とサッシが同化', why: '窓が壁に溶け込み、塊としての存在感が出ます。' });

  // 金物の色（サッシ・屋根・玄関ドア）: 黒と銀の混在
  if (roof && roof.metal && sash.metal) {
    const roofDark = isDark(roof);
    const sashDark = isDark(sash);
    if (roofDark !== sashDark) add({ level: 'note', part: '外部', cats: ['roof', 'sash'], title: '屋根とサッシで金属の色（黒／銀）が違います', why: '金属の色は黒か銀のどちらかにそろえると統一感が出ます。片流れで屋根がほとんど見えない場合は気にしなくて大丈夫です。' });
  }

  // アクセントが効いているか
  if (accent && !accent.wood && Math.abs(accent.L - wall.L) < 0.07) add({ level: 'note', part: '外部', cats: ['accent', 'extWall'], title: 'アクセントが外壁と近い色です', why: 'アクセントは外壁と明るさをはっきり変えた方が効きます（質感だけで見せるなら、このままでも上品です）。' });

  // 木の色（アクセント・軒天・玄関ドア）
  {
    const woods = [
      { cat: 'accent', t: accent },
      { cat: 'soffit', t: soffit },
      { cat: 'entDoor', t: door },
    ].filter((x): x is { cat: string; t: Tone } => !!x.t && x.t.wood);
    if (woods.length >= 2) {
      const spread = Math.max(...woods.map((w) => w.t.L)) - Math.min(...woods.map((w) => w.t.L));
      if (spread > 0.15) add({ level: 'warn', part: '外部', cats: woods.map((w) => w.cat), title: '外まわりの木の色が 2 種類あります', why: '木の色は 1 種類にそろえるのが基本です（例: 軒天のレッドシダーに合わせて玄関ドアも明るい木目に、または玄関ドアを黒に）。' });
      else add({ level: 'good', part: '外部', cats: woods.map((w) => w.cat), title: '外まわりの木の色がそろっています', why: '軒天・アクセント・玄関ドアの木の色が近く、温かみが一体に見えます。' });
    }
  }

  // 汚れ・色あせ（塗り壁）
  if (/stucco|plaster/.test(ext.wall.pattern ?? '')) {
    if (wall.L > 0.9) add({ level: 'note', part: '外部', cats: ['extWall'], title: '真っ白に近い塗り壁', why: '雨だれ・砂ぼこりが目立ちやすい色です。オフホワイト〜ライトグレーにすると見た目はほぼ白のまま長持ちします。窓の下に水切りを付けるのも効果的です。' });
    if (wall.L < 0.3) add({ level: 'note', part: '外部', cats: ['extWall'], title: '濃い色の塗り壁', why: '夏は外壁が熱くなりやすく、塗り壁の濃い色は塗りむら・白い粉（白華）が目立つことがあります。大きなサンプルで、晴れた日の外で確認してください。' });
  }

  // ---------- 内部 ----------
  const floor = tone(int.floor)!;
  const iwall = tone(int.wall)!;
  // 3D と同じ決め方: 手で選んだ色 → 建具の商品 → 壁になじませる（既定）
  const dc = d.specPatch?.doorColor ?? (d.finishes?.door ? 'preset' : undefined);
  const idoor = tone(dc === 'preset' ? int.door : dc === 'wood' ? { pattern: 'wood', color: '#b89572' } : dc ? { pattern: 'paint', color: dc } : { pattern: 'paint', color: int.wall.color })!;
  const counter = tone(int.furniture.counter);
  const cabinet = tone(int.furniture.cabinet);

  // 床と建具の木の色
  if (floor.wood && idoor.wood) {
    if (Math.abs(floor.L - idoor.L) > 0.12) add({ level: 'warn', part: '内部', cats: ['floor', 'door'], title: '床と建具で木の色が違います', why: '木目どうしの色違いは「喧嘩」して見えやすい組み合わせです。建具は壁と同じ色（フルハイトのクロス巻き）か黒にするか、床と同じ系統の木目にそろえると落ち着きます。' });
    else add({ level: 'good', part: '内部', cats: ['floor', 'door'], title: '床と建具の木の色がそろっています', why: '木の色が近く、ナチュラルにまとまります。' });
  } else if (!idoor.wood && Math.abs(idoor.L - iwall.L) < 0.05) {
    add({ level: 'good', part: '内部', cats: ['door', 'wall'], title: '建具が壁になじんでいます', why: '扉が壁に溶け込み、天井までの扉と合わせて線の少ないすっきりした空間に見えます（御社の標準の納まり）。' });
  }

  // キッチン・カップボードの木の色と床
  if (cabinet?.wood && floor.wood && Math.abs(cabinet.L - floor.L) > 0.18) add({ level: 'note', part: '内部', cats: ['kitchen', 'cupboard', 'floor'], title: 'キッチン（収納）の木目と床の木の色の差が大きい', why: '差をはっきり付けるなら意図が伝わります（濃いキッチン＋明るい床など）。中途半端な差だと色違いに見えるので、サンプルを並べて確認してください。' });

  // 全体が暗い
  if (isDark(floor) && iwall.L < 0.8 && cabinet && isDark(cabinet)) add({ level: 'warn', part: '内部', cats: ['floor', 'wall', 'kitchen'], title: '床・壁・キッチンがどれも暗め', why: 'LDK が重く・狭く見えることがあります。壁か天井を白に近くすると、落ち着きを残したまま明るさが戻ります。' });
  else if (isDark(floor)) add({ level: 'note', part: '内部', cats: ['floor'], title: '濃い色の床', why: '落ち着きと高級感が出ます。一方で、ほこり・細かい傷が白く目立ちやすい色です。' });
  else if (isLight(iwall) && floor.L > 0.6) add({ level: 'good', part: '内部', cats: ['floor', 'wall'], title: '明るい床と白い壁', why: '光がよく回り、部屋が広く見える組み合わせです。' });

  // キッチンの天板と扉
  if (counter && cabinet && counter.metal && isDark(cabinet)) add({ level: 'good', part: '内部', cats: ['kitchen'], title: 'ステンレス天板×濃い扉', why: '天板が光を受けて、キッチンの輪郭がはっきり出ます。' });

  // 照明の色
  const k = int.lightKelvin;
  if (k >= 3500 && floor.wood && floor.L < 0.6) add({ level: 'note', part: '内部', cats: ['light', 'floor'], title: '温白色（3500K）と濃い木の床', why: '木の赤みが抑えられ、少し青白く見えることがあります。くつろぐ LDK は電球色（2700〜3000K）が木の色をきれいに見せます。' });
  else if (k <= 2700) add({ level: 'good', part: '内部', cats: ['light'], title: '電球色 2700K', why: 'ホテルのような落ち着いた夜の雰囲気。手元の作業が多いキッチン・書斎は、手元灯を足すと安心です。' });

  // 玄関・水まわりの床
  if (picked(d, 'wetFloor') === 'wet.sangetsu.cf') add({ level: 'note', part: '内部', cats: ['wetFloor'], title: '水まわりがクッションフロア', why: '水に強くお手入れが楽で、足ざわりも柔らかい床です。洗濯機・洗面台の脚のへこみ跡が付きやすいので、置き場所には板を敷くと安心です。' });

  // ---------- 全体 ----------
  if (isDark(sash) && isDark(idoor) && picked(d, 'stair') === 'stair.steel') add({ level: 'good', part: '全体', cats: ['sash', 'door', 'stair'], title: '黒い金物で統一', why: 'サッシ・建具・鉄骨階段の黒が家じゅうで繰り返され、空間の「締め色」になっています。' });

  const order: Record<AdviceLevel, number> = { warn: 0, note: 1, good: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/** 部位ごとの注意（決定ボードの行に出す） */
export function adviceFor(list: Advice[], catId: string): Advice[] {
  return list.filter((a) => a.cats.includes(catId) && a.level !== 'good');
}
