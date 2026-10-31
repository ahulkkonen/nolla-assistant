import { expect, test } from 'vitest';
import { cutText, thinkingOf } from './session-text.ts';

test('thinkingOf trims the joined text: no empty last line (phase-21 decision 6)', () => {
  const m = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '  Mietin.' },
      { type: 'text', text: 'Vastaus.' },
      { type: 'thinking', thinking: 'Vielä.\n' },
    ],
  } as Parameters<typeof thinkingOf>[0];
  expect(thinkingOf(m)).toBe('Mietin.\n\nVielä.');
});

test('cutText cuts at a paragraph or a space, never inside a surrogate pair', () => {
  expect(cutText('lyhyt', 10)).toBe('lyhyt');
  const para = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}`;
  expect(cutText(para, 40)).toBe(`${'a'.repeat(30)}…`);
  const words = `${'a'.repeat(30)} ${'b'.repeat(30)}`;
  expect(cutText(words, 40)).toBe(`${'a'.repeat(30)}…`);
  const emoji = `${'x'.repeat(3000)}😀😀`;
  const cut = cutText(emoji, 3001);
  expect(cut).toBe(`${'x'.repeat(3000)}…`);
});
