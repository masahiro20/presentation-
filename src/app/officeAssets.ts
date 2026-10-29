/**
 * 事務所の既定の素材（お手本の写真・商品の実物写真）。
 * リポジトリには入れず、体験リンクと同じ保存先（Vercel Blob）の office/ に置く。
 * 各パソコンの写真庫（IndexedDB）に登録したものと合わせて使う（パソコンの登録が優先）。
 *   office/refs.json     [{ id, kind: 'exterior'|'interior', url, name }]
 *   office/samples.json  { [productId]: url }
 * 置き方: scripts/tmp の upload スクリプト（Blob の書き込みトークンが要る）。
 */
export const OFFICE_ASSETS_BASE = 'https://cilygkt6uhopqsbr.public.blob.vercel-storage.com/office';

export interface OfficeRef {
  id: string;
  kind: 'exterior' | 'interior';
  url: string;
  name?: string;
}

let refsCache: Promise<OfficeRef[]> | null = null;
let samplesCache: Promise<Record<string, string>> | null = null;

async function getJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(`${OFFICE_ASSETS_BASE}/${path}`, { cache: 'no-cache' });
    if (!r.ok) return fallback;
    return (await r.json()) as T;
  } catch {
    return fallback;
  }
}

/** 事務所の既定のお手本（無ければ空） */
export function officeRefs(): Promise<OfficeRef[]> {
  return (refsCache ??= getJson<OfficeRef[]>('refs.json', []).then((a) => (Array.isArray(a) ? a.filter((r) => r && r.url && (r.kind === 'exterior' || r.kind === 'interior')) : [])));
}

/** 事務所の既定の実物写真（商品 id → URL。無ければ空） */
export function officeSamples(): Promise<Record<string, string>> {
  return (samplesCache ??= getJson<Record<string, string>>('samples.json', {}).then((o) => (o && typeof o === 'object' ? o : {})));
}

/** URL の画像を取り出す（data: ならそのまま、https なら取得） */
export async function imageBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith('data:')) {
    const b64 = url.slice(url.indexOf(',') + 1);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`画像を取得できませんでした: ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}
