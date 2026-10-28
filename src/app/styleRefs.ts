/**
 * お手本の写真（御社の仕上げパース・竣工写真）。
 * 画像生成 AI（Nano Banana Pro）は参考画像の影響が強いので、カット集に「この写りで」と添えると、
 * 色味・光・植栽の雰囲気が御社の提案らしくそろう。事務所の写真庫（このブラウザ）に入り、どのお客様でも使う。
 */
import { libraryTx, shrinkPhoto } from '../coordinate/samples';

export type RefKind = 'exterior' | 'interior';

export interface StyleRef {
  id: string;
  kind: RefKind;
  url: string;
  name?: string;
  at: string;
}

export const REF_KIND_LABEL: Record<RefKind, string> = { exterior: '外観', interior: '内観' };

export async function listRefs(): Promise<StyleRef[]> {
  try {
    const all = await libraryTx<StyleRef[]>('refs', 'readonly', (s) => s.getAll() as IDBRequest<StyleRef[]>);
    return all.sort((a, b) => a.at.localeCompare(b.at));
  } catch {
    return [];
  }
}

export async function addRef(file: File, kind: RefKind): Promise<StyleRef> {
  // お手本は少し大きめに（AI に写りを伝えるため）
  const url = await shrinkPhoto(file, 1400);
  const ref: StyleRef = { id: `ref${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind, url, name: file.name, at: new Date().toISOString() };
  await libraryTx('refs', 'readwrite', (s) => s.put(ref, ref.id));
  return ref;
}

export async function deleteRef(id: string): Promise<void> {
  await libraryTx('refs', 'readwrite', (s) => s.delete(id));
}
