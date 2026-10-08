/**
 * プロジェクトの保存と読み込み
 *
 * - ファイル（.madori.json）に書き出し／読み込み: 図面の読み取り結果（手修正・家具・階段を含む）、テイスト、建設地、
 *   お客様情報、立面図・平面図、パースと日照の画像を 1 つのファイルにまとめる
 * - ブラウザには保存しない（作業内容は「保存」で書き出したファイルにだけ残る）
 *
 * 動画はサイズが大きいので保存しません（必要なら動画ステップから個別に保存してください）。
 */
import { state, emit, type ProjectState, type GalleryItem } from './state';
import { toast } from './dom';

export const PROJECT_FORMAT = 'madori-project-v1';

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  savedAt: string;
  app: string;
  name: string;
  customer: string;
  company: string;
  pdfName?: string;
  model: ProjectState['model'];
  design: ProjectState['design'];
  site: ProjectState['site'];
  render: ProjectState['render'];
  elevations: ProjectState['elevations'];
  sheets?: ProjectState['sheets'];
  plans: ProjectState['plans'];
  gallery: (Omit<GalleryItem, 'url'> & { url: string })[];
  sun: { seasons: ProjectState['sun']['seasons']; highlights: ProjectState['sun']['highlights']; diagramSvg?: string; images: { label: string; url: string }[] };
}

/** blob: の URL をファイルに入れられる data: URL にする（既に data: ならそのまま） */
async function toDataUrl(url: string): Promise<string> {
  if (!url.startsWith('blob:')) return url;
  try {
    const blob = await (await fetch(url)).blob();
    return await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  } catch {
    return '';
  }
}

export async function serializeProject(): Promise<ProjectFile> {
  const gallery = [];
  for (const g of state.gallery) {
    const url = await toDataUrl(g.url);
    if (url) gallery.push({ ...g, url });
  }
  const images = [];
  for (const im of state.sun.images) {
    const url = await toDataUrl(im.url);
    if (url) images.push({ label: im.label, url });
  }
  return {
    format: PROJECT_FORMAT,
    savedAt: new Date().toISOString(),
    app: '間取りプレゼン',
    name: state.name,
    customer: state.customer,
    company: state.company,
    pdfName: state.pdfName,
    model: state.model,
    design: state.design,
    site: state.site,
    render: state.render,
    elevations: state.elevations,
    sheets: state.sheets,
    plans: state.plans,
    gallery,
    sun: { seasons: state.sun.seasons, highlights: state.sun.highlights, diagramSvg: state.sun.diagramSvg, images },
  };
}

/** 読み込んだ内容を今のプロジェクトに反映する */
export function applyProject(p: ProjectFile) {
  if (p.format !== PROJECT_FORMAT) throw new Error('このファイルは間取りプレゼンのプロジェクトではありません');
  if (!p.model) throw new Error('プロジェクトに図面の読み取り結果が入っていません');
  state.name = p.name ?? state.name;
  state.customer = p.customer ?? state.customer;
  state.company = p.company ?? state.company;
  state.pdfName = p.pdfName;
  state.model = p.model;
  state.design = { ...state.design, ...p.design };
  state.site = { ...state.site, ...p.site };
  if (p.render) state.render = { ...state.render, ...p.render };
  state.elevations = p.elevations ?? [];
  state.sheets = p.sheets ?? [];
  state.plans = p.plans ?? [];
  state.gallery = (p.gallery ?? []).map((g) => ({ ...g }));
  state.sun = { seasons: p.sun?.seasons ?? [], highlights: p.sun?.highlights ?? [], diagramSvg: p.sun?.diagramSvg, images: p.sun?.images ?? [] };
  state.videos = [];
  emit('model');
  emit('project');
  emit('project-loaded');
}

const safeName = (s: string) => (s || 'プロジェクト').replace(/[\\/:*?"<>|]+/g, '_').trim();

/** ファイルに保存（ダウンロード） */
export async function saveProjectFile() {
  if (!state.model) {
    toast('図面を読み込んでから保存してください');
    return;
  }
  const data = await serializeProject();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName(state.name)}.madori.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`「${a.download}」に保存しました（${(blob.size / 1024 / 1024).toFixed(1)} MB）。このファイルを「開く」で読み込めば続きから作業できます`, 'ok', 6000);
}

/** ファイルから読み込む */
export async function openProjectFile(file: File) {
  const text = await file.text();
  let p: ProjectFile;
  try {
    p = JSON.parse(text);
  } catch {
    throw new Error('ファイルを読めませんでした（JSON ではありません）');
  }
  applyProject(p);
  toast(`プロジェクト「${state.name}」を開きました`, 'ok');
}

export function isProjectFile(f: File) {
  return /\.json$/i.test(f.name);
}

// ---- 以前の版がブラウザに残した自動保存の削除 ----
// 以前は IndexedDB に最後の作業を自動保存し「前回の続き」として表示していた。
// 公開版でお客様の情報が端末に残らないよう自動保存はやめ、残っている分も起動時に消す。
const LEGACY_DB = 'madori-presentation';

export function purgeLegacyAutosave() {
  try {
    indexedDB.deleteDatabase(LEGACY_DB);
  } catch {
    // 使えない環境では何もしない
  }
}
