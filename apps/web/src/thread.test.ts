import { describe, expect, it, vi } from 'vitest';
import {
  cacheRate,
  duration,
  Follow,
  findOffsets,
  mdBlocks,
  messageTime,
  replyUsage,
  sameLengthLower,
  settleTail,
  sumUsage,
  thoughtFor,
  threadKey,
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
  it('never closes a link inside an unclosed code span', () => {
    expect(settleTail('`[a](b')).toBe('`[a](b`');
    expect(settleTail('`[a](b`')).toBe('`[a](b`');
  });
  it('completes a table delimiter row only under a real header row', () => {
    expect(settleTail('| a | b |\n| -')).toBe('| a | b |\n| -| --- |');
    expect(settleTail('| a | b |\n| :-- | --: |')).toBe('| a | b |\n| :-- | --: |');
    expect(settleTail('a | b\n-')).toBe('a | b');
    expect(settleTail('| a \\| b |\n| -')).toBe('| a \\| b |\n| -');
    expect(settleTail('| `a|b` | c |\n| -')).toBe('| `a|b` | c |\n| -| --- |');
    expect(settleTail('| a | b |\n| x')).toBe('| a | b |\n| x');
  });
  it('holds back a half-typed fence, a lone list marker and setext underlines', () => {
    expect(settleTail('```py\nfoo\n``')).toBe('```py\nfoo');
    expect(settleTail('Text\n-')).toBe('Text');
    expect(settleTail('Text\n--')).toBe('Text');
    expect(settleTail('Text\n===')).toBe('Text');
    expect(settleTail('\n---')).toBe('\n---');
    expect(settleTail('```\n- ')).toBe('```\n- ');
  });
  it('leaves code inside an open fence alone', () => {
    expect(settleTail('```js\nconst a = `x')).toBe('```js\nconst a = `x');
    expect(settleTail('```\nx\n```\nsee `y')).toBe('```\nx\n```\nsee `y`');
    expect(settleTail('1. ```js\n   const a = `x')).toBe('1. ```js\n   const a = `x');
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
      '3 k · välimuisti 75 %',
    );
    expect(withRate('3 k', {})).toBe('3 k');
  });
});

/** A scroll container double: 1000 px of content in a 400 px view. */
const box = (scrollTop = 600) => ({
  scrollTop,
  scrollHeight: 1000,
  clientHeight: 400,
  scrollTo(o: ScrollToOptions) {
    if (o.behavior !== 'smooth') this.scrollTop = (o.top ?? 0) - this.clientHeight;
  },
});

describe('Follow', () => {
  it('a jump already at the bottom ends at once; a smooth one without events ends by timer', () => {
    vi.useFakeTimers();
    const f = new Follow();
    f.jump(box(600), true);
    expect(f.jumping).toBe(false);
    const el = box(0);
    f.jump(el, true);
    expect(f.jumping).toBe(true);
    vi.advanceTimersByTime(600);
    expect(f.jumping).toBe(false);
    f.jump(box(0), false);
    expect(f.jumping).toBe(false);
    vi.useRealTimers();
  });
  it('scroll events during a smooth jump keep it pinned and the pill hidden', () => {
    const f = new Follow();
    const el = box(0);
    f.jump(el, true);
    el.scrollTop = 300;
    expect(f.scrolled(el, 1000)).toBeUndefined();
    expect(f.pinned).toBe(true);
    el.scrollTop = 600;
    expect(f.scrolled(el, 1100)).toBe(false);
    expect(f.jumping).toBe(false);
  });
  it('unpins on the reader scrolling up only when the thread can scroll up', () => {
    const f = new Follow();
    f.up({ ...box(0) }, 0);
    expect(f.pinned).toBe(true);
    f.up({ ...box(600), scrollHeight: 400 }, 0);
    expect(f.pinned).toBe(true);
    const el = box(600);
    f.up(el, 1000);
    expect(f.pinned).toBe(false);
    // A late event of the follow's last jump does not pin it again.
    expect(f.scrolled(el, 1020)).toBeUndefined();
    expect(f.pinned).toBe(false);
  });
  it('content growth after its own scroll does not unpin; a later scroll by the reader does', () => {
    const f = new Follow();
    const el = box(600);
    f.follow(el, 1000);
    // A real element clamps the jump to the bottom; then the content grows by 200 px.
    el.scrollTop = 600;
    el.scrollHeight = 1200;
    expect(f.scrolled(el, 1016)).toBeUndefined();
    expect(f.pinned).toBe(true);
    el.scrollTop = 100;
    expect(f.scrolled(el, 2000)).toBe(true);
    expect(f.pinned).toBe(false);
  });
  it('reset pins and ends a jump', () => {
    const f = new Follow();
    f.jump(box(0), true);
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
