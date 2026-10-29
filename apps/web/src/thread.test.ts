import { describe, expect, it, vi } from 'vitest';
import {
  cacheRate,
  duration,
  endsInFence,
  Follow,
  findOffsets,
  mdBlocks,
  messageTime,
  nodeText,
  receiptSteps,
  replyTiming,
  replyUsage,
  sameLengthLower,
  settleTail,
  sumUsage,
  thoughtFor,
  threadKey,
  type Wait,
  waitSteps,
  withDefinitions,
  withRate,
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

describe('mdBlocks', () => {
  const blocks = (t: string, final = false) => mdBlocks(t, final).blocks;
  it('splits at blank lines outside fences', () => {
    expect(blocks('# A\n\npara\n\n```\nx\n\ny\n```\n\nend')).toEqual([
      '# A',
      'para',
      '```\nx\n\ny\n```',
      'end',
    ]);
  });
  it('keeps loose lists and indented content together', () => {
    expect(blocks('- a\n\n- b\n\n  more')).toEqual(['- a\n\n- b\n\n  more']);
    expect(blocks('1. a\n\n2. b')).toEqual(['1. a\n\n2. b']);
  });
  it('does not split before the next line exists', () => {
    expect(blocks('para\n\n')).toEqual(['para\n\n']);
  });
  it('reads a fence opened on a list or quote marker line', () => {
    const t = '1. Aja:\n   ```bash\n   echo a\n\n   echo b\n   ```\n\nLoppu';
    expect(blocks(t)).toEqual(['1. Aja:\n   ```bash\n   echo a\n\n   echo b\n   ```', 'Loppu']);
    expect(blocks('- ```js\nx\n\ny\n```\n\nz')).toEqual(['- ```js\nx\n\ny\n```', 'z']);
    expect(blocks('> ```\n> a\n\n> b\n> ```\n\nc')).toEqual(['> ```\n> a\n\n> b\n> ```', 'c']);
  });
  it('keeps a final text that ends inside a fence whole', () => {
    expect(blocks('a\n\n```\nx\n\ny', true)).toEqual(['a\n\n```\nx\n\ny']);
    expect(blocks('a\n\n```\nx\n\ny')).toEqual(['a', '```\nx\n\ny']);
  });
  it('shares finished reference definitions, outside fences only', () => {
    const t = 'see [x]\n\nmore\n\n[x]: https://e.fi\n[y]: https://f';
    expect(mdBlocks(t)).toEqual({
      blocks: ['see [x]', 'more', '[x]: https://e.fi\n[y]: https://f'],
      definitions: [{ label: 'x', line: '[x]: https://e.fi' }],
    });
    expect(mdBlocks('```\n[x]: https://e.fi\n```\n\nb\n').definitions).toEqual([]);
  });
  it('a final text shares its last line, a definition with its URL on the next line', () => {
    expect(mdBlocks('see [x]\n\n[x]: https://e.fi', true).definitions).toEqual([
      { label: 'x', line: '[x]: https://e.fi' },
    ]);
    expect(mdBlocks('see [x]\n\n[x]: https://e.fi').definitions).toEqual([]);
    expect(mdBlocks('see [x]\n\n[x]:\n  https://e.fi\n').definitions).toEqual([
      { label: 'x', line: '[x]:\n  https://e.fi' },
    ]);
  });
  it('collects a definition only where it can start a block', () => {
    expect(mdBlocks('kappale\n[x]: https://e.fi\n').definitions).toEqual([]);
    expect(mdBlocks('[a]: https://a\n[b]: https://b\n').definitions.map((d) => d.label)).toEqual([
      'a',
      'b',
    ]);
    expect(mdBlocks('```\nx\n```\n[c]: https://c\n').definitions.map((d) => d.label)).toEqual([
      'c',
    ]);
  });
  it('matches labels without case or extra spaces', () => {
    const { definitions } = mdBlocks('[Lähde  Yksi]: https://e.fi\n', true);
    expect(withDefinitions('katso [lähde yksi]', definitions)).toBe(
      'katso [lähde yksi]\n\n[Lähde  Yksi]: https://e.fi',
    );
    expect(withDefinitions('katso [muu]', definitions)).toBe('katso [muu]');
  });
  it('keeps text with a footnote definition whole', () => {
    expect(blocks('a[^1]\n\nb\n\n[^1]: lähde\n')).toEqual(['a[^1]\n\nb\n\n[^1]: lähde\n']);
  });
});

describe('settleTail', () => {
  it('closes inline code and links', () => {
    expect(settleTail('see `cod')).toBe('see `cod`');
    expect(settleTail('`a` and ``b')).toBe('`a` and ``b``');
    expect(settleTail('a [link](https://ex')).toBe('a [link](https://ex)');
    expect(settleTail('a ![kuva](https://ex')).toBe('a ');
    expect(settleTail('`a` [b](c)')).toBe('`a` [b](c)');
  });
  it('holds back a trailing backtick run instead of guessing a closer', () => {
    expect(settleTail('see `')).toBe('see ');
    expect(settleTail('see ``code`')).toBe('see ``code');
    expect(settleTail('see \\` and `x')).toBe('see \\` and `x`');
    expect(settleTail('a \\`')).toBe('a \\`');
  });
  it('treats a backslash inside a code span as literal', () => {
    expect(settleTail('`a\\` ja [b](c')).toBe('`a\\` ja [b](c)');
    expect(settleTail('\\`a ja `b')).toBe('\\`a ja `b`');
  });
  it('never closes a link inside an unclosed code span', () => {
    expect(settleTail('`[a](b')).toBe('`[a](b`');
    expect(settleTail('`[a](b`')).toBe('`[a](b`');
  });
  it('holds back a table until its delimiter row ends, and a row without text (phase 27)', () => {
    expect(settleTail('Taulukko:\n| Kuukausi | Kulu')).toBe('Taulukko:');
    expect(settleTail('| a | b |')).toBe('');
    expect(settleTail('```\nx\n```\n\n|')).toBe('```\nx\n```\n');
    expect(settleTail('| a | b |\n')).toBe('');
    expect(settleTail('| a | b |\n|--')).toBe('');
    expect(settleTail('| a | b |\n| :-- | --: |')).toBe('');
    const head = '| a | b |\n|---|---|\n';
    expect(settleTail(head)).toBe(head);
    expect(settleTail(`${head}| 1 | 2`)).toBe(`${head}| 1 | 2`);
    expect(settleTail(`${head}| 1 | 2 |\n|`)).toBe(`${head}| 1 | 2 |`);
    expect(settleTail(`${head}| 1 | 2 |\n`)).toBe(`${head}| 1 | 2 |\n`);
  });
  it('shows a prose line with a pipe while it streams; code span and escaped pipes are text', () => {
    expect(settleTail('Aja cat a | grep b')).toBe('Aja cat a | grep b');
    expect(settleTail('Aja cat a | grep b\n')).toBe('Aja cat a | grep b\n');
    expect(settleTail('Aja cat a | grep b\n|')).toBe('Aja cat a | grep b');
    expect(settleTail('Valitse A | B\nTai')).toBe('Valitse A | B\nTai');
    // A second piped line may be the header's delimiter or a row: held. A header row without the
    // leading pipe waits with its delimiter row once that starts.
    expect(settleTail('a | b\nc | d')).toBe('a | b');
    expect(settleTail('a | b\n--|-')).toBe('');
    expect(settleTail('a | b\n--|--\n')).toBe('a | b\n--|--\n');
    expect(settleTail('Käytä `a|b` näin')).toBe('Käytä `a|b` näin');
    expect(settleTail('a \\| b')).toBe('a \\| b');
  });
  it('closes open ** and *, the inner first; a trailing run waits (phase 27)', () => {
    expect(settleTail('Tämä on **tärkeä')).toBe('Tämä on **tärkeä**');
    expect(settleTail('Tämä on *kallis ')).toBe('Tämä on *kallis*');
    expect(settleTail('**a *b')).toBe('**a *b***');
    expect(settleTail('*a **b')).toBe('*a **b***');
    expect(settleTail('***a')).toBe('***a***');
    expect(settleTail('a **')).toBe('a ');
    expect(settleTail('**valmis**')).toBe('**valmis**');
    expect(settleTail('**valmis*')).toBe('**valmis**');
    expect(settleTail('- kohta **lihava')).toBe('- kohta **lihava**');
    expect(settleTail('* kohta')).toBe('* kohta');
    expect(settleTail('2 * 3 = 6')).toBe('2 * 3 = 6');
    expect(settleTail('`a*b` ja *c')).toBe('`a*b` ja *c*');
    expect(settleTail('\\*ei')).toBe('\\*ei');
    expect(settleTail('**auki `koodi')).toBe('**auki `koodi`**');
    expect(settleTail('**eka\ntoka')).toBe('**eka\ntoka');
  });
  it('holds back a half-typed fence, a lone list marker and setext underlines', () => {
    expect(settleTail('```py\nfoo\n``')).toBe('```py\nfoo');
    expect(settleTail('Text\n-')).toBe('Text');
    expect(settleTail('Text\n--')).toBe('Text');
    expect(settleTail('Text\n===')).toBe('Text');
    expect(settleTail('\n---')).toBe('\n---');
    expect(settleTail('```\n- ')).toBe('```\n- ');
  });
  it('holds back a last line that opens a fence: its info string may still grow', () => {
    expect(settleTail('Sivu:\n```ht')).toBe('Sivu:');
    expect(settleTail('Sivu:\n```html')).toBe('Sivu:');
    expect(settleTail('```')).toBe('');
    expect(settleTail('- ```js')).toBe('');
    expect(settleTail('Sivu:\n```html\n')).toBe('Sivu:\n```html\n');
    expect(settleTail('```py\nx\n```')).toBe('```py\nx\n```');
  });
  it('tells whether a block ends inside a fence', () => {
    expect(endsInFence('Sivu:\n```html\n<h1>x')).toBe(true);
    expect(endsInFence('1. ```js\n   const a = 1')).toBe(true);
    expect(endsInFence('```\nx\n```')).toBe(false);
    expect(endsInFence('Teksti `koodi`')).toBe(false);
  });
  it('leaves code inside an open fence alone', () => {
    expect(settleTail('```js\nconst a = `x')).toBe('```js\nconst a = `x');
    expect(settleTail('```\nx\n```\nsee `y')).toBe('```\nx\n```\nsee `y`');
    expect(settleTail('1. ```js\n   const a = `x')).toBe('1. ```js\n   const a = `x');
  });
});

describe('nodeText', () => {
  it('reads every text below a code node, also inside annotation spans and next to the caret', () => {
    const text = (value: string) => ({ type: 'text', value });
    const pre = {
      type: 'element',
      children: [
        {
          type: 'element',
          children: [
            text('<p>Hei '),
            { type: 'element', children: [text('Matti Virtanen')] },
            text('!</p>\n'),
            { type: 'element', children: [] },
          ],
        },
      ],
    };
    expect(nodeText(pre)).toBe('<p>Hei Matti Virtanen!</p>\n');
    expect(nodeText(undefined)).toBe('');
  });
});

describe('cacheRate and withRate', () => {
  it('is the read share of all prompt tokens, none without all counts or a divisor', () => {
    expect(cacheRate({ input: 10, cacheRead: 82, cacheWrite: 8 })).toBe('82 %');
    expect(cacheRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
    expect(cacheRate({ input: 5, cacheRead: 5 })).toBeUndefined();
    expect(cacheRate(undefined)).toBeUndefined();
  });
  it('shows one decimal near the ends', () => {
    expect(cacheRate({ input: 4, cacheRead: 996, cacheWrite: 0 })).toBe('99,6 %');
    expect(cacheRate({ input: 996, cacheRead: 4, cacheWrite: 0 })).toBe('0,4 %');
    expect(cacheRate({ input: 0, cacheRead: 10, cacheWrite: 0 })).toBe('100 %');
  });
  it('appends the rate when there is one', () => {
    expect(withRate('3 k', { input: 1, cacheRead: 3, cacheWrite: 0 })).toBe(
      '3 k · välimuisti\u00a075\u00a0%',
    );
    expect(withRate('3 k', {})).toBe('3 k');
  });
});

describe('waiting line (phase 26)', () => {
  const wait = (w: Partial<Wait>): Wait => ({
    step: 0,
    since: 0,
    accepted: false,
    ended: false,
    ...w,
  });
  /** "Word 12 s" per step, `*` on the active one. */
  const text = (w: Wait, now: number, row = false) =>
    waitSteps(w, now, row)
      .map((s) => `${s.on ? '*' : ''}${s.word}${s.ms === undefined ? '' : ` ${duration(s.ms)}`}`)
      .join(' → ');

  it('steps through sending, the queue, thinking and writing', () => {
    expect(text(wait({}), 100)).toBe('*lähetetään → jonossa → ajattelee → kirjoittaa');
    expect(text(wait({ accepted: true }), 100)).toBe(
      '*lähetetty → jonossa → ajattelee → kirjoittaa',
    );
    const queue = wait({ step: 1, since: 1000, accepted: true, queued: 0 });
    expect(text(queue, 13_400)).toBe('lähetetty → *jonossa 12 s → ajattelee → kirjoittaa');
    // Headers came, nothing streams yet: the active thinking step has no clock.
    const work = wait({ step: 2, since: 15_000, queued: 14_000 });
    expect(text(work, 15_100)).toBe('lähetetty → jonotti 14 s → *ajattelee → kirjoittaa');
    expect(text({ ...work, thinking: 15_000, thought: 0 }, 18_000)).toBe(
      'lähetetty → jonotti 14 s → *ajattelee 3 s → kirjoittaa',
    );
    expect(text({ ...work, tool: 16_000 }, 18_000)).toBe(
      'lähetetty → jonotti 14 s → *työkalu 2 s → kirjoittaa',
    );
  });

  it('the action row line drops the send step and a thinking that did not happen', () => {
    const writing = wait({ step: 3, since: 20_000, queued: 14_000, writing: 20_000 });
    expect(text({ ...writing, thought: 3000 }, 22_000, true)).toBe(
      'jonotti 14 s → ajatteli 3 s → *kirjoittaa 2 s',
    );
    expect(text(writing, 22_000, true)).toBe('jonotti 14 s → *kirjoittaa 2 s');
    // A queue under a second still happened: at least 1 s, as `duration` writes it.
    expect(text({ ...writing, queued: 4 }, 22_000, true)).toBe('jonotti 1 s → *kirjoittaa 2 s');
  });

  it('marks later steps and drops a later thinking the model cannot do (UI review)', () => {
    const queue = wait({ step: 1, since: 1000, accepted: true, queued: 0 });
    expect(waitSteps(queue, 2000).map((s) => (s.later ? s.word : '-'))).toEqual([
      '-',
      '-',
      'ajattelee',
      'kirjoittaa',
    ]);
    expect(waitSteps(queue, 13_400, false, false).map((s) => s.word)).toEqual([
      'lähetetty',
      'jonossa',
      'kirjoittaa',
    ]);
    // A thinking that came anyway stays.
    const thinking = wait({ step: 2, since: 15_000, queued: 14_000, thinking: 15_000, thought: 0 });
    expect(waitSteps(thinking, 18_000, false, false).map((s) => s.word)).toContain('ajattelee');
  });

  it('a later round queues again with the turn total', () => {
    const again = wait({ step: 1, since: 30_000, queued: 14_000, thought: 3000 });
    expect(text(again, 32_000)).toBe('lähetetty → *jonossa 16 s → ajattelee → kirjoittaa');
  });

  it('the receipt lists the phases that happened, a reply with its tool rounds', () => {
    const steps = (t: Parameters<typeof receiptSteps>[0]) =>
      receiptSteps(t).map((s) => `${s.word} ${duration(s.ms ?? 0)}`);
    expect(steps({ queueMs: 14_000, thinkMs: 3000, writeMs: 3000 })).toEqual([
      'jonotti 14 s',
      'ajatteli 3 s',
      'kirjoitti 3 s',
    ]);
    expect(steps({ queueMs: 900, writeMs: 1200 })).toEqual(['jonotti 1 s', 'kirjoitti 1 s']);
    expect(steps({})).toEqual([]);
    const msg = (id: string, role: 'user' | 'assistant', text: string, extra = {}) => ({
      id,
      role,
      text,
      ...extra,
    });
    const timing = replyTiming(
      [
        msg('u1', 'user', 'Hae'),
        msg('t1', 'assistant', '', { phases: { queueMs: 2000 }, thinking: { ms: 1000 } }),
        msg('a1', 'assistant', 'Tässä', {
          phases: { queueMs: 12_000, writeMs: 3000 },
          thinking: { ms: 2000 },
        }),
        // Stored before phase 26: no receipt.
        msg('u2', 'user', 'Vanha'),
        msg('a2', 'assistant', 'Vastaus', { thinking: { ms: null } }),
      ],
      false,
    );
    expect(timing.get('a1')).toEqual({ queueMs: 14_000, thinkMs: 3000, writeMs: 3000 });
    expect(timing.has('a2')).toBe(false);
  });
});

describe('Follow', () => {
  /** A double that clamps `scrollTop` like an element. */
  const el = (scrollTop = 600, scrollHeight = 1000) => {
    const o = {
      top: scrollTop,
      scrollHeight,
      clientHeight: 400,
      get scrollTop() {
        return this.top;
      },
      set scrollTop(v: number) {
        this.top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight));
      },
      scrollTo(opt: ScrollToOptions) {
        if (opt.behavior !== 'smooth') this.scrollTop = opt.top ?? 0;
      },
    };
    return o;
  };
  it('a jump already at the bottom ends at once; a smooth one without events ends by timer', () => {
    vi.useFakeTimers();
    const f = new Follow();
    f.jump(el(600), true);
    expect(f.jumping).toBe(false);
    f.jump(el(0), true);
    expect(f.jumping).toBe(true);
    vi.advanceTimersByTime(600);
    expect(f.jumping).toBe(false);
    f.jump(el(0), false);
    expect(f.jumping).toBe(false);
    vi.useRealTimers();
  });
  it('scroll events during a smooth jump keep it pinned and the pill hidden', () => {
    const f = new Follow();
    const e = el(0);
    f.jump(e, true);
    e.scrollTop = 300;
    expect(f.scrolled(e)).toBeUndefined();
    expect(f.pinned).toBe(true);
    e.scrollTop = 600;
    expect(f.scrolled(e)).toBe(false);
    expect(f.jumping).toBe(false);
  });
  it('fast deltas: its own jumps never unpin, also when content grew before the event', () => {
    const f = new Follow();
    const e = el(600);
    for (let i = 0; i < 5; i++) {
      e.scrollHeight += 200;
      f.follow(e);
      e.scrollHeight += 50;
      expect(f.scrolled(e)).toBeUndefined();
      expect(f.pinned).toBe(true);
    }
  });
  it('a reader scroll between fast deltas unpins and shows the pill', () => {
    const f = new Follow();
    const e = el(600);
    f.follow(e);
    e.scrollTop -= 300;
    expect(f.scrolled(e)).toBe(true);
    expect(f.pinned).toBe(false);
    e.scrollHeight += 200;
    f.follow(e);
    expect(e.scrollTop).toBe(300);
  });
  it('a late event of its own last jump after the reader scrolled up does not pin again', () => {
    const f = new Follow();
    const e = el(600);
    f.follow(e);
    f.up(e);
    expect(f.pinned).toBe(false);
    expect(f.scrolled(e)).toBe(false);
  });
  it('wheel and touch unpin only when the thread can scroll up', () => {
    const f = new Follow();
    f.up(el(0));
    expect(f.pinned).toBe(true);
    f.up(el(0, 400));
    expect(f.pinned).toBe(true);
    f.up(el(600));
    expect(f.pinned).toBe(false);
  });
  it('a small scroll up stops the follow at once; the next delta leaves it (phase 27)', () => {
    const f = new Follow();
    const e = el(600);
    f.follow(e);
    f.up(e);
    e.scrollTop = 570;
    expect(f.scrolled(e)).toBe(false);
    expect(f.pinned).toBe(false);
    e.scrollHeight += 28;
    expect(f.resized(e, 0)).toBe(false);
    expect(e.scrollTop).toBe(570);
    // The stream grows on: the pill shows once the reader is more than 80 px away.
    e.scrollHeight += 60;
    expect(f.resized(e, 0)).toBe(true);
    expect(e.scrollTop).toBe(570);
  });
  it('back at the bottom, the reader pins it again', () => {
    const f = new Follow();
    const e = el(600);
    f.up(e);
    e.scrollTop = 599;
    f.scrolled(e);
    expect(f.pinned).toBe(true);
    e.scrollHeight += 100;
    expect(f.resized(e, 0)).toBe(false);
    expect(e.scrollTop).toBe(700);
  });
  it('sync takes the state from a search hit jump', () => {
    const f = new Follow();
    expect(f.sync(el(100))).toBe(true);
    expect(f.pinned).toBe(false);
  });
  it('resized: pinned keeps the bottom, scrolled up keeps the distance, no pill (phase 26)', () => {
    const f = new Follow();
    const e = el(600);
    f.follow(e);
    // A keyboard takes 330 px of the thread.
    e.clientHeight = 70;
    f.resized(e, 330);
    expect(e.scrollHeight - e.scrollTop - e.clientHeight).toBe(0);
    expect(f.scrolled(e)).toBe(false);
    const up = el(200);
    expect(f.sync(up)).toBe(true);
    up.clientHeight = 70;
    f.resized(up, 330);
    expect(up.scrollHeight - up.scrollTop - up.clientHeight).toBe(400);
    // Its own scroll: the state stays (scrolled up, pill shown), nothing pins.
    expect(f.scrolled(up)).toBeUndefined();
    expect(f.pinned).toBe(false);
  });
  it('reset pins and ends a jump', () => {
    const f = new Follow();
    f.jump(el(0), true);
    f.pinned = false;
    f.reset();
    expect([f.pinned, f.jumping]).toEqual([true, false]);
  });
});

describe('threadKey', () => {
  const target = (inside: string | null) => ({
    closest: (s: string) => (inside && s.split(', ').includes(inside) ? {} : null),
  });
  const key = (k: string, inside: string | null = null, mods = {}) =>
    threadKey({
      key: k,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...mods,
      target: target(inside) as unknown as EventTarget,
    });
  it('End jumps and the up keys stop the follow', () => {
    expect(key('End')).toBe('end');
    expect(key('PageUp')).toBe('up');
    expect(key('a')).toBeUndefined();
  });
  it('ignores menus, dialogs, buttons, text entry and modifier keys', () => {
    for (const s of ['[role="menu"]', '[role="dialog"]', 'button', 'textarea', '[contenteditable]'])
      expect(key('End', s)).toBeUndefined();
    expect(key('End', null, { ctrlKey: true })).toBeUndefined();
    expect(key('Home', null, { shiftKey: true })).toBeUndefined();
  });
});
