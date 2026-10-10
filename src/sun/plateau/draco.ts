/**
 * Draco デコーダ（ブラウザ: three の DRACOLoader をモジュール単位で 1 個。Node のテストは tests/helpers/nodeDraco.ts を注入）。
 *
 * Vite は DRACOLoader を import するだけで dist/assets に draco_decoder-*.wasm/.js・draco_wasm_wrapper-*.js を同梱する
 * （DRACOLoader が new URL(..., import.meta.url) で参照しているため。setDecoderPath 不要）。
 * wasm を配信できない公開先（.wasm を application/wasm で返さない・CSP で弾かれる等）では preload が失敗するので、
 * setDecoderConfig({ type: 'js' }) で asm.js 版（draco_decoder.js）のデコーダを作り直してもう一度試す。
 * Draco の Worker は Blob URL（CSP を入れるときは worker-src blob: が必要）。
 * 仕様: scratchpad/plateau-spec.md §2.5（W4 が実装）
 */
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import type { DracoDecoderLike } from './types';

/** 差し替えたデコーダの作り方（null = 既定の DRACOLoader） */
let factory: (() => DracoDecoderLike) | null = null;
/** モジュール単位のデコーダ（初回の getDracoDecoder で作る） */
let instance: DracoDecoderLike | null = null;
/** 今のデコーダの種類（wasm で失敗したら js で作り直す。js でも失敗したら捨てて次回 wasm から） */
let decoderType: 'wasm' | 'js' = 'wasm';
/** ensureDracoReady の進行中・完了の Promise（失敗したら捨てて次回もう一度） */
let ready: Promise<void> | null = null;

/** DRACOLoader の preload 内部（decoderPending）に触るための最小の形。三角形の復号を始める前に設定を変えるため preload は作成時に呼ぶ */
interface DracoLoaderInternals {
  setDecoderConfig?(config: { type: 'js' | 'wasm' }): unknown;
  _initDecoder?(): Promise<unknown>;
  decoderPending?: Promise<unknown> | null;
  dispose?(): unknown;
}

const isPromiseLike = (v: unknown): v is PromiseLike<unknown> => !!v && typeof (v as PromiseLike<unknown>).then === 'function';

/** デコーダごとの preload の Promise（DRACOLoader は decoderPending、注入デコーダは preload() の戻り値）。preload を 2 度呼ばずに待つため */
const preloadOf = new WeakMap<DracoDecoderLike, Promise<void>>();

/** デコーダを 1 個作る（既定: new DRACOLoader().setWorkerLimit(4)、type 'js' のときは setDecoderConfig してから preload） */
function createDecoder(type: 'wasm' | 'js'): DracoDecoderLike {
  // @types/three の DRACOLoader には decodeDracoFile の宣言が無い（実装にはある）ので DracoDecoderLike に読み替える
  const d: DracoDecoderLike = factory ? factory() : (new DRACOLoader().setWorkerLimit(4) as unknown as DracoDecoderLike);
  const internals = d as DracoDecoderLike & DracoLoaderInternals;
  if (type === 'js' && typeof internals.setDecoderConfig === 'function') internals.setDecoderConfig({ type: 'js' });
  const r = d.preload();
  // DRACOLoader の preload は this を返し内部の decoderPending に Promise を持つ。注入デコーダは preload() が Promise を返すことがある
  const pending = isPromiseLike(r) ? r : isPromiseLike(internals.decoderPending) ? internals.decoderPending : null;
  if (pending) {
    const p = Promise.resolve(pending).then(() => undefined);
    // 失敗は ensureDracoReady で扱う（ここでは未処理の拒否にしない）
    p.catch(() => undefined);
    preloadOf.set(d, p);
  }
  return d;
}

/** preload の完了を待つ（作成時に控えた Promise。無ければ即 resolve = 同期に準備できるデコーダ） */
async function awaitPreload(d: DracoDecoderLike): Promise<void> {
  const p = preloadOf.get(d);
  if (p) await p;
}

/** 既定: new DRACOLoader().setWorkerLimit(4).preload()（モジュール単位 1 個） */
export function getDracoDecoder(): DracoDecoderLike {
  if (!instance) instance = createDecoder(decoderType);
  return instance;
}

/** デコーダの作り方を差し替える（テスト・Node 用）。null で既定に戻す。今あるデコーダは捨てる */
export function setDracoDecoderFactory(f: (() => DracoDecoderLike) | null): void {
  factory = f;
  instance = null;
  decoderType = 'wasm';
  ready = null;
}

/**
 * preload 待ち。wasm 取得失敗なら setDecoderConfig({ type: 'js' }) で作り直してもう一度。
 * 両方失敗なら最後のエラーを投げ（呼び出し側は 'error/decode' に畳む）、デコーダは捨てて次の呼び出しで wasm からやり直す（通信状況が変われば通る）
 */
export async function ensureDracoReady(): Promise<void> {
  if (ready) return ready;
  const run = async () => {
    const first = getDracoDecoder();
    try {
      await awaitPreload(first);
    } catch (e) {
      if (decoderType === 'js') throw e;
      console.warn('PLATEAU: Draco の wasm デコーダを用意できなかったため JS 版で再試行します', e);
      (first as DracoDecoderLike & DracoLoaderInternals).dispose?.();
      decoderType = 'js';
      instance = createDecoder('js');
      await awaitPreload(instance);
    }
  };
  const p = run();
  ready = p;
  p.catch(() => {
    if (ready !== p) return;
    ready = null;
    (instance as (DracoDecoderLike & DracoLoaderInternals) | null)?.dispose?.();
    instance = null;
    decoderType = 'wasm';
  });
  return p;
}
