/**
 * 写真仕上げ・動画化のプロンプト集（いつでもコピーできるように固定で置く）。
 * パース画面の「プロンプト集」と、単独のページ（prompts.html: スマホで Gemini を開きながら使う）で同じものを出す。
 * カット集の ZIP（cuts.ts）は物件ごとの素材名が入った専用の文を作る。こちらは物件によらない汎用の文と、質を上げる追加の文・崩れたときの直し。
 * 考え方は finishGuide.ts と同じ: 形はツールの下絵が決め、AI には質感と光（動画はカメラの動き 1 つ）だけを任せる。
 */
import { h } from './dom';
import './promptLibrary.css';

export type PromptItem = { label: string; note?: string; text: string };
export type PromptGroup = { title: string; how: string; items: PromptItem[] };

const EXT_BASE =
  'This is an architectural visualization base image of a Japanese detached house. Keep the composition, camera position, field of view, the position and number of walls, windows and doors, and the roof shape exactly as in the image; only upgrade materials and lighting to photorealistic quality. Do not add or remove windows or doors. No people, no text, no signage, no extra props. Match the colors and textures of the attached material board photo.\n' +
  'Photorealistic architectural exterior photography, vertical lines kept vertical, 24 mm lens, highest resolution.';

const INT_BASE =
  'This is an architectural visualization base image of a Japanese house interior. Keep the composition, camera position, field of view, the position and number of walls, windows and doors, the stairs and the furniture layout and sizes exactly as in the image; only upgrade materials and lighting to photorealistic quality. Do not add or remove windows, doors or furniture. No people, no text, no extra props (a branch in a vase and a few books at most). Match the colors and textures of the attached material board photo. If an exterior photo is attached, match its color grading.\n' +
  'Photorealistic architectural interior photography, 20–24 mm lens, vertical lines kept vertical, highest resolution. Keep shaded areas dark and preserve natural contrast; do not brighten the room evenly.';

export const PROMPT_GROUPS: PromptGroup[] = [
  {
    title: '1. 共通の文（最初に貼る）',
    how: '新しい会話で、下絵の画像と「00_素材ボード.jpg」（あれば先に仕上げた外観の写真も）を添付し、まずこの文を貼ります。',
    items: [
      { label: '外観の共通文', text: EXT_BASE },
      { label: '内観の共通文', text: INT_BASE },
    ],
  },
  {
    title: '1-2. X シリーズの写りに寄せる（最高品質の手本）',
    how: '御社の X シリーズ施工事例集（仕上げパース）の写りを言葉にしたものです。共通の文の後ろに足します。事例集の写真を 1 枚「お手本」として添えると、さらに近づきます（最後の文も足す）。',
    items: [
      { label: '外観: X シリーズの写り', note: 'おすすめ', text: 'Look and feel: crisp clear blue sky with scattered white cumulus clouds, bright afternoon sun with sharp but soft-edged shadows and dappled tree shadows on the walls. A modern box-shaped house with finely textured plaster walls in charcoal and warm gray, slim black aluminum window frames, thin black fascia and a light concrete base. Light multi-stem deciduous trees with fresh green leaves and low planting along the walls, a smooth concrete approach, a dark asphalt road in the foreground, ordinary Japanese suburban houses softly in the background. Low eye-level camera about 1.5 m, wide-angle 20–24 mm, two-point perspective, rich but natural contrast.' },
      { label: '内観: X シリーズの写り', note: 'おすすめ', text: 'Look and feel: calm, high-end Japanese interior. Bright sunlight entering through large full-height glass in slim black steel frames, crisp dappled leaf shadows on the floor and walls. Matte warm white walls, natural materials with real texture (fine wood slats, large-format stone tiles, oak), minimal black furniture. Strong contrast between sunlit and shaded areas, the outside greenery fresh and vivid. Eye-level camera, wide-angle 20 mm, two-point perspective, architectural magazine quality.' },
      { label: 'お手本の写真を添えたとき', text: 'Match the photographic look of the attached reference photo (sky, sunlight, color grading, contrast, planting and texture of the walls) — but do not copy its building, layout or windows. The building must stay exactly as in the base image.' },
    ],
  },
  {
    title: '2. 場面ごと（共通の文の後ろに足す）',
    how: '共通の文に続けて、写っている場面の文を 1 つ足します。',
    items: [
      { label: '外観: 道路側（昼）', text: 'Daytime natural light with soft shadows. Quiet Japanese residential neighborhood with low, unobtrusive neighboring houses, asphalt road, natural sky with a few soft clouds, a multi-stem deciduous tree and low ground-cover planting at the entrance.' },
      { label: '外観: 庭側', text: 'Garden side of the house in soft afternoon light. A wooden deck and a small lawn, a multi-stem deciduous tree casting dappled shadows on the wall, large windows showing a glimpse of the warm interior. Calm and private, no neighbors in focus.' },
      { label: '外観: 空から（俯瞰）', text: 'Aerial view from about 30 m, slightly oblique. Show the roof clearly and the surrounding residential streets in soft focus. Natural daylight, realistic roof materials and gutters.' },
      { label: '内観: LDK', text: 'Living, dining and kitchen. Soft natural daylight from the windows with gentle contact shadows on the oak floor. Matte white plaster walls. Minimal flat-front kitchen with a thin counter and no visible handles. The exterior through the windows is slightly bright with garden trees and sky, not blown out. No curtains or blinds; clear glass in thin black frames.' },
      { label: '内観: 吹抜・階段', text: 'Double-height space with the stair. Keep the stair type, direction and handrail exactly as in the image. Daylight falling from the high windows, with a soft gradient of light down the wall. Thin black steel details, oak treads.' },
      { label: '内観: キッチン', text: 'Kitchen seen from the dining side. Minimal flat-front cabinets, a thin counter with a subtle stone or stainless texture, integrated hood, a few neatly placed items only. Soft window light grazing the counter.' },
      { label: '内観: 寝室・子ども部屋', text: 'Bedroom. Calm, soft daylight, slightly warmer tone. Simple bedding in white and light gray linen. Oak floor, matte white walls. No clutter.' },
      { label: '内観: 洗面・浴室・トイレ', text: 'Washroom. Bright but soft light, clean white surfaces, matte tiles or plaster, a simple mirror and counter as in the image. No towels piled up, no bottles.' },
      { label: '内観: 玄関・土間', text: 'Entrance hall with a concrete or tiled earthen floor (doma) and a step up to the oak floor. Soft light from the entrance door glass, a simple shoe storage as in the image. Quiet, uncluttered.' },
      { label: '内観: 畳コーナー・和室', text: 'Tatami corner with real woven rush texture and thin borders, a low window with soft side light, calm and minimal Japanese atmosphere.' },
    ],
  },
  {
    title: '3. 質を一段上げる（最後に足す）',
    how: '共通の文＋場面の文の後ろに、必要なものを 1〜3 つ足します。全部足すと指示が多すぎて形が崩れやすいので、写りに合わせて選んでください。',
    items: [
      { label: 'カメラ・レンズ（写真らしさ）', note: 'まず足すならこれ', text: 'Shot on a full-frame camera with a 24 mm tilt-shift lens at f/8, ISO 100, on a tripod, natural white balance. Two-point perspective with perfectly vertical lines.' },
      { label: '素材の本物らしさ', note: 'CG っぽさ・プラスチック感を消す', text: 'Realistic material detail: subtle trowel texture on the plaster, natural grain and color variation in the wood, fine joints between boards, soft reflections on the floor and glass. Avoid a CGI or plastic look.' },
      { label: '光の本物らしさ', note: '平板・白っぽいとき', text: 'Physically accurate daylight: soft bounce light from the floor and walls, soft-edged sun patches, gentle shading in the corners, natural falloff of light deeper into the room. No HDR halos, no oversaturation.' },
      { label: '建築雑誌の写り', note: '御社の落ち着いたトーンに', text: 'Editorial architectural photography like a Japanese residential architecture magazine: calm, restrained color grading, slightly muted tones, clean composition, a sense of quiet everyday life.' },
      { label: '植栽・外構（外観）', text: 'Mature, natural-looking planting: a multi-stem deciduous tree with fine branches and light foliage, low ground cover and a few ornamental grasses, realistic gravel and concrete paving with subtle weathering.' },
      { label: '朝の光', text: 'Change the time to early morning: low, warm raking sunlight, long soft shadows, a light haze in the air. Keep everything else the same.' },
      { label: '夕景・夜（ブルーアワー）', text: 'Change the time to blue hour: deep blue sky, warm 2700K downlights and pendants glowing through the windows, cozy contrast between inside and outside. Keep everything else the same.' },
      { label: '曇りのやわらかい光', text: 'Change the weather to a bright overcast day: very soft, even light with gentle shadows, natural colors. Keep everything else the same.' },
      { label: '解像度を上げる（仕上げの最後に）', text: 'Upscale this image to the highest resolution and sharpen fine details. Do not change anything else.' },
    ],
  },
  {
    title: '4. 崩れたときの直し（同じ会話で返す）',
    how: '仕上がりを見て、崩れた所に合う文を同じ会話で返します。直らないときは新しい会話でやり直す方が早いです。',
    items: [
      { label: '窓・ドア・屋根の形が変わった', text: 'Keep the windows, doors and roof exactly as in the base image. Only change materials and lighting.' },
      { label: '家具が増えた・変わった', text: 'Keep the furniture, windows and doors exactly as in the base image. Do not add any objects. Only change materials and lighting.' },
      { label: '白っぽく平板', text: 'Lower the exposure slightly and keep the shadows. More contrast between the lit and shaded areas.' },
      { label: '暗すぎる', text: 'Raise the exposure slightly, as if more daylight comes through the windows. Keep the shadows soft and natural.' },
      { label: '色が素材ボードと違う', text: 'Match the wall, floor and exterior colors to the attached material board exactly.' },
      { label: 'カーテンが付いた', text: 'Remove the curtains and blinds. Clear glass with the garden visible.' },
      { label: '天井が木になった', text: 'The ceiling is flat matte white plaster, not wood.' },
      { label: '人・文字・看板が出た', text: 'Remove all people, text, logos and signs.' },
      { label: '縦の線が傾いている', text: 'Make all vertical lines perfectly vertical (correct the perspective). Do not change anything else.' },
    ],
  },
  {
    title: '5. 動画にする（Kling・Runway・Veo）',
    how: '仕上げた写真を「最初のフレーム（Image to Video）」に入れ、1 つ貼ります。長さは 5 秒。2〜3 本作って一番崩れていないものを選びます。',
    items: [
      { label: '外観: ゆっくり近づく', text: '5-second single continuous shot. Eye-level camera slowly dollies in toward the entrance, about 1 m, smooth and steady. The building, the number and shape of windows and doors stay exactly the same, with no morphing or warping; vertical lines stay vertical. No people, animals, moving cars or text. Only the leaves, clouds and the light move subtly. Calm, photorealistic architectural film, as if the photograph came to life.' },
      { label: '外観（空から）: ゆっくり回る', text: '5-second single continuous shot. The camera slowly orbits about 15 degrees to the right around the house, smooth and steady. The building, the number and shape of windows and doors stay exactly the same, with no morphing or warping. No people, animals, moving cars or text. Only the leaves, clouds and the light move subtly. Calm, photorealistic architectural film.' },
      { label: '内観: ゆっくり進む', text: '5-second single continuous shot. Eye-level camera slowly dollies forward about 1 m into the room, smooth and steady. The room, furniture and the number and shape of windows and doors stay exactly the same, with no morphing or warping; vertical lines stay vertical. No people, animals or text. Only the light and the trees outside the windows move subtly. Calm, photorealistic architectural film, as if the photograph came to life.' },
      { label: '内観: 光が移ろう（カメラ固定）', text: '5-second locked-off shot, the camera does not move. Sunlight patches slowly drift across the floor and the leaves outside sway gently. Everything else stays exactly the same, with no morphing. No people or text. Calm, photorealistic.' },
      { label: '最初と最後のフレームでつなぐ（ルームツアー）', note: 'Veo 3.1・Kling 3.0 以降', text: '5-second single continuous shot that moves smoothly from the first frame to the last frame at eye level, like walking slowly through the house. Keep the walls, windows, doors and furniture exactly as in the two frames; do not invent new rooms or corridors. No people or text. Calm, photorealistic architectural film.' },
    ],
  },
];

/** ZIP に入れるテキスト版 */
export function promptLibraryText(): string {
  const out = ['プロンプト集（写真の仕上げ・動画化）— Home Landick Studio', '使い方: 1 の共通の文 →（おすすめ）1-2 の X シリーズの写り → 2 の場面の文 → 必要なら 3 の文、の順に続けて貼る。崩れたら 4 を同じ会話で返す。', ''];
  for (const g of PROMPT_GROUPS) {
    out.push(`━━ ${g.title} ━━`, g.how, '');
    for (const it of g.items) out.push(`■ ${it.label}${it.note ? `（${it.note}）` : ''}`, it.text, '');
  }
  return out.join('\n');
}

async function copyText(text: string, btn: HTMLButtonElement, pre: HTMLElement) {
  const done = (ok: boolean) => {
    const was = btn.dataset.label ?? btn.textContent ?? 'コピー';
    btn.dataset.label = was;
    btn.textContent = ok ? 'コピーしました' : '選択しました（⌘C / Ctrl+C）';
    btn.classList.toggle('done', ok);
    window.setTimeout(() => {
      btn.textContent = was;
      btn.classList.remove('done');
    }, 1600);
  };
  try {
    if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    done(true);
  } catch {
    // クリップボードが使えない環境では文を選択状態にして、手でコピーしてもらう
    const r = document.createRange();
    r.selectNodeContents(pre);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
    done(false);
  }
}

function itemEl(it: PromptItem): HTMLElement {
  const pre = h('pre', { class: 'pl-text' }, it.text);
  const btn: HTMLButtonElement = h('button', { class: 'pl-copy', onclick: () => void copyText(it.text, btn, pre) }, 'コピー');
  return h('div', { class: 'pl-item' }, h('div', { class: 'pl-head' }, h('b', null, it.label), it.note ? h('span', { class: 'pl-note' }, it.note) : null, btn), pre);
}

/** プロンプト集の本体（パース画面のダイアログ・単独ページで共通） */
export function renderPromptLibrary(): HTMLElement {
  return h(
    'div',
    { class: 'pl' },
    h('p', { class: 'pl-lead' }, '使い方: ① 共通の文 →（おすすめ）X シリーズの写り → ② 場面の文 → 必要なら ③ の文、の順に続けて貼ります。崩れたら ④ を同じ会話で返します。Gemini では「画像を作成」を選び、モデルを Pro（思考モード）にすると Nano Banana Pro になります。1 カットごとに新しい会話で。お客様のお名前・住所は書かないでください。'),
    PROMPT_GROUPS.map((g) => h('section', { class: 'pl-group' }, h('h4', null, g.title), h('p', { class: 'pl-how' }, g.how), g.items.map((it) => itemEl(it)))),
  );
}
