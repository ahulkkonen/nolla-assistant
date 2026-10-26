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
