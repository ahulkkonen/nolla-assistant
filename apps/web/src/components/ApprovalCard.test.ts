import type { ApprovalView } from '@pa/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { Approval } from '../store.ts';
import { ApprovalCard, CLAMP } from './ApprovalCard.tsx';

const card = (view: ApprovalView, extra: Partial<Approval> = {}) =>
  renderToStaticMarkup(
    createElement(ApprovalCard, {
      a: {
        type: 'approval.request',
        chatId: 'c1',
        requestId: 'r1',
        tool: 'profile_edit',
        args: { file: 'prompt', content: 'x' },
        reason: 'Työkalu profile_edit vaatii hyväksynnän.',
        expiresAt: '2026-10-29T10:00:00.000Z',
        view,
        ...extra,
      },
    }),
  );
const diff = (n: number) => ({
  kind: 'diff' as const,
  file: 'prompts/assistant.md',
  created: false,
  diff: `@@ -1,${n} +1,${n} @@\n${Array.from({ length: n - 1 }, (_, i) => `+rivi ${i + 1}`).join('\n')}\n`,
});
const rows = (html: string) => html.match(/Lisätty: |@@ -1/g)?.length ?? 0;

test('diff: over 13 lines shows 13 with the fade and "Näytä kaikki"; 13 lines show all', () => {
  const long = card(diff(20));
  expect(rows(long)).toBe(CLAMP);
  expect(long).toContain('mask-image:linear-gradient(to_bottom,black_240px,transparent)');
  expect(long).toContain('Näytä kaikki');
  expect(long).not.toContain('rivi 13<');
  expect(long).toContain('rivi 12<');

  const short = card(diff(CLAMP));
  expect(rows(short)).toBe(CLAMP);
  expect(short).not.toContain('Näytä kaikki');
  expect(short).not.toContain('mask-image');
});

test('diff: a sign column, the tints and the words; the title and file of a prompt change', () => {
  const html = card({
    kind: 'diff',
    file: 'prompts/assistant.md',
    created: false,
    diff: '@@ -1,2 +1,2 @@\n konteksti\n-vanha\n+uusi\n',
  });
  expect(html).toContain('Muutetaanko avustajan ohjetta?');
  expect(html).toContain('Muutetaan tiedostoa <span class="font-mono');
  expect(html).toMatch(
    /class="flex pr-3 bg-destructive-subtle">.*?bg-destructive".*?−.*?Poistettu: <\/span>vanha/,
  );
  expect(html).toMatch(
    /class="flex pr-3 bg-success-subtle">.*?bg-success".*?\+.*?Lisätty: <\/span>uusi/,
  );
  expect(html).toContain('Muutos tulee voimaan seuraavassa vastauksessa');
  expect(html).not.toContain('ulkopuolista sisältöä');
});

test('mode, automation, chat and tainted cards', () => {
  const mode = card(
    { kind: 'diff', file: 'modes/lyhyt.md', created: true, diff: '@@ -0,0 +1 @@\n+a\n' },
    { args: { file: 'mode', id: 'lyhyt', content: '---\nname: Lyhyt\n---\n\nLyhyesti.' } },
  );
  expect(mode).toContain('Lisätäänkö tila ”Lyhyt”?');

  const yaml = card(
    {
      kind: 'yaml',
      file: 'automations/aamu.yaml',
      created: true,
      yaml: 'id: aamu\nname: Aamukatsaus\ncron: 30 7 * * 1-5\n',
      nextRuns: ['2026-11-02T05:30:00.000Z'],
    },
    { tool: 'automation_edit', tainted: true },
  );
  expect(yaml).toContain('Luodaanko automaatio ”Aamukatsaus”?');
  expect(yaml).toContain('Luodaan uusi tiedosto');
  expect(yaml).toContain('Seuraavat ajot: ');
  expect(yaml).toContain('Hyväksy vain, jos pyysit muutosta itse.');

  const chat = card(
    {
      kind: 'chat',
      chatId: 'c0',
      title: 'Kasvimaa',
      createdAt: '2026-10-25T14:20:00.000Z',
      messages: 1,
      query: null,
    },
    { tool: 'chat_read', tainted: true },
  );
  expect(chat).toContain('Luetaanko keskustelu ”Kasvimaa”?');
  expect(chat).toContain('25.10.2026 · 1 viesti');
  expect(chat).toContain('jos pyysit lukemista itse.');
});
