/**
 * 動画書き出し
 * 1コマずつ高品質にレンダリングし、WebCodecs (H.264) で MP4 に。未対応環境では MediaRecorder (WebM)。
 */
import * as THREE from 'three';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { Viewer } from '../scene/viewer';
import type { CameraProgram } from './paths';

export interface RecordOptions {
  width: number;
  height: number;
  fps: number;
  /** 各フレームの前に呼ばれる（太陽の時刻変更など） */
  beforeFrame?: (t: number, sample: ReturnType<CameraProgram['sample']>) => void;
  onProgress?: (ratio: number, previewUrl?: string) => void;
  signal?: AbortSignal;
  title?: string;
  /** 字幕を焼き込む */
  captions?: boolean;
}

export interface RecordResult {
  blob: Blob;
  mime: string;
  ext: 'mp4' | 'webm';
}

async function pickCodec(w: number, h: number, fps: number): Promise<{ codec: string; muxCodec: 'avc' | 'vp9' } | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const cands: [string, 'avc' | 'vp9'][] = [
    ['avc1.640033', 'avc'],
    ['avc1.4d0033', 'avc'],
    ['avc1.42003e', 'avc'],
    ['vp09.00.40.08', 'vp9'],
  ];
  for (const [codec, muxCodec] of cands) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: 12_000_000, framerate: fps });
      if (r.supported) return { codec, muxCodec };
    } catch {
      /* 次へ */
    }
  }
  return null;
}

/** 字幕・フェード・タイトルを合成する 2D キャンバス */
class Compositor {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d')!;
  }
  draw(src: HTMLCanvasElement, fade: number, caption?: string, title?: string) {
    const { ctx, w, h } = this;
    ctx.drawImage(src, 0, 0, w, h);
    if (caption) {
      const fs = Math.round(h * 0.042);
      ctx.font = `600 ${fs}px 'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif`;
      const tw = ctx.measureText(caption).width;
      const pad = fs * 0.7;
      const x = w / 2 - tw / 2 - pad;
      const y = h * 0.86 - fs;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.roundRect(x, y, tw + pad * 2, fs * 1.8, fs * 0.4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(caption, w / 2 - tw / 2, y + fs * 0.9);
    }
    if (title) {
      const fs = Math.round(h * 0.03);
      ctx.font = `600 ${fs}px 'Noto Sans JP','Hiragino Sans',sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.textBaseline = 'top';
      ctx.fillText(title, fs, fs);
    }
    if (fade > 0) {
      ctx.fillStyle = `rgba(0,0,0,${Math.min(1, fade)})`;
      ctx.fillRect(0, 0, w, h);
    }
  }
}

export async function recordProgram(viewer: Viewer, program: CameraProgram, opts: RecordOptions): Promise<RecordResult> {
  const { width, height, fps } = opts;
  const renderer = viewer.renderer;
  const camera = viewer.camera;
  const prevSize = renderer.getSize(new THREE.Vector2());
  const prevPR = renderer.getPixelRatio();
  viewer.pause(true);
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  viewer.composer.setPixelRatio(1);
  viewer.composer.setSize(width, height);
  camera.aspect = width / height;
  camera.shiftY = 0;
  camera.updateProjectionMatrix();
  const comp = new Compositor(width, height);
  const frames = Math.ceil(program.duration * fps);

  const renderAt = (i: number) => {
    const t = i / fps;
    const s = program.sample(t);
    opts.beforeFrame?.(t, s);
    camera.fov = s.fov;
    camera.position.copy(s.pos);
    camera.lookAt(s.target);
    camera.updateProjectionMatrix();
    viewer.renderFrame();
    comp.draw(renderer.domElement, s.fade, opts.captions !== false ? s.caption : undefined, opts.title);
  };

  try {
    const codec = await pickCodec(width, height, fps);
    if (codec) {
      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: codec.muxCodec, width, height, frameRate: fps },
        fastStart: 'in-memory',
      });
      let encErr: unknown = null;
      const enc = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => (encErr = e),
      });
      enc.configure({ codec: codec.codec, width, height, bitrate: Math.round(width * height * fps * 0.18), framerate: fps });
      for (let i = 0; i < frames; i++) {
        if (opts.signal?.aborted) throw new DOMException('中止しました', 'AbortError');
        if (encErr) throw encErr;
        renderAt(i);
        const vf = new VideoFrame(comp.canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
        enc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
        vf.close();
        while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
        if (i % 5 === 0) {
          opts.onProgress?.(i / frames, i % 30 === 0 ? comp.canvas.toDataURL('image/jpeg', 0.6) : undefined);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      await enc.flush();
      muxer.finalize();
      const buf = (muxer.target as ArrayBufferTarget).buffer;
      return { blob: new Blob([buf], { type: 'video/mp4' }), mime: 'video/mp4', ext: 'mp4' };
    }
    // ---- フォールバック: MediaRecorder ----
    const stream = comp.canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.start();
    for (let i = 0; i < frames; i++) {
      if (opts.signal?.aborted) break;
      const t0 = performance.now();
      renderAt(i);
      track.requestFrame();
      opts.onProgress?.(i / frames);
      const wait = 1000 / fps - (performance.now() - t0);
      await new Promise((r) => setTimeout(r, Math.max(0, wait)));
    }
    rec.stop();
    await done;
    return { blob: new Blob(chunks, { type: 'video/webm' }), mime: 'video/webm', ext: 'webm' };
  } finally {
    renderer.setPixelRatio(prevPR);
    renderer.setSize(prevSize.x, prevSize.y, false);
    viewer.pause(false);
    viewer.resize();
  }
}
