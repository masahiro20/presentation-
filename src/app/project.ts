/**
 * プロジェクトの保存と読み込み
 *
 * - ファイル（.madori.json）に書き出し／読み込み: 図面の読み取り結果（手修正・家具・階段を含む）、テイスト、建設地、
 *   お客様情報、立面図・平面図、パースと日照の画像を 1 つのファイルにまとめる
 * - ブラウザ（IndexedDB）に自動保存: 図面を読み込んだとき・修正したとき・設定を変えたときに保存し、
 *   次に開いたとき「前回の続きから」で戻せる
 *
 * 動画はサイズが大きいので保存しません（必要なら動画ステップから個別に保存してください）。
 */
import { state, emit, on, type ProjectState, type GalleryItem } from './state';
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

// ---- ブラウザへの自動保存 ----
const DB = 'madori-presentation';
const STORE = 'projects';
const KEY = 'last';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(value: unknown) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet<T>(): Promise<T | null> {
  const db = await openDb();
  const v = await new Promise<T | null>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return v;
}

export async function clearAutosave() {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // 使えない環境では何もしない
  }
}

let saving = false;
let pending = false;
let lastSig = '';
export const autosaveInfo = { at: null as Date | null };

/** 変化があれば自動保存（連続して呼ばれても 1 回にまとめる） */
export async function autosave(force = false) {
  if (!state.model) return;
  if (saving) {
    pending = true;
    return;
  }
  saving = true;
  try {
    const sig = JSON.stringify({ m: state.model, d: state.design, s: state.site, n: state.name, c: state.customer, co: state.company, g: state.gallery.length, e: state.elevations.length, p: state.plans.length, si: state.sun.images.length, ss: state.sun.seasons.length });
    if (!force && sig === lastSig) return;
    const data = await serializeProject();
    await idbPut(data);
    lastSig = sig;
    autosaveInfo.at = new Date();
  } catch (e) {
    console.warn('autosave failed', e);
  } finally {
    saving = false;
    if (pending) {
      pending = false;
      void autosave();
    }
  }
}

export async function loadAutosave(): Promise<ProjectFile | null> {
  try {
    const p = await idbGet<ProjectFile>();
    return p && p.format === PROJECT_FORMAT && p.model ? p : null;
  } catch {
    return null;
  }
}

/** 自動保存を開始: モデル・プロジェクトの変化で保存し、設定の変化は 15 秒ごとに拾う */
export function startAutosave() {
  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void autosave(), 1500);
  };
  on('model', schedule);
  on('project', schedule);
  on('gallery', schedule);
  setInterval(() => void autosave(), 15000);
  window.addEventListener('beforeunload', () => void autosave());
}

(globalThis as any).__project = { loadAutosave, autosave, serializeProject };
