import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted reply. `match` (a substring or RegExp, tested against the text of the request's last
 * user message) reserves the turn for matching calls: a call takes the first queued turn whose
 * `match` matches, else the first turn without `match`. Parallel callers (subagents, the title
 * job) then cannot take each other's turns.
 */
export type FakeTurn = (
  | ({ text: string } & FakeReply)
  | ({
      toolCalls: { id?: string; name: string; args: Record<string, unknown> }[];
      text?: string;
    } & FakeReply)
  /** An HTTP error before the stream, as LiteLLM passes an upstream refusal or outage on. */
  | { error: { status: number; message: string } }
  /** Phase 14: a `zdr/search` answer; only `zdr/search` calls take it (see `FAKE_CITATIONS`). */
  | ({ citations: FakeCitation[]; text?: string } & FakeReply)
) & { match?: string | RegExp };
/** One OpenRouter `url_citation` annotation of the web plugin. */
export type FakeCitation = { url: string; title: string; content?: string };
/** The `zdr/search` answer when no `citations` turn is queued (e2e and demo use). */
export const FAKE_CITATIONS: FakeCitation[] = [
  {
    url: 'https://www.ilmatieteenlaitos.fi/saa/helsinki',
    title: 'Helsinki – sääennuste – Ilmatieteen laitos',
    content: 'Helsingin sää tänään: pilvistä, 7 astetta, heikkoa tuulta.',
  },
  {
    url: 'https://yle.fi/saa',
    title: 'Sää | Yle',
    content: 'Viikon sää: sateinen alku, viikonloppuna poutaa.',
  },
];
/**
 * Phase 13: `reasoning` streams as `reasoning_content` deltas before the text (LiteLLM's field);
 * `thinkMs` waits after the first of them. `usage.cost` is OpenRouter's billed USD, which LiteLLM
 * passes on. Phase 26: `queueMs` waits before the response headers, as a provider queue does.
 */
type FakeReply = {
  reasoning?: string;
  thinkMs?: number;
  queueMs?: number;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    cost?: number;
    reasoning_tokens?: number;
    cached_tokens?: number;
  };
};
/** The ECB rate the fake serves (`ECB_RATES` = `url`): USD per 1 EUR, as the live probe got it. */
export const FAKE_ECB_CSV =
  'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\n' +
  'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-23,1.1193\n';
/** An OpenRouter `/api/v1/models` entry; `zdr` marks the ids that `?zdr=true` returns. */
export type FakeCatalogModel = { id: string; zdr: boolean } & Record<string, unknown>;

const catalogModel = (
  id: string,
  name: string,
  zdr: boolean,
  efforts: string[],
  defaultEffort: string,
  created: number,
): FakeCatalogModel => ({
  id,
  name,
  zdr,
  created,
  context_length: 1_048_576,
  pricing: { prompt: '0.000002', completion: '0.00001' },
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  supported_parameters: ['tools', 'reasoning'],
  top_provider: { max_completion_tokens: 65_536 },
  reasoning: {
    default_effort: defaultEffort,
    mandatory: !efforts.includes('none'),
    supported_efforts: efforts,
  },
});

const fable = catalogModel(
  'anthropic/claude-fable-5.1',
  'Anthropic: Claude Fable 5.1',
  false,
  ['high', 'medium', 'low', 'none'],
  'medium',
  1_790_000_000,
);

/**
 * The public catalog the server reads at start (phase-10 decision 8); Fable has no ZDR endpoint.
 * "Uusimmat" (phase 21): the Anthropic alias points to Fable, Argon is Google's newest model, and
 * Opus is in neither, so it stays in "Kaikki mallit".
 */
export const FAKE_CATALOG: FakeCatalogModel[] = [
  catalogModel(
    'google/gemini-4-argon',
    'Google: Gemini 4 Argon',
    true,
    ['high', 'medium', 'low'],
    'medium',
    1_780_000_000,
  ),
  catalogModel(
    'anthropic/claude-opus-5.5',
    'Anthropic: Claude Opus 5.5',
    true,
    ['max', 'xhigh', 'high', 'medium', 'low'],
    'high',
    1_795_000_000,
  ),
  fable,
  {
    ...fable,
    id: '~anthropic/claude-fable-latest',
    name: 'Anthropic: Claude Fable Latest',
    alias_target: { slug: fable.id, name: fable.name },
  },
];
export type FakeRequest = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
};

const split = (s: string, n: number) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g')) ?? [];

/** Text of the last `user` message; content parts are joined. */
const lastUserText = (body: any): string => {
  const m = [...(Array.isArray(body?.messages) ? body.messages : [])]
    .reverse()
    .find((x: any) => x?.role === 'user');
  const c = m?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c)
    ? c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('')
    : '';
};

const matches = (t: FakeTurn, text: string) =>
  t.match !== undefined &&
  (typeof t.match === 'string' ? text.includes(t.match) : t.match.test(text));

/**
 * Takes the first turn whose `match` matches, else the first turn without `match`. A `zdr/search`
 * call takes only `citations` turns, and other calls never take one.
 */
const take = (queue: FakeTurn[], body: any) => {
  const text = lastUserText(body);
  const search = body?.model === 'zdr/search';
  const kind = (t: FakeTurn) => 'citations' in t === search;
  const i = queue.findIndex((t) => kind(t) && matches(t, text));
  const j = i >= 0 ? i : queue.findIndex((t) => kind(t) && t.match === undefined);
  if (j >= 0) return queue.splice(j, 1)[0];
  return search ? { citations: FAKE_CITATIONS } : undefined;
};

/**
 * `fallback` answers a call when the queue is empty (demo use); tests leave it unset so an
 * unscripted call fails loudly.
 */
export async function startFakeLlm(
  turns: FakeTurn[] = [],
  fallback?: (body: any) => FakeTurn | undefined,
) {
  const queue = [...turns];
  const requests: FakeRequest[] = [];
  const catalog = structuredClone(FAKE_CATALOG);
  let callN = 0;
  let transcript = 'fake transcript';

  const server = createServer((req, res) => {
    const json = (status: number, obj: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const path = req.url?.split('?')[0] ?? '';
    if (req.method === 'GET' && path.endsWith('/service/data/EXR/D.USD.EUR.SP00.A')) {
      res.writeHead(200, { 'Content-Type': 'text/csv' });
      return res.end(FAKE_ECB_CSV);
    }
    if (req.method === 'GET' && path.endsWith('/models')) {
      const zdrOnly = new URLSearchParams(req.url?.split('?')[1]).get('zdr') === 'true';
      return json(200, {
        data: catalog.filter((m) => !zdrOnly || m.zdr).map(({ zdr: _, ...m }) => m),
      });
    }
    if (req.method === 'POST' && path.endsWith('/audio/transcriptions')) {
      // Records the multipart text fields and the file's name, type and size.
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        try {
          const form = await new Request('http://x', {
            method: 'POST',
            headers: { 'content-type': String(req.headers['content-type']) },
            body: Buffer.concat(chunks),
          }).formData();
          const body: Record<string, unknown> = {};
          form.forEach((v, k) => {
            body[k] = typeof v === 'string' ? v : { name: v.name, type: v.type, size: v.size };
          });
          requests.push({ path: req.url ?? '', headers: req.headers, body });
          json(200, { text: transcript });
        } catch {
          json(400, { error: { message: 'fake-llm: bad multipart' } });
        }
      });
      return;
    }
    if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
      return json(404, { error: { message: 'fake-llm: not found' } });
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: { message: 'fake-llm: bad json' } });
      }
      requests.push({ path: req.url ?? '', headers: req.headers, body });
      const turn = take(queue, body) ?? fallback?.(body);
      if (!turn) return json(500, { error: { message: 'fake-llm: no scripted turn' } });
      if ('error' in turn)
        return json(turn.error.status, {
          error: { code: turn.error.status, message: turn.error.message },
        });
      if (turn.queueMs) await new Promise((r) => setTimeout(r, turn.queueMs));

      const id = `chatcmpl-${requests.length}`;
      const created = Math.floor(Date.now() / 1000);
      const model = body.model;
      const calls =
        'toolCalls' in turn
          ? turn.toolCalls.map((c) => ({ ...c, id: c.id ?? `call_${++callN}` }))
          : [];
      // The web plugin's results: one annotation per citation, the model lists them as links.
      const annotations =
        'citations' in turn
          ? turn.citations.map((c) => ({
              type: 'url_citation',
              url_citation: { ...c, start_index: 0, end_index: 0 },
            }))
          : undefined;
      const text =
        turn.text ??
        ('citations' in turn ? turn.citations.map((c) => `[${c.title}](${c.url})`).join('\n') : '');
      const finish = calls.length ? 'tool_calls' : 'stop';
      const u = turn.usage;
      const usage = u
        ? {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.prompt_tokens + u.completion_tokens,
            ...(u.cached_tokens !== undefined
              ? { prompt_tokens_details: { cached_tokens: u.cached_tokens } }
              : {}),
            ...(u.reasoning_tokens !== undefined
              ? { completion_tokens_details: { reasoning_tokens: u.reasoning_tokens } }
              : {}),
            ...(u.cost !== undefined ? { cost: u.cost } : {}),
          }
        : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      if (body.stream !== true) {
        const message: Record<string, unknown> = { role: 'assistant', content: text || null };
        if (turn.reasoning) message.reasoning_content = turn.reasoning;
        if (annotations) message.annotations = annotations;
        if (calls.length) {
          message.tool_calls = calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          }));
        }
        return json(200, {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message, finish_reason: finish }],
          usage,
        });
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (choices: unknown[], extra: object = {}) =>
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })}\n\n`,
        );
      const delta = (d: object, finish_reason: string | null = null) =>
        send([{ index: 0, delta: d, finish_reason }]);

      delta({ role: 'assistant', content: '' });
      // The thinking lasts `thinkMs`: from the first reasoning delta to the last one.
      for (const [i, part] of split(turn.reasoning ?? '', 8).entries()) {
        if (i === 1 && turn.thinkMs) await new Promise((r) => setTimeout(r, turn.thinkMs));
        delta({ reasoning_content: part });
      }
      for (const part of split(text, 8)) delta({ content: part });
      calls.forEach((c, index) => {
        delta({
          tool_calls: [
            { index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } },
          ],
        });
        for (const part of split(JSON.stringify(c.args), 16)) {
          delta({ tool_calls: [{ index, function: { arguments: part } }] });
        }
      });
      delta({}, finish);
      if (body.stream_options?.include_usage) send([], { usage });
      res.end('data: [DONE]\n\n');
    });
  });

  const { origin, close } = await listenLocal(server);
  return {
    url: `${origin}/v1`,
    requests,
    /** Served at `GET /v1/models` (point `OPENROUTER_CATALOG` at `url`); edit before the server starts. */
    catalog,
    push: (turn: FakeTurn) => void queue.push(turn),
    /** Text the `/audio/transcriptions` route returns. */
    setTranscript: (text: string) => {
      transcript = text;
    },
    close,
  };
}

/** Listens on a free loopback port; `close` also drops open connections. */
export async function listenLocal(server: Server) {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
