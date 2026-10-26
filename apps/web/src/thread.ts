import type { CallUsage } from '@pa/protocol';

const clock = new Intl.DateTimeFormat('fi', { hour: 'numeric', minute: '2-digit' });
const dayMonth = new Intl.DateTimeFormat('fi', { day: 'numeric', month: 'numeric' });
const fullDate = new Intl.DateTimeFormat('fi', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
});
const weekday = new Intl.DateTimeFormat('fi', { weekday: 'long' });

/**
 * A message time (phase-13 decision 18), in the browser's time zone: "klo 17.20" today,
 * "25.10. klo 17.20" this year, "25.10.2025 klo 17.20" before.
 */
export function messageTime(iso: string, now = new Date()) {
  const d = new Date(iso);
  const time = `klo ${clock.format(d)}`;
  if (d.toDateString() === now.toDateString()) return time;
  if (d.getFullYear() === now.getFullYear()) return `${dayMonth.format(d)} ${time}`;
  return `${fullDate.format(d)} ${time}`;
}

/** "maanantai 26.10.2026 klo 17.20": the time's tooltip. */
export const fullTime = (iso: string) => {
  const d = new Date(iso);
  return `${weekday.format(d)} ${fullDate.format(d)} klo ${clock.format(d)}`;
};

/** Tokens of a call: input, output and both cache parts, as Pi's `totalTokens`. */
export const tokensOf = (u: CallUsage) => u.input + u.output + u.cacheRead + u.cacheWrite;

/**
 * One reply's usage: the message and the tool rounds before it in its turn (decision 15). The
 * model is the last call's; any estimate makes the sum an estimate.
 */
export function sumUsage(list: (CallUsage | undefined)[]): CallUsage | undefined {
  const calls = list.filter((u): u is CallUsage => !!u);
  const last = calls.at(-1);
  if (!last) return undefined;
  const add = (k: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'costUsd') =>
    calls.reduce((n, u) => n + u[k], 0);
  return {
    model: last.model,
    input: add('input'),
    output: add('output'),
    cacheRead: add('cacheRead'),
    cacheWrite: add('cacheWrite'),
    reasoning: add('reasoning'),
    costUsd: add('costUsd'),
    estimated: calls.some((u) => u.estimated),
  };
}

/** "12 s", "1 min 5 s"; at least 1 s. */
export function duration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** The closed thinking row: "Ajatteli 12 s", or "Ajatteli" without a time. */
export const thoughtFor = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? 'Ajatteli' : `Ajatteli ${duration(ms)}`;
