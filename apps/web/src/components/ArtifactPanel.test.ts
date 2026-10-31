import type { Artifact, ChatSummary } from '@pa/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, test } from 'vitest';
import { blockMasked, maskedSource, revealArtifact, useStore } from '../store.ts';
import { RevealBar } from './ArtifactPanel.tsx';

// Phase-30 decision 14: a page of a tainted chat runs its masked source until the user confirms.
const LINE = 'Ulkoista sisältöä: oikeat arvot piilotettu';
const BLOCK = '<h1>Matti Virtanen</h1>\n';
const page = (masked?: string, id = 'a1'): Artifact => ({
  id,
  kind: 'html',
  title: 'Sivu',
  language: 'html',
  content: '<h1>Matti Virtanen</h1>',
  ...(masked === undefined ? {} : { masked }),
});
const chat = (id: string, tainted: boolean) => ({ id, tainted }) as ChatSummary;
const withChat = (tainted: boolean, list: Artifact[]) =>
  useStore.setState({
    activeChatId: 'c1',
    chats: [chat('c1', tainted)],
    artifacts: { c1: list },
    revealed: {},
  });
const s = () => useStore.getState();

beforeEach(() => withChat(false, []));

test('the panel bar: the masked line, and "Näytä oikeat arvot" only with something to reveal', () => {
  const bar = (onReveal?: () => void) =>
    renderToStaticMarkup(createElement(RevealBar, { title: 'Sivu', onReveal }));
  expect(bar(() => {})).toContain(LINE);
  expect(bar(() => {})).toMatch(/<button[^>]*>Näytä oikeat arvot<\/button>/);
  expect(bar()).toContain(LINE);
  expect(bar()).not.toContain('<button');
});

test('only a page with a masked source runs it; charts and untainted pages run their content', () => {
  expect(maskedSource(s(), 'c1', page('<h1>Pekka Laaksonen</h1>'))).toBe(
    '<h1>Pekka Laaksonen</h1>',
  );
  expect(maskedSource(s(), 'c1', page())).toBeUndefined();
  expect(maskedSource(s(), 'c1', { ...page('x'), kind: 'vega-lite' })).toBeUndefined();
  expect(maskedSource(s(), 'c1', undefined)).toBeUndefined();
  withChat(false, [page()]);
  expect(blockMasked(s(), BLOCK)).toBe(false);
  withChat(false, [page('<h1>Pekka Laaksonen</h1>')]);
  expect(blockMasked(s(), BLOCK)).toBe(true);
});

test('a tainted chat: a page without its masked source yet runs nothing, and its card says so', () => {
  withChat(true, []);
  // The code block's own `local-` artifact (opened before the server artifact came).
  expect(maskedSource(s(), 'c1', { ...page(), id: 'local-1' })).toBeNull();
  expect(blockMasked(s(), BLOCK)).toBe(true);
  // The server artifact with its masked source takes over.
  withChat(true, [page('<h1>Pekka Laaksonen</h1>')]);
  expect(maskedSource(s(), 'c1', s().artifacts.c1?.[0])).toBe('<h1>Pekka Laaksonen</h1>');
});

test('the confirmed reveal restores that artifact of that chat only', () => {
  withChat(true, [page('<h1>Pekka Laaksonen</h1>')]);
  revealArtifact('c1', 'a1');
  expect(maskedSource(s(), 'c1', page('<h1>Pekka Laaksonen</h1>'))).toBeUndefined();
  expect(blockMasked(s(), BLOCK)).toBe(false);
  expect(maskedSource(s(), 'c1', page('x', 'a2'))).toBe('x');
  // A fork keeps the entry ids: the same id in another chat stays masked.
  expect(maskedSource(s(), 'c2', page('x'))).toBe('x');
});
