/**
 * こだわり指定（参考資料）の画面
 *
 * 設計士・コーディネーターが「ここはこの仕様・この写真のように提案したい」を、部位ごとに登録する。
 * 入口は 3 つ: 読み込みの画面（PDF と一緒に）・3D の階段のパネル（選んだ階段に）・パースの仕上げ（カット集）。
 * 登録した指定は、階段のつくり・手すり・段数として 3D と図面に入り、仕上げの説明文と同梱の参考画像にもなる（core/focus.ts）。
 */
import { clear, h, modal, segmented, toast } from './dom';
import { beforeModelEmit, emit, on, state, uid } from './state';
import {
  applyFocus,
  cleanStairLook,
  FOCUS_MAX_IMAGES,
  FOCUS_PART_LABEL,
  FOCUS_PARTS,
  focusFromModel,
  focusLookShort,
  focusTitle,
  JOINERY_LABEL,
  JOINERY_VARIANTS,
  normalizeFocus,
  STAIR_BUILD_LABEL,
  STAIR_BUILDS,
  STAIR_FRAME_LABEL,
  STAIR_FRAMES,
  STAIR_RAIL_LABEL,
  STAIR_RAILS,
  STAIR_STRINGER_LABEL,
  STAIR_STRINGERS,
  STAIR_TREAD_LABEL,
  STAIR_TREADS,
  stairLevels,
  stairNoteIndexToEdit,
  type FocusNote,
  type FocusPart,
} from '../core/focus';
import type { BuiltinVariant, StairBuild, StairFrame, StairLook, StairRail, StairStringer, StairTread } from '../core/types';
import type { DesignOptions, TimeOfDay } from '../styles/presets';
import { resolveSpec, VOID_GUARD_SPECS, type VoidGuardSpec } from '../styles/spec';
import { shrinkPhoto } from '../coordinate/samples';
import { selectedProduct, STAIR_PRODUCT_OF_BUILD, stairBuildOf } from '../coordinate/catalog';
import { categoryById, decide, itemOf } from '../coordinate/decisions';
import { getGeminiKey } from './aiFinish';
import { getReviewModel } from './aiDesigner';
import { readFocusImages } from './focusAi';

/** いまのプロジェクトのこだわり指定 */
export const focusNotes = (): FocusNote[] => state.focus ?? [];

// モデルが変わるたび（図面の読み直し・プロジェクトを開く・方眼や 3D の編集）に、階段の指定を当て直す
beforeModelEmit(() => {
  applyFocus(state.model, focusNotes());
});

/** 指定を入れ替えて、3D・図面に反映する */
export function setFocus(notes: FocusNote[]): number {
  state.focus = normalizeFocus(notes);
  const n = applyFocus(state.model, state.focus);
  if (state.model) emit('model');
  emit('focus');
  return n;
}

/** 1 件を足す・置き換える（同じ id があれば置き換え） */
export function upsertFocus(note: FocusNote): number {
  const list = focusNotes().slice();
  const i = list.findIndex((x) => x.id === note.id);
  if (i >= 0) list[i] = note;
  else list.push(note);
  return setFocus(list);
}

/**
 * 3D の階段のパネルから: その階の階段のつくり・手すりを変える。
 * その階を決めた指定があればそれを直す。無ければ、階段が 1 か所だけの家（2 階建て）は「すべての階段」の指定を直し
 * （同じ階段の指定を 2 つにしない）、3 階建てなどはその階の指定を新しく作る（「すべての階段」の指定は触らない）
 */
export function setStairLookAt(level: number, patch: Partial<StairLook>): void {
  const list = focusNotes().slice();
  const i = stairNoteIndexToEdit(list, level, stairLevels(state.model));
  const base: FocusNote = i >= 0 ? list[i] : { id: uid('fc'), part: 'stair', level, note: '', images: [], at: new Date().toISOString() };
  const stair = cleanStairLook({ ...(base.stair ?? {}), ...patch });
  const next: FocusNote = { ...base };
  if (stair) next.stair = stair;
  else delete next.stair;
  if (i >= 0) list[i] = next;
  else list.push(next);
  // 中身が空になった指定（言葉も画像もつくりも無い）は normalizeFocus が落とす
  state.focus = normalizeFocus(list);
  applyFocus(state.model, state.focus);
  emit('focus');
}

/** いまの階段のつくり（コーディネートの「階段」の品目から） */
export const stairBuildNow = (): StairBuild => stairBuildOf(state.design);

/**
 * コーディネートの品目を選び直す（こだわりの参考資料の画面・3D のパネルから）。
 * 品目は家に 1 つで、3D・仕上げの説明文・仕様書・見積が同じ品目を見る（別々に持つと、3D は箱階段なのに仕様書はスチール階段、が起きる）。
 * 戻り値: 変わったか
 */
export function setFinish(catId: string, productId: string): boolean {
  const cat = categoryById(catId);
  if (!cat || !cat.products.some((p) => p.id === productId) || selectedProduct(cat, state.design).id === productId) return false;
  state.design = { ...state.design, finishes: { ...(state.design.finishes ?? {}), [catId]: productId } };
  // お客様と「決定」にしていた品目を変えたら、決定を外す（コーディネートで選び直したときと同じ）
  if (itemOf(state.coord, catId).status === 'decided') {
    state.coord = decide(state.coord, catId, false);
    toast(`${cat.label}の「決定」を外しました（選び直したため）`, 'info');
  }
  emit('design');
  emit('coord');
  // 開いている 3D に今のデザインを渡す（app.ts が受ける）
  emit('design-3d');
  return true;
}

/** 階段のつくりを変える = コーディネートの「階段」の品目を選ぶ。戻り値: 変わったか */
export const setStairBuild = (build: StairBuild): boolean => setFinish('stair', STAIR_PRODUCT_OF_BUILD[build]);

/**
 * デザイン（納まり・時間帯）を変える（こだわりの参考資料の画面から）。
 * 吹抜の手すり・間接照明は「納まり」に 1 つだけ持つ: ここで変えると、パースの右のパネルも同じ設定になる
 */
export function patchDesign(patch: Partial<DesignOptions>): void {
  state.design = { ...state.design, ...patch };
  emit('design');
  emit('design-3d');
}

/** いまの納まり（標準仕様に、細かな調整を重ねたもの） */
const specNow = () => resolveSpec(state.design.specId, state.design.specPatch);

/**
 * こだわりの参考資料の画面・3D のパネルからデザインを変えたときに fn を呼ぶ（パースの右のパネルの描き直し）。
 * el が画面から外れたら自分で止まる。fn の中で画面を作り直してよいように、知らせの処理が終わってから呼ぶ
 */
export function onDesignFromFocus(el: HTMLElement, fn: () => void): void {
  const off = on('design-3d', () => {
    if (!el.isConnected) {
      off();
      return;
    }
    queueMicrotask(() => {
      if (el.isConnected) fn();
    });
  });
}

/**
 * 3D の「元に戻す／やり直す」でモデルが前の状態に戻った直後に呼ぶ: 階段のつくり・手すりの指定も、戻ったモデルに合わせる
 * （合わせないと、戻したモデルに今の指定が当て直されて、3D で変えたつくり・手すりだけ元に戻らない）
 */
export function syncFocusFromModel(): void {
  const cur = focusNotes();
  const next = focusFromModel(state.model, cur, () => uid('fc'), new Date().toISOString());
  if (next === cur) return;
  state.focus = next;
  emit('focus');
}

const PLACEHOLDER: Record<FocusPart, string> = {
  stair: '例: 黒い鉄骨に無垢のオークの踏板。手すりは細いフラットバーで軽く見せたい',
  joinery: '例: テレビボードは床から浮かせて下に間接照明。壁一面はオークのオープン棚',
  lighting: '例: ダウンライトは少なく、下がり天井の縁とテレビボードの下の間接照明で落ち着いた明るさに',
  kitchen: '例: 黒のセラミック天板のアイランド。背面は造作のオープン棚',
  living: '例: 壁と天井は同じグレーの塗り、テレビの壁はグレーの左官',
  entrance: '例: 土間は 600 角のグレーのタイル。正面に飾り棚',
  void: '例: 吹抜の手すりは透明なガラス。天井にシーリングファン',
  bath: '例: 洗面は造作のカウンターに置き型のボウル。壁はモザイクタイル',
  exterior: '例: 外壁は白の塗り壁に木の格子。軒天は板張り',
  other: '例: 全体に無垢の木と左官の質感を見せたい',
};

/**
 * 指定・階段のつくりが変わるたびに fn を呼ぶ（一覧の描き直し）。el が画面から外れたら自分で止まる。
 * 3D の階段のパネルで手すり・つくりを変えたとき、右のパネルの一覧が古いままにならないように
 */
export function onFocusChange(el: HTMLElement, fn: () => void): void {
  const offs: (() => void)[] = [];
  const run = () => {
    if (!el.isConnected) {
      offs.forEach((off) => off());
      return;
    }
    fn();
  };
  for (const ev of ['focus', 'design-3d']) offs.push(on(ev, run));
}

/** 読み込みの画面・3D のパネルに置く、いまの指定の一覧（小さく） */
export function focusChips(onOpen: (editId?: string) => void): HTMLElement {
  const list = focusNotes();
  if (!list.length) return h('p', { class: 'hint keep', style: 'margin:0 0 6px' }, 'まだありません。階段・キッチン・外観など、こだわりたい所に参考画像と仕様を添えられます。');
  return h(
    'div',
    { class: 'focus-chips' },
    ...list.map((n) =>
      h(
        'button',
        { class: 'focus-chip', title: [focusLookShort(n, stairBuildNow()), n.note].filter(Boolean).join(' ／ ') || '参考画像', onclick: () => onOpen(n.id) },
        n.images[0] ? h('img', { src: n.images[0].url, alt: '' }) : null,
        h('span', null, focusTitle(n)),
        focusLookShort(n, stairBuildNow()) ? h('small', null, focusLookShort(n, stairBuildNow())) : null,
      ),
    ),
  );
}

export interface FocusDialogOpts {
  /** 開いたらすぐこの部位の追加（3D の階段のパネルから） */
  part?: FocusPart;
  level?: number;
  /** 開いたらすぐこの指定を直す */
  editId?: string;
  /** 閉じたとき */
  onClose?: () => void;
}

/** こだわり指定の画面を開く */
export function openFocusDialog(opts: FocusDialogOpts = {}): void {
  const body = h('div', { class: 'focus-dialog' });
  let closed = false;
  const closeModal = modal('こだわりの参考資料（仕様・画像）', body, [{ label: '閉じる', onClick: () => { closed = true; opts.onClose?.(); } }], true);
  // × と背景のクリックで閉じたときも知らせる
  const back = body.closest('.modal-back');
  if (back) {
    const obs = new MutationObserver(() => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!closed) opts.onClose?.();
      }
    });
    obs.observe(document.body, { childList: true });
  }

  const showList = () => {
    clear(body);
    const list = focusNotes();
    body.append(
      h('p', { class: 'hint keep' }, '階段・造作・照明・吹抜など、こだわりたい所に「この仕様・この写真のように提案したい」を添えます。階段（つくり・桁・手すり・踏板の色・段数）、吹抜の手すり、照明（間接照明・ペンダント・光の色）は 3D に入り、造作は 3D に置けます。どの部位も、パースの仕上げ（カット集・AI 仕上げ）の説明文と同梱の参考画像になります。図面を読み直しても残ります。'),
      h('p', { class: 'hint' }, '参考画像は社内の作業用です。お客様の体験リンク・提案資料には出ません（カタログ・他社の写真を使うときの権利にご注意ください）。'),
      list.length
        ? h(
            'div',
            { class: 'focus-list' },
            ...list.map((n) =>
              h(
                'div',
                { class: 'focus-card' },
                h('div', { class: 'focus-thumbs' }, ...(n.images.length ? n.images.map((im) => h('img', { src: im.url, alt: im.name ?? '参考画像' })) : [h('div', { class: 'focus-noimg' }, '画像なし')])),
                h(
                  'div',
                  { class: 'focus-text' },
                  h('b', null, focusTitle(n)),
                  focusLookShort(n, stairBuildNow()) ? h('div', { class: 'focus-look' }, focusLookShort(n, stairBuildNow())) : null,
                  n.note ? h('div', { class: 'focus-note' }, n.note) : null,
                ),
                h(
                  'div',
                  { class: 'focus-actions' },
                  h('button', { class: 'btn sm', onclick: () => showEditor(n) }, '直す'),
                  h('button', {
                    class: 'btn sm ghost',
                    onclick: () => {
                      setFocus(focusNotes().filter((x) => x.id !== n.id));
                      toast(`${focusTitle(n)}の指定を消しました`, 'ok');
                      showList();
                    },
                  }, '消す'),
                ),
              ),
            ),
          )
        : h('p', { class: 'focus-empty' }, 'まだ登録がありません。'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: () => showEditor(null) }, '＋ こだわりを足す')),
    );
  };

  const showEditor = (orig: FocusNote | null, preset?: { part?: FocusPart; level?: number }) => {
    clear(body);
    const levels = stairLevels(state.model);
    const draft: FocusNote = orig
      ? { ...orig, images: orig.images.slice(), stair: orig.stair ? { ...orig.stair } : undefined }
      : { id: uid('fc'), part: preset?.part ?? 'stair', ...(preset?.level != null ? { level: preset.level } : {}), note: '', images: [], at: new Date().toISOString() };
    // 階段のつくりは家に 1 つ（コーディネートの「階段」の品目）。ここで選び直したら、登録のときに品目を入れ替える
    let draftBuild: StairBuild = stairBuildNow();
    // 吹抜の縁（落下防止）は家全体の「納まり」に 1 つ。ここで選び直したら、登録のときに入れ替える
    let draftGuard: VoidGuardSpec = specNow().voidGuard;
    // 照明の雰囲気: 間接照明（納まり）・ダイニングのペンダントと光の色（コーディネートの品目）・時間帯。登録のときに入れ替える
    const pendantCat = categoryById('pendant');
    const lightCat = categoryById('light');
    const lightNow = () => ({
      indirect: specNow().indirectLighting,
      pendant: pendantCat ? selectedProduct(pendantCat, state.design).id : '',
      light: lightCat ? selectedProduct(lightCat, state.design).id : '',
      tod: state.design.timeOfDay,
    });
    const draftLight = lightNow();
    const form = h('div', { class: 'focus-form' });
    body.append(form);

    const render = () => {
      clear(form);
      const isStair = draft.part === 'stair';
      const isVoid = draft.part === 'void';
      const isJoinery = draft.part === 'joinery';
      const isLighting = draft.part === 'lighting';
      // 部位
      const partSel = h(
        'select',
        {
          onchange: (e: Event) => {
            draft.part = (e.target as HTMLSelectElement).value as FocusPart;
            if (draft.part !== 'stair') {
              delete draft.level;
              delete draft.stair;
            }
            if (draft.part !== 'joinery') delete draft.joinery;
            render();
          },
        },
        ...FOCUS_PARTS.map((p) => h('option', { value: p, selected: p === draft.part }, FOCUS_PART_LABEL[p])),
      );
      // 階段: どの階段に
      const levelSel = isStair
        ? h(
            'select',
            {
              onchange: (e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                if (v) draft.level = Number(v);
                else delete draft.level;
              },
            },
            h('option', { value: '', selected: draft.level == null }, 'すべての階段'),
            ...levels.map((lv) => h('option', { value: String(lv), selected: draft.level === lv }, `${lv} 階から上がる階段`)),
            ...(draft.level != null && !levels.includes(draft.level) ? [h('option', { value: String(draft.level), selected: true }, `${draft.level} 階から上がる階段`)] : []),
          )
        : null;
      // 参考画像
      const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' }) as HTMLInputElement;
      const addFiles = async (files: Iterable<File | Blob>) => {
        for (const f of files) {
          if (draft.images.length >= FOCUS_MAX_IMAGES) {
            toast(`参考画像は ${FOCUS_MAX_IMAGES} 枚までです`, 'info');
            break;
          }
          if (!f.type.startsWith('image/')) continue;
          try {
            draft.images.push({ url: await shrinkPhoto(f, 1400), ...('name' in f && f.name ? { name: f.name } : {}) });
          } catch {
            toast('画像を読めませんでした（JPEG・PNG をお試しください）', 'error');
          }
        }
        render();
      };
      fileIn.addEventListener('change', () => {
        const fs = [...(fileIn.files ?? [])];
        fileIn.value = '';
        void addFiles(fs);
      });
      const drop = h(
        'div',
        {
          class: 'focus-drop',
          tabindex: 0,
          title: 'クリックして選ぶ・ここへ画像を落とす・コピーした画像を貼り付ける（Ctrl+V）',
          onclick: () => fileIn.click(),
          ondragover: (e: DragEvent) => { e.preventDefault(); drop.classList.add('over'); },
          ondragleave: () => drop.classList.remove('over'),
          ondrop: (e: DragEvent) => {
            e.preventDefault();
            drop.classList.remove('over');
            void addFiles([...(e.dataTransfer?.files ?? [])]);
          },
          onpaste: (e: ClipboardEvent) => {
            const fs = [...(e.clipboardData?.items ?? [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter((f): f is File => !!f);
            if (fs.length) {
              e.preventDefault();
              void addFiles(fs);
            }
          },
        },
        draft.images.length >= FOCUS_MAX_IMAGES ? `参考画像は ${FOCUS_MAX_IMAGES} 枚まで` : '＋ 参考画像を足す（クリック・ドロップ・貼り付け）',
      );
      const thumbs = h(
        'div',
        { class: 'focus-thumbs edit' },
        ...draft.images.map((im, i) =>
          h(
            'div',
            { class: 'focus-thumb' },
            h('img', { src: im.url, alt: im.name ?? '参考画像' }),
            h('button', { class: 'icon-btn', title: 'この画像を外す', onclick: () => { draft.images.splice(i, 1); render(); } }, '×'),
          ),
        ),
      );
      // ひとこと
      const noteIn = h('textarea', { rows: 3, placeholder: PLACEHOLDER[draft.part], oninput: (e: Event) => { draft.note = (e.target as HTMLTextAreaElement).value; } }) as HTMLTextAreaElement;
      noteIn.value = draft.note;
      // 階段のつくり・手すり・段数
      const look = (): StairLook => draft.stair ?? {};
      const setLook = (patch: Partial<StairLook>) => {
        draft.stair = cleanStairLook({ ...look(), ...patch });
      };
      const short = (s: string) => s.replace(/（.*）/, '');
      const stairBox = isStair
        ? h(
            'div',
            { class: 'focus-stair' },
            h('div', { class: 'field-label' }, 'つくり（3D に反映。家じゅうの階段に共通）'),
            segmented<StairBuild>(STAIR_BUILDS.map((b) => ({ value: b, label: short(STAIR_BUILD_LABEL[b]) })), draftBuild, (v) => { draftBuild = v; draft.note = noteIn.value; render(); }),
            // 鉄骨階段だけ: 桁を両側のささら桁（御社の施工事例の形）か、中央の力桁 1 本か
            ...(draftBuild === 'steel'
              ? [
                  h('div', { class: 'field-label', style: 'margin-top:8px' }, '鉄骨の桁（3D に反映）'),
                  segmented<StairStringer>(STAIR_STRINGERS.map((k) => ({ value: k, label: STAIR_STRINGER_LABEL[k] })), look().stringer ?? 'side', (v) => setLook({ stringer: v })),
                ]
              : []),
            h('div', { class: 'field-label', style: 'margin-top:8px' }, '手すり（3D に反映）'),
            segmented<string>([{ value: '', label: '標準のまま' }, ...STAIR_RAILS.map((r) => ({ value: r as string, label: short(STAIR_RAIL_LABEL[r]) }))], look().rail ?? '', (v) => setLook({ rail: (v || undefined) as StairRail | undefined })),
            h('div', { class: 'field-label', style: 'margin-top:8px' }, '踏板の色（3D に反映）'),
            segmented<StairTread>(STAIR_TREADS.map((k) => ({ value: k, label: short(STAIR_TREAD_LABEL[k]) })), look().tread ?? 'floor', (v) => setLook({ tread: v })),
            h('div', { class: 'field-label', style: 'margin-top:8px' }, '鉄の色（桁とアイアンの手すり。3D に反映）'),
            segmented<StairFrame>(STAIR_FRAMES.map((k) => ({ value: k, label: STAIR_FRAME_LABEL[k] })), look().frame ?? 'black', (v) => setLook({ frame: v })),
            h(
              'label',
              { class: 'field', style: 'margin-top:8px;max-width:260px' },
              h('span', { class: 'field-label' }, '段数（空欄 = 図面の読み取りどおり）'),
              h('input', {
                type: 'number',
                min: 6,
                max: 30,
                step: 1,
                value: look().steps ?? '',
                placeholder: '例: 14',
                onchange: (e: Event) => {
                  const v = Number((e.target as HTMLInputElement).value);
                  setLook({ steps: v >= 6 && v <= 30 ? Math.round(v) : undefined });
                },
              }),
            ),
            h('p', { class: 'hint' }, 'つくりは、コーディネートの「階段」の品目と同じものです（ここで変えると仕様書・見積の品目も同じになります）。桁・手すり・踏板の色・段数は階段ごとに決められます。標準は、両側の黒い鋼板の桁に床と同じ色の踏板、細いアイアンの手すりです。'),
          )
        : null;
      // 吹抜: 2 階側の縁（落下防止）。家全体の「納まり」の設定を、ここからも選べる
      const overrides = (state.model?.floors ?? []).reduce((n, f) => n + f.rooms.filter((r) => r.type === 'void' && r.voidGuard).length, 0);
      const voidBox = isVoid
        ? h(
            'div',
            { class: 'focus-stair' },
            h('div', { class: 'field-label' }, '吹抜の 2 階側の縁（落下防止。3D に反映・家全体の設定）'),
            segmented<VoidGuardSpec>(VOID_GUARD_SPECS.map((g) => ({ value: g.value, label: g.label })), draftGuard, (v) => { draftGuard = v; draft.note = noteIn.value; render(); }),
            h('p', { class: 'hint keep', style: 'margin:4px 0 0' }, VOID_GUARD_SPECS.find((g) => g.value === draftGuard)?.note ?? ''),
            h('p', { class: 'hint' }, `パースの「納まり」と同じ設定です（ここで変えると、そちらも同じになります）。吹抜ごとに変えるときは、3D で吹抜の縁（手すり）をクリックして選びます。${overrides ? `いま、個別に変えた吹抜が ${overrides} か所あります（そこは個別の指定のまま）。` : ''}`),
          )
        : null;
      // 造作: 形（仕上げの説明文に入る）。3D には「家具」の道具で置く
      const joinBox = isJoinery
        ? h(
            'div',
            { class: 'focus-stair' },
            h(
              'label',
              { class: 'field', style: 'max-width:420px' },
              h('span', { class: 'field-label' }, '造作の形（仕上げの説明文に入ります）'),
              h(
                'select',
                {
                  onchange: (e: Event) => {
                    const v = (e.target as HTMLSelectElement).value as BuiltinVariant | '';
                    if (v) draft.joinery = v;
                    else delete draft.joinery;
                    draft.note = noteIn.value;
                    render();
                  },
                },
                h('option', { value: '', selected: !draft.joinery }, '決めない（ひとこと・参考画像だけ）'),
                ...JOINERY_VARIANTS.map((k) => h('option', { value: k, selected: draft.joinery === k }, JOINERY_LABEL[k])),
              ),
            ),
            draft.joinery
              ? h(
                  'div',
                  { class: 'btn-row', style: 'margin-top:8px' },
                  h('button', { class: 'btn sm', title: 'この指定を保存して画面を閉じ、3D の「家具」の道具を、この形を置く状態にします', onclick: () => save(draft.joinery) }, '保存して、この形を 3D に置く'),
                )
              : null,
            h('p', { class: 'hint' }, '3D では「家具」の道具の「造作家具を置く」と同じ物です。置きたい壁の近くの床をクリックすると壁に付き、置いたあとドラッグで動かして、幅・高さ・木の色を変えられます。'),
          )
        : null;
      // 照明の雰囲気: 3D に反映できる 4 つ（どれもデザインの設定そのもの）
      const lightBox = isLighting
        ? h(
            'div',
            { class: 'focus-stair' },
            h('div', { class: 'field-label' }, '間接照明（天井際の光の線。3D に反映）'),
            segmented<string>([{ value: '1', label: 'あり' }, { value: '0', label: 'なし' }], draftLight.indirect ? '1' : '0', (v) => { draftLight.indirect = v === '1'; }),
            ...(pendantCat
              ? [
                  h('div', { class: 'field-label', style: 'margin-top:8px' }, 'ダイニングのペンダント（3D に反映）'),
                  segmented<string>(pendantCat.products.map((p) => ({ value: p.id, label: short(p.name) })), draftLight.pendant, (v) => { draftLight.pendant = v; }),
                ]
              : []),
            ...(lightCat
              ? [
                  h('div', { class: 'field-label', style: 'margin-top:8px' }, '光の色（夜景・夕景の 3D に反映）'),
                  segmented<string>(lightCat.products.map((p) => ({ value: p.id, label: p.code })), draftLight.light, (v) => { draftLight.light = v; }),
                ]
              : []),
            h('div', { class: 'field-label', style: 'margin-top:8px' }, 'パースの時間帯（3D に反映）'),
            segmented<TimeOfDay>(
              [
                { value: 'morning', label: '朝' },
                { value: 'day', label: '昼' },
                { value: 'evening', label: '夕景' },
                { value: 'night', label: '夜景' },
              ],
              draftLight.tod,
              (v) => { draftLight.tod = v; },
            ),
            h('p', { class: 'hint' }, 'どれもデザインの設定そのものです: 間接照明はパースの「納まり」、ペンダントと光の色はコーディネートの「ダイニングの照明」「照明の色」、時間帯はパースの「時間帯」（ここで変えると、そちらも同じになります）。照明の雰囲気は夕景・夜景でよく伝わります。'),
          )
        : null;
      // AI に読んでもらう
      const key = getGeminiKey();
      const aiNote = h('span', { class: 'hint keep', style: 'margin-left:8px' }, key ? '押すと参考画像が Google の AI に送られます。結果は下書きなので、確かめてから保存してください。' : 'AI で読むには、Google AI Studio の鍵を「AI 仕上げ」の設定に入れてください（無くても手で選べます）。');
      const aiBtn = h(
        'button',
        {
          class: 'btn sm',
          disabled: !key || !draft.images.length,
          title: isStair
            ? '参考画像から、つくり・桁・手すり・踏板の色・段数とひとことを読み取ります'
            : isVoid
              ? '参考画像から、吹抜の手すりの種類とひとことを読み取ります'
              : isJoinery
                ? '参考画像から、造作の形とひとことを読み取ります'
                : isLighting
                  ? '参考画像から、間接照明・ペンダント・光の色・時間帯とひとことを読み取ります'
                  : '参考画像から、仕上げの担当に伝えるひとことを読み取ります',
          onclick: async () => {
            aiBtn.disabled = true;
            aiBtn.textContent = '読んでいます…';
            try {
              const r = await readFocusImages(key, getReviewModel(), { part: draft.part, images: draft.images.map((im) => im.url), note: draft.note });
              if (r.raw) {
                toast('AI の答えを読めませんでした。手で選んでください', 'error', 6000);
              } else {
                if (r.build && isStair) draftBuild = r.build;
                if (r.stair && isStair) draft.stair = cleanStairLook({ ...look(), ...r.stair });
                if (r.guard && isVoid) draftGuard = r.guard;
                if (r.joinery && isJoinery) draft.joinery = r.joinery;
                if (r.lighting && isLighting) {
                  if (r.lighting.indirect != null) draftLight.indirect = r.lighting.indirect;
                  if (r.lighting.pendant && pendantCat?.products.some((p) => p.id === `pend.${r.lighting!.pendant}`)) draftLight.pendant = `pend.${r.lighting.pendant}`;
                  if (r.lighting.kelvin && lightCat?.products.some((p) => p.id === `light.${r.lighting!.kelvin}`)) draftLight.light = `light.${r.lighting.kelvin}`;
                  if (r.lighting.tod) draftLight.tod = r.lighting.tod;
                }
                if (r.note && !draft.note.trim()) draft.note = r.note;
                else if (r.note && !draft.note.includes(r.note)) draft.note = `${draft.note.trim()}\n${r.note}`;
                toast(`画像から読み取りました${r.reason ? `: ${r.reason}` : ''}（確かめてから保存してください）`, 'ok', 8000);
              }
            } catch (e) {
              toast(`AI で読めませんでした: ${(e as Error).message}`, 'error', 8000);
            }
            render();
          },
        },
        '画像から読み取る（AI）',
      ) as HTMLButtonElement;

      /** @param place 造作: 保存したあと、この形を 3D に置く状態にする */
      const save = (place?: BuiltinVariant) => {
        draft.note = noteIn.value.trim();
        const stair = isStair ? cleanStairLook(draft.stair) : undefined;
        const joinery = isJoinery ? draft.joinery : undefined;
        const buildChanged = isStair && draftBuild !== stairBuildNow();
        const guardChanged = isVoid && draftGuard !== specNow().voidGuard;
        const now = lightNow();
        const lightChanged = isLighting && (draftLight.indirect !== now.indirect || draftLight.pendant !== now.pendant || draftLight.light !== now.light || draftLight.tod !== now.tod);
        const hasNote = !!(draft.note || draft.images.length || stair || joinery);
        if (!hasNote && !buildChanged && !guardChanged && !lightChanged) {
          toast('参考画像・ひとこと・仕様のどれかを入れてください', 'info');
          return;
        }
        // デザインの設定（家に 1 つ）を入れ替える: 階段のつくり・吹抜の縁・照明
        const msgs: string[] = [];
        if (buildChanged) {
          setStairBuild(draftBuild);
          msgs.push(`階段のつくりを「${short(STAIR_BUILD_LABEL[draftBuild])}」にしました（コーディネートの「階段」も同じ品目です）。`);
        }
        if (guardChanged) {
          patchDesign({ specPatch: { ...state.design.specPatch, voidGuard: draftGuard } });
          msgs.push(`吹抜の縁を「${VOID_GUARD_SPECS.find((g) => g.value === draftGuard)?.label ?? draftGuard}」にしました（家全体の設定。パースの「納まり」も同じです）。`);
        }
        if (lightChanged) {
          const patch: Partial<DesignOptions> = {};
          if (draftLight.indirect !== now.indirect) patch.specPatch = { ...state.design.specPatch, indirectLighting: draftLight.indirect };
          if (draftLight.tod !== now.tod) patch.timeOfDay = draftLight.tod;
          if (Object.keys(patch).length) patchDesign(patch);
          if (draftLight.pendant !== now.pendant) setFinish('pendant', draftLight.pendant);
          if (draftLight.light !== now.light) setFinish('light', draftLight.light);
          msgs.push('照明の設定を 3D に反映しました（間接照明・ペンダント・光の色・時間帯）。');
        }
        if (!hasNote) {
          // 設定だけを変えた: 指定（参考資料）は作らない。元からあった指定の中身を空にしたのなら、その指定は消す
          if (orig) setFocus(focusNotes().filter((x) => x.id !== orig.id));
          toast(msgs.join(''), 'ok', 6000);
          showList();
          return;
        }
        const note: FocusNote = {
          id: draft.id,
          part: draft.part,
          ...(isStair && draft.level != null ? { level: draft.level } : {}),
          note: draft.note,
          images: draft.images,
          ...(stair ? { stair } : {}),
          ...(joinery ? { joinery } : {}),
          at: draft.at || new Date().toISOString(),
        };
        const n = upsertFocus(note);
        const partName = FOCUS_PART_LABEL[draft.part].replace(/（.*）/, '');
        toast(msgs.join('') + (isStair && stair ? (state.model ? `階段 ${n} か所の 3D に反映しました（パースの仕上げの説明文にも入ります）` : '登録しました。図面を読み込むと階段の 3D に反映します') : `${partName}のこだわりを登録しました（パースの仕上げの説明文と参考画像に入ります）`), 'ok', 6000);
        if (place) {
          // 画面を閉じて、3D の「家具」の道具を、この形を置く状態にする（道具が受け取ると done を呼ぶ）
          closed = true;
          closeModal();
          opts.onClose?.();
          let taken = false;
          emit('place-builtin', { variant: place, done: () => { taken = true; } });
          if (!taken) toast('造作は、パース（3D）の画面で、左の「家具」→「造作家具を置く」から置けます', 'info', 8000);
          return;
        }
        showList();
      };

      form.append(
        h('div', { class: 'focus-row' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'どこの'), partSel), levelSel ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'どの階段に'), levelSel) : null),
        h('div', { class: 'field-label' }, `参考画像（${draft.images.length}/${FOCUS_MAX_IMAGES}）`),
        thumbs,
        drop,
        fileIn,
        h('div', { class: 'btn-row', style: 'margin:6px 0 10px;align-items:center' }, aiBtn, aiNote),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'ひとこと（設計の意図。仕上げの AI にもそのまま伝えます）'), noteIn),
        ...[stairBox, voidBox, joinBox, lightBox].flatMap((x) => (x ? [x] : [])),
        // 保存のボタンは、縦に長くなっても見えている所に（「閉じる」を押して書きかけを失わないように）
        h('div', { class: 'btn-row focus-save' }, h('button', { class: 'btn primary', onclick: () => save() }, orig ? '保存' : '登録'), h('button', { class: 'btn ghost', onclick: showList }, 'やめる（一覧へ戻る）')),
      );
    };
    render();
  };

  const edit = opts.editId ? focusNotes().find((n) => n.id === opts.editId) : undefined;
  if (edit) showEditor(edit);
  else if (opts.part) showEditor(null, { part: opts.part, level: opts.level });
  else showList();
}
