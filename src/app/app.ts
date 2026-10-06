/** アプリ本体（ステップ切り替えと共有ビューア） */
import { h, clear, toast } from './dom';
import { state, on, emit } from './state';
import { saveProjectFile, openProjectFile, purgeLegacyAutosave } from './project';
import { Viewer } from '../scene/viewer';

export interface StepCtx {
  app: App;
  stage: HTMLElement;
  side: HTMLElement;
}

export interface Step {
  id: string;
  label: string;
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
  builtVersion = -1;

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
    const top = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, '家'), h('div', null, '間取りプレゼン', h('small', null, '平面図PDF → パース・動画・日照検討'))),
      this.stepBar,
      h('div', { class: 'spacer' }),
      nameInput,
      this.buildProjectButtons(),
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
      this.renderSteps();
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
      h('button', { class: 'btn sm', title: 'プロジェクトをファイルに保存（Ctrl+S）。図面の読み取り結果・修正・テイスト・建設地・パース画像をまとめて保存します', onclick: () => void saveProjectFile() }, '💾 保存'),
      h('button', { class: 'btn sm', title: '保存したプロジェクト（.madori.json）を開く', onclick: () => input.click() }, '📂 開く'),
      input,
    );
  }

  get viewer(): Viewer {
    if (!this._viewer) {
      this._viewer = new Viewer(this.viewerHost, state.design);
      this.buildNavBar(this._viewer);
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
    const setMode = (m: Mode) => {
      v.setNavMode(m);
      orbit.classList.toggle('on', m === 'orbit');
      pan.classList.toggle('on', m === 'pan');
      walk.classList.toggle('on', m === 'walk');
    };
    setMode('orbit');
    bar.append(
      orbit,
      pan,
      walk,
      h('div', { class: 'nav-sep' }),
      h('button', { class: 'nav-btn', title: 'ズームイン', onclick: () => v.zoomBy(0.75) }, h('span', { class: 'ic' }, '＋')),
      h('button', { class: 'nav-btn', title: 'ズームアウト', onclick: () => v.zoomBy(1.33) }, h('span', { class: 'ic' }, '－')),
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
  }

  /** モデルが更新されていれば 3D を作り直す */
  ensureScene() {
    if (!state.model) return;
    const v = this.viewer;
    if (this.builtVersion !== this.modelVersion) {
      v.setModel(state.model);
      this.builtVersion = this.modelVersion;
    }
  }

  renderSteps() {
    clear(this.stepBar);
    this.steps.forEach((s, i) =>
      this.stepBar.appendChild(
        h(
          'button',
          { class: `step ${this.current?.id === s.id ? 'on' : ''}`, disabled: s.needsModel && !state.model, onclick: () => this.go(s.id) },
          h('span', { class: 'num' }, String(i + 1)),
          s.label,
        ),
      ),
    );
  }

  async go(id: string) {
    const s = this.steps.find((x) => x.id === id);
    if (!s || (s.needsModel && !state.model)) return;
    this.current?.unmount?.();
    this.current = s;
    this.renderSteps();
    clear(this.side);
    clear(this.stepHost);
    this.stepHost.style.pointerEvents = s.uses3d ? 'none' : 'auto';
    this.viewerHost.style.visibility = s.uses3d ? 'visible' : 'hidden';
    if (s.uses3d) {
      this.ensureScene();
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
