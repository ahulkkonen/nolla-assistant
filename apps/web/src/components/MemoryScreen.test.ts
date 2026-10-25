import { expect, test } from 'vitest';
import { proposed } from './MemoryScreen.tsx';

const diff = [
  '--- a/USER.md',
  '+++ b/USER.md',
  '@@ -1,3 +1,2 @@',
  ' Asun Tampereella.',
  '-Pidän kahvista.',
  '-Pidän teestä.',
  '+Pidän kahvista ja teestä.',
].join('\n');

test('proposed: rebuilds the new file from a whole-file diff', () => {
  expect(proposed(diff, 'USER.md', 'x')).toBe('Asun Tampereella.\nPidän kahvista ja teestä.');
  expect(proposed(diff, 'MEMORY.md', 'ennallaan')).toBe('ennallaan');
});
