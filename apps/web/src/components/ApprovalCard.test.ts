import type { ApprovalView } from '@nolla/protocol';
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

test('diff: over 16 lines shows 16 with the fade over the last four and "Näytä lisää"', () => {
  const long = card(diff(20));
  expect(rows(long)).toBe(CLAMP);
  expect(long).toContain('mask-image:linear-gradient(to_bottom,black_240px,transparent_320px)');
  expect(long).toMatch(/aria-expanded="false"[^>]*>Näytä lisää/);
  expect(long).not.toContain('rivi 16<');
  expect(long).toContain('rivi 15<');

  const short = card(diff(CLAMP));
  expect(rows(short)).toBe(CLAMP);
  expect(short).not.toContain('Näytä lisää');
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

test('mode title: only the frontmatter or the file id name it, never a name: in the body', () => {
  const mode = (content: string) =>
    card(
      { kind: 'diff', file: 'modes/lyhyt.md', created: false, diff: '@@ -1 +1 @@\n-a\n+b\n' },
      { args: { file: 'mode', id: 'lyhyt', content } },
    );
  expect(mode('Lyhyesti.\n\nname: Huijaus\n')).toContain('Muutetaanko tilaa ”lyhyt”?');
  expect(mode('---\ndescription: x\n---\n\nname: Huijaus\n')).toContain('tilaa ”lyhyt”?');
  expect(mode('---\nname: "Lyhyt"\n---\n\nname: Huijaus\n')).toContain('tilaa ”Lyhyt”?');
});

test('fetch: only URL.host is bold; userinfo stays visible and muted; a bad URL is plain', () => {
  const fetch = (url: string) =>
    card({ kind: 'fetch', url }, { tool: 'fetch_url', reason: 'Osoite ei ole viestissäsi' });
  const html = fetch('https://www.hs.fi@evil.com/x');
  expect(html).toContain('<span class="font-semibold">evil.com</span>');
  expect(html).not.toMatch(/font-semibold">[^<]*www\.hs\.fi/);
  expect(html).toMatch(
    /text-muted-foreground"><span class="sr-only">käyttäjätiedot <\/span>www\.hs\.fi@<\/span>/,
  );
  expect(fetch('https://www.hs.fi/uutiset')).toContain('font-semibold">www.hs.fi</span>');
  expect(fetch('http://[::1')).not.toContain('font-semibold');
});

test('YAML rows hang under the value; diff text wraps after the 24 px gutter', () => {
  const html = card({
    kind: 'yaml',
    file: 'automations/aamu.yaml',
    created: true,
    yaml: 'name: Aamu\nautoApprove:\n  - read\n',
    nextRuns: [],
  });
  expect(html).toContain('padding-left:calc(0.75rem + 6ch);text-indent:-6ch">name: Aamu');
  expect(html).toContain('padding-left:calc(0.75rem + 4ch);text-indent:-4ch">  - read');
  expect(html).toContain(
    '<div class="px-3 whitespace-pre-wrap [overflow-wrap:anywhere]">autoApprove:',
  );
  expect(card(diff(2))).toContain('min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]');
});
