/** プロジェクトの状態 */
import type { BuildingModel } from '../core/types';
import { DEFAULT_DESIGN, type DesignOptions } from '../styles/presets';
import { DEFAULT_SITE, type SiteLocation } from '../sun/geo';
import type { SeasonResult, SunHighlight } from '../sun/report';

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
  };
  videos: { title: string; url: string; ext: string }[];
  /** 提案用パース（写真品質）の設定 */
  render: { samples: number; width: number; height: number };
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
