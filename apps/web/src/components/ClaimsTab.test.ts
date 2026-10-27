import { expect, test } from 'vitest';
import { claimDate, expiryDay } from './ClaimsTab.tsx';

test('expiryDay: a month becomes its last day, a day stays, none is empty', () => {
  expect(expiryDay('2026-02')).toBe('2026-02-28');
  expect(expiryDay('2028-02')).toBe('2028-02-29');
  expect(expiryDay('2026-12-24')).toBe('2026-12-24');
  expect(expiryDay(null)).toBe('');
});

test('claimDate: Finnish day and month forms', () => {
  expect(claimDate('2026-10-05')).toBe('5.10.2026');
  expect(claimDate('2026-10')).toBe('10.2026');
});
