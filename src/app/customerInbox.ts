/**
 * 体験リンクからお客様が送ったもの（customer.json: ご要望の文章・「いいね」した構図）を受け取る。
 * 仕様の選択（picks.json）はコーディネートで受け取る。ここは文章と「いいね」だけ。
 *
 * 使う人（設計士）: 読込画面の「ご要望との照合」とコーディネートの「お客様の選択を受け取る」から同じ関数を呼ぶ。
 * お客様が書き足して送り直しても、前に取り込んだ分は置き換える（二重に増えない）。
 */
import { state, emit } from './state';
import { inboxUrlFor, type CustomerInbox } from '../coordinate/decisions';

export interface InboxResult {
  /** ご要望の文章が新しく入った（または書き換わった） */
  wishesChanged: boolean;
  likes: number;
  at: string;
}

function customerBlock(text: string, at: string): string {
  const date = at ? new Date(at).toLocaleDateString('ja-JP') : '';
  return `【お客様からのご要望（体験リンク ${date}）】\n${text.trim()}`;
}

/** 受け取り先（最後に作った体験リンク）から customer.json を読む。無ければ null */
export async function receiveCustomerInbox(link = state.coord.shareUrl): Promise<InboxResult | null> {
  const url = link ? inboxUrlFor(link) : null;
  if (!url) return null;
  let inbox: CustomerInbox;
  try {
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    inbox = (await r.json()) as CustomerInbox;
  } catch {
    return null;
  }
  let wishesChanged = false;
  const w = (inbox.wishes ?? '').trim();
  const prev = state.coord.customerWishes;
  if (w && w !== prev) {
    const block = customerBlock(w, inbox.at);
    const cur = state.wishes ?? '';
    if (prev && cur.includes(customerBlock(prev, state.coord.customerWishesAt ?? ''))) state.wishes = cur.replace(customerBlock(prev, state.coord.customerWishesAt ?? ''), block);
    else state.wishes = `${cur.trim()}${cur.trim() ? '\n\n' : ''}${block}`;
    wishesChanged = true;
  }
  state.coord = { ...state.coord, likes: inbox.likes ?? [], likesAt: inbox.at, customerWishes: w || prev, customerWishesAt: w && w !== prev ? inbox.at : state.coord.customerWishesAt };
  emit('coord');
  return { wishesChanged, likes: (inbox.likes ?? []).length, at: inbox.at };
}

/** 受け取った結果のひとこと（トースト用） */
export function inboxSummary(r: InboxResult | null): string {
  if (!r) return 'お客様からのご要望・いいねはまだ届いていません';
  const parts = [r.wishesChanged ? 'ご要望を「ご要望との照合」に入れました' : 'ご要望は前回から変わっていません', r.likes ? `いいね ${r.likes} 件` : ''].filter(Boolean);
  return parts.join('・');
}
