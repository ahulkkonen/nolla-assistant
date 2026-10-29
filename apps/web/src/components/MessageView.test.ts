import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { expect, test } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MessageView, rehypeConfidence } from './MessageView.tsx';

const html = (md: string) =>
  renderToStaticMarkup(createElement(Markdown, { rehypePlugins: [rehypeConfidence] }, md));
// Phase-23 decision 9: each span ends with its N, which CSS shows on hover, a tap or "Näytä luvut".
const conf = (p: number, n: number, text: string) =>
  `<span class="conf" style="--conf:${p}" title="Luottamus ${n}/9">${text}<sup class="conf-n">${n}</sup></span>`;

test('rehypeConfidence: each sentence before its marker gets --conf and its N, the marker goes', () => {
  expect(html('Varma.⟦9⟧ Arvaus.⟦1⟧ Keskeltä.⟦5⟧ Loppu ilman')).toBe(
    `<p>${conf(100, 9, 'Varma.')}${conf(0, 1, ' Arvaus.')}${conf(50, 5, ' Keskeltä.')} Loppu ilman</p>`,
  );
});

test('rehypeConfidence: a marker inside bold wraps the bold text node; code stays as written', () => {
  expect(html('Alku **tärkeä lause.⟦7⟧** ja `koodi ⟦3⟧`')).toBe(
    `<p>Alku <strong>${conf(75, 7, 'tärkeä lause.')}</strong> ja <code>koodi ⟦3⟧</code></p>`,
  );
});

test('rehypeConfidence: an unterminated marker at the end of the last text is hidden', () => {
  expect(html('Eka.⟦8⟧ Toka.⟦')).toBe(`<p>${conf(88, 8, 'Eka.')} Toka.</p>`);
  expect(html('Eka.⟦8⟧ Toka.⟦6')).toBe(`<p>${conf(88, 8, 'Eka.')} Toka.</p>`);
});

const view = (role: 'user' | 'assistant', text: string) =>
  renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(MessageView, { role, text })),
  );

test('legend: a reply with markers shows the scale and "Näytä luvut"; others have none', () => {
  const html = view('assistant', 'Varma.⟦9⟧ Arvaus.⟦1⟧');
  expect(html).toContain('<span>Luottamus</span>');
  expect(html.match(/class="conf-swatch/g)).toHaveLength(9);
  expect(html).toContain('style="--conf:0"');
  expect(html).toContain('style="--conf:100"');
  // Phones hide the scale's words visually; the text keeps them.
  expect(html.replace(/<[^>]+>/g, '')).toContain('Luottamus1 arvaus9 varmaNäytä luvut');
  expect(html).toMatch(/<button type="button" aria-pressed="false"[^>]*>Näytä luvut<\/button>/);
  expect(html).not.toContain('data-conf-n');
  expect(view('assistant', 'Ei merkintöjä.')).not.toContain('Näytä luvut');
  expect(view('user', 'Varma.⟦9⟧')).not.toContain('Näytä luvut');
});
