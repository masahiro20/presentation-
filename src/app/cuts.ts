/**
 * AI 仕上げ用の「カット集」
 *
 * 写真品質レンダリングの代わりに、見どころカメラの構図を高品質描画（実写の空・柔らかい影・2 倍描画）で
 * 高解像度に一括保存し、画像生成 AI に渡すための説明文（部屋・素材・光）を付けて ZIP にまとめる。
 * 構図・間取り・家具の位置はこの画像のとおりに、質感だけを写真らしく仕上げてもらう使い方を想定。
 */
import type { StepCtx } from './app';
import { state } from './state';
import { progressModal, toast, download } from './dom';
import type { Shot } from '../scene/shots';
import { renderStudio } from '../scene/studio';
import { exteriorById, interiorById, type TimeOfDay } from '../styles/presets';
import type { MatSpec } from '../styles/textures';
import { resolveSpec } from '../styles/spec';

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
const PATTERN_JA: Record<string, string> = {
  plaster: '塗り壁（左官）', stucco: '塗り壁', paint: '塗装', galvalume: 'ガルバリウム鋼板の縦張り', standingSeam: 'ガルバリウム鋼板（立平葺き）', woodSiding: '木の板張り', lapSiding: '板張り', siding: 'サイディング',
  concrete: 'コンクリート', stone: '石', brick: 'レンガ', tileFloor: 'タイル', marble: '大理石', wood: '木', woodFloor: '無垢のフローリング', herringbone: 'ヘリンボーンの床', tatami: '畳', gravel: '砂利', grass: '芝生', paving: '舗装', roofTile: '瓦', slate: 'スレート', fabric: 'ファブリック', leather: 'レザー',
};
const PATTERN_EN: Record<string, string> = {
  plaster: 'hand-troweled plaster', stucco: 'stucco', paint: 'painted', galvalume: 'vertical galvalume steel siding', standingSeam: 'standing-seam galvalume metal roof', woodSiding: 'wood siding', lapSiding: 'lap siding', siding: 'siding',
  concrete: 'concrete', stone: 'stone', brick: 'brick', tileFloor: 'large-format tile', marble: 'marble', wood: 'wood', woodFloor: 'solid oak flooring', herringbone: 'herringbone wood floor', tatami: 'tatami', gravel: 'gravel', grass: 'lawn', paving: 'paving', roofTile: 'roof tile', slate: 'slate', fabric: 'linen fabric', leather: 'leather',
};
const mat = (m: MatSpec | undefined, lang: 'ja' | 'en') => (m ? `${(lang === 'ja' ? PATTERN_JA : PATTERN_EN)[m.pattern] ?? m.pattern} ${m.color}` : '');
const TOD_JA: Record<TimeOfDay, string> = { day: '昼（自然光）', evening: '夕方（マジックアワー）', night: '夜（室内照明）' };
const TOD_EN: Record<TimeOfDay, string> = { day: 'daytime natural light', evening: 'golden hour', night: 'night, warm interior lighting' };

export function cutPrompt(shot: Shot, index: number): { ja: string; en: string } {
  const ext = exteriorById(state.design.exteriorId);
  const int = interiorById(state.design.interiorId);
  const spec = resolveSpec(state.design.specId, state.design.specPatch);
  const tod = shot.timeOfDay ?? state.design.timeOfDay;
  const room = shot.roomId && state.model ? state.model.floors.flatMap((f) => f.rooms).find((r) => r.id === shot.roomId) : undefined;
  const common = {
    ja: '住宅の建築パース（下絵）です。構図・カメラ位置・間取り・壁と窓とドアの位置・家具の配置と大きさは、この画像のとおりに変えずに、質感と光だけを写真のようにリアルに仕上げてください。人物・文字・余計な小物は加えないでください。',
    en: 'This is an architectural visualization base image of a house. Keep the composition, camera, floor plan, wall/window/door positions and the furniture layout exactly as in the image; only upgrade materials and lighting to photorealistic quality. No people, no text, no extra props.',
  };
  if (shot.kind === 'interior') {
    const name = room ? `${room.name}（${(room.labeledTatami ?? room.area / 1.62).toFixed(1)}帖）` : shot.title;
    const ja = `${common.ja}\n内観: ${name}。床は${mat(int.floor, 'ja')}、壁は${mat(int.wall, 'ja')}、天井は${mat(int.ceiling, 'ja')}、建具は${mat(int.door, 'ja')}（${spec.doors.fullHeight ? 'フルハイトの枠無し' : '標準の枠付き'}）。窓は${spec.windows.interiorReveal === 'plaster' ? '塗り回しのステルス枠' : '標準の枠'}で、サッシ色は${ext.frame.color}。テイスト「${int.name}」: ${int.catch}。時間帯は${TOD_JA[tod]}。写真のような柔らかい自然光とレンズ 24mm 相当の広角、建築写真の水平な垂直線。`;
    const en = `${common.en}\nInterior: ${room?.name ?? shot.title}. Floor: ${mat(int.floor, 'en')}; walls: ${mat(int.wall, 'en')}; ceiling: ${mat(int.ceiling, 'en')}; doors: ${mat(int.door, 'en')} (${spec.doors.fullHeight ? 'full-height frameless' : 'standard casing'}); window frames ${ext.frame.color}. Style: ${int.name}. Lighting: ${TOD_EN[tod]}. Photorealistic architectural photography, 24mm lens, vertical lines kept vertical, soft natural light.`;
    return { ja, en };
  }
  if (shot.kind === 'cutaway') {
    const ja = `${common.ja}\n輪切り模型（${shot.level ?? ''}階）: 壁を床から約 1.35m の高さで水平に切り、斜め上から見下ろした建築模型のカット。切り口は白いまま、壁の厚みも残してください。床は${mat(int.floor, 'ja')}、壁は${mat(int.wall, 'ja')}、建具は${mat(int.door, 'ja')}。家具・キッチン・階段の配置と大きさはそのまま。外構: 地面は${mat(ext.landscape.ground, 'ja')}。時間帯は${TOD_JA[tod]}。柔らかい自然光で、建築模型を撮った写真のように仕上げてください。`;
    const en = `${common.en}\nDollhouse section (floor ${shot.level ?? ''}): walls cut horizontally about 1.35 m above the floor, seen from above at an oblique angle, like an architectural model. Keep the white cut faces and wall thickness. Floor: ${mat(int.floor, 'en')}; walls: ${mat(int.wall, 'en')}; doors: ${mat(int.door, 'en')}; furniture, kitchen and stairs exactly as placed; ground ${mat(ext.landscape.ground, 'en')}. Lighting: ${TOD_EN[tod]}. Soft natural light, photorealistic architectural model photography.`;
    return { ja, en };
  }
  const roofJa = ext.roof.type === 'shed' ? '片流れ' : ext.roof.type === 'gable' ? '切妻' : ext.roof.type === 'hip' ? '寄棟' : '陸屋根';
  const ja = `${common.ja}\n外観${shot.kind === 'aerial' ? '（鳥瞰）' : ''}: 外壁は${mat(ext.wall, 'ja')}${ext.accent ? `、アクセントに${mat(ext.accent, 'ja')}` : ''}。屋根は${roofJa}（${mat(ext.roof.material, 'ja')}）、軒の出 ${ext.roof.eaves}mm。サッシは${ext.frame.color}の細いフレーム、玄関ドアは${mat(ext.entranceDoor, 'ja')}。外構: 地面は${mat(ext.landscape.ground, 'ja')}、アプローチは${mat(ext.landscape.approach, 'ja')}。テイスト「${ext.name}」: ${ext.catch}。時間帯は${TOD_JA[tod]}。建築写真のように、周囲は落ち着いた住宅地、空は自然に。`;
  const en = `${common.en}\nExterior${shot.kind === 'aerial' ? ' (aerial)' : ''}: walls ${mat(ext.wall, 'en')}${ext.accent ? `, accent ${mat(ext.accent, 'en')}` : ''}; ${ext.roof.type} roof in ${mat(ext.roof.material, 'en')} with ${ext.roof.eaves}mm eaves; slim ${ext.frame.color} window frames; entrance door ${mat(ext.entranceDoor, 'en')}; ground ${mat(ext.landscape.ground, 'en')}, approach ${mat(ext.landscape.approach, 'en')}. Style: ${ext.name}. Lighting: ${TOD_EN[tod]}. Photorealistic architectural photography, quiet residential surroundings, natural sky.`;
  void index;
  return { ja, en };
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();

/** 見どころカメラを高品質描画で一括保存して ZIP にする */
export async function exportCuts(ctx: StepCtx, shots: Shot[], opts: { width: number; height: number }) {
  const v = ctx.app.viewer;
  if (!shots.length) {
    toast('カットがありません');
    return;
  }
  const pm = progressModal(`AI 仕上げ用のカット集を作成中（${shots.length}枚・${opts.width}×${opts.height}）`);
  const prev = v.currentView();
  // AI 仕上げの下絵に文字を焼き込まない（部屋名の札は消す）
  const prevLabels = v.roomLabelsShown();
  v.setRoomLabels(false);
  const entries: { name: string; data: Uint8Array }[] = [];
  const lines: string[] = [];
  lines.push(`${state.name}　カット集（AI 仕上げ用）`, `作成: ${new Date().toLocaleString('ja-JP')}`, '', '使い方: 各画像を画像生成 AI（写真化・リライティング）に渡し、下の説明文をプロンプトとして貼り付けてください。構図と間取りはそのまま、質感だけを仕上げる指示になっています。', '');
  let n = 0;
  try {
    for (let i = 0; i < shots.length; i++) {
      if (pm.signal.aborted) break;
      const shot = shots[i];
      pm.set(i / shots.length, shot.title);
      v.applyShot(shot);
      await new Promise((r) => setTimeout(r, 40));
      try {
        const url = await renderStudio(v, { width: opts.width, height: opts.height, interior: shot.kind === 'interior', exposure: shot.kind === 'interior' ? 1.9 : 1.0 });
        const name = `${String(i + 1).padStart(2, '0')}_${safe(shot.title)}.jpg`;
        entries.push({ name, data: dataUrlToBytes(url) });
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
    entries.push({ name: 'カット一覧と説明文.txt', data: new TextEncoder().encode(lines.join('\n')) });
    const zip = makeZip(entries);
    const url = URL.createObjectURL(zip);
    download(url, `${safe(state.name)}_カット集.zip`);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`カット集を保存しました（${n}枚・${(zip.size / 1024 / 1024).toFixed(1)} MB）`, 'ok', 6000);
  } finally {
    pm.close();
    v.setRoomLabels(prevLabels);
    v.applyView(prev);
  }
}
