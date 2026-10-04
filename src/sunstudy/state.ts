/** 日照シミュレーション（3D データ読み込み版）の状態 */
import type { AerialImage, GeoFrame, HeightGrid, ImportedModel, LatLon, MeasurePoint, ModelPlacement, Neighbor, NeighborSource } from './types';
import { DEFAULT_PLACEMENT } from './types';

export interface StudyUI {
  year: number;
  month: number;
  day: number;
  /** ローカル時刻 (h, 小数) */
  hour: number;
  playing: boolean;
  speed: number;
}

export interface StudyState {
  name: string;
  customer: string;
  company: string;
  /** 建設地（ピン）。未設定なら null */
  frame: GeoFrame | null;
  /** 敷地の輪郭（任意。地図上で描く） */
  sitePolygon: LatLon[];
  /** 地形 */
  grid: HeightGrid | null;
  aerial: AerialImage | null;
  /** 遠方の地形（山・丘）による地平線の高度角（方位 0..359°、真北から時計回り）。無ければ null */
  horizon: { elevDeg: Float32Array; source: string; radiusKm: number } | null;
  /** 周辺建物（自動取得 + 手動） */
  neighbors: Neighbor[];
  neighborSources: NeighborSource[];
  neighborNotes: string[];
  /** 自動取得した建物への上書き（高さ修正・非表示）。id → 値 */
  neighborOverrides: Record<string, { height?: number; hidden?: boolean }>;
  /** 読み込んだ 3D データと配置 */
  model: ImportedModel | null;
  placement: ModelPlacement;
  /** 測定点 */
  points: MeasurePoint[];
  ui: StudyUI;
  show: { aerial: boolean; neighbors: boolean; terrain: boolean; sunPath: boolean; site: boolean; points: boolean };
  /** 周辺環境の取得状況 */
  env: { loaded: boolean; loading: boolean; error: string | null; attribution: string };
  /** 解析結果（レポート用） */
  results: {
    images: { label: string; url: string }[];
    diagramSvg?: string;
    diagramSummary?: { hour: number; maxDist: number }[];
    heatmapUrl?: string;
    heatmapLabel?: string;
    facadeUrl?: string;
    mapUrl?: string;
  };
}

export const study: StudyState = {
  name: '〇〇様邸 日照検討',
  customer: '〇〇様',
  company: '',
  frame: null,
  sitePolygon: [],
  grid: null,
  aerial: null,
  horizon: null,
  neighbors: [],
  neighborSources: [],
  neighborNotes: [],
  neighborOverrides: {},
  model: null,
  placement: { ...DEFAULT_PLACEMENT },
  points: [],
  ui: { year: new Date().getFullYear(), month: 12, day: 22, hour: 10, playing: false, speed: 1 },
  show: { aerial: true, neighbors: true, terrain: true, sunPath: true, site: true, points: true },
  env: { loaded: false, loading: false, error: null, attribution: '' },
  results: { images: [] },
};

type Handler = (payload?: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

/**
 * イベント:
 *  'frame'      ピン位置・住所が変わった
 *  'site'       敷地ポリゴンが変わった
 *  'env'        地形・航空写真・周辺建物の取得状況が変わった（再構築が必要）
 *  'neighbors'  周辺建物の一覧が変わった（手動追加・高さ修正・削除）
 *  'model'      3D データを読み込んだ／差し替えた
 *  'placement'  単位・向き・位置・高さ・表示が変わった
 *  'points'     測定点が変わった
 *  'project'    プロジェクト名など
 *  'time'       日付・時刻が変わった
 */
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

/** 表示中の周辺建物（上書きを適用） */
export function visibleNeighbors(): Neighbor[] {
  return study.neighbors
    .map((n) => {
      const o = study.neighborOverrides[n.id];
      return o ? { ...n, height: o.height ?? n.height, hidden: o.hidden ?? n.hidden, heightKind: o.height != null ? ('manual' as const) : n.heightKind } : n;
    })
    .filter((n) => !n.hidden);
}
