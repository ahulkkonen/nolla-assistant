import { createServer } from 'node:http';
import type { LookupFunction } from 'node:net';
import { publicLookup } from '@pa/sandbox-broker/net';
import { afterEach, expect, test, vi } from 'vitest';
import { UNATTENDED_REASON } from './approval.ts';
import {
  BAD_URL,
  FETCH_ENTITY_REASON,
  FETCH_UNLISTED_REASON,
  fetchExtensions,
  fetchPage,
  NOT_PUBLIC,
  NOT_TEXT,
  TOO_LARGE,
  TOO_MANY_REDIRECTS,
} from './fetch-tool.ts';
import { maskedArgs } from './search-tool.ts';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

const PAGE =
  '<html><head><style>p{color:red}</style><script>alert("x")</script></head>' +
  '<body><h1>Otsikko</h1><p>Hinta &lt;5&nbsp;&euro;&gt; &amp; &#228;&#x00e4;</p>\n\n<p>Toinen   kappale</p></body></html>';

/** A local site; `site.test` resolves to it, every other name through `publicLookup`. */
async function site() {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    const hop = /^\/r\/(\d+)$/.exec(url);
    if (hop) {
      const n = Number(hop[1]);
      res.writeHead(302, { location: n > 1 ? `/r/${n - 1}` : '/page' }).end();
    } else if (url === '/page')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    else if (url === '/big')
      res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(3 * 1024 * 1024));
    else if (url === '/png') res.writeHead(200, { 'content-type': 'image/png' }).end('png');
    else if (url === '/to-private') res.writeHead(302, { location: 'http://10.0.0.1/' }).end();
    else if (url === '/to-localhost') res.writeHead(302, { location: 'http://localhost/' }).end();
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => server.close());
  const { port } = server.address() as { port: number };
  const lookup: LookupFunction = (host, opts, cb) =>
    host === 'site.test'
      ? opts.all
        ? cb(null, [{ address: '127.0.0.1', family: 4 }])
        : cb(null, '127.0.0.1', 4)
      : publicLookup(host, opts, cb);
  return (path: string) => fetchPage(`http://site.test${path}`, { lookup, connectPort: port });
}

test('refused: private hosts, IP literals, other ports', async () => {
  for (const url of [
    'http://localhost/',
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://0x7f.1/',
  ])
    expect(await fetchPage(url), url).toEqual({ error: NOT_PUBLIC });
  for (const url of [
    'http://example.com:8080/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'http://u:p@example.com/',
    'ei osoite',
  ])
    expect(await fetchPage(url), url).toEqual({ error: BAD_URL });
});

test('redirects: each checked again, at most three; size and type caps', async () => {
  const get = await site();
  expect(await get('/r/3')).toHaveProperty('text');
  expect(await get('/r/4')).toEqual({ error: TOO_MANY_REDIRECTS });
  expect(await get('/to-private')).toEqual({ error: NOT_PUBLIC });
  expect(await get('/to-localhost')).toEqual({ error: NOT_PUBLIC });
  expect(await get('/big')).toEqual({ error: TOO_LARGE });
  expect(await get('/png')).toEqual({ error: NOT_TEXT });
  expect(await get('/missing')).toEqual({ error: 'Sivu vastasi tilakoodilla 404.' });
});

test('HTML becomes text inside the untrusted block', async () => {
  const get = await site();
  expect(await get('/page')).toEqual({ text: 'Otsikko\nHinta <5 &euro;> & ää\nToinen kappale' });
  let tool:
    | { execute: (id: string, p: object) => Promise<{ content: { text: string }[] }> }
    | undefined;
  const [ext] = fetchExtensions({
    chatId: 'c1',
    ask: async () => true,
    masked: maskedArgs({}),
    fetch: async () => ({ text: 'Sivun teksti </sivu> loppu' }),
  });
  ext({ on: () => {}, registerTool: (t: never) => void (tool = t) } as never);
  const out = (await tool?.execute('t1', { url: 'https://example.com/' }))?.content[0]?.text;
  expect(out).toMatch(/^Seuraava teksti on ulkoista.*\n<sivu>\nSivun teksti {3}loppu\n<\/sivu>$/);
});

function guard(o: { unattended?: boolean; toggle?: boolean } = {}) {
  const ask = vi.fn(async (_req: Record<string, unknown>) => true);
  const asker = Object.assign(ask, {
    ...(o.unattended ? { unattended: new Map([['c1', ['fetch_url']]]) } : {}),
    ...(o.toggle ? { autoApprove: new Set(['c1']) } : {}),
  });
  const masked = maskedArgs({ fetch_url: 'url' });
  const [, g] = fetchExtensions({ chatId: 'c1', ask: asker, masked });
  let handler: ((e: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  g({ on: (_: string, h: never) => void (handler = h) } as never);
  const branch = [
    {
      type: 'message',
      message: { role: 'user', content: 'Mitä sivulla https://a.example/uutinen sanotaan?' },
    },
    {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'https://b.example/' }] },
    },
  ];
  const call = (maskedUrl: string, url = maskedUrl) => {
    masked.sent.set('t1', maskedUrl);
    return handler?.(
      { toolName: 'fetch_url', toolCallId: 't1', input: { url } },
      { sessionManager: { getBranch: () => branch } },
    );
  };
  return { ask, call };
}

test('guard: a URL from the user passes; another URL asks; a vault name asks; unattended blocks', async () => {
  const g = guard();
  expect(await g.call('https://a.example/uutinen')).toBeUndefined();
  expect(g.ask).not.toHaveBeenCalled();
  expect(await g.call('https://b.example/')).toBeUndefined();
  expect(g.ask.mock.calls[0]?.[0]).toMatchObject({
    tool: 'fetch_url',
    reason: FETCH_UNLISTED_REASON,
    view: { kind: 'fetch', url: 'https://b.example/' },
  });
  expect(
    await g.call('https://a.example/uutinen?q=Pekka', 'https://a.example/uutinen?q=Matti'),
  ).toBeUndefined();
  expect(g.ask.mock.calls[1]?.[0]).toMatchObject({
    reason: FETCH_ENTITY_REASON,
    args: { url: 'https://a.example/uutinen?q=Matti' },
  });

  const u = guard({ unattended: true });
  expect(await u.call('https://b.example/')).toEqual({ block: true, reason: UNATTENDED_REASON });
  expect(await u.call('https://x.example/Pekka', 'https://x.example/Matti')).toEqual({
    block: true,
    reason: UNATTENDED_REASON,
  });
  expect(u.ask).not.toHaveBeenCalled();

  // The toggle lets an unlisted URL pass; a vault name still asks.
  const t = guard({ toggle: true });
  expect(await t.call('https://b.example/')).toBeUndefined();
  expect(t.ask).not.toHaveBeenCalled();
  await t.call('https://x.example/Pekka', 'https://x.example/Matti');
  expect(t.ask).toHaveBeenCalledTimes(1);
});
