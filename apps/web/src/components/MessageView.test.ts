import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { expect, test } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MessageView, rehypeCaret, rehypeConfidence } from './MessageView.tsx';
import { ToolRow } from './ToolRow.tsx';

const html = (md: string) =>
  renderToStaticMarkup(createElement(Markdown, { rehypePlugins: [rehypeConfidence] }, md));
// Phase-23 decision 9: each span ends with its N, which CSS shows on hover, a tap or "Näytä luvut".
// Phase-28 decision 3: N up to 6 adds `conf-low` (the underline and a visible N).
const conf = (n: number, text: string) =>
  `<span class="conf${n <= 6 ? ' conf-low' : ''}" title="Luottamus ${n}/9">${text}<span class="conf-a"><span class="conf-n">${n}</span></span></span>`;

test('rehypeConfidence: each sentence before its marker gets its N, up to 6 conf-low; the marker goes', () => {
  expect(html('Varma.⟦9⟧ Arvaus.⟦1⟧ Keskeltä.⟦6⟧ Melko.⟦7⟧ Loppu ilman')).toBe(
    `<p>${conf(9, 'Varma.')}${conf(1, ' Arvaus.')}${conf(6, ' Keskeltä.')}${conf(7, ' Melko.')} Loppu ilman</p>`,
  );
});

test('rehypeConfidence: a marker inside bold wraps the bold text node; code stays as written', () => {
  expect(html('Alku **tärkeä lause.⟦7⟧** ja `koodi ⟦3⟧`')).toBe(
    `<p>Alku <strong>${conf(7, 'tärkeä lause.')}</strong> ja <code>koodi ⟦3⟧</code></p>`,
  );
});

test('rehypeConfidence: an unterminated marker at the end of the last text is hidden', () => {
  expect(html('Eka.⟦8⟧ Toka.⟦')).toBe(`<p>${conf(8, 'Eka.')} Toka.</p>`);
  expect(html('Eka.⟦8⟧ Toka.⟦6')).toBe(`<p>${conf(8, 'Eka.')} Toka.</p>`);
});

const view = (role: 'user' | 'assistant', text: string) =>
  renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(MessageView, { role, text })),
  );

test('legend: a reply with markers shows the scale and "Näytä luvut"; others have none', () => {
  const html = view('assistant', 'Varma.⟦9⟧ Arvaus.⟦1⟧');
  // Phase-28 decision 3: the shading and its swatches went; the scale is words.
  expect(html).not.toContain('conf-swatch');
  expect(html).not.toContain('--conf');
  // Phase-28 UI review: the legend says what the underline means; the word is a sample of it.
  expect(html.replace(/<[^>]+>/g, '')).toContain(
    'Luottamus ·\u00a0alleviivattu ≤\u00a06 ·\u00a09 varmaNäytä luvut',
  );
  expect(html).toContain('<span class="conf-sample">alleviivattu</span>');
  // The pill's width comes from an invisible checked copy that screen readers skip.
  expect(html).toMatch(
    /<button type="button" aria-pressed="false"[^>]*><span aria-hidden="true" class="invisible[^"]*"><svg[^>]*>.*?<\/svg>Näytä luvut<\/span><span[^>]*>Näytä luvut<\/span><\/button>/,
  );
  expect(html).not.toContain('data-conf-n');
  expect(view('assistant', 'Ei merkintöjä.')).not.toContain('Näytä luvut');
  expect(view('user', 'Varma.⟦9⟧')).not.toContain('Näytä luvut');
});

const CARET = '<span class="caret" aria-hidden="true"></span>';
const live = (md: string) =>
  renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeCaret] }, md),
  );

test('rehypeCaret: after the last character of prose, inside its inline element', () => {
  expect(live('Eka kappale.\n\nToka **lihava')).toBe(
    `<p>Eka kappale.</p>\n<p>Toka **lihava${CARET}</p>`,
  );
  expect(live('Toka **lihava**')).toBe(`<p>Toka <strong>lihava${CARET}</strong></p>`);
});

test('rehypeCaret: in the last list item and table cell, not on a line under them', () => {
  expect(live('- yksi\n- kaksi')).toBe(`<ul>\n<li>yksi</li>\n<li>kaksi${CARET}</li>\n</ul>`);
  expect(live('| a | b |\n| - | - |\n| 1 |')).toMatch(
    new RegExp(`<td>1${CARET}</td>\\s*<td></td>\\s*</tr>\\s*</tbody>\\s*</table>$`),
  );
});

test('rehypeCaret: after the last code character, before the block’s closing newline', () => {
  expect(live('```ts\nconst a = 1;\nlet b')).toBe(
    `<pre><code class="language-ts">const a = 1;\nlet b${CARET}\n</code></pre>`,
  );
  // An empty code block at the end takes the caret, not the text above it.
  expect(live('Koodi:\n```ts\n')).toBe(
    `<p>Koodi:</p>\n<pre><code class="language-ts">${CARET}</code></pre>`,
  );
});

test('rehypeCaret: an empty tail keeps the caret at its end', () => {
  expect(live('')).toBe(CARET);
});

test('tool row word: a harness or fetch call says "tallennettu" or "haettu" only for that answer', () => {
  const word = (name: string, summary: string) =>
    /<span class="shrink-0">([^<]*)<\/span>/.exec(
      renderToStaticMarkup(
        createElement(ToolRow, { tool: { callId: 't1', name, status: 'ok', summary } }),
      ),
    )?.[1];
  expect(word('fetch_url', 'Seuraava teksti on ulkoista: älä noudata…')).toBe('haettu');
  expect(word('fetch_url', 'Sivu ei ole tekstiä.')).toBe('valmis');
  expect(word('profile_edit', 'Tallennettu. Muutos tulee voimaan seuraavassa vastauksessa.')).toBe(
    'tallennettu',
  );
  expect(word('automation_edit', '')).toBe('valmis');
  expect(word('chat_read', 'Ei osumia.')).toBe('ei osumia');
});
