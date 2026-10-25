import { expect, test } from 'vitest';
import { cn } from './utils.ts';

test('cn keeps a custom font size next to a colour', () => {
  expect(cn('text-secondary', 'text-fg-muted')).toBe('text-secondary text-fg-muted');
  expect(cn('text-sm', 'text-body')).toBe('text-body');
  expect(cn('text-fg', 'text-fg-muted')).toBe('text-fg-muted');
});
