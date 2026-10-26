import { describe, expect, it } from 'vitest';
import { duration, messageTime, sumUsage, thoughtFor } from './thread.ts';

const call = (costUsd: number, estimated = false) => ({
  model: 'zdr/strong',
  input: 100,
  output: 20,
  cacheRead: 10,
  cacheWrite: 0,
  reasoning: 5,
  costUsd,
  estimated,
});

describe('thread helpers', () => {
  it('shows the time today, the day this year and the year before', () => {
    const now = new Date(2026, 9, 26, 18, 0);
    expect(messageTime(new Date(2026, 9, 26, 17, 20).toISOString(), now)).toBe('klo 17.20');
    expect(messageTime(new Date(2026, 9, 25, 17, 20).toISOString(), now)).toBe('25.10. klo 17.20');
    expect(messageTime(new Date(2025, 9, 25, 17, 20).toISOString(), now)).toBe(
      '25.10.2025 klo 17.20',
    );
  });

  it('sums a turn: the tool rounds and the reply, an estimate makes the sum one', () => {
    expect(sumUsage([undefined])).toBeUndefined();
    const sum = sumUsage([call(0.01), undefined, call(0.02, true)]);
    expect(sum).toMatchObject({
      input: 200,
      output: 40,
      cacheRead: 20,
      reasoning: 10,
      estimated: true,
    });
    expect(sum?.costUsd).toBeCloseTo(0.03);
  });

  it('writes the thinking time', () => {
    expect(thoughtFor(12_000)).toBe('Ajatteli 12 s');
    expect(thoughtFor(65_000)).toBe('Ajatteli 1 min 5 s');
    expect(thoughtFor(200)).toBe('Ajatteli 1 s');
    expect(thoughtFor(null)).toBe('Ajatteli');
    expect(duration(8_400)).toBe('8 s');
  });
});
