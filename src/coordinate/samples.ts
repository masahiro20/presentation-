/**
 * 商品の実物写真（サンプル写真）と質感イメージ。
 *
 * - 実物写真: コーディネーターが撮ったサンプルやメーカーの写真を商品ごとに 1 枚登録する。登録は「事務所の写真庫」
 *   （このブラウザの IndexedDB）に入り、どのお客様のプロジェクトでも使い回せる。プロジェクトに使った分は state.coord.samples にも写し、
 *   保存ファイル・体験リンク（お客様のスマホ）にも届く。
 * - 質感イメージ: 写真が無い商品は、3D と同じ実写テクスチャから小さな見本板を描く（色と質感の目安。実物はサンプルで確かめる）。
 */
import { FINISH_CATEGORIES, resolveProductId, type Product } from './catalog';
import { officeSamples } from '../app/officeAssets';
import { exteriorById, interiorById, type DesignOptions, type ExteriorStyle, type InteriorStyle } from '../styles/presets';
import { makeMaterial, type MatSpec } from '../styles/textures';

const DB = 'madori-library';
const STORE = 'samples';
/** 事務所の写真庫の棚: samples = 商品の実物写真、refs = お手本の写真（御社の仕上げパース） */
export type LibraryStore = 'samples' | 'refs';
const STORES: LibraryStore[] = ['samples', 'refs'];

export interface SamplePhoto {
  url: string;
  /** 写真の出どころ（ファイル名など） */
  name?: string;
  at: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      for (const st of STORES) if (!r.result.objectStoreNames.contains(st)) r.result.createObjectStore(st);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** 写真庫の 1 操作（store の棚で fn を実行） */
export async function libraryTx<T>(store: LibraryStore, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
const tx = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => libraryTx(STORE, mode, fn);

/** 写真庫から読む（無ければ undefined） */
export async function librarySample(productId: string): Promise<SamplePhoto | undefined> {
  try {
    return (await tx<SamplePhoto | undefined>('readonly', (s) => s.get(productId) as IDBRequest<SamplePhoto | undefined>)) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function saveLibrarySample(productId: string, photo: SamplePhoto): Promise<void> {
  await tx('readwrite', (s) => s.put(photo, productId));
}

export async function deleteLibrarySample(productId: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(productId));
}

/** 写真を長辺 900px の JPEG に縮める（資料・リンクに入れても重くならないように） */
export async function shrinkPhoto(file: Blob, max = 900): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k);
  cv.height = Math.round(bmp.height * k);
  cv.getContext('2d')!.drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close();
  return cv.toDataURL('image/jpeg', 0.85);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 部位 → 3D のどの素材が変わるか */
const PICK: Record<string, (s: { ext: ExteriorStyle; int: InteriorStyle }) => MatSpec | undefined> = {
  extWall: (s) => s.ext.wall,
  accent: (s) => s.ext.accent,
  roof: (s) => s.ext.roof.material,
  soffit: (s) => s.ext.roof.soffit,
  sash: (s) => ({ pattern: 'paint', color: s.ext.frame.color, roughness: 0.35, metalness: s.ext.frame.metalness }),
  entDoor: (s) => s.ext.entranceDoor,
  floor: (s) => s.int.floor,
  wetFloor: (s) => s.int.wetFloor,
  entFloor: (s) => s.int.entranceFloor,
  wall: (s) => s.int.wall,
  accentWall: (s) => s.int.accentWall,
  ceiling: (s) => s.int.ceiling,
  door: (s) => s.int.door,
  kitchen: (s) => s.int.furniture.cabinet,
  cupboard: (s) => s.int.furniture.cabinet,
};

/** 商品を選んだときの素材（質感イメージ用）。見た目に関わらない商品（設備）は undefined */
export function materialOf(catId: string, p: Product, d: DesignOptions): MatSpec | undefined {
  const pick = PICK[catId];
  if (!pick || !p.apply) return undefined;
  const s = { ext: clone(exteriorById(d.exteriorId)), int: clone(interiorById(d.interiorId)) };
  p.apply(s);
  return pick(s);
}

const chipCache = new Map<string, string>();

/** 質感イメージ: 3D と同じ素材の模様を、斜めの光が当たった見本板のように描く */
export function textureChip(spec: MatSpec, w = 240, h = 160): string {
  const key = JSON.stringify([spec, w, h]);
  const hit = chipCache.get(key);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d')!;
  g.fillStyle = spec.color;
  g.fillRect(0, 0, w, h);
  try {
    const img = makeMaterial(spec).map?.image as CanvasImageSource & { width?: number; height?: number } | undefined;
    if (img && img.width && img.height) {
      // 実物の見本板に近い範囲（テクスチャ 1 枚の約半分 ≒ 1m 前後）を切り出す
      const sw = img.width * 0.45;
      g.drawImage(img, 0, 0, sw, (sw * h) / w, 0, 0, w, h);
    }
  } catch {
    // テクスチャが作れない環境では色だけ
  }
  // 斜めの光と縁（見本板らしく）
  const lg = g.createLinearGradient(0, 0, w, h);
  lg.addColorStop(0, 'rgba(255,255,255,0.16)');
  lg.addColorStop(0.55, 'rgba(255,255,255,0)');
  lg.addColorStop(1, 'rgba(0,0,0,0.12)');
  g.fillStyle = lg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(0,0,0,0.12)';
  g.strokeRect(0.5, 0.5, w - 1, h - 1);
  const url = cv.toDataURL('image/jpeg', 0.86);
  chipCache.set(key, url);
  return url;
}

/** この部位に写真・質感イメージを出せるか（設備は色見本だけ） */
export function hasLook(catId: string): boolean {
  return catId in PICK;
}

/** 商品の見せ方: 実物写真（あれば）→ 質感イメージ → 無し */
export function lookOf(catId: string, p: Product, d: DesignOptions, samples: Record<string, string> | undefined): { url: string; real: boolean } | undefined {
  const real = samples?.[p.id];
  if (real) return { url: real, real: true };
  const spec = materialOf(catId, p, d);
  if (!spec) return undefined;
  return { url: textureChip(spec), real: false };
}

/** プロジェクトで使う商品（選択中・候補）の写真を写真庫から state に写す */
export async function fillSamplesFromLibrary(ids: string[], into: Record<string, string>): Promise<number> {
  let n = 0;
  let office: Record<string, string> | null = null;
  for (const id of ids) {
    if (into[id]) continue;
    const s = await librarySample(id);
    if (s) {
      into[id] = s.url;
      n++;
      continue;
    }
    // 事務所の既定（メーカーの商品写真）。資料・決定書で使うので data URL にして持つ
    office ??= await officeSamples();
    const url = office[id] ?? office[resolveProductId(id)];
    if (url) {
      try {
        const blob = await (await fetch(url)).blob();
        into[id] = await shrinkPhoto(blob, 900);
        n++;
      } catch {
        // 取れなければ質感イメージのまま
      }
    }
  }
  return n;
}

export function categoryOfProduct(productId: string): string | undefined {
  return FINISH_CATEGORIES.find((c) => c.products.some((p) => p.id === productId))?.id;
}
