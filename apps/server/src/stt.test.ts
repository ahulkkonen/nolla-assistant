import { afterEach, expect, test } from 'vitest';
import { MAX_AUDIO_BYTES } from './stt.ts';
import { api, boot, KEY, login, runCleanups } from './test-utils.ts';

afterEach(runCleanups);

const upload = (port: number, cookie: string, audio: Blob, extra: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  form.set('audio', audio, 'rec.webm');
  return api(port, '/api/transcribe', { method: 'POST', headers: { cookie }, body: form });
};

test('transcribe forwards to zdr/stt and returns the text', { timeout: 30_000 }, async () => {
  const { llm, config, run } = await boot([]);
  await run();
  llm.setTranscript('Hei maailma');
  const { cookie } = await login(config.port);
  const audio = new Blob([new Uint8Array(1000)], { type: 'audio/webm;codecs=opus' });

  expect((await upload(config.port, '', audio)).status).toBe(401);
  const res = await upload(config.port, cookie, audio);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: 'Hei maailma' });
  const req = llm.requests.find((r) => r.path.endsWith('/audio/transcriptions'));
  expect(req?.headers.authorization).toBe(`Bearer ${KEY}`);
  expect(req?.body).toMatchObject({
    model: 'zdr/stt',
    language: 'fi',
    response_format: 'json',
    file: { type: 'audio/webm', size: 1000 },
  });

  expect((await upload(config.port, cookie, audio, { language: 'sv' })).status).toBe(200);
  expect(llm.requests.at(-1)?.body.language).toBe('sv');
  expect((await upload(config.port, cookie, audio, { language: 'FI;x' })).status).toBe(400);
});

test('transcribe rejects a wrong mime and a too large file', { timeout: 30_000 }, async () => {
  const { config, run } = await boot([]);
  await run();
  const { cookie } = await login(config.port);
  const wrong = new Blob([new Uint8Array(10)], { type: 'video/mp4' });
  expect((await upload(config.port, cookie, wrong)).status).toBe(415);
  const big = new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)], { type: 'audio/ogg' });
  expect((await upload(config.port, cookie, big)).status).toBe(413);
});

test('transcribe maps an upstream failure to 502', { timeout: 30_000 }, async () => {
  const { config, run } = await boot([], { LITELLM_URL: 'http://127.0.0.1:1' });
  await run();
  const { cookie } = await login(config.port);
  const res = await upload(config.port, cookie, new Blob(['x'], { type: 'audio/wav' }));
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: 'stt_failed' });
});

test('transcribe allows 10 requests a minute', { timeout: 30_000 }, async () => {
  const { config, run } = await boot([]);
  await run();
  const { cookie } = await login(config.port);
  const wrong = new Blob([new Uint8Array(10)], { type: 'video/mp4' });
  for (let i = 0; i < 10; i++) expect((await upload(config.port, cookie, wrong)).status).toBe(415);
  const res = await upload(config.port, cookie, wrong);
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual({ error: 'rate_limited' });
});
