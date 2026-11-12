/** アプリ本体（ステップ切り替えと共有ビューア） */
import { h, clear, toast } from './dom';
import { state, on, emit } from './state';
import { estimateSummary } from './steps/estimateStep';
import { yenMan } from '../core/planDiff';
import { shareDialog } from './share';
import { saveProjectFile, openProjectFile, purgeLegacyAutosave } from './project';
import { Viewer } from '../scene/viewer';
import { auditEnvelope } from '../scene/selfCheck';
import { createFurnitureTool } from './furnitureTool';
import { createEditTool3d } from './editTool3d';
import { syncFocusFromModel } from './focusNotes';
import { createExteriorTool } from './exteriorTool';
import { furnitureDims, furnitureItems } from '../scene/furniture';

export interface StepCtx {
  app: App;
  stage: HTMLElement;
  side: HTMLElement;
}

export interface Step {
  id: string;
  label: string;
  /** 狭い画面で使う短い名前 */
  short?: string;
  needsModel: boolean;
  /** 3D ビューアを使うか */
  uses3d: boolean;
  mount(ctx: StepCtx): void | Promise<void>;
  unmount?(): void;
}

export class App {
  readonly root: HTMLElement;
  readonly stage: HTMLElement;
  readonly side: HTMLElement;
  readonly viewerHost: HTMLElement;
  private navBar: HTMLElement;
  private stepHost: HTMLElement;
  private stepBar: HTMLElement;
  private current: Step | null = null;
  private _viewer: Viewer | null = null;
  modelVersion = 0;
  private furnTool: ReturnType<typeof createFurnitureTool> | null = null;
  private editTool: ReturnType<typeof createEditTool3d> | null = null;
  private extTool: ReturnType<typeof createExteriorTool> | null = null;
  builtVersion = -1;
  /**
   * 3D の道具（家具・外構・窓・戸・階段・屋根・天井高…）の「元に戻す／やり直す」（Ctrl+Z／Ctrl+Shift+Z・Ctrl+Y）。
   * 道具で直すたびに、直す前のモデルの写し（JSON）を積む。ほかの画面（方眼など）でモデルが変わったら積んだ写しは捨てる
   * （古い写しに戻して方眼の修正まで消さないように）
   */
  private undo3d: string[] = [];
  private redo3d: string[] = [];
  /** 今のモデルの写し（直す前の状態として次に積む）。null = まだ取っていない */
  private snap3d: string | null = null;
  /** 3D の道具が出した・元に戻したモデルの変更の間は true（積んだ写しを捨てない） */
  private own3dEmit = false;

  constructor(
    root: HTMLElement,
    readonly steps: Step[],
  ) {
    this.root = root;
    this.stepBar = h('nav', { class: 'steps' });
    const nameInput = h('input', {
      class: 'project-name',
      value: state.name,
      title: 'プロジェクト名',
      oninput: (e: Event) => {
        state.name = (e.target as HTMLInputElement).value;
        emit('project');
      },
    });
    // 作業パネルを隠して 3D を画面いっぱいに（もう一度押すと戻る）
    let sideHidden = false;
    const sideBtn = h('button', { class: 'side-toggle', title: '作業パネルを隠す／表示する' }, '▸');
    sideBtn.onclick = () => {
      sideHidden = !sideHidden;
      document.body.classList.toggle('side-hidden', sideHidden);
      sideBtn.textContent = sideHidden ? '◂' : '▸';
      window.setTimeout(() => this._viewer?.resize(), 220);
    };
    const office = h('div', { class: 'office' });
    const paintOffice = () => {
      clear(office);
      if (state.logo) office.appendChild(h('img', { src: state.logo, style: 'height:26px;max-width:120px;object-fit:contain;vertical-align:middle;margin-right:10px' }));
      office.appendChild(document.createTextNode(state.company || ''));
    };
    paintOffice();
    on('project', paintOffice);
    on('project-loaded', paintOffice);
    // 概算の総額と、プロジェクトを開いてからの増減（コーデ・間取りを触るたびに静かに更新。押すと見積へ）
    const costPill = h('button', { class: 'cost-pill', title: '概算（税込の総合計）とプロジェクトを開いてからの増減。押すと見積へ', onclick: () => void this.go('estimate') });
    let costBase: number | null = null;
    let costTimer = 0;
    const paintCost = () => {
      window.clearTimeout(costTimer);
      costTimer = window.setTimeout(() => {
        if (!state.model) {
          costPill.hidden = true;
          return;
        }
        let grand: number | undefined;
        try {
          grand = estimateSummary()?.grand;
        } catch {
          grand = undefined;
        }
        if (grand == null) {
          costPill.hidden = true;
          return;
        }
        costBase ??= grand;
        const d = grand - costBase;
        clear(costPill);
        costPill.hidden = false;
        costPill.append(h('span', { class: 'v' }, yenMan(grand)), Math.abs(d) >= 10000 ? h('span', { class: `d ${d > 0 ? 'up' : 'down'}` }, `${d > 0 ? '＋' : '－'}${yenMan(Math.abs(d))}`) : h('span', { class: 'd' }, '概算'));
      }, 500);
    };
    for (const ev of ['model', 'estimate', 'design', 'coord', 'project-loaded']) on(ev, paintCost);
    on('project-loaded', () => {
      costBase = null;
      paintCost();
    });
    paintCost();
    const top = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand', title: 'Home Landick' }, h('img', { class: 'logo', src: './brand/logo-hl.png', alt: 'Home Landick' })),
      office,
      nameInput,
      h('div', { class: 'spacer' }),
      this.stepBar,
      h('div', { class: 'spacer' }),
      costPill,
      this.buildProjectButtons(),
      sideBtn,
    );
    this.viewerHost = h('div', { id: 'viewer3d', class: 'view' });
    this.navBar = h('div', { class: 'nav-tools' });
    this.viewerHost.appendChild(this.navBar);
    this.stepHost = h('div', { class: 'view', style: 'pointer-events:none' });
    this.stage = h('div', { class: 'stage' }, this.viewerHost, this.stepHost);
    this.side = h('aside', { class: 'side' });
    root.append(top, h('div', { class: 'main' }, this.stage, this.side));
    this.renderSteps();
    on('model', () => {
      this.modelVersion++;
      // 3D の道具以外（方眼・読み込み・開く）でモデルが変わった: 3D の元に戻す履歴は捨てる
      if (!this.own3dEmit) {
        this.undo3d = [];
        this.redo3d = [];
        this.snap3d = null;
      }
      this.renderSteps();
    });
    // 階段のつくりを変えた（こだわりの参考資料・3D の階段のパネル = コーディネートの「階段」の品目）: 開いている 3D を作り直す
    on('stair-build', () => {
      this._viewer?.setDesign(state.design);
    });
    // 保存したプロジェクトを開いたら、3D のテイストも反映して外観・内観パースへ
    on('project-loaded', () => {
      (nameInput as HTMLInputElement).value = state.name;
      if (this._viewer) {
        this._viewer.setModel(state.model!);
        this.builtVersion = this.modelVersion;
        this._viewer.setDesign(state.design);
      }
      void this.go('design');
    });
    purgeLegacyAutosave();
  }

  /** 保存／開く（ヘッダー） */
  private buildProjectButtons() {
    // 側パネルの説明文（.hint）を出すか。慣れたら消して、ボタンと値だけの画面にする（既定: 消す。ブラウザに覚える）
    const hintsToggle = () => {
      let on = false;
      try {
        on = localStorage.getItem('madori.hints') === 'on';
      } catch {
        on = false;
      }
      const apply = () => {
        document.body.classList.toggle('hints-off', !on);
        b.classList.toggle('on', on);
        b.title = on ? '説明文を隠す（ボタンと値だけの画面に）' : '各パネルの説明文を表示する';
      };
      const b = h(
        'button',
        {
          class: 'btn sm ghost hints-btn',
          onclick: () => {
            on = !on;
            try {
              localStorage.setItem('madori.hints', on ? 'on' : 'off');
            } catch {
              /* 使えない環境 */
            }
            apply();
          },
        },
        '説明',
      );
      apply();
      return b;
    };
    // 文字を大きく（側パネル・札・操作バーを 1.15 倍。日照の文字が小さい・細いという声に）
    const textToggle = () => {
      let on = false;
      try {
        on = localStorage.getItem('madori.textLg') === 'on';
      } catch {
        on = false;
      }
      const apply = () => {
        document.body.classList.toggle('text-lg', on);
        b.classList.toggle('on', on);
        b.title = on ? '文字を標準の大きさに戻す' : '側パネル・札の文字を大きくする';
      };
      const b = h(
        'button',
        {
          class: 'btn sm ghost text-btn',
          onclick: () => {
            on = !on;
            try {
              localStorage.setItem('madori.textLg', on ? 'on' : 'off');
            } catch {
              /* 使えない環境 */
            }
            apply();
          },
        },
        '文字 大',
      );
      apply();
      return b;
    };
    const input = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' }) as HTMLInputElement;
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.value = '';
      if (!f) return;
      try {
        await openProjectFile(f);
      } catch (e) {
        toast((e as Error).message, 'error', 6000);
      }
    });
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveProjectFile();
      }
    });
    return h(
      'div',
      { class: 'proj-btns' },
      h('button', { class: 'btn sm ghost', title: 'プロジェクトをファイルに保存（Ctrl+S）。図面の読み取り結果・修正・テイスト・建設地・パース画像をまとめて保存します', onclick: () => void saveProjectFile() }, '保存'),
      h('button', { class: 'btn sm ghost', title: '保存したプロジェクト（.madori.json）を開く', onclick: () => input.click() }, '開く'),
      hintsToggle(),
      textToggle(),
      h('button', { class: 'btn sm primary', title: 'お客様がスマホで開ける体験リンクを作る（歩く・光・テイスト・AR・動画）', onclick: () => void shareDialog(this) }, 'お客様に渡す'),
      input,
    );
  }

  get viewer(): Viewer {
    if (!this._viewer) {
      this._viewer = new Viewer(this.viewerHost, state.design);
      // 空は背景（箱型）ではなく、カメラを包む球に貼る。背景だと広角・縦長・遠くからの構図で空に茶色（空の画像の地面側）の塊が出る
      this._viewer.useSkyDome(true);
      // 点検用（裏の Chrome から構図を確かめる）
      (globalThis as unknown as { __viewer: Viewer }).__viewer = this._viewer;
      (globalThis as unknown as { __furnitureItems: typeof furnitureItems }).__furnitureItems = furnitureItems;
      (globalThis as unknown as { __furnitureDims: typeof furnitureDims }).__furnitureDims = furnitureDims;
      this.buildNavBar(this._viewer);
      // 3D を見せないステップの中で作られたとき（資料の自動作成など）は、隠れたまま描き続けないように止めておく
      if (this.current && !this.current.uses3d) this._viewer.pause(true);
    }
    return this._viewer;
  }

  /** 3D 操作ツール（回転／掴んで移動／目線で歩く／ズーム） */
  private buildNavBar(v: Viewer) {
    const bar = this.navBar;
    type Mode = 'orbit' | 'pan' | 'walk';
    const orbit = h('button', { class: 'nav-btn', title: '回転（ドラッグで建物の周りを回る。クリックした物を中心に回ります）', onclick: () => setMode('orbit') }, h('span', { class: 'ic' }, '⟲'), '回転');
    const pan = h('button', { class: 'nav-btn', title: '移動（画面を掴んで上下左右にずらす）\nスペースキーを押している間も移動になります', onclick: () => setMode('pan') }, h('span', { class: 'ic' }, '✋'), '移動');
    const walk = h('button', { class: 'nav-btn', title: '目線（人の目の高さで歩く）\nドラッグで見回し、ホイールまたは W/S で前後、A/D で左右。階段も上れます', onclick: () => setMode('walk') }, h('span', { class: 'ic' }, '👁'), '目線');
    // 表示の重さ: 閲覧（軽快）が既定。仕上げ表示は止まったときだけ GTAO・SMAA 込みで描く。保存・書き出しは常に高品質
    const finish = h(
      'button',
      {
        class: 'nav-btn',
        title: '高精細表示（止まったときの絵を 1.5 倍の解像度・細かい影で描く。切ると等倍で軽快）\n止まったときの陰影・輪郭の仕上げはどちらでも入り、保存するパース・動画は常に高品質です',
        onclick: () => {
          v.setViewMode(v.viewMode === 'finish' ? 'browse' : 'finish');
          finish.classList.toggle('on', v.viewMode === 'finish');
          try {
            localStorage.setItem('madori.viewMode', v.viewMode);
          } catch {
            /* 保存できない環境は無視 */
          }
        },
      },
      h('span', { class: 'ic' }, '✦'),
      '仕上げ',
    );
    try {
      if (localStorage.getItem('madori.viewMode') === 'finish') v.setViewMode('finish');
    } catch {
      /* 保存できない環境は無視 */
    }
    finish.classList.toggle('on', v.viewMode === 'finish');
    const setMode = (m: Mode) => {
      v.setNavMode(m);
      orbit.classList.toggle('on', m === 'orbit');
      pan.classList.toggle('on', m === 'pan');
      walk.classList.toggle('on', m === 'walk');
    };
    setMode('orbit');
    // 家具・造作の置き直し（3D 画面のまま）。家具だけ作り直すので、建物の作り直しは起こさない
    this.furnTool = createFurnitureTool(
      v,
      this.viewerHost,
      () => {
        this.edited3d();
        this.builtVersion = this.modelVersion;
      },
      () => {
        this.editTool?.setActive(false);
        this.extTool?.setActive(false);
      },
    );
    // 天井高・シャッター・窓・戸（3D を見ながら部屋・壁をクリック）。建物が変わるので作り直す
    this.editTool = createEditTool3d(
      v,
      this.viewerHost,
      () => {
        this.edited3d();
        this.ensureScene();
      },
      () => {
        this.furnTool?.setActive(false);
        this.extTool?.setActive(false);
      },
    );
    // 外構の物（植栽・フェンス・車・BBQ…）。外構だけ作り直す
    this.extTool = createExteriorTool(
      v,
      this.viewerHost,
      () => {
        this.edited3d();
        this.builtVersion = this.modelVersion;
      },
      () => {
        this.furnTool?.setActive(false);
        this.editTool?.setActive(false);
      },
    );
    // 道具を開いていないときのクリック: 家具 → 家具の道具、外構の物 → 外構の道具、窓・戸・壁・床 → 窓・戸の道具（CAD のように、見ている物をそのまま選んで直す）
    const furnTool = this.furnTool;
    const extTool = this.extTool;
    const editTool = this.editTool;
    // 点検スクリプト用（ハンドルのドラッグなどを外から再現する）
    (globalThis as unknown as { __tools: unknown }).__tools = { furnTool, extTool, editTool };
    v.onPickIdle = (hit, ndc) => {
      if (hit.group === 'furniture') return furnTool.pickHere(hit.point) || editTool.pickHere(hit, ndc);
      if (hit.group === 'landscape') return extTool.pickHere(hit.point);
      if (hit.group === 'building' || hit.group === 'cut') return editTool.pickHere(hit, ndc) || furnTool.pickHere(hit.point);
      if (hit.group === 'roof') return editTool.pickHere(hit, ndc);
      if (hit.group === 'ground') return extTool.pickHere(hit.point);
      return false;
    };
    // 選んだ家具・外構の物は、そのまま掴んでドラッグで動かせる（CAD の直接操作。道具を開いて選んでいる物だけ）
    v.onDragStart = (p, ndc) => furnTool.dragStart(p, ndc) || extTool.dragStart(p, ndc) || editTool.dragStart(p, ndc);
    v.onDragMove = (p, ndc) => {
      furnTool.dragMove(p);
      extTool.dragMove(p);
      editTool.dragMove(p, ndc);
    };
    v.onDragEnd = (p, moved) => {
      furnTool.dragEnd(p, moved);
      extTool.dragEnd(p, moved);
      editTool.dragEnd(p, moved);
    };
    bar.append(
      orbit,
      pan,
      walk,
      this.furnTool.button,
      this.extTool.button,
      this.editTool.button,
      h('div', { class: 'nav-sep' }),
      h('button', { class: 'nav-btn', title: 'ズームイン', onclick: () => v.zoomBy(0.75) }, h('span', { class: 'ic' }, '＋')),
      h('button', { class: 'nav-btn', title: 'ズームアウト', onclick: () => v.zoomBy(1.33) }, h('span', { class: 'ic' }, '－')),
      h('div', { class: 'nav-sep' }),
      finish,
    );
    bar.title = '左ドラッグ：回転（移動モードでは移動、目線モードでは見回し）／右ドラッグ：移動／ホイール：カーソルの位置へズーム（目線モードでは前後）／W・A・S・D：歩いて移動（Q・E 上下、Shift 速く）';
    // スペースキーを押している間は一時的に「移動」
    let held: Mode | null = null;
    const typing = (e: KeyboardEvent) => /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || typing(e) || this.viewerHost.style.visibility === 'hidden' || !this.current?.uses3d) return;
      e.preventDefault();
      if (held == null && v.navMode !== 'walk') {
        held = v.navMode;
        setMode('pan');
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code !== 'Space' || held == null) return;
      setMode(held);
      held = null;
    });
    // 3D の道具の操作を元に戻す（Ctrl+Z）・やり直す（Ctrl+Shift+Z／Ctrl+Y）。方眼の画面には方眼の元に戻すがある
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || typing(e) || this.viewerHost.style.visibility === 'hidden' || !this.current?.uses3d) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      e.preventDefault();
      this.undo3dStep(k === 'y' || e.shiftKey);
    });
  }

  /** モデルが更新されていれば 3D を作り直す */
  ensureScene() {
    if (!state.model) return;
    const v = this.viewer;
    if (this.builtVersion !== this.modelVersion) {
      v.setModel(state.model);
      this.builtVersion = this.modelVersion;
      this.selfCheck(v);
    }
    // 3D で直す前の状態（元に戻す先）を取っておく
    if (!this.snap3d) this.snap3d = JSON.stringify(state.model);
  }

  /** 3D の道具で直した: 直す前の写しを積み、今の状態を写し直してから知らせる */
  private edited3d() {
    const now = state.model ? JSON.stringify(state.model) : null;
    // 中身が変わっていない「直した」（選び直しただけ等）は積まない（Ctrl+Z が何も起きない 1 回にならないように）
    if (this.snap3d && now !== this.snap3d) {
      this.undo3d.push(this.snap3d);
      if (this.undo3d.length > 30) this.undo3d.shift();
      this.redo3d = [];
    }
    this.snap3d = now;
    this.own3dEmit = true;
    try {
      emit('model');
    } finally {
      this.own3dEmit = false;
    }
  }

  /** 3D の道具の操作を 1 つ元に戻す（redo = やり直す）。モデルは同じ物のまま中身を入れ替える（ほかの画面が持つ参照を切らない） */
  undo3dStep(redo = false) {
    const from = redo ? this.redo3d : this.undo3d;
    const to = redo ? this.undo3d : this.redo3d;
    const json = from.pop();
    if (!json || !state.model) {
      toast(redo ? 'やり直す操作がありません' : '元に戻す操作がありません（3D の道具で直したものを戻せます）', 'info', 2500);
      return;
    }
    if (this.snap3d) to.push(this.snap3d);
    this.snap3d = json;
    const m = state.model as unknown as Record<string, unknown>;
    const next = JSON.parse(json) as Record<string, unknown>;
    for (const k of Object.keys(m)) if (!(k in next)) delete m[k];
    Object.assign(m, next);
    // 3D で変えた階段のつくり・手すり（こだわりの参考資料）も、戻ったモデルに合わせる
    syncFocusFromModel();
    this.own3dEmit = true;
    try {
      emit('model');
    } finally {
      this.own3dEmit = false;
    }
    // 開いている道具の選択・つまみを今のモデルに合わせ直す（閉じている道具は触らない: 窓・戸の道具の描き直しは、閉じていてもつまみ・寸法を消すため）
    [this.furnTool, this.extTool, this.editTool].find((t) => t?.isActive())?.refresh();
    this.ensureScene();
    toast(redo ? 'やり直しました（Ctrl+Shift+Z）' : '元に戻しました（Ctrl+Z）', 'ok', 1500);
  }

  /**
   * 3D を作った直後の自己点検: 外から見て外壁が抜けている所・屋根の穴を数え、あれば知らせる
   * （読み取りの崩れを、お客様に見せる前にここで気づけるように）
   */
  private selfCheck(v: Viewer) {
    const ver = this.modelVersion;
    window.setTimeout(() => {
      if (ver !== this.modelVersion || !state.model) return;
      try {
        const a = auditEnvelope(v);
        const wallM = a.walls.reduce((s, x) => s + x.len, 0);
        const roofN = a.roofs.reduce((s, x) => s + x.n, 0);
        if (!a.walls.length && roofN === 0) return;
        const where = [...new Set(a.walls.map((x) => `${x.level}階${x.room ? `・${x.room}` : ''}`))].slice(0, 3).join('、');
        const parts = [a.walls.length ? `外壁が抜けている所 ${a.walls.length} か所（計 ${wallM.toFixed(1)} m${where ? `：${where}` : ''}）` : '', roofN ? `屋根の穴 ${roofN} 点` : ''].filter(Boolean);
        toast(`外観の自己点検: ${parts.join('・')}。「図面読込」の「間取りを手で修正する」で壁を描き足せます`, 'info', 9000);
      } catch (e) {
        console.warn('自己点検に失敗', e);
      }
    }, 600);
  }

  renderSteps() {
    clear(this.stepBar);
    this.steps.forEach((s, i) =>
      this.stepBar.appendChild(
        h(
          'button',
          { class: `step ${this.current?.id === s.id ? 'on' : ''}`, disabled: s.needsModel && !state.model, onclick: () => this.go(s.id) },
          h('span', { class: 'num' }, String(i + 1)),
          h('span', { class: 'lbl-long' }, s.label),
          h('span', { class: 'lbl-short' }, s.short ?? s.label),
        ),
      ),
    );
  }

  async go(id: string) {
    const s = this.steps.find((x) => x.id === id);
    if (!s || (s.needsModel && !state.model)) return;
    this.current?.unmount?.();
    if (!s.uses3d) {
      this.furnTool?.setActive(false);
      this.extTool?.setActive(false);
    }
    this.current = s;
    this.renderSteps();
    clear(this.side);
    clear(this.stepHost);
    this.stepHost.style.pointerEvents = s.uses3d ? 'none' : 'auto';
    this.viewerHost.style.visibility = s.uses3d ? 'visible' : 'hidden';
    // 3D を見せないステップでは描画ループを止める（隠れたまま毎コマ高品質で描き続けると、図面・見積・資料の画面が重くなる。
    // 撮影（capture）は明示的に描くので止めていても動く）
    this._viewer?.pause(!s.uses3d);
    if (s.uses3d) {
      this.ensureScene();
      // 日照の太陽の軌道・周辺建物・ヒートマップは日照ステップだけ（そのステップが自分で表示する）
      this.viewer.groups.context.visible = false;
      this.viewer.groups.overlay.visible = false;
      this.viewer.invalidate();
      this.viewer.resize();
    }
    const inner = h('div', { class: 'side-inner' });
    this.side.appendChild(inner);
    await s.mount({ app: this, stage: this.stepHost, side: inner });
    location.hash = id;
  }

  get currentId() {
    return this.current?.id;
  }
}
