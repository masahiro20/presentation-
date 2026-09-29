import './app/styles.css';
import { App } from './app/app';
import { importStep } from './app/steps/importStep';
import { designStep } from './app/steps/designStep';
import { elevationStep } from './app/steps/elevationStep';
import { sunStep } from './app/steps/sunStep';
import { videoStep } from './app/steps/videoStep';
import { presentStep } from './app/steps/presentStep';
import { state, emit } from './app/state';
import { parsePdfInBrowser } from './parser/browser';

const app = new App(document.getElementById('app')!, [importStep, designStep, elevationStep, sunStep, videoStep, presentStep]);
(window as unknown as { app: App }).app = app;

async function boot() {
  const params = new URLSearchParams(location.search);
  const sample = params.get('sample');
  if (sample) {
    const buf = new Uint8Array(await (await fetch(`./samples/${sample}`)).arrayBuffer());
    state.model = await parsePdfInBrowser(buf, { name: 'サンプル邸' });
    state.pdfName = 'サンプル邸';
    emit('model');
  }
  const target = location.hash.slice(1);
  await app.go(state.model && target ? target : 'import');
  (window as unknown as { __ready: boolean }).__ready = true;
}
boot();
