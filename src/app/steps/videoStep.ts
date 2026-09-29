import * as THREE from 'three';
import { h, toast, progressModal, section, segmented, modal, download } from '../dom';
import { state } from '../state';
import type { Step, StepCtx } from '../app';
import { walkthroughProgram, droneProgram, sunTimelapseProgram, type CameraProgram } from '../../video/paths';
import { recordProgram } from '../../video/recorder';
import { currentShots } from './designStep';
import { siteLatLon } from '../../sun/geo';
import { sunPosition, sunDirectionWorld, localDate, sunriseSunset } from '../../sun/solar';

type Kind = 'walk' | 'drone' | 'sunWinter' | 'sunSummer';

const LABEL: Record<Kind, string> = {
  walk: 'ウォークスルー',
  drone: '外観 360°（ドローン）',
  sunWinter: '日照タイムラプス（冬至）',
  sunSummer: '日照タイムラプス（夏至）',
};

let previewRaf = 0;

function makeProgram(ctx: StepCtx, kind: Kind): { program: CameraProgram; before?: (t: number, s: ReturnType<CameraProgram['sample']>) => void } {
  const v = ctx.app.viewer;
  const st = v.state!;
  if (kind === 'walk') return { program: walkthroughProgram(st.model, st.meta, st.site, currentShots(ctx)) };
  if (kind === 'drone') return { program: droneProgram(st.meta) };
  const { lat, lon } = siteLatLon(state.site);
  const y = new Date().getFullYear();
  const [m, d] = kind === 'sunWinter' ? [12, 22] : [6, 21];
  const rs = sunriseSunset(y, m, d, lat, lon);
  const program = sunTimelapseProgram(st.meta, rs.sunrise + 0.2, rs.sunset - 0.2, 12);
  let lastEnv = -1;
  return {
    program,
    before: (_t, s) => {
      if (s.hour == null) return;
      const sp = sunPosition(localDate(y, m, d, s.hour), lat, lon);
      const env = Math.floor(s.hour * 4) !== lastEnv;
      lastEnv = Math.floor(s.hour * 4);
      v.setSunDirection(sunDirectionWorld(sp.azimuth, sp.elevation, st.model.northAngleDeg), env);
      (v.userData.sunCtx as { updateSunMarker?: (d: THREE.Vector3) => void } | undefined)?.updateSunMarker?.(sunDirectionWorld(sp.azimuth, sp.elevation, st.model.northAngleDeg));
    },
  };
}

function stopPreview(ctx: StepCtx) {
  cancelAnimationFrame(previewRaf);
  previewRaf = 0;
  ctx.app.viewer.controls.enabled = true;
}

export const videoStep: Step = {
  id: 'video',
  label: '動画',
  needsModel: true,
  uses3d: true,
  unmount() {
    cancelAnimationFrame(previewRaf);
  },
  mount(ctx) {
    const v = ctx.app.viewer;
    v.setCutaway(null);
    let kind: Kind = 'walk';
    let res: '720' | '1080' = '1080';
    const capEl = h('div', { style: 'position:absolute;left:50%;bottom:8%;transform:translateX(-50%);background:rgba(0,0,0,0.5);color:#fff;padding:6px 16px;border-radius:8px;font-size:18px;display:none' });
    ctx.stage.appendChild(capEl);
    const preview = () => {
      stopPreview(ctx);
      const { program, before } = makeProgram(ctx, kind);
      v.controls.enabled = false;
      const t0 = performance.now();
      const loop = () => {
        const t = (performance.now() - t0) / 1000;
        if (t > program.duration) {
          stopPreview(ctx);
          capEl.style.display = 'none';
          return;
        }
        const s = program.sample(t);
        before?.(t, s);
        v.applyView({ pos: s.pos, target: s.target, fov: s.fov });
        capEl.style.display = s.caption ? 'block' : 'none';
        capEl.textContent = s.caption ?? '';
        v.renderer.domElement.style.filter = s.fade > 0 ? `brightness(${1 - s.fade})` : '';
        previewRaf = requestAnimationFrame(loop);
      };
      previewRaf = requestAnimationFrame(loop);
    };
    const record = async () => {
      stopPreview(ctx);
      capEl.style.display = 'none';
      const { program, before } = makeProgram(ctx, kind);
      const [w, hh] = res === '1080' ? [1920, 1080] : [1280, 720];
      const pm = progressModal(`${LABEL[kind]}を書き出しています（約${Math.round(program.duration)}秒の動画）`);
      const prevView = v.currentView();
      try {
        const out = await recordProgram(v, program, {
          width: w,
          height: hh,
          fps: 30,
          beforeFrame: before,
          signal: pm.signal,
          title: kind.startsWith('sun') ? `${state.name}　${LABEL[kind]}` : undefined,
          onProgress: (r, p) => pm.set(r, `${Math.round(r * 100)}%`, p),
        });
        const url = URL.createObjectURL(out.blob);
        state.videos = state.videos.filter((x) => x.title !== LABEL[kind]);
        state.videos.push({ title: LABEL[kind], url, ext: out.ext });
        pm.close();
        modal(LABEL[kind], h('video', { src: url, controls: true, autoplay: true, style: 'width:100%' }), [
          { label: `${out.ext.toUpperCase()} をダウンロード`, primary: true, onClick: () => download(url, `${state.name}_${LABEL[kind]}.${out.ext}`) },
          { label: '閉じる' },
        ], true);
      } catch (e) {
        pm.close();
        if ((e as Error).name !== 'AbortError') {
          console.error(e);
          toast(`動画の書き出しに失敗しました: ${(e as Error).message}`, 'error');
        }
      } finally {
        v.applyView(prevView);
        v.renderer.domElement.style.filter = '';
      }
    };
    ctx.side.append(
      h('h2', null, '動画'),
      h('p', { class: 'lead' }, '道路から玄関を通って各部屋をめぐるウォークスルー、外観をぐるりと回るドローン映像、一日の日差しの動きを見せるタイムラプスを自動で作成します。部屋名の字幕も入ります。'),
      section(
        '種類',
        segmented<Kind>(
          [
            { value: 'walk', label: 'ウォークスルー' },
            { value: 'drone', label: '外観360°' },
            { value: 'sunWinter', label: '日照(冬)' },
            { value: 'sunSummer', label: '日照(夏)' },
          ],
          kind,
          (k) => {
            kind = k;
          },
        ),
      ),
      section(
        '画質',
        segmented(
          [
            { value: '1080', label: 'フルHD 1080p' },
            { value: '720', label: 'HD 720p（速い）' },
          ],
          res,
          (r) => (res = r as '720' | '1080'),
        ),
      ),
      section(
        '作成',
        h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: preview }, '▶ プレビュー'), h('button', { class: 'btn ghost', onclick: () => stopPreview(ctx) }, '停止')),
        h('button', { class: 'btn primary block', onclick: record }, '🎬 動画を書き出す（MP4）'),
        h('p', { class: 'hint' }, '1コマずつ高画質でレンダリングするため、パソコンの性能により数分かかります。お使いのブラウザが MP4 に未対応の場合は WebM で保存されます。'),
      ),
      section(
        '作成済みの動画',
        ...(state.videos.length
          ? state.videos.map((vd) => h('div', { class: 'btn-row', style: 'align-items:center' }, h('span', { style: 'flex:1;font-size:13px' }, vd.title), h('button', { class: 'btn sm', onclick: () => download(vd.url, `${state.name}_${vd.title}.${vd.ext}`) }, '保存')))
          : [h('p', { class: 'hint' }, 'まだありません')]),
      ),
    );
  },
};
