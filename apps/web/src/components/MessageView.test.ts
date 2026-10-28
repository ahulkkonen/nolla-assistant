import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { expect, test } from 'vitest';
import { rehypeConfidence } from './MessageView.tsx';

const html = (md: string) =>
  renderToStaticMarkup(createElement(Markdown, { rehypePlugins: [rehypeConfidence] }, md));
const conf = (p: number, n: number, text: string) =>
  `<span class="conf" style="--conf:${p}" title="Luottamus ${n}/9">${text}</span>`;

test('rehypeConfidence: each sentence before its marker gets --conf, the marker goes', () => {
  expect(html('Varma.⟦9⟧ Arvaus.⟦1⟧ Keskeltä.⟦5⟧ Loppu ilman')).toBe(
    `<p>${conf(100, 9, 'Varma.')}${conf(35, 1, ' Arvaus.')}${conf(68, 5, ' Keskeltä.')} Loppu ilman</p>`,
  );
});

test('rehypeConfidence: a marker inside bold wraps the bold text node; code stays as written', () => {
  expect(html('Alku **tärkeä lause.⟦7⟧** ja `koodi ⟦3⟧`')).toBe(
    `<p>Alku <strong>${conf(84, 7, 'tärkeä lause.')}</strong> ja <code>koodi ⟦3⟧</code></p>`,
  );
});

test('rehypeConfidence: an unterminated marker at the end of the last text is hidden', () => {
  expect(html('Eka.⟦8⟧ Toka.⟦')).toBe(`<p>${conf(92, 8, 'Eka.')} Toka.</p>`);
  expect(html('Eka.⟦8⟧ Toka.⟦6')).toBe(`<p>${conf(92, 8, 'Eka.')} Toka.</p>`);
});
