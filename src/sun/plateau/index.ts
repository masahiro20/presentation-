/**
 * PLATEAU 3D Tiles 連携（国土交通省 3D都市モデル）の入口。両アプリ（日照ツール・間取りプレゼン）はここから使う。
 * 仕様: scratchpad/plateau-spec.md §2
 */
export type * from './types';
export type { BatchTable, B3dm } from './b3dm';
export { parseB3dm, peekB3dmHeader } from './b3dm';
export type { TileNode, ContentTile, ParsedTileset } from './tileset';
export { parseTileset, selectContentTiles } from './tileset';
export { getDracoDecoder, setDracoDecoderFactory, ensureDracoReady } from './draco';
export { decodeTileGlb } from './glb';
export type { SplitOptions, BuildingRecord, SplitResult } from './buildings';
export { readBuildingRecords, splitBuildings, footprintFromBottomFaces, sortRoofFirst, compareWithRecord } from './buildings';
export type { PlateauIndexSet, PlateauArea, PlateauIndex, NetOpts } from './catalog';
export { REVERSE_GEOCODER_URL, PLATEAU_LATEST_URL, loadPlateauIndex, muniCodesAround, muniCodesByRegion, pickDataset, resolveTilesetUrl } from './catalog';
export type { PlateauFetchOptions, PlateauFetchResult } from './fetch';
export { fetchPlateauBuildings, fetchCached, clearPlateauCaches, plateauDatasetLabel } from './fetch';
export { quantizeMesh, dequantizeMesh, quantizedBytes } from './meshCodec';
export type { RoofUVSpec, PlateauGeometryOptions } from './geometry';
export { buildPlateauGeometry } from './geometry';
