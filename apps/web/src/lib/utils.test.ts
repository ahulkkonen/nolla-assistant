import { expect, test } from 'vitest';
import { cn } from './utils.ts';

test('cn keeps a type role next to a colour', () => {
  expect(cn('text-meta', 'text-muted-foreground')).toBe('text-meta text-muted-foreground');
  expect(cn('text-sm', 'text-body')).toBe('text-body');
  expect(cn('text-ui', 'text-meta')).toBe('text-meta');
  expect(cn('text-foreground', 'text-muted-foreground')).toBe('text-muted-foreground');
});
