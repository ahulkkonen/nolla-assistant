import { expect, test } from 'vitest';
import { cronText, runText, scheduleText } from './cron.ts';

test('cronText', () => {
  expect(cronText('0 7 * * 1-5')).toBe('ma–pe klo 7.00');
  expect(cronText('0 3 1 1 *')).toBe('1.1. klo 3.00');
  expect(cronText('* * * * *')).toBe('joka minuutti');
  expect(cronText('30 18 * * *')).toBe('joka päivä klo 18.30');
  expect(cronText('0 0 7 * * 6,0')).toBe('la, su klo 7.00');
  expect(cronText('0 9 15 * *')).toBe('kuun 15. päivä klo 9.00');
  expect(cronText('*/5 * * * *')).toBe('*/5 * * * *');
});

test('scheduleText names the presets, runText the local time', () => {
  expect(scheduleText('30 7 * * 1-5')).toBe('Arkisin klo 7.30');
  expect(scheduleText('0 18 * * *')).toBe('Päivittäin klo 18.00');
  expect(scheduleText('5 9 * * 0')).toBe('Viikoittain su klo 9.05');
  expect(scheduleText('0 3 1 1 *')).toBe('1.1. klo 3.00');
  expect(runText(new Date(2026, 9, 27, 7, 30).toISOString())).toBe('ti 27.10. klo 7.30');
});
