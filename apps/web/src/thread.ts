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

type Turnish = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  usage?: CallUsage | undefined;
};

/**
 * Each reply's usage (decision 15): its call plus the tool rounds before it that have no text.
 * Rounds of a turn that ended without a reply (an abort, an error) go to the reply before them,
 * so the replies add up to the chat total; while a turn runs (`running`), its rounds wait.
 */
export function replyUsage(messages: Turnish[], running: boolean) {
  const out = new Map<string, CallUsage>();
  let pending: CallUsage[] = [];
  let lastReply: string | undefined;
  const settle = () => {
    const merged = lastReply && pending.length && sumUsage([...pending, out.get(lastReply)]);
    if (lastReply && merged) out.set(lastReply, merged);
    pending = [];
  };
  for (const m of messages) {
    if (m.role === 'user') settle();
    else if (!m.text) {
      if (m.usage) pending.push(m.usage);
    } else {
      const u = sumUsage([...pending, m.usage]);
      pending = [];
      if (u) out.set(m.id, u);
      lastReply = m.id;
    }
  }
  if (!running) settle();
  return out;
}

/** "12 s", "1 min 5 s"; at least 1 s. */
export function duration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** The closed thinking row: "Ajatteli 12 s", or "Ajatteli" without a time. */
export const thoughtFor = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? 'Ajatteli' : `Ajatteli ${duration(ms)}`;

/**
 * Lower case that keeps every offset: the whole string when its length stays, else char by
 * char, keeping a char whose lower case has another length (`İ` → `i̇`).
 */
export function sameLengthLower(s: string) {
  const all = s.toLocaleLowerCase('fi');
  if (all.length === s.length) return all;
  return [...s]
    .map((ch) => {
      const low = ch.toLocaleLowerCase('fi');
      return low.length === ch.length ? low : ch;
    })
    .join('');
}

/** Offsets of `q` in `text`, case-insensitive (`fi`), without overlaps. */
export function findOffsets(text: string, q: string): number[] {
  const needle = sameLengthLower(q);
  if (!needle) return [];
  const hay = sameLengthLower(text);
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

const FENCE = /^\s*(`{3,}|~{3,})/;
/** A fence line that closes `open` (same char, at least as long, nothing after it). */
const closes = (line: string, open: string) => {
  const m = FENCE.exec(line);
  return (
    !!m && m[1]![0] === open[0] && m[1]!.length >= open.length && !line.slice(m[0].length).trim()
  );
};

/**
 * Splits Markdown at blank lines outside code fences, so a streamed reply re-renders only its
 * last block. A blank line before an indented line or a list item does not split (loose lists,
 * nested content), and text with link reference or footnote definitions stays whole, because
 * those resolve across blocks.
 */
export function mdBlocks(text: string): string[] {
  if (/^ {0,3}\[[^\]\n]+\]:/m.test(text)) return [text];
  const lines = text.split('\n');
  const blocks: string[] = [];
  let start = 0;
  let fence = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      if (closes(line, fence)) fence = '';
    } else if (FENCE.test(line)) fence = FENCE.exec(line)![1]!;
    else if (
      !line.trim() &&
      i > start &&
      i + 1 < lines.length &&
      !/^(\s|[-*+](\s|$)|\d+[.)](\s|$)|$)/.test(lines[i + 1]!)
    ) {
      blocks.push(lines.slice(start, i).join('\n'));
      start = i + 1;
    }
  }
  blocks.push(lines.slice(start).join('\n'));
  return blocks;
}

/**
 * The streamed last block as it will read once its closing markers arrive, so nothing flips
 * between raw and rendered text: an unclosed inline code span or link is closed, a table's
 * delimiter row gets its missing cells, and a half-typed fence or a lone list marker (which
 * would read as a setext heading underline) waits for the next delta. An unclosed fence already
 * renders as a code block (CommonMark).
 */
export function settleTail(block: string): string {
  const lines = block.split('\n');
  let fence = '';
  let after = 0;
  lines.forEach((line, i) => {
    if (fence) {
      if (closes(line, fence)) [fence, after] = ['', i + 1];
    } else if (FENCE.test(line)) fence = FENCE.exec(line)![1]!;
  });
  const last = lines.at(-1)!;
  if (/^\s*(`{1,2}|~{1,2})$/.test(last) || (!fence && /^\s*([-*+]|\d+[.)])\s*$/.test(last)))
    lines.pop();
  if (fence) return lines.join('\n');
  const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  const head = lines.at(-2);
  const tail = lines.at(-1);
  if (head?.includes('|') && tail && /^\s*\|?\s*:?-[-:|\s]*$/.test(tail)) {
    const want = cells(head).length;
    const typed = cells(tail).filter((c) => c.includes('-'));
    if (typed.length < want)
      lines[lines.length - 1] =
        `|${[...typed, ...Array<string>(want - typed.length).fill(' --- ')].join('|')}|`;
  }
  let out = lines.join('\n');
  // Code spans: a run of backticks opens one, the next run of the same length closes it.
  let open = 0;
  for (const run of lines.slice(after).join('\n').match(/`+/g) ?? [])
    open = open === run.length ? 0 : open || run.length;
  if (open) out = out.endsWith('`'.repeat(open)) ? out.slice(0, -open) : out + '`'.repeat(open);
  // A link whose URL is still coming: closed; an image waits whole (no request to half a URL).
  const link = /(!?)\[[^\]\n]*\]\([^)\s]*$/.exec(out);
  if (link) out = link[1] ? out.slice(0, link.index) : `${out})`;
  return out;
}
