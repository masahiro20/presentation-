/**
 * 外部仕上表（立面図シートの上の帯）。御社の立面図の帯を模写:
 *   左端に縦書きの「外部仕上表」、右へ 5 組（部位名｜内容）× 4 行。各マスは 2 行（材料・品番 と 色／防火）
 * 内容はコーディネートで選んだ商品（メーカー・品番・色）と、御社の標準仕様の文言から組む。
 * 単位は 1/100 の図面 mm（文字は紙の上で約 1.4mm）。図枠に入れるときは縮尺に合わせて拡大される
 */
import type { DesignOptions } from '../styles/presets';
import { exteriorFor, FINISH_CATEGORIES } from '../coordinate/catalog';
import { esc } from './sheet';

export interface FinishCell {
  /** 1 行目（材料） */
  a: string;
  /** 1 行目の右（色：…） */
  ar?: string;
  /** 2 行目（品番・下地） */
  b?: string;
  /** 2 行目の右（防火：…） */
  br?: string;
}

export interface FinishRow {
  label: string;
  cell: FinishCell;
}

/** 立面図の外壁の丸数字（① 外壁、④ アクセント）。表の行名と一致させる */
export const WALL_MARKS = { wall: '①', accent: '④' } as const;

const product = (design: DesignOptions, catId: string) => {
  const cat = FINISH_CATEGORIES.find((c) => c.id === catId);
  const id = design.finishes?.[catId];
  return cat && id ? cat.products.find((x) => x.id === id) : undefined;
};
const note = (design: DesignOptions, catId: string) => (design.finishNotes?.[catId] ?? '').trim();

/** 御社の標準仕様（コーディネートの選択で置き換わる部分以外は固定の文言） */
export function exteriorFinishRows(design: DesignOptions): FinishRow[][] {
  const st = exteriorFor(design);
  const roofP = product(design, 'roof');
  const wallP = product(design, 'extWall');
  const accP = product(design, 'accent');
  const soffitP = product(design, 'soffit');
  const sashP = product(design, 'sash');
  const doorP = product(design, 'entDoor');
  const pat = st.wall.pattern ?? '';
  const isPlaster = pat === 'stucco' || pat === 'plaster';
  // 外壁①: 商品があればその名前、無ければテイスト名から
  const wallMain = wallP
    ? /ジョリパット/.test(wallP.name)
      ? '塗り壁材 ジョリパット ミーティア仕上げ'
      : /Sto/.test(wallP.name)
        ? '塗り壁材 Sto ミーティア仕上げ'
        : /ガルバ/.test(wallP.name)
          ? 'ガルバリウム鋼板 Kスパン 縦張り'
          : `${wallP.name}`
    : /そとん/.test(st.name)
      ? '塗り壁材 そとん壁 掻き落とし仕上げ'
      : /Sto/.test(st.name)
        ? '塗り壁材 Sto ミーティア仕上げ'
        : isPlaster
          ? '塗り壁材 ジョリパット ミーティア仕上げ'
          : pat === 'standingSeam' || pat === 'galvalume'
            ? 'ガルバリウム鋼板 Kスパン 縦張り'
            : pat === 'wood' || pat === 'woodSiding'
              ? '木板張り'
              : '窯業系サイディング 張り';
  // 色: 商品があればその色名、無ければテイスト名の色の言葉（「ジョリパット グレー」→ グレー）
  const colorWord = (name: string) => {
    const m = /(オフホワイト|ホワイト|ライトグレー|グレージュ|グレー|ベージュ|チャコール|ブラック|墨色|白|黒)/.exec(name.split('×')[0]);
    return m ? m[1] : '';
  };
  const wallColor = wallP?.color ?? (design.wallColorOverride ? `指定色 ${design.wallColorOverride}` : colorWord(st.name));
  const wallSub = note(design, 'extWall') || (isPlaster || /塗り壁/.test(wallMain) ? '外壁側 窯業系サイディング 厚15＋屋内側 PB 厚12.5 張り' : '外壁側 構造用合板 9mm＋屋内側 PB 厚12.5 張り');
  const accMain = accP
    ? /SOLIDO/.test(accP.name)
      ? '窯業系平形ストレート 通気パネル工法'
      : /ウイルウォール|木板/.test(accP.name)
        ? '木板張り（レッドシダー）'
        : accP.name
    : st.accent
      ? st.accent.pattern === 'solido'
        ? '窯業系平形ストレート 通気パネル工法'
        : st.accent.pattern === 'wood' || st.accent.pattern === 'woodSiding'
          ? '木板張り（レッドシダー）'
          : 'アクセント外壁'
      : '';
  const accSub = accMain ? note(design, 'accent') || (/通気パネル/.test(accMain) ? '【ケイミュー】SOLIDO typeM LAP' : /レッドシダー/.test(accMain) ? '【チャネルオリジナル】ウイルウォール' : '') : '';
  const soffit = soffitP
    ? /同色/.test(soffitP.name)
      ? { a: 'ケイ酸カルシウム板 t10（外壁同色 塗装）', ar: '色：外壁合わせ' }
      : /シダー|木目/.test(soffitP.name)
        ? { a: `${soffitP.name}`, ar: `色：${soffitP.color ?? ''}` }
        : { a: 'ケイ酸カルシウム板 t10（塗装軒天ボード）', ar: `色：${soffitP.color ?? ''}` }
    : { a: 'ケイ酸カルシウム板 t10（塗装軒天ボード）', ar: '色：N-25 合わせ' };
  const roofColor = roofP?.color ?? (st.roof.material.pattern === 'standingSeam' ? 'ブラック' : '');
  const frameDark = /ブラック|黒/.test(sashP?.color ?? '') || (!sashP && parseInt(st.frame.color.slice(1, 3), 16) < 80);
  const gutter = st.roof.gutter;
  const roofRows: FinishRow[] = [
    { label: '屋根', cell: { a: `金属屋根 ${roofP ? roofP.name.replace(/立平葺き/, 't0.35 立平葺') : 'ガルバリウム鋼板 t0.35 立平葺'}`, ar: roofColor ? `色：${roofColor}` : '', b: note(design, 'roof') || '下葺材 アスファルトルーフィング 940＋構造用合板 t12', br: '防火：NM-8697' } },
    { label: '破風・鼻隠', cell: { a: 'ガルバリウム鋼板 t0.35 巻き込み仕上げ', ar: '色：ブラック' } },
    { label: '軒裏①', cell: { ...soffit, b: '', br: '防火：QF030RS-0124' } },
    { label: '軒裏②', cell: { a: '' } },
  ];
  const gutterRows: FinishRow[] = [
    { label: '軒樋', cell: gutter ? { a: '塩ビ製軒樋', b: '【Panasonic】グランスケア PGR60', br: '色：ブラック' } : { a: '軒樋なし（軒ゼロ納まり）' } },
    { label: '縦樋', cell: gutter ? { a: '塩ビ製縦樋', b: '【Panasonic】グランスケア PGR60', br: '色：ブラック' } : { a: '縦樋なし' } },
    { label: `外壁${WALL_MARKS.wall}`, cell: { a: wallMain, ar: wallColor ? `色：${wallColor}` : '', b: wallSub, br: isPlaster || /塗り壁/.test(wallMain) ? '防火：PC030BE-9201' : '' } },
    { label: `外壁${WALL_MARKS.accent}`, cell: accMain ? { a: accMain, ar: `色：${accP?.color ?? ''}`, b: accSub, br: /SOLIDO/.test(accSub) ? '防火：PC030BE-4146(1)' : '' } : { a: '' } },
  ];
  const baseRows: FinishRow[] = [
    { label: '外壁下地', cell: { a: '構造用合板 9mm＋透湿・防水シート t0.17＋通気胴縁張り', ar: '（外壁通気工法）' } },
    { label: '通気金物', cell: { a: '鋼板製 軒天換気材 軒ゼロタイプ', ar: '色：ブラック' } },
    { label: '土台水切', cell: { a: 'ガルバリウム鋼板 t0.35＋通気パッキン t20 or 気密パッキン t20', ar: '色：ブラック' } },
    { label: '基礎巾木', cell: { a: 'コンクリート立ち上がりの上、モルタル刷毛引き専用 塗装仕上げ', b: '外壁仕上げ塗り合わせ' } },
  ];
  const doorRows: FinishRow[] = [
    { label: '玄関ドア', cell: { a: doorP && /引き戸|コンコード/.test(doorP.name) ? '断熱玄関引き戸 ハンドル手動錠' : '断熱玄関片開きドア ハンドル手動錠', b: note(design, 'entDoor') || (doorP ? `【${doorP.maker.replace(/ AP$/, '')}】${doorP.name.replace(/ 片開き$/, '')} D2仕様` : '【YKK】ヴェナート D30 D2仕様'), br: `色：${doorP?.color ?? 'ディープグレイ'}` } },
    { label: '外建具', cell: { a: '樹脂アルミ複合サッシ＋16＋3 Low-E クリア＋網戸', b: note(design, 'sash') || (sashP ? `【${sashP.maker}】${sashP.name.replace(/（.*）$/, '')}` : '【LIXIL】TW'), br: frameDark ? '色：外ブラック／内ブラック' : `色：${sashP?.color ?? 'シルバー'}` } },
    { label: '断熱材', cell: { a: '屋根：高性能グラスウール t200', b: '壁：高性能グラスウール t105' } },
    { label: '断熱材', cell: { a: '基礎：カネライトフォーム（押出法ポリスチレンフォーム）t50', b: '（基礎内断熱 立ち上がり）' } },
  ];
  const otherRows: FinishRow[] = [
    { label: 'ポーチ', cell: { a: '磁器質タイル張り', b: '【ダントータイル】MDV-102 300×600' } },
    { label: 'バルコニー', cell: { a: 'FRP 防水仕上げ' } },
    { label: 'その他', cell: { a: '' } },
    { label: '', cell: { a: '' } },
  ];
  return [roofRows, gutterRows, baseRows, doorRows, otherRows];
}

/**
 * 外部仕上表の SVG。左上 (x, y)、幅 w。戻り値に高さ
 * 文字は紙の上で約 1.4mm（1/100 のとき 140）。図枠に入れると縮尺に合わせて拡大される
 */
export function exteriorFinishTableSvg(design: DesignOptions, x: number, y: number, w: number, opts: { rowH?: number; fs?: number } = {}): { svg: string; w: number; h: number } {
  const groups = exteriorFinishRows(design);
  const rowH = opts.rowH ?? 560;
  const fs = opts.fs ?? 135;
  const rows = 4;
  const h = rowH * rows;
  const headW = 620; // 縦書き「外部仕上表」
  const labW = 820;
  const gw = (w - headW) / groups.length;
  const sw = 12;
  const thin = 6;
  let s = '';
  s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff" stroke="#111" stroke-width="${sw}"/>`;
  // 縦書きの見出し
  s += `<line x1="${x + headW}" y1="${y}" x2="${x + headW}" y2="${y + h}" stroke="#111" stroke-width="${sw}"/>`;
  const head = '外部仕上表';
  const hfs = 190;
  const hy0 = y + h / 2 - ((head.length - 1) * hfs * 1.25) / 2;
  for (let i = 0; i < head.length; i++) s += `<text x="${x + headW / 2}" y="${(hy0 + i * hfs * 1.25 + hfs * 0.35).toFixed(0)}" font-size="${hfs}" text-anchor="middle" fill="#111">${esc(head[i])}</text>`;
  groups.forEach((g, gi) => {
    const gx = x + headW + gi * gw;
    if (gi > 0) s += `<line x1="${gx}" y1="${y}" x2="${gx}" y2="${y + h}" stroke="#111" stroke-width="${sw}"/>`;
    s += `<line x1="${gx + labW}" y1="${y}" x2="${gx + labW}" y2="${y + h}" stroke="#111" stroke-width="${thin}"/>`;
    g.slice(0, rows).forEach((r, ri) => {
      const ry = y + ri * rowH;
      if (ri > 0) s += `<line x1="${gx}" y1="${ry}" x2="${gx + gw}" y2="${ry}" stroke="#111" stroke-width="${thin}"/>`;
      if (r.label) s += `<text x="${gx + labW / 2}" y="${(ry + rowH / 2 + fs * 0.4).toFixed(0)}" font-size="${fs * 1.05}" text-anchor="middle" fill="#111">${esc(r.label)}</text>`;
      const cx = gx + labW + 70;
      const cr = gx + gw - 70;
      const cw = gw - labW - 140;
      const y1 = ry + rowH * 0.36;
      const y2 = ry + rowH * 0.8;
      // 1 行目: 材料（長いときは縮める）／右端に色
      const fit = (t: string, maxW: number) => {
        let wch = 0;
        for (const ch of t) wch += /[\x20-\x7e｡-ﾟ]/.test(ch) ? 0.55 : 1;
        const need = wch * fs;
        return need > maxW ? ` textLength="${maxW.toFixed(0)}" lengthAdjust="spacingAndGlyphs"` : '';
      };
      const rightW = (t?: string) => (t ? [...t].reduce((a, ch) => a + (/[\x20-\x7e｡-ﾟ]/.test(ch) ? 0.55 : 1), 0) * fs * 0.95 + 160 : 0);
      if (r.cell.a) s += `<text x="${cx}" y="${y1.toFixed(0)}" font-size="${fs}" fill="#111"${fit(r.cell.a, cw - rightW(r.cell.ar))}>${esc(r.cell.a)}</text>`;
      if (r.cell.ar) s += `<text x="${cr}" y="${y1.toFixed(0)}" font-size="${fs * 0.95}" text-anchor="end" fill="#111">${esc(r.cell.ar)}</text>`;
      if (r.cell.b) s += `<text x="${cx}" y="${y2.toFixed(0)}" font-size="${fs}" fill="#111"${fit(r.cell.b, cw - rightW(r.cell.br))}>${esc(r.cell.b)}</text>`;
      if (r.cell.br) s += `<text x="${cr}" y="${y2.toFixed(0)}" font-size="${fs * 0.95}" text-anchor="end" fill="#111">${esc(r.cell.br)}</text>`;
      // 2 行の間の点線（御社の表の書き方）
      s += `<line x1="${cx}" y1="${(ry + rowH * 0.5).toFixed(0)}" x2="${cr}" y2="${(ry + rowH * 0.5).toFixed(0)}" stroke="#999" stroke-width="4" stroke-dasharray="30 30"/>`;
    });
  });
  return { svg: s, w, h };
}
