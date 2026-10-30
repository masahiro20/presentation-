/**
 * お客様向け「体験リンク」を作る。
 * プロジェクト（図面の読み取り結果・テイスト・建設地・パース画像）と動画を保存先（Vercel Blob）へ直接送り、
 * 閲覧ページ（view.html）の URL を返す。お客様はスマホで開き、歩く・光を動かす・テイストを変える・AR で敷地に置く・動画を見る、ができる。
 */
import { upload } from '@vercel/blob/client';
import { state } from './state';
import { serializeProject } from './project';
import { h, modal, toast } from './dom';
import { finishDeltas, estimateSummary } from './steps/estimateStep';
import { exportAr, type ArFiles } from '../scene/exportAr';
import type { Viewer } from '../scene/viewer';

export interface ShareVideo {
  title: string;
  url: string;
}

function newId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

/** 体験リンクの共有に使うアプリ（AR のデータを今の 3D から書き出す） */
export interface ShareApp {
  ensureScene(): void;
  viewer: Viewer;
}

/**
 * AR のデータ（原寸・1/50 模型 × Android 用 glb・iPhone 用 usdz）を作って保存先に置く。
 * お客様のスマホで書き出すと時間がかかり、待っている間にボタンを押した扱いが切れて AR が開かない
 * （iPhone の Quick Look・Android の Scene Viewer はタップの直後にしか開けない）。Scene Viewer は公開 URL のファイルしか開けない。
 * そのため、ここで先に作って置いておき、お客様のスマホはタップで URL を開くだけにする
 */
async function uploadAr(app: ShareApp, id: string, onProgress?: (msg: string) => void): Promise<ArFiles> {
  app.ensureScene();
  const v = app.viewer;
  const out: ArFiles = {};
  const jobs: [keyof ArFiles, 'glb' | 'usdz', number, string][] = [
    ['glb', 'glb', 1, 'ar.glb'],
    ['usdz', 'usdz', 1, 'ar.usdz'],
    ['glbModel', 'glb', 0.02, 'ar-model.glb'],
    ['usdzModel', 'usdz', 0.02, 'ar-model.usdz'],
  ];
  for (let i = 0; i < jobs.length; i++) {
    const [key, fmt, scale, name] = jobs[i];
    onProgress?.(`AR のデータを作っています（${i + 1}/${jobs.length}）`);
    try {
      const data = await exportAr(v, fmt, scale, { tex: fmt === 'glb' ? 512 : 256 });
      const type = fmt === 'glb' ? 'model/gltf-binary' : 'model/vnd.usdz+zip';
      const r = await upload(`share/${id}/${name}`, new Blob([data as BlobPart], { type }), { access: 'public', handleUploadUrl: '/api/share', multipart: data.byteLength > 8e6, contentType: type });
      out[key] = r.url;
    } catch (e) {
      console.warn('AR のデータを作れませんでした', name, e);
    }
  }
  return out;
}

export async function shareProject(onProgress?: (msg: string) => void, app?: ShareApp): Promise<string> {
  if (!state.model) throw new Error('図面を読み込んでから共有してください');
  const id = newId();
  const videos: ShareVideo[] = [];
  for (let i = 0; i < state.videos.length; i++) {
    const vdo = state.videos[i];
    onProgress?.(`動画を送っています（${i + 1}/${state.videos.length}）`);
    const blob = await (await fetch(vdo.url)).blob();
    const r = await upload(`share/${id}/video-${i + 1}.${vdo.ext}`, blob, { access: 'public', handleUploadUrl: '/api/share', multipart: true, contentType: vdo.ext === 'mp4' ? 'video/mp4' : 'video/webm' });
    videos.push({ title: vdo.title, url: r.url });
  }
  const ar = app ? await uploadAr(app, id, onProgress) : {};
  onProgress?.('プロジェクトを送っています');
  const project = await serializeProject();
  // コーディネートの候補の差額（お客様の「仕様を選ぶ」に出す。見積の計算はこちらで済ませて渡す）
  const deltas: Record<string, Record<string, number | null>> = {};
  for (const [catId, it] of Object.entries(state.coord.items)) if ((it.candidates?.length ?? 0) >= 2 && it.status !== 'decided') deltas[catId] = finishDeltas(catId);
  // 概算の総額: お客様の「仕様を選ぶ」で、選ぶたびに総額が動いて見えるように
  const grand = estimateSummary()?.grand;
  const data = { ...project, share: { id, videos, ar, deltas, grand, designer: state.designer, tel: state.tel, email: state.email, url: state.url } };
  const r = await upload(`share/${id}/project.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }), { access: 'public', handleUploadUrl: '/api/share', contentType: 'application/json' });
  const link = `${location.origin}/view.html?p=${encodeURIComponent(r.url)}`;
  // コーディネートの「お客様の選択を受け取る」の受け取り先
  state.coord = { ...state.coord, shareUrl: link };
  return link;
}

/** 共有の案内（進み具合 → できたリンク） */
export async function shareDialog(app?: ShareApp) {
  const msg = h('p', { class: 'hint' }, '準備しています…');
  const box = h('div', null, msg);
  const m = modal('お客様に渡す体験リンク', box, []);
  try {
    const url = await shareProject((t) => (msg.textContent = t), app);
    box.replaceChildren(
      h('p', null, 'スマホで開くと、歩く・光を動かす・テイストを変える・AR で敷地に置く・動画を見る、ができます。気に入った構図に「いいね」、思いついたご要望を書いて送れます（読込画面の「ご要望との照合」とコーディネートで受け取れます）。LINE やメールでこのリンクを送ってください。'),
      h('input', { type: 'text', readonly: true, value: url, style: 'width:100%;font-size:13px', onclick: (e: Event) => (e.target as HTMLInputElement).select() }),
      h(
        'div',
        { class: 'btn-row', style: 'margin-top:10px' },
        h('button', { class: 'btn primary', onclick: () => navigator.clipboard.writeText(url).then(() => toast('リンクをコピーしました', 'ok')) }, 'リンクをコピー'),
        h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener' }, '自分のパソコンで開く'),
        typeof navigator.share === 'function' ? h('button', { class: 'btn', onclick: () => navigator.share({ title: state.name, url }).catch(() => {}) }, '送る…') : null,
      ),
      h('p', { class: 'hint' }, `収録: パース ${state.gallery.length} 枚・動画 ${state.videos.length} 本。動画は外部で仕上げたルームツアーを、パース →「仕上げ（外部）」で取り込むと入ります。`),
    );
  } catch (e) {
    const err = e as Error & { status?: number };
    const noStore = /no-store|503|BLOB_READ_WRITE_TOKEN/.test(err.message);
    box.replaceChildren(h('p', { style: 'color:#b04a3a' }, noStore ? '保存先がまだ用意されていません。' : `共有に失敗しました: ${err.message}`));
    if (noStore) box.appendChild(h('p', { class: 'hint' }, 'Vercel の madori-presentation プロジェクト → Storage → Create Database → Blob を一度作ってつなぐと使えるようになります（無料枠で足ります）。つないだ後は再デプロイが必要です。'));
  }
  void m;
}
