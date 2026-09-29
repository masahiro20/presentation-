/** アプリ本体（ステップ切り替えと共有ビューア） */
import { h, clear } from './dom';
import { state, on, emit } from './state';
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
    );
    this.viewerHost = h('div', { id: 'viewer3d', class: 'view' });
    this.stepHost = h('div', { class: 'view', style: 'pointer-events:none' });
    this.stage = h('div', { class: 'stage' }, this.viewerHost, this.stepHost);
    this.side = h('aside', { class: 'side' });
    root.append(top, h('div', { class: 'main' }, this.stage, this.side));
    this.renderSteps();
    on('model', () => {
      this.modelVersion++;
      this.renderSteps();
    });
  }

  get viewer(): Viewer {
    if (!this._viewer) this._viewer = new Viewer(this.viewerHost, state.design);
    return this._viewer;
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
