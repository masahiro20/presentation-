/**
 * 外部ツールで仕上げた写真の取り込み
 *
 * 流れ: カット集（ZIP）を保存 → 好きな画像生成ツール（ChatGPT・Gemini・Midjourney・Krea など）で写真に仕上げる
 *       → 仕上がった画像をここで取り込む → どのカットの仕上げかを確かめて、ギャラリー（＝プレゼン資料）へ入れる。
 * 同じカットの下書き・写真品質の画像より、取り込んだ仕上げ写真が資料で優先される（presentStep の pick）。
 *
 * カットとの対応は、①ファイル名に残したカットの目印（__c-xxxx）、②カット集の通し番号（01_…）と前回のカット集の控え、
 * ③ファイル名にカットの題名が含まれるか、の順に推し量り、最後は一覧で人が選び直せる。
 */
import type { StepCtx } from './app';
import { state, emit, uid, type GalleryItem } from './state';
import { h, modal, toast } from './dom';
import type { Shot } from '../scene/shots';

const MANIFEST_KEY = 'madori.cutManifest';

/** カット集のファイル名に入れるカットの目印（外部ツールがファイル名を残せば、取り込みで確実に対応が取れる） */
export function cutToken(shot: Shot): string {
  // 英数とハイフンだけ（ファイル名で壊れない）。長い id は短い要約にする
  let hsh = 0;
  for (const c of shot.id) hsh = (hsh * 31 + c.charCodeAt(0)) >>> 0;
  return `c-${hsh.toString(36)}`;
}

/** カット集を保存したときの控え（通し番号 → カット）。ファイル名が付け替えられても番号で戻せるように */
export function saveCutManifest(entries: { no: number; shot: Shot }[]) {
  try {
    const all = JSON.parse(localStorage.getItem(MANIFEST_KEY) || '{}') as Record<string, { no: number; id: string; token: string; title: string }[]>;
    all[state.name || '_'] = entries.map((e) => ({ no: e.no, id: e.shot.id, token: cutToken(e.shot), title: e.shot.title }));
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(all));
  } catch {
    /* 保存できない環境では番号の対応は使わない */
  }
}

function loadManifest(): { no: number; id: string; token: string; title: string }[] {
  try {
    const all = JSON.parse(localStorage.getItem(MANIFEST_KEY) || '{}');
    return all[state.name || '_'] ?? [];
  } catch {
    return [];
  }
}

const norm = (s: string) => s.normalize('NFKC').replace(/[\s_\-（）()・:：]/g, '').toLowerCase();

/** ファイル名からカットを推し量る */
export function guessShot(fileName: string, shots: Shot[], manifest = loadManifest()): Shot | null {
  const base = fileName.replace(/\.[a-z0-9]+$/i, '');
  // ① 目印
  const tok = base.match(/c-[0-9a-z]{3,8}/i)?.[0]?.toLowerCase();
  if (tok) {
    const s = shots.find((x) => cutToken(x) === tok);
    if (s) return s;
  }
  // ③ 題名（長い題名から先に照合: 「内観 LDK」より「内観 LDKから中庭」を優先）
  const nb = norm(base.replace(/パース/g, ''));
  const byTitle = [...shots].sort((a, b) => b.title.length - a.title.length).find((s) => {
    const t = norm(s.title.replace(/パース/g, ''));
    return t.length >= 2 && nb.includes(t);
  });
  if (byTitle) return byTitle;
  // ② 通し番号
  const no = base.match(/^(\d{1,3})(?:[_\-\s]|$)/)?.[1];
  if (no) {
    const m = manifest.find((e) => e.no === Number(no));
    if (m) return shots.find((s) => s.id === m.id) ?? null;
  }
  return null;
}

/** 画像を読み込み、長辺 2400px までに縮めた JPEG の data URL にする（資料・保存の重さを抑える） */
async function readImage(file: File, maxSide = 2400): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.92);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const kindOf = (s: Shot): GalleryItem['kind'] => (s.kind === 'section' || s.kind === 'cutaway' ? 'other' : s.kind);

/** 仕上げた画像をギャラリーに入れる（同じカットの以前の仕上げは置き換える） */
export function addFinished(url: string, shot: Shot | null, fileName: string): GalleryItem {
  const item: GalleryItem = shot
    ? { id: uid('img'), title: `${shot.title}（写真仕上げ）`, caption: shot.caption, url, kind: kindOf(shot), quality: 'photoreal', shotId: `${shot.id}-ai` }
    : { id: uid('img'), title: fileName.replace(/\.[a-z0-9]+$/i, ''), caption: '', url, kind: 'other', quality: 'photoreal' };
  const idx = item.shotId ? state.gallery.findIndex((g) => g.shotId === item.shotId) : -1;
  if (idx >= 0) state.gallery.splice(idx, 1, item);
  else state.gallery.push(item);
  return item;
}

/** ファイルを選んで取り込む（対応を一覧で確かめてから入れる） */
export async function importFinishedImages(ctx: StepCtx, shots: Shot[]) {
  void ctx;
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true }) as HTMLInputElement;
  const files = await new Promise<File[]>((resolve) => {
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
  if (!files.length) return;
  const manifest = loadManifest();
  const rows: { file: File; url: string; sel: HTMLSelectElement }[] = [];
  for (const f of files) {
    let url: string;
    try {
      url = await readImage(f);
    } catch {
      toast(`${f.name} を読み込めませんでした`, 'error');
      continue;
    }
    const guess = guessShot(f.name, shots, manifest);
    const sel = h(
      'select',
      { style: 'width:100%' },
      h('option', { value: '' }, '（カットに結び付けない: その他の画像として追加）'),
      ...shots.map((s) => h('option', { value: s.id, selected: guess?.id === s.id }, s.title)),
    ) as HTMLSelectElement;
    rows.push({ file: f, url, sel });
  }
  if (!rows.length) return;
  const list = h(
    'div',
    { style: 'display:grid;gap:10px;max-height:62vh;overflow:auto' },
    ...rows.map((r) =>
      h(
        'div',
        { style: 'display:grid;grid-template-columns:160px 1fr;gap:10px;align-items:center' },
        h('img', { src: r.url, style: 'width:160px;aspect-ratio:16/9;object-fit:cover;border-radius:2px' }),
        h('div', null, h('div', { class: 'hint', style: 'margin:0 0 4px;word-break:break-all' }, r.file.name), r.sel),
      ),
    ),
  );
  modal(
    `仕上げた写真を取り込む（${rows.length}枚）`,
    h('div', null, h('p', { class: 'hint', style: 'margin-top:0' }, 'どのカットの仕上げかを確かめてください（ファイル名から推し量っています）。取り込むと、同じカットの下書きより優先してプレゼン資料に使われます。'), list),
    [
      { label: 'やめる' },
      {
        label: '取り込む',
        primary: true,
        onClick: () => {
          for (const r of rows) addFinished(r.url, shots.find((s) => s.id === r.sel.value) ?? null, r.file.name);
          emit('gallery');
          toast(`${rows.length}枚の仕上げ写真をギャラリー（プレゼン資料）に入れました`, 'ok', 6000);
        },
      },
    ],
    true,
  );
}
