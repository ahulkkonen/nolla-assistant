import { describe, expect, it } from 'vitest';
import { formatCost, formatTokens } from './index.ts';

const rate = { usdPerEur: 1.1193, date: '2026-10-23' };
// Intl puts a no-break space before the currency sign.
const s = (t: string) => t.replace(/ /g, '\u00a0');

describe('formatCost', () => {
  it('chat and month: two decimals in euros', () => {
    expect(formatCost(0.4701, rate)).toBe(s('0,42 €'));
    expect(formatCost(0, rate)).toBe(s('0,00 €'));
    expect(formatCost(1381.2, rate)).toBe(s('1 233,99 €'));
  });
  it('chat and month: below 0,01 shows "< 0,01 €"', () => {
    expect(formatCost(0.005, rate)).toBe(`< ${s('0,01 €')}`);
  });
  it('reply: three decimals below 0,10, two above', () => {
    expect(formatCost(0.0045, rate, { reply: true })).toBe(s('0,004 €'));
    expect(formatCost(0.2, rate, { reply: true })).toBe(s('0,18 €'));
  });
  it('reply: below 0,001 shows "< 0,001 €"', () => {
    expect(formatCost(0.0005, rate, { reply: true })).toBe(`< ${s('0,001 €')}`);
  });
  it('an estimate gets "~"', () => {
    expect(formatCost(0.4701, rate, { estimated: true })).toBe(`~${s('0,42 €')}`);
  });
  it('without a rate the unit is "$"', () => {
    expect(formatCost(0.42, null)).toBe(s('0,42 $'));
    expect(formatCost(0.004, null, { reply: true })).toBe(s('0,004 $'));
  });
});

describe('formatTokens', () => {
  it.each([
    [1, '1 tokeni'],
    [0, '0 tokenia'],
    [640, '640 tokenia'],
    [3400, '3,4 k tokenia'],
    [9990, '10 k tokenia'],
    [18_000, '18 k tokenia'],
    [999_400, '999 k tokenia'],
    [999_600, '1 M tokenia'],
    [1_200_000, '1,2 M tokenia'],
  ])('%i → %s', (n, text) => expect(formatTokens(n)).toBe(text));
});
