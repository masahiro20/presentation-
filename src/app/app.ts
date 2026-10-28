/** アプリ本体（ステップ切り替えと共有ビューア） */
import { h, clear, toast } from './dom';
import { state, on, emit } from './state';
import { shareDialog } from './share';
import { saveProjectFile, openProjectFile, purgeLegacyAutosave } from './project';
import { Viewer } from '../scene/viewer';
import { auditEnvelope } from '../scene/selfCheck';
import { createFurnitureTool } from './furnitureTool';

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
    const top = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, h('div', { class: 'wordmark' }, 'Home Landick')),
      office,
      nameInput,
      h('div', { class: 'spacer' }),
      this.stepBar,
      h('div', { class: 'spacer' }),
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
      h('button', { class: 'btn sm ghost', title: 'プロジェクトをファイルに保存（Ctrl+S）。図面の読み取り結果・修正・テイスト・建設地・パース画像をまとめて保存します', onclick: () => void saveProjectFile() }, '保存'),
      h('button', { class: 'btn sm ghost', title: '保存したプロジェクト（.madori.json）を開く', onclick: () => input.click() }, '開く'),
      h('button', { class: 'btn sm primary', title: 'お客様がスマホで開ける体験リンクを作る（歩く・光・テイスト・AR・動画）', onclick: () => void shareDialog(this) }, 'お客様に渡す'),
      input,
    );
  }

  get viewer(): Viewer {
    if (!this._viewer) {
      this._viewer = new Viewer(this.viewerHost, state.design);
      // 点検用（裏の Chrome から構図を確かめる）
      (globalThis as unknown as { __viewer: Viewer }).__viewer = this._viewer;
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
    // 表示の重さ: 閲覧（軽快）が既定。仕上げ表示は止まったときだけ GTAO・SMAA 込みで描く。保存・書き出しは常に高品質
    const finish = h(
      'button',
      {
        class: 'nav-btn',
        title: '仕上げ表示（止まったときに陰影・輪郭を仕上げて描く。見て回るときは切って軽快に）\n保存するパース・動画は表示に関係なく常に高品質です',
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
    this.furnTool = createFurnitureTool(v, this.viewerHost, () => {
      emit('model');
      this.builtVersion = this.modelVersion;
    });
    bar.append(
      orbit,
      pan,
      walk,
      this.furnTool.button,
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
    if (!s.uses3d) this.furnTool?.setActive(false);
    this.current = s;
    this.renderSteps();
    clear(this.side);
    clear(this.stepHost);
    this.stepHost.style.pointerEvents = s.uses3d ? 'none' : 'auto';
    this.viewerHost.style.visibility = s.uses3d ? 'visible' : 'hidden';
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
