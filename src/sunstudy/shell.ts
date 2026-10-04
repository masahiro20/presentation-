/** 日照シミュレーションの画面の殻（ステップバー・ステージ・サイドパネル・共有の 3D シーン） */
import { h, clear } from '../app/dom';
import { study, on, emit } from './state';
import { StudyScene } from './scene';

export interface StudyCtx {
  shell: StudyShell;
  /** 3D の上に重ねるオーバーレイ（uses3d のステップ）／2D の画面（uses3d でないステップ） */
  stage: HTMLElement;
  side: HTMLElement;
  scene: StudyScene;
}

export interface StudyStep {
  id: string;
  label: string;
  /** 進めるか（例: 建物のステップは場所が決まってから） */
  enabled(): boolean;
  /** 無効なときに表示する理由 */
  disabledHint?: string;
  uses3d: boolean;
  mount(ctx: StudyCtx): void | Promise<void>;
  unmount?(): void;
}

export class StudyShell {
  readonly root: HTMLElement;
  readonly stage: HTMLElement;
  readonly side: HTMLElement;
  readonly viewerHost: HTMLElement;
  private navBar: HTMLElement;
  private stepHost: HTMLElement;
  private stepBar: HTMLElement;
  private current: StudyStep | null = null;
  private _scene: StudyScene | null = null;

  constructor(
    root: HTMLElement,
    readonly steps: StudyStep[],
  ) {
    this.root = root;
    this.stepBar = h('nav', { class: 'steps' });
    const nameInput = h('input', {
      class: 'project-name',
      value: study.name,
      title: 'プロジェクト名（お客様名・案件名）',
      oninput: (e: Event) => {
        study.name = (e.target as HTMLInputElement).value;
        emit('project');
      },
    });
    const top = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark sun' }, '☀'), h('div', null, '日照シミュレーション', h('small', null, '3D データ → 地図の実在の場所 → 日当たり・日影図'))),
      this.stepBar,
      h('div', { class: 'spacer' }),
      nameInput,
      h('a', { class: 'top-link', href: './index.html', title: '平面図 PDF から立面・パース・動画・資料を作る間取りプレゼンへ' }, '間取りプレゼン →'),
    );
    this.viewerHost = h('div', { id: 'viewer3d', class: 'view' });
    this.navBar = h('div', { class: 'nav-tools' });
    this.viewerHost.appendChild(this.navBar);
    this.stepHost = h('div', { class: 'view', style: 'pointer-events:none' });
    this.stage = h('div', { class: 'stage' }, this.viewerHost, this.stepHost);
    this.side = h('aside', { class: 'side' });
    root.append(top, h('div', { class: 'main' }, this.stage, this.side));
    this.renderSteps();
    for (const ev of ['frame', 'model', 'env']) on(ev, () => this.renderSteps());
    on('project', () => {
      if (nameInput.value !== study.name) nameInput.value = study.name;
    });
  }

  /** 3D シーン（最初に必要になったときに作る） */
  get scene(): StudyScene {
    if (!this._scene) {
      this._scene = new StudyScene(this.viewerHost);
      this.buildNavBar(this._scene);
    }
    return this._scene;
  }

  /** 3D 操作ツール（回転／掴んで移動／ズーム） */
  private buildNavBar(v: StudyScene) {
    const bar = this.navBar;
    const orbit = h('button', { class: 'nav-btn', title: '回転（ドラッグで建物の周りを回る）', onclick: () => setMode('orbit') }, h('span', { class: 'ic' }, '⟲'), '回転');
    const pan = h('button', { class: 'nav-btn', title: '移動（画面を掴んで上下左右にずらす）\nスペースキーを押している間も移動になります', onclick: () => setMode('pan') }, h('span', { class: 'ic' }, '✋'), '移動');
    const setMode = (m: 'orbit' | 'pan') => {
      v.setNavMode(m);
      orbit.classList.toggle('on', m === 'orbit');
      pan.classList.toggle('on', m === 'pan');
    };
    setMode('orbit');
    bar.append(
      orbit,
      pan,
      h('div', { class: 'nav-sep' }),
      h('button', { class: 'nav-btn', title: 'ズームイン', onclick: () => v.zoomBy(0.75) }, h('span', { class: 'ic' }, '＋')),
      h('button', { class: 'nav-btn', title: 'ズームアウト', onclick: () => v.zoomBy(1.33) }, h('span', { class: 'ic' }, '－')),
    );
    bar.title = '左ドラッグ：回転（移動モードでは移動）／右ドラッグ：移動／ホイール：カーソルの位置へズーム';
    let held: 'orbit' | 'pan' | null = null;
    const typing = (e: KeyboardEvent) => /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || typing(e) || this.viewerHost.style.visibility === 'hidden' || !this.current?.uses3d) return;
      e.preventDefault();
      if (held == null) {
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

  renderSteps() {
    clear(this.stepBar);
    this.steps.forEach((s, i) => {
      const en = s.enabled();
      this.stepBar.appendChild(
        h(
          'button',
          { class: `step ${this.current?.id === s.id ? 'on' : ''}`, disabled: !en, title: en ? '' : s.disabledHint ?? '', onclick: () => this.go(s.id) },
          h('span', { class: 'num' }, String(i + 1)),
          s.label,
        ),
      );
    });
  }

  async go(id: string) {
    const s = this.steps.find((x) => x.id === id);
    if (!s || !s.enabled()) return;
    this.current?.unmount?.();
    this.current = s;
    this.renderSteps();
    clear(this.side);
    clear(this.stepHost);
    this.stepHost.style.pointerEvents = s.uses3d ? 'none' : 'auto';
    this.viewerHost.style.visibility = s.uses3d ? 'visible' : 'hidden';
    if (s.uses3d) {
      this.scene.pause(false);
      this.scene.resize();
    } else if (this._scene) this._scene.pause(true);
    const inner = h('div', { class: 'side-inner' });
    this.side.appendChild(inner);
    // 3D を使わないステップでは WebGL のシーンを作らない（必要になったときに作る）
    const shell = this;
    await s.mount({
      shell,
      stage: this.stepHost,
      side: inner,
      get scene() {
        return shell.scene;
      },
    });
    location.hash = id;
  }

  get currentId() {
    return this.current?.id;
  }
}
