import { expect, test } from 'vitest';
import { cronText } from './cron.ts';

test('cronText', () => {
  expect(cronText('0 7 * * 1-5')).toBe('ma–pe klo 7.00');
  expect(cronText('0 3 1 1 *')).toBe('1.1. klo 3.00');
  expect(cronText('* * * * *')).toBe('joka minuutti');
  expect(cronText('30 18 * * *')).toBe('joka päivä klo 18.30');
  expect(cronText('0 0 7 * * 6,0')).toBe('la, su klo 7.00');
  expect(cronText('0 9 15 * *')).toBe('kuun 15. päivä klo 9.00');
  expect(cronText('*/5 * * * *')).toBe('*/5 * * * *');
});
