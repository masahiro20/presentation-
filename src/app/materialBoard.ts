/**
 * 素材ボード: コーディネートで選んだ商品の見本（実物写真があればそれ、無ければ 3D と同じ質感イメージ）を
 * 部位の名前・メーカー・商品名・色と一緒に 1 枚の画像に並べる。
 * カット集に同梱し、画像生成 AI（Nano Banana Pro）に下絵と一緒に「参考画像」として渡すためのもの
 * （文字で「オーク」と書くより、実物の板の写真を見せた方が仕上がりの色・木目が決まる）。
 */
import { FINISH_CATEGORIES, selectedProduct, type Product } from '../coordinate/catalog';
import { lookOf } from '../coordinate/samples';
import { state } from './state';

export interface BoardEntry {
  catId: string;
  label: string;
  product: Product;
  url?: string;
  real: boolean;
}

/** ボードに載せる部位（設備は載せない。見た目に関わる順） */
const ORDER = ['extWall', 'accent', 'roof', 'soffit', 'sash', 'entDoor', 'entFloor', 'floor', 'wall', 'accentWall', 'ceiling', 'door', 'baseboard', 'stair', 'kitchen', 'cupboard', 'pendant', 'wetFloor', 'washWall', 'vanity', 'bath'];

export function boardEntries(samples: Record<string, string> | undefined): BoardEntry[] {
  const out: BoardEntry[] = [];
  for (const id of ORDER) {
    const cat = FINISH_CATEGORIES.find((c) => c.id === id);
    if (!cat) continue;
    const p = selectedProduct(cat, state.design);
    if (/^(acc|aw)\.none$/.test(p.id)) continue;
    // 実物写真があれば部位を問わず載せる（キッチン・浴室・照明はメーカーの商品写真が事務所の既定に入る）
    const look = lookOf(id, p, state.design, samples);
    out.push({ catId: id, label: cat.label.replace(/（.*?）/g, ''), product: p, url: look?.url, real: !!look?.real });
  }
  return out;
}

const loadImage = (url: string) =>
  new Promise<HTMLImageElement | null>((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = url;
  });

/** 素材ボードを JPEG の data URL にする（幅 W px。4 列） */
export async function renderMaterialBoard(entries: BoardEntry[], W = 1800): Promise<string> {
  const cols = 4;
  const pad = 28;
  const tileW = Math.floor((W - pad * (cols + 1)) / cols);
  const imgH = Math.round(tileW * 0.62);
  const textH = 92;
  const tileH = imgH + textH;
  const rows = Math.ceil(entries.length / cols);
  const headH = 80;
  const H = headH + pad + rows * (tileH + pad);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#f4f2ee';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#222';
  g.font = `600 ${Math.round(W / 56)}px 'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif`;
  g.fillText(`${state.name || ''}　素材ボード（仕上げの見本）`, pad, headH * 0.62);
  g.font = `${Math.round(W / 95)}px 'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif`;
  g.fillStyle = '#666';
  g.fillText('MATERIAL BOARD — reference for the finishing AI: match these colors and textures', pad, headH * 0.62 + Math.round(W / 60));
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const x = pad + (i % cols) * (tileW + pad);
    const y = headH + pad + Math.floor(i / cols) * (tileH + pad);
    g.fillStyle = '#fff';
    g.fillRect(x, y, tileW, tileH);
    g.strokeStyle = 'rgba(0,0,0,0.12)';
    g.strokeRect(x + 0.5, y + 0.5, tileW - 1, tileH - 1);
    const im = e.url ? await loadImage(e.url) : null;
    if (im) {
      // 中央をトリミングして枠いっぱいに
      const r = Math.max(tileW / im.width, imgH / im.height);
      const sw = tileW / r;
      const sh = imgH / r;
      g.drawImage(im, (im.width - sw) / 2, (im.height - sh) / 2, sw, sh, x, y, tileW, imgH);
    } else {
      // 見本画像が無い部位は色見本の帯
      const sw = e.product.swatch.length ? e.product.swatch : ['#ccc'];
      const w = tileW / sw.length;
      sw.forEach((c, k) => {
        g.fillStyle = c;
        g.fillRect(x + k * w, y, w, imgH);
      });
    }
    if (e.real) {
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(x + 8, y + 8, 56, 22);
      g.fillStyle = '#fff';
      g.font = `600 13px 'Noto Sans JP','Hiragino Sans',sans-serif`;
      g.fillText('実物', x + 16, y + 24);
    }
    g.fillStyle = '#777';
    g.font = `${Math.round(tileW / 26)}px 'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif`;
    g.fillText(e.label, x + 12, y + imgH + 26);
    g.fillStyle = '#222';
    g.font = `600 ${Math.round(tileW / 21)}px 'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif`;
    const name = `${e.product.maker}　${e.product.name}`;
    g.fillText(fit(g, name, tileW - 24), x + 12, y + imgH + 54);
    g.fillStyle = '#555';
    g.font = `${Math.round(tileW / 26)}px 'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif`;
    g.fillText(fit(g, [e.product.code, e.product.color].filter(Boolean).join('　'), tileW - 24), x + 12, y + imgH + 78);
  }
  return cv.toDataURL('image/jpeg', 0.9);
}

function fit(g: CanvasRenderingContext2D, t: string, w: number): string {
  if (g.measureText(t).width <= w) return t;
  let s = t;
  while (s.length > 1 && g.measureText(s + '…').width > w) s = s.slice(0, -1);
  return s + '…';
}
