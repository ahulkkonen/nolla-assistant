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

const percent = (digits: number) =>
  new Intl.NumberFormat('fi', { style: 'percent', maximumFractionDigits: digits });
const wholePercent = percent(0);
const finePercent = percent(1);

type CacheCounts = {
  input?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
};

/**
 * The prompt cache hit rate (phase-16 decision 10), "82 %": `cacheRead / (input + cacheRead +
 * cacheWrite)`. Undefined unless all three counts are there (older totals lack them) and the
 * divisor is above 0. One decimal below 1 % and above 99 % ("99,6 %"), so 100 % means all.
 */
export function cacheRate(u: CacheCounts | undefined) {
  if (u?.input === undefined || u.cacheRead === undefined || u.cacheWrite === undefined) return;
  const all = u.input + u.cacheRead + u.cacheWrite;
  if (!all) return;
  const rate = u.cacheRead / all;
  return (rate < 0.01 || rate > 0.99 ? finePercent : wholePercent).format(rate);
}

/** `text` + " · välimuisti 82 %" when the counts give a rate (meta, menu, header, Käyttö). */
export const withRate = (text: string, u: CacheCounts | undefined) => {
  const rate = cacheRate(u);
  return rate ? `${text} · välimuisti ${rate}` : text;
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

/** A fence line, also after list or quote markers (`1. ```bash`, `- ```js`, `> ````). */
const FENCE = /^(?:\s*(?:[-*+]|\d+[.)])\s+|\s*>\s?)*\s*(`{3,}|~{3,})/;
/** A fence line that closes `open` (same char, at least as long, nothing after it). */
const closes = (line: string, open: string) => {
  const m = FENCE.exec(line);
  return (
    !!m && m[1]![0] === open[0] && m[1]!.length >= open.length && !line.slice(m[0].length).trim()
  );
};
/** A link reference definition (the URL may be on the next line), or a footnote (`[^1]:`). */
const DEFINITION = /^ {0,3}\[([^\]\n]+)\]:(\s*\S)?/;
/** A reference label as Markdown matches it: case and inner whitespace do not count. */
const labelKey = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();
type Definition = { label: string; line: string };

/**
 * Splits Markdown at blank lines outside code fences, so a streamed reply re-renders only its
 * last block. A blank line before an indented line or a list item does not split (loose lists,
 * nested content). `definitions` are the finished link reference definitions: they resolve
 * across blocks, so the caller appends to each block the ones it uses (a definition renders
 * nothing; a block changes only when a definition it uses arrives). A
 * footnote definition renders a section of its own, so that text stays one block, and so does a
 * `final` text that ends inside a fence: a fence the scan misread would invert every later block.
 */
export function mdBlocks(
  text: string,
  final = false,
): { blocks: string[]; definitions: Definition[] } {
  const lines = text.split('\n');
  const blocks: string[] = [];
  const definitions: Definition[] = [];
  // A definition starts a block: at the start, after a blank line or after another definition.
  let canDefine = true;
  const whole = { blocks: [text], definitions: [] };
  let start = 0;
  let fence = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      if (closes(line, fence)) [fence, canDefine] = ['', true];
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      fence = open[1]!;
      continue;
    }
    const def = DEFINITION.exec(line);
    if (def?.[1]?.startsWith('^')) return whole;
    const isDef: boolean = !!def?.[1] && canDefine;
    if (isDef && def?.[1]) {
      // The URL on the next line: both lines. The last line may still grow, so only finished
      // definitions are shared, except in a final text.
      const next = def[2] ? undefined : lines[i + 1];
      const end = def[2] ? i : i + 1;
      if ((def[2] || next?.trim()) && (final || end + 1 < lines.length))
        definitions.push({
          label: labelKey(def[1]),
          line: next === undefined ? line : `${line}\n${next}`,
        });
    }
    canDefine = !line.trim() || isDef;
    if (
      !line.trim() &&
      i > start &&
      i + 1 < lines.length &&
      !/^(\s|[-*+](\s|$)|\d+[.)](\s|$)|$)/.test(lines[i + 1]!)
    ) {
      blocks.push(lines.slice(start, i).join('\n'));
      start = i + 1;
    }
  }
  if (fence && final) return whole;
  blocks.push(lines.slice(start).join('\n'));
  return { blocks, definitions };
}

/**
 * The length of the unclosed code span opener (0: every span closed). A backslash escapes a
 * backtick only outside a span; inside one it is literal (`` `a\` `` is closed).
 */
const openSpan = (text: string) => {
  let open = 0;
  for (let i = 0; i < text.length; ) {
    if (!open && text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let n = 0;
    while (text[i] === '`') [i, n] = [i + 1, n + 1];
    open = open === n ? 0 : open || n;
  }
  return open;
};

/** `block` with the reference definitions it uses (`[label]`, case and spaces ignored). */
export function withDefinitions(block: string, definitions: Definition[]) {
  const low = labelKey(block);
  const used = definitions.filter((d) => low.includes(`[${d.label}]`) && !block.includes(d.line));
  return used.length ? `${block}\n\n${used.map((d) => d.line).join('\n')}` : block;
}

/** Table cells of a row: escaped pipes and pipes inside code spans do not split. */
const cells = (row: string) =>
  row
    .replace(/\\\|/g, '')
    .replace(/(`+)[\s\S]*?\1/g, '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|');

/**
 * The streamed last block, settled so that it never shows what the final text will not render;
 * when unsure it holds back instead of closing. An unclosed inline code span or link URL is
 * closed; a table's delimiter row gets its missing cells; a half-typed fence, a lone list marker
 * or a setext underline (`-`, `--`, `=`) after text waits for the next delta. An unclosed fence
 * already renders as a code block (CommonMark).
 */
export function settleTail(block: string): string {
  const lines = block.split('\n');
  let fence = '';
  let after = 0;
  lines.forEach((line, i) => {
    if (fence) {
      if (closes(line, fence)) [fence, after] = ['', i + 1];
    } else {
      const open = FENCE.exec(line);
      if (open) fence = open[1]!;
    }
  });
  const last = lines.at(-1)!;
  const prev = lines.at(-2)?.trim();
  if (
    /^\s*(`{1,2}|~{1,2})$/.test(last) ||
    (!fence && /^\s*([-*+]|\d+[.)])\s*$/.test(last)) ||
    (!fence && prev && /^ {0,3}(=+|-+)\s*$/.test(last))
  )
    lines.pop();
  if (fence) return lines.join('\n');
  const head = lines.at(-2);
  const tail = lines.at(-1);
  // A delimiter row being typed under a header row of two or more unescaped pipes.
  if (
    head &&
    tail &&
    (head.replace(/\\\|/g, '').match(/\|/g) ?? []).length >= 2 &&
    /^[\s|:-]*-[\s|:-]*$/.test(tail)
  ) {
    const want = cells(head).length;
    const typed = cells(tail).filter((c) => c.includes('-'));
    if (typed.length < want)
      lines[lines.length - 1] =
        `|${[...typed, ...Array<string>(want - typed.length).fill(' --- ')].join('|')}|`;
  }
  const out = lines.join('\n');
  const open = openSpan(lines.slice(after).join('\n'));
  if (open) {
    // A trailing run is the opener itself or maybe a closer still being typed: hold it back and
    // add no closer. Otherwise close the span.
    const trailing = /(?<!\\)`+$/.exec(out)?.[0].length ?? 0;
    if (trailing) return out.slice(0, -trailing);
    return out + '`'.repeat(open);
  }
  // A link whose URL is still coming: closed; an image waits whole (no request to half a URL).
  const link = /(!?)\[[^\]\n]*\]\([^)\s`]*$/.exec(out);
  if (!link) return out;
  return link[1] ? out.slice(0, link.index) : `${out})`;
}

/** The thread's scroll container as the follow logic needs it (an element, or a test double). */
type Scroller = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTo(options: ScrollToOptions): void;
};
const gapOf = (el: Scroller) => el.scrollHeight - el.scrollTop - el.clientHeight;
/** Pinned within this many px of the bottom; the pill shows past `AWAY`. */
const NEAR = 48;
const AWAY = 80;

/**
 * Auto-follow of a streaming thread (brief 7.5). Only the reader unpins it (wheel, touch, keys or
 * a scroll this follow did not cause); the follow's own jumps and the pill's smooth scroll never
 * do. A scroll is the follow's own when `scrollTop` is where the follow put it (within 1 px).
 */
export class Follow {
  pinned = true;
  jumping = false;
  /** The `scrollTop` the follow set last; NaN once the reader moved. */
  private set = Number.NaN;
  private scrolledSinceJump = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** Content changed: stay at the bottom while pinned (a jump, not a smooth scroll). */
  follow(el: Scroller) {
    if (!this.pinned) return;
    el.scrollTop = el.scrollHeight;
    // Read back: the element clamps the value.
    this.set = el.scrollTop;
  }

  /** A scroll event: whether the reader is away from the bottom, or undefined to keep the state. */
  scrolled(el: Scroller): boolean | undefined {
    const gap = gapOf(el);
    this.scrolledSinceJump = true;
    if (this.jumping && gap >= NEAR) return undefined;
    this.jumping = false;
    // The follow's own jump (content may have grown since): not the reader.
    if (Math.abs(el.scrollTop - this.set) <= 1) return gap < NEAR ? false : undefined;
    return this.sync(el);
  }

  /** Takes the state from where the thread is now (the reader's scroll, a search hit's jump). */
  sync(el: Scroller) {
    const gap = gapOf(el);
    this.set = Number.NaN;
    this.pinned = gap < NEAR;
    return gap > AWAY;
  }

  /**
   * The reader scrolls up by `delta` px (wheel, keys; touch: unknown): the follow stops at once,
   * unless the thread cannot scroll up or the move stays within the bottom zone.
   */
  up(el: Scroller, delta = Number.POSITIVE_INFINITY) {
    this.jumping = false;
    if (el.scrollHeight <= el.clientHeight || el.scrollTop <= 0) return;
    if (gapOf(el) + delta < NEAR) return;
    this.pinned = false;
    this.set = Number.NaN;
  }

  /** The pill or End: to the bottom, and the follow resumes. */
  jump(el: Scroller, smooth: boolean) {
    this.pinned = this.jumping = true;
    this.scrolledSinceJump = false;
    clearTimeout(this.timer);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    // Already there (or an instant jump): no scroll event may come to end the jump.
    if (gapOf(el) < NEAR) {
      this.jumping = false;
      this.set = el.scrollTop;
    } else
      this.timer = setTimeout(() => {
        if (!this.scrolledSinceJump) this.jumping = false;
      }, 600);
  }

  /** Another chat: pinned, no jump on its way. */
  reset() {
    this.pinned = true;
    this.jumping = false;
    this.set = Number.NaN;
    clearTimeout(this.timer);
  }
}

/** Targets that keep their keys: menus, dialogs, lists, buttons and every text entry. */
const OWN_KEYS =
  '[role="menu"], [role="dialog"], [role="listbox"], [role="radiogroup"], button, input, textarea, select, [contenteditable], [role="textbox"]';

/** A key in the thread: `end` jumps to the latest, `up` stops the follow, else nothing. */
export function threadKey(e: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}): 'end' | 'up' | undefined {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const t = e.target as { closest?: (s: string) => unknown } | null;
  if (!t?.closest || t.closest(OWN_KEYS)) return;
  if (e.key === 'End') return 'end';
  if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') return 'up';
}
