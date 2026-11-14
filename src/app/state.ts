/** プロジェクトの状態 */
import type { PlanSummary } from '../core/planDiff';
import type { SightlineIssue } from '../core/sightlines';
import type { SiteStudyInput } from '../core/siteStudy';
import type { BuildingModel } from '../core/types';
import { DEFAULT_DESIGN, type DesignOptions } from '../styles/presets';
import { DEFAULT_SITE, type SiteLocation } from '../sun/geo';
import type { SeasonResult, SunHighlight } from '../sun/report';
import type { ExternalBuilding } from './externalFit';
import type { SunDisclosure } from './sunDisclosure';
import type { EstimateState } from './steps/estimateStep';
import type { CoordState } from '../coordinate/decisions';
import type { FocusNote } from '../core/focus';

export interface GalleryItem {
  id: string;
  title: string;
  caption: string;
  url: string;
  kind: 'exterior' | 'interior' | 'aerial' | 'cutaway' | 'section' | 'sun' | 'other';
  quality: 'realtime' | 'photoreal';
  shotId?: string;
  /** AI で仕上げたとき: 下絵の輪郭がどれだけ残っているか（0〜1。低いと窓・屋根が変わっている可能性） */
  aiScore?: number;
  /** AI で仕上げたモデル名 */
  aiModel?: string;
}

export interface ProjectState {
  name: string;
  customer: string;
  company: string;
  /** 提案書の締めのページ: 設計担当・連絡先 */
  designer?: string;
  /** 表題欄の資格・氏名（例: 一級建築士第379471号　伊岐見 恭子） */
  license?: string;
  /** 読み込み直後の「提案一式をまとめて作る」: 資料の画面を開いたら自動作成を始める（'draft' = 高品質描画で速く） */
  autoRun?: 'draft' | 'photo';
  /** 提案資料に資金計画（概算）のページを入れる */
  deckFunding?: boolean;
  /** 提案資料の出し方: 出すページの選び方と、建築概要の上書き（右のメモ） */
  deck?: DeckOptions;
  /** 会社情報（見積書・資金計画書の発行者欄） */
  companyRep?: string;
  companyAddress?: string;
  tel?: string;
  email?: string;
  url?: string;
  /** 事務所ロゴ（dataURL。図面の表題欄・ヘッダー・シネマに使う） */
  logo?: string;
  pdfName?: string;
  /** お客様のご要望（ヒアリングシート・要望書の文章。間取りと照合して資料に「ご要望との照合」として載せる） */
  wishes?: string;
  /** 前回までのプランの要約（図面を読み直したときに差分を出す。新しいものが後ろ） */
  revisions?: PlanSummary[];
  /** 敷地から先に検討（プランが無い段階の条件）。図面を読んだら照合に使う */
  siteStudy?: SiteStudyInput;
  model: BuildingModel | null;
  design: DesignOptions;
  site: SiteLocation;
  gallery: GalleryItem[];
  elevations: { dir: string; title: string; svg: string }[];
  plans: { level: number; svg: string }[];
  /** A3 図面シート（図枠・表題欄付き: 平面図・立面図・断面図） */
  sheets: { title: string; svg: string; floors?: number[] }[];
  /** 図面シートの配置（手で直した分。平面図の縮尺・1 階と 2 階の間隔・並び・パネルごとのずらし） */
  sheetLayout?: SheetLayout;
  sun: {
    seasons: SeasonResult[];
    highlights: SunHighlight[];
    diagramSvg?: string;
    images: { label: string; url: string }[];
    /** 隣家からの視線（周辺建物を取得したときに計算。資料の「窓と隣家の視線」のページ） */
    sightlines?: SightlineIssue[];
    /**
     * 結果を作った時点の周辺建物の扱い（計算から除外・表示だけ隠した建物）。部屋の日当たり・資料の日照のページの注記に使う。
     * 結果と一緒に捨てる（clearedSunResults）。無ければ資料を作る時点の扱いで書く
     */
    disclosure?: SunDisclosure;
  };
  videos: { title: string; url: string; ext: string }[];
  /** 提案用パース（写真品質）の設定 */
  render: { samples: number; width: number; height: number };
  /** 設計の 3D データ（3DS など）で置き換えた正確な建物（日照ステップ）。無ければ null */
  external: ExternalBuilding | null;
  /** 見積・資金計画（数量の上書き・仕様の選択・資金計画の入力） */
  estimate: EstimateState | null;
  /** コーディネートの段取り（部位ごとの候補・決定・お客様の選択） */
  coord: CoordState;
  /**
   * こだわり指定（参考資料）: 階段・キッチン・外観などに「この仕様・この写真のように提案したい」を添えたもの。
   * 図面を読み直しても残り、モデルが変わるたびに階段のつくり・手すり・段数を当て直す（core/focus.ts・app/focusNotes.ts）
   */
  focus?: FocusNote[];
  /** 図面のメモから作ったこだわりの下書きのうち、見送ったもの（core/memoIntent.ts の id。もう一度は出さない） */
  focusSkip?: string[];
}

/**
 * 提案資料の出し方。
 * pages: 'all' = すべてのページ、'summary' = 表紙・理念・私たちのアプローチ・建築概要・締めだけ（会社紹介と概要の提出・記録用）、
 * 'custom' = custom に入れた id のページだけ。
 * overview: 建築概要の項目の上書き（項目名 → 値。空なら自動の値、「×」でその行を消す）。overviewExtra: 足す行（1 行に 1 項目「項目：値」）
 */
export interface DeckOptions {
  pages?: 'all' | 'summary' | 'custom';
  custom?: string[];
  overview?: Record<string, string>;
  overviewExtra?: string;
}

/** 図面シートの配置の手直し。offsets は図面のパネル（1 階・2 階 …）ごとの紙の上のずらし (mm) */
export interface SheetLayout {
  plan?: {
    /** 縮尺の分母（100・150・200）。無ければ自動 */
    scale?: number;
    /** 1 階と 2 階の間隔 (m)。既定 0.6 */
    gapM?: number;
    /** 並べ方: 横一列（既定）／縦 */
    stack?: 'row' | 'col';
    offsets?: Record<string, { x: number; y: number }>;
  };
}

export const state: ProjectState = {
  name: '〇〇様邸 新築計画',
  customer: '〇〇様',
  company: '',
  model: null,
  design: { ...DEFAULT_DESIGN },
  site: { ...DEFAULT_SITE },
  gallery: [],
  elevations: [],
  plans: [],
  sheets: [],
  sun: { seasons: [], highlights: [], images: [] },
  videos: [],
  render: { samples: 512, width: 1920, height: 1080 },
  external: null,
  estimate: null,
  coord: { items: {} },
};

type Handler = (payload?: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

export function on(ev: string, fn: Handler) {
  if (!handlers.has(ev)) handlers.set(ev, new Set());
  handlers.get(ev)!.add(fn);
  return () => handlers.get(ev)!.delete(fn);
}

/** モデルが変わった知らせ（emit('model')）の直前に、モデルへ当て直すもの（こだわり指定の階段のつくりなど）。聞き手より先に走る */
const modelHooks = new Set<() => void>();
export function beforeModelEmit(fn: () => void) {
  modelHooks.add(fn);
  return () => modelHooks.delete(fn);
}

export function emit(ev: string, payload?: unknown) {
  if (ev === 'model') modelHooks.forEach((f) => f());
  handlers.get(ev)?.forEach((f) => f(payload));
}

let idc = 0;
export const uid = (p = 'id') => `${p}-${Date.now().toString(36)}-${(idc++).toString(36)}`;

(globalThis as any).__state = state;
