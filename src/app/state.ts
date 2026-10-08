/** プロジェクトの状態 */
import type { BuildingModel } from '../core/types';
import { DEFAULT_DESIGN, type DesignOptions } from '../styles/presets';
import { DEFAULT_SITE, type SiteLocation } from '../sun/geo';
import type { SeasonResult, SunHighlight } from '../sun/report';
import type { ExternalBuilding } from './externalFit';
import type { SunDisclosure } from './sunDisclosure';

export interface GalleryItem {
  id: string;
  title: string;
  caption: string;
  url: string;
  kind: 'exterior' | 'interior' | 'aerial' | 'sun' | 'other';
  quality: 'realtime' | 'photoreal';
  shotId?: string;
}

export interface ProjectState {
  name: string;
  customer: string;
  company: string;
  pdfName?: string;
  model: BuildingModel | null;
  design: DesignOptions;
  site: SiteLocation;
  gallery: GalleryItem[];
  elevations: { dir: string; title: string; svg: string }[];
  plans: { level: number; svg: string }[];
  sun: {
    seasons: SeasonResult[];
    highlights: SunHighlight[];
    diagramSvg?: string;
    images: { label: string; url: string }[];
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
  sun: { seasons: [], highlights: [], images: [] },
  videos: [],
  render: { samples: 512, width: 1920, height: 1080 },
  external: null,
};

type Handler = (payload?: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

export function on(ev: string, fn: Handler) {
  if (!handlers.has(ev)) handlers.set(ev, new Set());
  handlers.get(ev)!.add(fn);
  return () => handlers.get(ev)!.delete(fn);
}

export function emit(ev: string, payload?: unknown) {
  handlers.get(ev)?.forEach((f) => f(payload));
}

let idc = 0;
export const uid = (p = 'id') => `${p}-${Date.now().toString(36)}-${(idc++).toString(36)}`;
