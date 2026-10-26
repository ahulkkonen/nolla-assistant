import { describe, expect, it } from 'vitest';
import {
  duration,
  findOffsets,
  messageTime,
  replyUsage,
  sameLengthLower,
  sumUsage,
  thoughtFor,
} from './thread.ts';

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

  it('gives each reply its tool rounds; a turn without a reply adds to the reply before it', () => {
    const msg = (id: string, role: 'user' | 'assistant', text: string, costUsd?: number) => ({
      id,
      role,
      text,
      ...(costUsd !== undefined ? { usage: call(costUsd) } : {}),
    });
    const thread = [
      msg('u1', 'user', 'Kysy'),
      msg('t1', 'assistant', '', 0.01),
      msg('a1', 'assistant', 'Vastaus', 0.02),
      msg('u2', 'user', 'Toinen'),
      msg('t2', 'assistant', '', 0.04),
    ];
    const done = replyUsage(thread, false);
    expect(done.get('a1')?.costUsd).toBeCloseTo(0.07);
    expect(done.get('a1')?.model).toBe('zdr/strong');
    // While the turn runs, its round waits for its own reply.
    expect(replyUsage(thread, true).get('a1')?.costUsd).toBeCloseTo(0.03);
  });

  it('finds every hit, case-insensitive, with offsets that fit the original text', () => {
    expect(findOffsets('Omena ja OMENAPUU, omena.', 'omena')).toEqual([0, 9, 19]);
    expect(findOffsets('aaaa', 'aa')).toEqual([0, 2]);
    expect(findOffsets('teksti', '')).toEqual([]);
    // "İ" lowers to two code units: kept as it is, so the later offsets stay right.
    const text = 'İstanbul ja omena';
    expect(sameLengthLower(text)).toHaveLength(text.length);
    const [at] = findOffsets(text, 'OMENA');
    expect(text.slice(at, (at ?? 0) + 5)).toBe('omena');
  });

  it('writes the thinking time', () => {
    expect(thoughtFor(12_000)).toBe('Ajatteli 12 s');
    expect(thoughtFor(65_000)).toBe('Ajatteli 1 min 5 s');
    expect(thoughtFor(200)).toBe('Ajatteli 1 s');
    expect(thoughtFor(null)).toBe('Ajatteli');
    expect(duration(8_400)).toBe('8 s');
  });
});
