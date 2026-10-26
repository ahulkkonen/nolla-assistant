import { expect, test } from 'vitest';
import { startFakeLlm } from './index.ts';

const events = (t: string) =>
  t
    .split('\n\n')
    .filter((e) => e.startsWith('data: ') && !e.includes('[DONE]'))
    .map((e) => JSON.parse(e.slice(6)));

test('streams scripted turns', async () => {
  const args = { path: '/tmp/some/long/file.txt', n: 1 };
  const fake = await startFakeLlm([
    { text: 'hello there, world' },
    { toolCalls: [{ name: 'read', args }] },
  ]);
  const call = () =>
    fetch(`${fake.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm1', stream: true, messages: [] }),
    });
  try {
    const a = events(await (await call()).text());
    expect(a.map((e) => e.choices[0].delta.content ?? '').join('')).toBe('hello there, world');

    const b = events(await (await call()).text());
    const tcs = b.flatMap((e) => e.choices[0].delta.tool_calls ?? []);
    expect(tcs[0].function.name).toBe('read');
    expect(JSON.parse(tcs.map((t) => t.function.arguments ?? '').join(''))).toEqual(args);

    expect(fake.requests.length).toBe(2);
    expect(fake.requests[0]?.body.model).toBe('m1');
    expect((await call()).status).toBe(500);
  } finally {
    await fake.close();
  }
});

test('a turn with `match` answers only a call whose last user message matches', async () => {
  const fake = await startFakeLlm([
    { text: 'parent' },
    { text: 'child B', match: 'aihe B' },
    { text: 'child A', match: /aihe A$/ },
  ]);
  const ask = async (content: unknown) => {
    const res = await fetch(`${fake.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content }] }),
    });
    if (!res.ok) return res.status;
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    return body.choices[0]?.message.content;
  };
  try {
    // Out of queue order; content parts count too.
    expect(await ask([{ type: 'text', text: 'Tee tehtävä.\n\naihe A' }])).toBe('child A');
    expect(await ask('Otsikoi keskustelu')).toBe('parent');
    // Matched turns are never handed to an unmatched call.
    expect(await ask('Otsikoi keskustelu')).toBe(500);
    expect(await ask('Tee aihe B nyt')).toBe('child B');
  } finally {
    await fake.close();
  }
});

test('an error turn answers with its status; GET /models serves the catalog', async () => {
  const fake = await startFakeLlm([
    { error: { status: 404, message: 'No endpoints found matching your data policy' } },
  ]);
  try {
    const res = await fetch(`${fake.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 404, message: 'No endpoints found matching your data policy' },
    });
    const ids = async (q: string) =>
      ((await (await fetch(`${fake.url}/models${q}`)).json()) as { data: { id: string }[] }).data
        .map((m) => m.id)
        .sort();
    expect(await ids('?supported_parameters=tools')).toEqual(fake.catalog.map((m) => m.id).sort());
    expect(await ids('?supported_parameters=tools&zdr=true')).not.toContain(
      'anthropic/claude-fable-5.1',
    );
  } finally {
    await fake.close();
  }
});

test('reasoning streams before the text; the usage chunk carries cost and token details', async () => {
  const fake = await startFakeLlm([
    {
      text: 'vastaus',
      reasoning: 'mietin ensin',
      thinkMs: 30,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        cost: 0.0123,
        reasoning_tokens: 5,
        cached_tokens: 40,
      },
    },
    { text: 'ilman', reasoning: 'lyhyt' },
  ]);
  const call = (stream: boolean) =>
    fetch(`${fake.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'm',
        stream,
        stream_options: { include_usage: true },
        messages: [],
      }),
    });
  try {
    const start = Date.now();
    const e = events(await (await call(true)).text());
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
    const deltas = e.flatMap((x) => x.choices.map((c: { delta: object }) => c.delta));
    const firstText = deltas.findIndex((d) => d.content);
    const lastThink = deltas.findLastIndex((d) => d.reasoning_content);
    expect(deltas.map((d) => d.reasoning_content ?? '').join('')).toBe('mietin ensin');
    expect(lastThink).toBeLessThan(firstText);
    expect(e.at(-1).usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 5 },
      cost: 0.0123,
    });
    const body = (await (await call(false)).json()) as {
      choices: { message: { reasoning_content?: string } }[];
      usage: object;
    };
    expect(body.choices[0]?.message.reasoning_content).toBe('lyhyt');
    expect(body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  } finally {
    await fake.close();
  }
});

test('GET the ECB path serves the rate CSV and is not a recorded request', async () => {
  const fake = await startFakeLlm();
  try {
    const res = await fetch(
      `${fake.url}/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=1&format=csvdata&detail=dataonly`,
    );
    expect(res.headers.get('content-type')).toBe('text/csv');
    expect((await res.text()).split('\n')[1]).toBe(
      'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-23,1.1193',
    );
    expect(fake.requests).toHaveLength(0);
  } finally {
    await fake.close();
  }
});
