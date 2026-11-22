/** プロンプト集の単独ページ（prompts.html）。スマホで Gemini を開きながら、ここからコピーして貼る */
import { h } from './app/dom';
import { renderPromptLibrary } from './app/promptLibrary';

const app = document.getElementById('app')!;
app.append(
  h('header', null, h('img', { src: './brand/logo-hl.png', alt: 'Home Landick' }), h('h1', null, 'プロンプト集'), h('a', { href: './' }, 'Studio に戻る')),
  renderPromptLibrary(),
);
