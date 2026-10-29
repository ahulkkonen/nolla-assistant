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

/**
 * `text` + " · välimuisti 82 %" when the counts give a rate (meta, menu, header, Käyttö); a
 * no-break space keeps the word and the rate on one line.
 */
export const withRate = (text: string, u: CacheCounts | undefined) => {
  const rate = cacheRate(u);
  return rate ? `${text} · välimuisti\u00a0${rate}` : text;
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
  thinking?: { ms: number | null } | undefined;
  phases?: { queueMs?: number | undefined; writeMs?: number | undefined } | undefined;
};

/**
 * Each reply's sum of `get` (decision 15): its call plus the tool rounds before it that have no
 * text. Rounds of a turn that ended without a reply (an abort, an error) go to the reply before
 * them, so the replies add up to the chat total; while a turn runs (`running`), its rounds wait.
 */
function perReply<T>(
  messages: Turnish[],
  running: boolean,
  get: (m: Turnish) => T | undefined,
  sum: (list: (T | undefined)[]) => T | undefined,
) {
  const out = new Map<string, T>();
  let pending: T[] = [];
  let lastReply: string | undefined;
  const settle = () => {
    const merged = lastReply && pending.length && sum([...pending, out.get(lastReply)]);
    if (lastReply && merged) out.set(lastReply, merged);
    pending = [];
  };
  for (const m of messages) {
    const v = get(m);
    if (m.role === 'user') settle();
    else if (!m.text) {
      if (v) pending.push(v);
    } else {
      const u = sum([...pending, v]);
      pending = [];
      if (u) out.set(m.id, u);
      lastReply = m.id;
    }
  }
  if (!running) settle();
  return out;
}

/** Each reply's usage (decision 15). */
export const replyUsage = (messages: Turnish[], running: boolean) =>
  perReply(messages, running, (m) => m.usage, sumUsage);

/** Phase 26: what a reply's receipt says; a phase that did not happen is undefined. */
export type Timing = { queueMs?: number; thinkMs?: number; writeMs?: number };
const timingOf = (m: Turnish): Timing | undefined => {
  const t: Timing = {
    ...(m.phases?.queueMs !== undefined ? { queueMs: m.phases.queueMs } : {}),
    ...(m.thinking?.ms != null ? { thinkMs: m.thinking.ms } : {}),
    ...(m.phases?.writeMs !== undefined ? { writeMs: m.phases.writeMs } : {}),
  };
  return Object.keys(t).length ? t : undefined;
};
const sumTiming = (list: (Timing | undefined)[]): Timing | undefined => {
  const out: Timing = {};
  for (const t of list)
    for (const k of ['queueMs', 'thinkMs', 'writeMs'] as const) {
      const v = t?.[k];
      if (v !== undefined) out[k] = (out[k] ?? 0) + v;
    }
  return Object.keys(out).length ? out : undefined;
};
/** Each reply's receipt (phase 26), its tool rounds included like its usage. */
export const replyTiming = (messages: Turnish[], running: boolean) =>
  perReply(messages, running, timingOf, sumTiming);

/** "12 s", "1 min 5 s"; at least 1 s. */
export function duration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/**
 * The waiting line of a running chat (phase 26), in client times (ms). `step`: 0 sending, 1 in
 * the provider's queue, 2 thinking or running a tool, 3 writing; `since`: when it began.
 */
export type Wait = {
  step: 0 | 1 | 2 | 3;
  since: number;
  /** `message.accepted` came: "Lähetetty". */
  accepted: boolean;
  /** Queue time of the turn's finished rounds; undefined before the first request. */
  queued?: number | undefined;
  /**
   * Finished thinking time of the turn; undefined while it has not thought. `thinking`: it
   * thinks now, since then.
   */
  thought?: number | undefined;
  thinking?: number | undefined;
  /** A tool runs, since then. */
  tool?: number | undefined;
  /** The `messageId` of the last `sent` phase: a `headers` phase of another request is stale. */
  request?: string | undefined;
  /** The first text token of the current message came then. */
  writing?: number | undefined;
  /** A final without tool calls came: no round follows, the turn only settles. */
  ended: boolean;
};

/** One step of the line: `k` its place (0–3), `on` the active one, `later` one still to come. */
export type Step = { k: number; word: string; ms?: number; on?: boolean; later?: boolean };
const NOW = ['lähetetään', 'jonossa', 'ajattelee', 'kirjoittaa'];
const PAST = ['lähetetty', 'jonotti', 'ajatteli', 'kirjoitti'];

/**
 * The steps of a wait at `now` (phase 26): "Lähetetty → jonossa 12 s → ajattelee → kirjoittaa".
 * The active step counts; a past step shows its time, or goes when it did not happen (no
 * thinking); a later step shows its word only. `row`: the action row's line, without sending.
 * `thinks`: false for a model without reasoning or with the effort off, so no later "ajattelee".
 */
export function waitSteps(w: Wait, now: number, row = false, thinks = true): Step[] {
  const thought =
    w.thought === undefined
      ? undefined
      : w.thought + (w.thinking === undefined ? 0 : now - w.thinking);
  const clock = [
    undefined,
    w.queued === undefined ? undefined : w.queued + (w.step === 1 ? now - w.since : 0),
    w.tool !== undefined ? now - w.tool : thought,
    w.writing === undefined ? undefined : now - w.writing,
  ];
  return [0, 1, 2, 3].flatMap((k): Step[] => {
    if (row && k === 0) return [];
    const at = clock[k];
    const ms = at === undefined ? undefined : Math.max(0, at);
    if (k > w.step) return k === 2 && !thinks ? [] : [{ k, word: NOW[k] ?? '', later: true }];
    if (k < w.step)
      return k === 0
        ? [{ k, word: PAST[0] ?? '' }]
        : ms === undefined
          ? []
          : [{ k, word: PAST[k] ?? '', ms }];
    const word =
      k === 0
        ? w.accepted
          ? PAST[0]
          : NOW[0]
        : k === 2 && w.tool !== undefined
          ? 'työkalu'
          : NOW[k];
    return [{ k, word: word ?? '', on: true, ...(ms === undefined ? {} : { ms }) }];
  });
}

/** A finished reply's receipt (phase 26): "Jonotti 14 s → ajatteli 3 s → kirjoitti 3 s". */
export const receiptSteps = (t: Timing): Step[] =>
  (['queueMs', 'thinkMs', 'writeMs'] as const).flatMap((key, i) => {
    const ms = t[key];
    return ms === undefined ? [] : [{ k: i + 1, word: PAST[i + 1]!, ms }];
  });

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

/** A table row candidate: an unescaped pipe outside code spans. */
const piped = (line = '') => /\|/.test(line.replace(/\\\|/g, '').replace(/(`+)[\s\S]*?\1/g, ''));
const DELIMITER = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** Line `i` is a row of a table above it: a delimiter row under a header row, then rows. */
const inTable = (lines: string[], i: number) => {
  for (let j = i - 1; j > 0 && piped(lines[j]); j--)
    if (DELIMITER.test(lines[j] ?? '') && piped(lines[j - 1])) return true;
  return false;
};

/** A line that starts as a table row does: a pipe after at most 3 spaces. */
const ROW = /^ {0,3}\|/;

/**
 * Phase 27: a table waits until its delimiter row ends (before that its header row renders as
 * text); so does a row without text yet. Only a line that starts with a pipe, or one after a piped
 * line, is held: a prose line with a pipe ("cat a | grep b") shows while it streams. A header row
 * without the leading pipe shows as text until its delimiter row starts.
 */
function holdTable(lines: string[]) {
  const n = lines.length - 1;
  const last = lines[n] ?? '';
  const prev = lines[n - 1] ?? '';
  // No text yet: a delimiter row being typed, a row that only has its first pipe.
  const empty = /^[\s|:-]*$/.test(last);
  if (
    empty &&
    piped(prev) &&
    (ROW.test(prev) || last.includes('-')) &&
    !DELIMITER.test(prev) &&
    !inTable(lines, n - 1)
  )
    lines.splice(n - 1);
  else if (piped(last) && (ROW.test(last) || piped(prev)) && (empty || !inTable(lines, n)))
    lines.pop();
}

/** List and quote markers at the start of a line: never emphasis. */
const MARKERS = /^(?:\s*(?:[-*+]|\d+[.)])\s+|\s*>\s?)*/;

/**
 * Phase 27: closes the emphasis (`**`, `*`) that the last line leaves open, the inner one first,
 * and holds back a trailing run (an opener, or a closer still being typed). A run opens when
 * text follows it and closes an open one when text comes before it.
 */
function closeEmphasis(out: string) {
  const body = out.replace(/(?<!\\)\*+$/, '');
  const line = body
    .slice(body.lastIndexOf('\n') + 1)
    .replace(MARKERS, (m) => ' '.repeat(m.length))
    .replace(/\\./g, 'xx')
    .replace(/(`+)[\s\S]*?\1/g, (m) => 'x'.repeat(m.length));
  const open: string[] = [];
  for (const m of line.matchAll(/\*+/g)) {
    const before = /\S/.test(line[m.index - 1] ?? ' ');
    const after = /\S/.test(line[m.index + m[0].length] ?? ' ');
    for (const k of m[0].length === 1 ? ['*'] : m[0].length === 2 ? ['**'] : ['**', '*']) {
      const at = open.lastIndexOf(k);
      if (before && at >= 0) open.splice(at, 1);
      else if (after) open.push(k);
    }
  }
  return open.length ? body.trimEnd() + open.reverse().join('') : body;
}

/**
 * The fence `lines` end inside ('' when every fence closed), the line that opened it, and the line
 * after the last closed fence.
 */
function scanFences(lines: string[]) {
  let fence = '';
  let opened = -1;
  let after = 0;
  lines.forEach((line, i) => {
    if (fence) {
      if (closes(line, fence)) [fence, after] = ['', i + 1];
    } else {
      const open = FENCE.exec(line);
      if (open) [fence, opened] = [open[1]!, i];
    }
  });
  return { fence, opened, after };
}

/** A streamed block that ends inside an open code fence (phase-20 decision 8). */
export const endsInFence = (block: string) => !!scanFences(block.split('\n')).fence;

/** All text below a hast node: a code block's source, with caret and annotation spans in it. */
export type TextNode = { type: string; value?: string; children?: TextNode[] };
export const nodeText = (n: TextNode | undefined): string =>
  !n ? '' : n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(nodeText).join('');

/**
 * The streamed last block, settled so that it never shows what the final text will not render;
 * when unsure it holds back instead of closing. An unclosed inline code span, link URL or
 * emphasis is closed; a half-typed fence, a fence opener whose info string may still grow
 * (phase-20 decision 9), a lone list marker, a setext underline (`-`, `--`, `=`) after text and
 * a table before its delimiter row ends wait for the next delta. An unclosed fence already
 * renders as a code block (CommonMark).
 */
export function settleTail(block: string): string {
  const lines = block.split('\n');
  let { fence, opened, after } = scanFences(lines);
  if (fence && opened === lines.length - 1) {
    lines.pop();
    fence = '';
  }
  const last = lines.at(-1) ?? '';
  const prev = lines.at(-2)?.trim();
  if (
    /^\s*(`{1,2}|~{1,2})$/.test(last) ||
    (!fence && /^\s*([-*+]|\d+[.)])\s*$/.test(last)) ||
    (!fence && prev && /^ {0,3}(=+|-+)\s*$/.test(last))
  )
    lines.pop();
  if (fence) return lines.join('\n');
  holdTable(lines);
  let out = lines.join('\n');
  const open = openSpan(lines.slice(after).join('\n'));
  if (open) {
    // A trailing run is the opener itself or maybe a closer still being typed: hold it back and
    // add no closer. Otherwise close the span.
    const trailing = /(?<!\\)`+$/.exec(out)?.[0].length ?? 0;
    out = trailing ? out.slice(0, -trailing) : out + '`'.repeat(open);
  } else {
    // A link whose URL is still coming: closed; an image waits whole (no request to half a URL).
    const link = /(!?)\[[^\]\n]*\]\([^)\s`]*$/.exec(out);
    if (link) out = link[1] ? out.slice(0, link.index) : `${out})`;
  }
  return closeEmphasis(out);
}

/** The thread's scroll container as the follow logic needs it (an element, or a test double). */
type Scroller = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTo(options: ScrollToOptions): void;
};
const gapOf = (el: Scroller) => el.scrollHeight - el.scrollTop - el.clientHeight;
/** The follow's own scroll counts as at the bottom within this many px; the pill: past `AWAY`. */
const NEAR = 48;
const AWAY = 80;
/** Phase 27: the reader's own scroll pins again only at the bottom (a fraction of a px apart). */
const BOTTOM = 2;

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
    this.pinned = gap < BOTTOM;
    return gap > AWAY;
  }

  /**
   * The reader scrolls up (wheel, touch, keys): the follow stops at once (brief 7.5; phase 27: also
   * for a small move), unless the thread cannot scroll up. The bottom, the pill or End resume it.
   */
  up(el: Scroller) {
    this.jumping = false;
    if (el.scrollHeight <= el.clientHeight || el.scrollTop <= 0) return;
    this.pinned = false;
    this.set = Number.NaN;
  }

  /**
   * The thread or its content changed height (phase 26: an Android keyboard, a taller composer;
   * phase 27: the stream). `delta` is the thread's old height minus the new one. Pinned, it keeps
   * the bottom; scrolled up, it keeps the reader's distance to the bottom (its own scroll). Returns
   * whether the reader is away (the pill).
   */
  resized(el: Scroller, delta: number) {
    if (this.pinned) {
      this.follow(el);
      return false;
    }
    if (delta) {
      el.scrollTop += delta;
      this.set = el.scrollTop;
    }
    return gapOf(el) > AWAY;
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
