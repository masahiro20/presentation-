/**
 * 仕上げた写真（外部の画像生成 AI で作ったもの）の色味を資料の中でそろえる。
 * 1 枚ずつ別のセッションで仕上げると、明るさと色かぶり（黄味・青味）がばらつき、資料をめくったときの一体感が無くなる。
 * 各写真の中間調の平均（明るさ・R/G/B の比）を測り、全体の中央値に向けて軽く寄せる（やり過ぎない: 明るさ ±15%、色 ±10% まで）。
 */

export interface PhotoStats {
  /** 中間調の平均輝度（0〜1） */
  lum: number;
  /** 中間調の R・G・B の平均（0〜1） */
  rgb: [number, number, number];
}

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('画像を読めませんでした'));
    im.src = url;
  });

/** 写真の中間調（真っ白な空・真っ黒な影を除いた画素）の明るさと色 */
export async function photoStats(url: string): Promise<PhotoStats> {
  const im = await loadImage(url);
  const w = 160;
  const h = Math.max(1, Math.round((im.naturalHeight / im.naturalWidth) * w));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(im, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  let n = 0;
  let r = 0;
  let gg = 0;
  let b = 0;
  let l = 0;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    if (lum < 0.08 || lum > 0.92) continue;
    n++;
    r += d[i] / 255;
    gg += d[i + 1] / 255;
    b += d[i + 2] / 255;
    l += lum;
  }
  if (!n) return { lum: 0.5, rgb: [0.5, 0.5, 0.5] };
  return { lum: l / n, rgb: [r / n, gg / n, b / n] };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0.5;
};

/** そろえる先（中央値）。外観と内観は明るさが違って当然なので、別々に取る */
export function harmonyTarget(stats: PhotoStats[]): PhotoStats {
  return { lum: median(stats.map((s) => s.lum)), rgb: [median(stats.map((s) => s.rgb[0])), median(stats.map((s) => s.rgb[1])), median(stats.map((s) => s.rgb[2]))] };
}

/** 1 枚を目標に寄せる（ゲインは控えめに）。ほぼ同じなら元の URL をそのまま返す */
export async function harmonizePhoto(url: string, stat: PhotoStats, target: PhotoStats, strength = 0.7): Promise<string> {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  // 色かぶり: 中間調の R/G/B の比を目標に合わせる（明るさの差は含めない）
  const sMean = (stat.rgb[0] + stat.rgb[1] + stat.rgb[2]) / 3;
  const tMean = (target.rgb[0] + target.rgb[1] + target.rgb[2]) / 3;
  const gains = [0, 1, 2].map((i) => clamp(1 + ((target.rgb[i] / tMean) / (stat.rgb[i] / sMean) - 1) * strength, 0.9, 1.1));
  const lumGain = clamp(1 + (target.lum / Math.max(0.05, stat.lum) - 1) * strength, 0.85, 1.15);
  if (gains.every((g) => Math.abs(g - 1) < 0.015) && Math.abs(lumGain - 1) < 0.02) return url;
  const im = await loadImage(url);
  const cv = document.createElement('canvas');
  cv.width = im.naturalWidth;
  cv.height = im.naturalHeight;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(im, 0, 0);
  const img = g.getImageData(0, 0, cv.width, cv.height);
  const d = img.data;
  // ハイライトは飛ばさない（明るい所ほどゲインを弱める）
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = d[i + c] / 255;
      const k = gains[c] * lumGain;
      const soft = k > 1 ? 1 + (k - 1) * (1 - v * v) : k;
      d[i + c] = Math.max(0, Math.min(255, Math.round(v * soft * 255)));
    }
  }
  g.putImageData(img, 0, 0);
  return cv.toDataURL('image/jpeg', 0.92);
}

/**
 * 取り込む写真の組（＋すでにある同じ種類の写真）で目標を決め、取り込む写真だけを寄せる。
 * kind ごと（外観／内観）に分けて行う
 */
export async function harmonizeBatch(items: { url: string; kind: string }[], existing: { url: string; kind: string }[]): Promise<string[]> {
  const out = items.map((i) => i.url);
  const groups = new Map<string, number[]>();
  items.forEach((it, i) => {
    const k = it.kind === 'interior' ? 'interior' : 'exterior';
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(i);
  });
  for (const [k, idx] of groups) {
    const stats = await Promise.all(idx.map((i) => photoStats(items[i].url)));
    const ex = existing.filter((e) => (e.kind === 'interior' ? 'interior' : 'exterior') === k);
    const exStats = await Promise.all(ex.map((e) => photoStats(e.url).catch(() => null)));
    const target = harmonyTarget([...stats, ...exStats.filter((s): s is PhotoStats => !!s)]);
    // 1 枚だけで、ほかに同じ種類の写真が無ければそろえる相手がいない
    if (stats.length + exStats.length < 2) continue;
    for (let j = 0; j < idx.length; j++) out[idx[j]] = await harmonizePhoto(items[idx[j]].url, stats[j], target);
  }
  return out;
}
