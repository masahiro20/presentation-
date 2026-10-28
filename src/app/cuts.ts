/**
 * AI 仕上げ用の「カット集」
 *
 * 写真品質レンダリングの代わりに、見どころカメラの構図を高品質描画（実写の空・柔らかい影・2 倍描画）で
 * 高解像度に一括保存し、画像生成 AI に渡すための説明文（部屋・素材・光）を付けて ZIP にまとめる。
 * 構図・間取り・家具の位置はこの画像のとおりに、質感だけを写真らしく仕上げてもらう使い方を想定。
 */
import { renderPass, segmentLegend, type PassKind } from '../scene/passes';
import type { StepCtx } from './app';
import { state } from './state';
import { progressModal, toast, download } from './dom';
import type { Shot } from '../scene/shots';
import { renderStudio } from '../scene/studio';
import { exteriorById, interiorById, type TimeOfDay } from '../styles/presets';
import { selectedProduct, type Product } from '../coordinate/catalog';
import { categoryById } from '../coordinate/decisions';
import { boardEntries, renderMaterialBoard } from './materialBoard';
import { librarySample } from '../coordinate/samples';
import { listRefs, REF_KIND_LABEL, type StyleRef, type RefKind } from './styleRefs';
import { exposureFor } from './draftCapture';
import { resolveSpec } from '../styles/spec';
import { cutToken, saveCutManifest } from './finishImport';

// ---- ZIP（無圧縮） ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
export function makeZip(entries: { name: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const now = dosTime(new Date());
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(now.time), ...u16(now.date),
      ...u32(crc), ...u32(e.data.length), ...u32(e.data.length), ...u16(name.length), ...u16(0), ...name,
    ]);
    parts.push(local, e.data);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(now.time), ...u16(now.date),
        ...u32(crc), ...u32(e.data.length), ...u32(e.data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(0), ...u32(offset), ...name,
      ]),
    );
    offset += local.length + e.data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  return new Blob([...parts, ...central, end].map((u) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer), { type: 'application/zip' });
}

function dataUrlToBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- 説明文 ----
// 画像生成 AI に渡す素材の言葉は、3D の色コード（#8f8e8a）ではなく、コーディネートで選んだ実在の商品（メーカー・商品名・色）で書く。
// 英語は商品名だけでは伝わらないので、商品ごとの「見た目の言葉」（LOOK）を添える
const LOOK_EN: [RegExp, string][] = [
  [/^ext\.jp\./, 'Jolypat fine-textured mineral plaster render, matte, hand-troweled "Meteor" finish'],
  [/^ext\.sto\./, 'Sto fine-grained mineral plaster render, matte, hand-troweled "Meteor" finish'],
  [/^ext\.soton/, 'Shirasu volcanic plaster (Soton-kabe), scratched "kakiotoshi" finish, warm off-white'],
  [/^ext\.gl\./, 'vertical standing-rib galvalume steel siding (K-span), narrow ribs'],
  [/^acc\.solido\./, 'SOLIDO fiber-cement lap siding, horizontal boards with a mottled, cement-like, slightly uneven surface'],
  [/^acc\.wood|^soffit\.cedar|^aw\.sugi|^ceil\.sugi/, 'Japanese cedar (sugi) boards, natural clear finish with visible grain'],
  [/^roof\.gl\./, 'standing-seam galvalume metal roof, thin edge, almost no eaves'],
  [/^soffit\./, 'flat painted calcium-silicate soffit board'],
  [/^sash\./, 'slim aluminium-resin composite window frames, flush glazing'],
  [/^door\.venato\./, 'flush insulated steel entrance door with a long vertical pull handle'],
  [/^door\.concord/, 'sliding entrance door with vertical slats'],
  [/^ent\.denver|^floor\.denver/, 'large-format (600×600) matte porcelain tile with a soft stone pattern'],
  [/^ent\.|^floor\.hirata|^floor\.tile/, 'large-format matte porcelain tile, thin grout lines'],
  [/^floor\.(channel|iemon|prairie|ioc)/, 'wide-plank oak flooring with natural grain, matte oil finish'],
  [/^floor\.sangetsu/, 'matte vinyl floor tile with a mortar / concrete look'],
  [/^floor\.mortex|^aw\.mortex/, 'Mortex micro-cement (seamless, trowel marks, soft cloudy grey)'],
  [/^wall\.cloth|^ceil\.cloth|^ceil\.dark|^aw\.cloth/, 'smooth matte wallpaper, very fine texture'],
  [/^wall\.porters|^aw\.porters/, 'Porter\'s Paints matte mineral paint with subtle brush movement'],
  [/^aw\.solido/, 'SOLIDO fiber-cement panels used on an interior wall, mottled cement surface'],
  [/^door\.kamiya\.glass/, 'full-height frameless glass door with a slim black frame'],
  [/^door\.kamiya|^door\.lixil|^door\.panasonic/, 'full-height flush interior door without casing, same color as the wall'],
  [/^door\.custom/, 'custom oak veneer door, flush, no casing'],
  [/^bb\./, 'very thin baseboard, almost invisible'],
  [/^stair\.steel/, 'open-riser steel stair: black steel stringer and flat-bar balusters, thick oak treads'],
  [/^stair\.wood/, 'open-riser wooden stair with oak treads and a slim black handrail'],
  [/^kit\.|^kitchen/, 'minimal flat-front kitchen with a thin counter, no visible handles, integrated hood'],
  [/^cup\./, 'matching flat-front back cabinets with floating wall units'],
  [/^pend\.ph5/, 'Louis Poulsen PH5 pendant above the dining table'],
  [/^pend\.dome/, 'black dome pendant above the dining table'],
  [/^pend\.globes/, 'cluster of small frosted glass globe pendants above the dining table'],
  [/^wet\./, 'matte porcelain / vinyl tile floor'],
  [/^wash\./, 'small matte tiles behind the washbasin with a plain mirror'],
  [/^van\./, 'minimal counter-top washbasin with an under-counter cabinet'],
  [/^bath\./, 'Japanese unit bath with dark matte walls'],
];
function lookEn(p: Product): string {
  const hit = LOOK_EN.find(([re]) => re.test(p.id));
  return hit ? hit[1] : p.name;
}
/** 部位 1 つの言葉: ja = 「外壁: Sto 塗り壁材 Sto ミーティア仕上げ グレー」、en = 商品名 + 見た目 */
function partWords(catId: string): { ja: string; en: string } | null {
  const cat = categoryById(catId);
  if (!cat) return null;
  const p = selectedProduct(cat, state.design);
  if (/\.none$/.test(p.id)) return null;
  const maker = p.maker && p.maker !== '—' ? `${p.maker} ` : '';
  const ja = `${maker}${p.name}${p.color ? `（${p.color}）` : ''}`;
  const en = `${maker}${p.name}${p.color ? ` [${p.color}]` : ''} — ${lookEn(p)}`;
  return { ja, en };
}
const list = (ids: [string, string, string][], lang: 'ja' | 'en') =>
  ids
    .map(([id, ja, en]) => {
      const w = partWords(id);
      return w ? `${lang === 'ja' ? ja : en}: ${w[lang]}` : '';
    })
    .filter(Boolean)
    .join(lang === 'ja' ? '。' : '; ');
const TOD_JA: Record<TimeOfDay, string> = { morning: '朝（低い横からの光・薄い靄）', day: '昼（自然光）', evening: '夕方（マジックアワー）', night: '夜（室内照明）' };
const TOD_EN: Record<TimeOfDay, string> = { morning: 'early morning, low raking sunlight, light mist', day: 'daytime natural light with soft shadows', evening: 'golden hour, warm low sun', night: 'blue hour, warm interior lighting glowing through the windows' };

const EXT_PARTS: [string, string, string][] = [
  ['extWall', '外壁', 'Exterior wall'],
  ['accent', 'アクセント外壁', 'Accent wall'],
  ['roof', '屋根', 'Roof'],
  ['soffit', '軒天', 'Soffit'],
  ['sash', 'サッシ', 'Windows'],
  ['entDoor', '玄関ドア', 'Entrance door'],
  ['entFloor', 'ポーチ・玄関土間', 'Porch / entrance floor'],
];
const INT_PARTS: [string, string, string][] = [
  ['floor', '床', 'Floor'],
  ['wall', '壁', 'Walls'],
  ['accentWall', 'アクセント壁', 'Accent wall'],
  ['ceiling', '天井', 'Ceiling'],
  ['door', '建具', 'Interior doors'],
  ['baseboard', '巾木', 'Baseboard'],
  ['stair', '階段', 'Stair'],
  ['kitchen', 'キッチン', 'Kitchen'],
  ['cupboard', 'カップボード', 'Back cabinets'],
  ['pendant', 'ダイニングの照明', 'Dining pendant'],
];
const WET_PARTS: [string, string, string][] = [
  ['wetFloor', '床', 'Floor'],
  ['washWall', '洗面の壁', 'Wall behind the basin'],
  ['vanity', '洗面台', 'Vanity'],
  ['bath', '浴室', 'Bathroom'],
];

/** 説明文に「お手本と同じ写りで」を入れるための、同梱したお手本（exportCuts が設定） */
let refsForPrompt: StyleRef[] | null = null;

export function cutPrompt(shot: Shot, index: number): { ja: string; en: string } {
  const ext = exteriorById(state.design.exteriorId);
  const int = interiorById(state.design.interiorId);
  const spec = resolveSpec(state.design.specId, state.design.specPatch);
  const tod = shot.timeOfDay ?? state.design.timeOfDay;
  const model = state.model;
  const room = shot.roomId && model ? model.floors.flatMap((f) => f.rooms).find((r) => r.id === shot.roomId) : undefined;
  const floors = model?.floors.length ?? 2;
  const clayJa = state.design.clay ? '下絵は白い模型（クレイ）なので、材質は次の指定どおりに着彩してください。' : '';
  const clayEn = state.design.clay ? ' The base image is a white clay model; apply the materials specified below.' : '';
  const refKind: RefKind = shot.kind === 'interior' ? 'interior' : 'exterior';
  const hasRef = (refsForPrompt ?? []).some((r) => r.kind === refKind);
  const common = {
    ja:
      '住宅の建築パース（下絵）です。' +
      clayJa +
      '構図・カメラ位置・画角・間取り・壁と窓とドアの位置と数・屋根の形・家具の配置と大きさは、この画像のとおりに変えずに、質感と光だけを写真のようにリアルに仕上げてください。窓やドアを増やさない・減らさない。人物・文字・余計な小物・看板は加えないでください。同梱の「素材ボード」の写真と同じ色・質感にしてください。' +
      (hasRef ? `同梱の「お手本（${REF_KIND_LABEL[refKind]}）」の写真と同じ写り（色味・光の柔らかさ・コントラスト・植栽や空の雰囲気）に仕上げてください。お手本の建物や間取りは真似しないでください。` : ''),
    en:
      'This is an architectural visualization base image of a Japanese detached house.' +
      clayEn +
      ' Keep the composition, camera position, field of view, floor plan, the position and number of walls, windows and doors, the roof shape and the furniture layout exactly as in the image; only upgrade materials and lighting to photorealistic quality. Do not add or remove windows or doors. No people, no text, no signage, no extra props. Match the colors and textures of the attached material board photo.' +
      (hasRef ? ' Match the photographic look of the attached reference photo (color grading, softness of light, contrast, mood of planting and sky) — but do not copy its building or layout.' : ''),
  };
  if (shot.kind === 'interior') {
    const name = room ? `${room.name}（${(room.labeledTatami ?? room.area / 1.62).toFixed(1)}帖）` : shot.title;
    const wet = !!room && ['washroom', 'bath', 'toilet'].includes(room.type);
    // その部屋にある物だけを書く（寝室の説明にキッチンや階段が混ざっていた）
    const ldk = !room || ['ldk', 'living', 'dining', 'kitchen'].includes(room.type) || /LDK|ＬＤＫ|キッチン|リビング/.test(shot.title);
    const stairy = /階段|ホール|吹抜/.test(shot.title) || (!!room && room.type === 'hall');
    const base = INT_PARTS.filter(([id]) => !['stair', 'kitchen', 'cupboard', 'pendant'].includes(id));
    const parts: [string, string, string][] = wet ? WET_PARTS : ldk ? INT_PARTS : stairy ? [...base, INT_PARTS.find(([id]) => id === 'stair')!] : room?.type === 'entrance' ? [['entFloor', '玄関土間', 'Entrance floor'], ...base] : base;
    const ja = `${common.ja}\n内観: ${name}。${list(parts, 'ja')}。建具は${spec.doors.fullHeight ? '天井までのフルハイト・枠無し' : '標準の枠付き'}、窓は${spec.windows.interiorReveal === 'plaster' ? '塗り回しのステルス枠' : '標準の枠'}。テイスト「${int.name}」: ${int.catch}。時間帯は${TOD_JA[tod]}。写真のような柔らかい自然光、レンズ 20〜24mm 相当の広角、建築写真の垂直線は垂直のまま、窓の外は明るく白飛びさせず緑と空を薄く見せる。`;
    const en = `${common.en}\nInterior: ${room?.name ?? shot.title}. ${list(parts, 'en')}. Doors are ${spec.doors.fullHeight ? 'full-height and frameless' : 'standard with casing'}; window reveals are ${spec.windows.interiorReveal === 'plaster' ? 'plastered (no visible frame)' : 'standard'}. Style: ${int.name}. Lighting: ${TOD_EN[tod]}. Photorealistic architectural interior photography, 20–24 mm lens, vertical lines kept vertical, soft natural light with gentle contact shadows, exterior through the windows slightly bright with greenery and sky, not blown out.`;
    return { ja, en };
  }
  if (shot.kind === 'cutaway') {
    const ja = `${common.ja}\n輪切り模型（${shot.level ?? ''}階）: 壁を床から約 1.35m の高さで水平に切り、斜め上から見下ろした建築模型のカット。切り口は白いまま、壁の厚みも残してください。${list(INT_PARTS.slice(0, 5), 'ja')}。家具・キッチン・階段の配置と大きさはそのまま。時間帯は${TOD_JA[tod]}。柔らかい自然光で、建築模型を撮った写真のように仕上げてください。`;
    const en = `${common.en}\nDollhouse section (floor ${shot.level ?? ''}): walls cut horizontally about 1.35 m above the floor, seen from above at an oblique angle, like an architectural model. Keep the white cut faces and wall thickness. ${list(INT_PARTS.slice(0, 5), 'en')}; furniture, kitchen and stairs exactly as placed. Lighting: ${TOD_EN[tod]}. Soft natural light, photorealistic architectural model photography.`;
    return { ja, en };
  }
  if (shot.kind === 'section') {
    const ja = `${common.ja}\n断面パース: 建物を鉛直の面で切り、切り口（白い断面）側から少し見上げ気味に見た建築断面のカット。切り口は白いまま、壁・床・屋根の厚みを残してください。${list([...INT_PARTS.slice(0, 4), EXT_PARTS[0], EXT_PARTS[2]], 'ja')}。家具・階段の配置はそのまま。時間帯は${TOD_JA[tod]}。柔らかい自然光で、建築雑誌の断面パースのように仕上げてください。`;
    const en = `${common.en}\nSection perspective: the building is cut by a vertical plane and seen from the cut side, slightly from above. Keep the white cut faces and the thickness of walls, floors and roof. ${list([...INT_PARTS.slice(0, 4), EXT_PARTS[0], EXT_PARTS[2]], 'en')}; furniture and stairs exactly as placed. Lighting: ${TOD_EN[tod]}. Soft natural light, like a section perspective in an architecture magazine.`;
    return { ja, en };
  }
  const roofJa = ext.roof.type === 'shed' ? '片流れ' : ext.roof.type === 'gable' ? '切妻' : ext.roof.type === 'hip' ? '寄棟' : '陸屋根';
  const roofEn = ext.roof.type === 'shed' ? 'mono-pitch (shed)' : ext.roof.type === 'gable' ? 'gable' : ext.roof.type === 'hip' ? 'hip' : 'flat';
  const ja = `${common.ja}\n外観${shot.kind === 'aerial' ? '（鳥瞰）' : ''}: ${floors}階建ての木造住宅、屋根は${roofJa}で軒の出 ${ext.roof.eaves}mm。${list(EXT_PARTS, 'ja')}。テイスト「${ext.name}」: ${ext.catch}。時間帯は${TOD_JA[tod]}。建築写真のように、周囲は落ち着いた日本の住宅地（隣家は低く控えめに）、道路はアスファルト、空は自然に、植栽は株立ちの落葉樹と下草を少し。`;
  const en = `${common.en}\nExterior${shot.kind === 'aerial' ? ' (aerial view)' : ''}: ${floors}-story timber house with a ${roofEn} roof and ${ext.roof.eaves} mm eaves. ${list(EXT_PARTS, 'en')}. Style: ${ext.name}. Lighting: ${TOD_EN[tod]}. Photorealistic architectural exterior photography, quiet Japanese residential neighborhood with low, unobtrusive neighboring houses, asphalt road, natural sky, a multi-stem deciduous tree and low ground-cover planting.`;
  void index;
  return { ja, en };
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();

/** 見どころカメラを高品質描画で一括保存して ZIP にする */
export async function exportCuts(ctx: StepCtx, shotsIn: Shot[], opts: { width: number; height: number; passes?: boolean }) {
  const v = ctx.app.viewer;
  // 輪切り模型・断面パースは外部で仕上げても資料に使わない（お客様向けの資料から外した）ので、まとめて出すときは入れない。
  // 「この構図だけ」のように 1 枚を指定したときはそのまま
  const shots = shotsIn.length > 1 ? shotsIn.filter((s) => s.kind !== 'cutaway' && s.kind !== 'section') : shotsIn;
  if (!shots.length) {
    toast('カットがありません');
    return;
  }
  const pm = progressModal(`カット集（Nano Banana Pro 用の下絵）を作成中（${shots.length}枚・${opts.width}×${opts.height}）`);
  const prev = v.currentView();
  // AI 仕上げの下絵に文字を焼き込まない（部屋名の札は消す）。想像の家並みの白い箱も写さない（空に大きな塊が写り、AI が建物と誤解する）
  const prevLabels = v.roomLabelsShown();
  v.setRoomLabels(false);
  v.setTownVisible(false);
  const entries: { name: string; data: Uint8Array }[] = [];
  const lines: string[] = [];
  lines.push(
    `${state.name}　カット集（Nano Banana Pro で仕上げる下絵）`,
    `作成: ${new Date().toLocaleString('ja-JP')}`,
    '',
    '使い方: 各画像を Nano Banana Pro に渡し、「00_素材ボード.jpg」（あれば「00_お手本_…」も）を一緒に参考画像として添えて、下の説明文をプロンプトとして貼り付けてください。構図と間取りはそのまま、質感と光だけを写真に仕上げる指示になっています。最初に仕上げた 1 枚（LDK・外観）を次のカットから参考画像に加えると、素材と色が全カットでそろいます。仕上がった画像は、パース →「仕上げ（外部）」→「仕上げた写真を取り込む」で資料に入ります（ファイル名の末尾の __c-… を残して保存すると、どのカットか自動で分かります）。',
    '',
  );
  let n = 0;
  const manifest: { no: number; shot: Shot }[] = [];
  try {
    // 素材ボード（コーディネートで選んだ商品の見本。実物写真があれば写真庫から）
    try {
      pm.set(0, '素材ボード');
      const samples: Record<string, string> = { ...(state.coord.samples ?? {}) };
      const entriesB = boardEntries(samples);
      for (const e of entriesB) if (!samples[e.product.id]) {
        const s = await librarySample(e.product.id).catch(() => undefined);
        if (s) samples[e.product.id] = s.url;
      }
      const board = await renderMaterialBoard(boardEntries(samples));
      entries.push({ name: '00_素材ボード.jpg', data: dataUrlToBytes(board) });
      lines.push('■ 00_素材ボード.jpg', '（コーディネートで選んだ仕上げの見本。すべてのカットで参考画像として一緒に渡してください。「実物」の印は実物の写真、それ以外は 3D と同じ質感のイメージです）', '');
    } catch (e) {
      console.warn('素材ボードを作れませんでした', e);
    }
    // お手本の写真（御社の仕上げパース）: 外観・内観それぞれ最大 3 枚
    try {
      const refs = await listRefs();
      const picked: StyleRef[] = [];
      for (const kind of ['exterior', 'interior'] as RefKind[]) picked.push(...refs.filter((r) => r.kind === kind).slice(-3));
      refsForPrompt = picked;
      const no: Record<RefKind, number> = { exterior: 0, interior: 0 };
      for (const r of picked) {
        no[r.kind]++;
        entries.push({ name: `00_お手本_${REF_KIND_LABEL[r.kind]}_${no[r.kind]}.jpg`, data: dataUrlToBytes(r.url) });
      }
      if (picked.length) lines.push(`■ 00_お手本_…jpg（${picked.length} 枚）`, '（御社の仕上げパース。外観のカットには「お手本_外観」、内観には「お手本_内観」を参考画像として一緒に渡すと、写り（色味・光・植栽）がそろいます。建物そのものは真似させない指示が説明文に入っています）', '');
    } catch (e) {
      refsForPrompt = null;
      console.warn('お手本の写真を読めませんでした', e);
    }
    for (let i = 0; i < shots.length; i++) {
      if (pm.signal.aborted) break;
      const shot = shots[i];
      pm.set(i / shots.length, shot.title);
      v.applyShot(shot);
      await new Promise((r) => setTimeout(r, 40));
      try {
        const tod = shot.timeOfDay ?? v.design.timeOfDay;
        const url = await renderStudio(v, { width: opts.width, height: opts.height, interior: shot.kind === 'interior', exposure: exposureFor(shot.kind, tod) });
        // 末尾の目印（__c-xxxx）は、仕上げた写真を取り込むときにどのカットかを見分けるため（ファイル名を残して保存すると確実）
        const base = `${String(i + 1).padStart(2, '0')}_${safe(shot.title)}__${cutToken(shot)}`;
        manifest.push({ no: i + 1, shot });
        const name = `${base}.jpg`;
        entries.push({ name, data: dataUrlToBytes(url) });
        if (opts.passes) {
          // 同じ構図の条件画像（深度・法線・線画・素材ID）。AI に形を固定して渡す
          for (const k of ['depth', 'normal', 'lines', 'segment'] as PassKind[]) entries.push({ name: `パス/${base}_${k}.png`, data: dataUrlToBytes(renderPass(v, k, opts.width, opts.height)) });
        }
        const p = cutPrompt(shot, i);
        lines.push(`■ ${name}`, shot.caption ? `（${shot.caption}）` : '', '【日本語】', p.ja, '', '【English】', p.en, '');
        n++;
      } catch (e) {
        lines.push(`■ ${shot.title}: 描画に失敗（${(e as Error).message}）`, '');
      }
    }
    if (!n) {
      toast('カットを描画できませんでした', 'error');
      return;
    }
    if (opts.passes) entries.push({ name: 'パス/素材IDの色凡例.txt', data: new TextEncoder().encode(`素材ID画像の塗り分け（色コード → 意味）\n\n${segmentLegend()}\n\n使い方: depth=ControlNet の Depth、normal=Normal、lines=Lineart／Canny の代わり、segment=領域ごとの素材指定（Segmentation）。同じファイル名の .jpg（白模型または仕上げ済みの下絵）と組で使います。`) });
    entries.push({ name: 'カット一覧と説明文.txt', data: new TextEncoder().encode(lines.join('\n')) });
    saveCutManifest(manifest);
    const zip = makeZip(entries);
    const url = URL.createObjectURL(zip);
    download(url, `${safe(state.name)}_カット集.zip`);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`カット集を保存しました（${n}枚・${(zip.size / 1024 / 1024).toFixed(1)} MB）`, 'ok', 6000);
  } finally {
    refsForPrompt = null;
    pm.close();
    v.setRoomLabels(prevLabels);
    v.setTownVisible(true);
    v.applyView(prev);
  }
}
