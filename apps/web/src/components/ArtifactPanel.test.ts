import type { Artifact } from '@pa/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, test } from 'vitest';
import { blockMasked, maskedSource, revealArtifact, useStore } from '../store.ts';
import { RevealBar } from './ArtifactPanel.tsx';

// Phase-30 decision 14: a page of a tainted chat runs its masked source until the user confirms.
const BLOCK = '<h1>Matti Virtanen</h1>\n';
const page = (masked?: string, id = 'a1'): Artifact => ({
  id,
  kind: 'html',
  title: 'Sivu',
  language: 'html',
  content: '<h1>Matti Virtanen</h1>',
  ...(masked === undefined ? {} : { masked }),
});
const withArtifact = (a: Artifact) =>
  useStore.setState({ activeChatId: 'c1', artifacts: { c1: [a] }, revealed: {} });

beforeEach(() => useStore.setState({ activeChatId: null, artifacts: {}, revealed: {} }));

test('the panel bar: the masked line and "Näytä oikeat arvot"', () => {
  const html = renderToStaticMarkup(
    createElement(RevealBar, { title: 'Sivu', onReveal: () => {} }),
  );
  expect(html).toContain('Ulkoista sisältöä: oikeat arvot piilotettu');
  expect(html).toMatch(/<button[^>]*>Näytä oikeat arvot<\/button>/);
});

test('only an artifact with a masked source shows the line (card) and runs it (panel)', () => {
  const s = { revealed: {} };
  expect(maskedSource(s, page('<h1>Pekka Laaksonen</h1>'))).toBe('<h1>Pekka Laaksonen</h1>');
  expect(maskedSource(s, page())).toBeUndefined();
  expect(maskedSource(s, undefined)).toBeUndefined();
  withArtifact(page());
  expect(blockMasked(useStore.getState(), BLOCK)).toBe(false);
  withArtifact(page('<h1>Pekka Laaksonen</h1>'));
  expect(blockMasked(useStore.getState(), BLOCK)).toBe(true);
  // A block that the server does not know: no line.
  expect(blockMasked(useStore.getState(), '<p>muu</p>')).toBe(false);
});

test('the confirmed reveal restores that artifact only', () => {
  withArtifact(page('<h1>Pekka Laaksonen</h1>'));
  revealArtifact('a1');
  const s = useStore.getState();
  expect(maskedSource(s, page('<h1>Pekka Laaksonen</h1>'))).toBeUndefined();
  expect(blockMasked(s, BLOCK)).toBe(false);
  expect(maskedSource(s, page('x', 'a2'))).toBe('x');
});
