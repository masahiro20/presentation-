import '../app/styles.css';
import './sunstudy.css';
import { StudyShell } from './shell';
import { placeStep } from './steps/placeStep';
import { modelStep } from './steps/modelStep';
import { simStep } from './steps/simStep';
import { study } from './state';
import { loadProjectFromUrl } from './project';

window.addEventListener('error', () => ((window as unknown as { __failed: boolean }).__failed = true));
window.addEventListener('unhandledrejection', () => ((window as unknown as { __failed: boolean }).__failed = true));

const shell = new StudyShell(document.getElementById('app')!, [placeStep, modelStep, simStep]);
(window as unknown as { shell: StudyShell; study: typeof study }).shell = shell;
(window as unknown as { shell: StudyShell; study: typeof study }).study = study;

async function boot() {
  // ?project=<url> でプロジェクト JSON を直接開く（デモ・検証用）
  const params = new URLSearchParams(location.search);
  const proj = params.get('project');
  if (proj) {
    try {
      await loadProjectFromUrl(proj);
    } catch (e) {
      console.error(e);
    }
  }
  const target = location.hash.slice(1);
  const step = shell.steps.find((s) => s.id === target && s.enabled());
  await shell.go(step ? step.id : 'place');
  (window as unknown as { __ready: boolean }).__ready = true;
}
void boot();
