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
