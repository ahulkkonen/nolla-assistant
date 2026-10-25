// Phase-3 egress gate (plan §13): LiteLLM + Presidio from infra/compose.yaml against a mock
// OpenRouter. Decision record: docs/decisions/0004-litellm-openrouter-zdr.md.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockOpenRouter } from './mock-openrouter.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const MASTER_KEY = 'sk-egress-test';
const PROJECT = 'pa-egress-test';
const SERVICES = ['litellm', 'presidio-analyzer', 'presidio-anonymizer'];

const hasDocker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const SKIP_NOTE = 'SKIPPED: docker not on PATH or daemon not running';
if (!hasDocker) process.stderr.write(`[egress] ${SKIP_NOTE}\n`);

describe.skipIf(!hasDocker)(
  hasDocker ? 'LiteLLM egress (docker)' : `LiteLLM egress ${SKIP_NOTE}`,
  () => {
    let mock: Awaited<ReturnType<typeof startMockOpenRouter>>;
    let base = '';
    let env: NodeJS.ProcessEnv = {};

    const compose = (...args: string[]) => {
      const r = spawnSync(
        'docker',
        [
          'compose',
          '-p',
          PROJECT,
          '-f',
          'infra/compose.yaml',
          '-f',
          'tests/egress/compose.override.yaml',
          ...args,
        ],
        { cwd: root, env, encoding: 'utf8' },
      );
      if (r.status !== 0) throw new Error(`docker compose ${args[0]} failed:\n${r.stderr}`);
      return r.stdout.trim();
    };

    beforeAll(async () => {
      mock = await startMockOpenRouter();
      env = {
        ...process.env,
        OPENROUTER_API_KEY: 'test',
        LITELLM_MASTER_KEY: MASTER_KEY,
        EGRESS_MOCK_PORT: String(mock.port),
      };
      compose('up', '-d', '--wait', '--wait-timeout', '120', ...SERVICES);
      // The override publishes 4000 on an ephemeral loopback port; ask compose which one.
      base = `http://${compose('port', 'litellm', '4000')}`;
    });

    afterAll(async () => {
      if (env.EGRESS_MOCK_PORT) compose('down', '-v', '--remove-orphans');
      await mock?.close();
    });

    const post = (path: string, body: unknown) =>
      fetch(base + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${MASTER_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const chat = (model: string, content: unknown, extra: object = {}) =>
      post('/v1/chat/completions', { model, messages: [{ role: 'user', content }], ...extra });
    const last = () => mock.requests.at(-1);

    /** Asserts LiteLLM refused with 400 and nothing reached the upstream. */
    async function expectRefused(res: Promise<Response>, message: RegExp) {
      const before = mock.requests.length;
      const r = await res;
      expect(r.status).toBe(400);
      expect(JSON.stringify(await r.json())).toMatch(message);
      expect(mock.requests.length).toBe(before);
    }

    it('(a) zdr/strong carries the ZDR provider block upstream', async () => {
      const r = await chat('zdr/strong', 'hei');
      expect(r.status).toBe(200);
      const up = last();
      expect(up?.path).toBe('/chat/completions');
      expect(up?.body.model).toBe('anthropic/claude-sonnet-5.5');
      expect(up?.body.provider).toMatchObject({
        zdr: true,
        data_collection: 'deny',
        allow_fallbacks: false,
      });
      expect(up?.headers.authorization).toBe('Bearer test');
    });

    it('accepts a Pi-shaped request on /chat/completions (LITELLM_URL without /v1)', async () => {
      // Pi's openai-completions api uses the OpenAI SDK, which appends /chat/completions to baseUrl.
      const r = await post('/chat/completions', {
        model: 'zdr/strong',
        messages: [
          { role: 'developer', content: 'järjestelmä' },
          { role: 'user', content: 'hei' },
        ],
        stream: false,
        store: false,
        max_completion_tokens: 100,
        reasoning_effort: 'high',
      });
      expect(r.status).toBe(200);
      expect(last()?.body.provider.zdr).toBe(true);
    });

    it('(b) blocks a checksum-valid hetu before the upstream', async () => {
      await expectRefused(
        chat('zdr/strong', 'hetuni on 010190-123M'),
        /Blocked entity detected: FI_PERSONAL_IDENTITY_CODE/,
      );
    });

    it('(b) blocks IBAN and card numbers, also in tool messages', async () => {
      await expectRefused(chat('zdr/fast', 'tili FI21 1234 5600 0007 85'), /IBAN_CODE/);
      await expectRefused(
        post('/v1/chat/completions', {
          model: 'zdr/strong',
          messages: [
            { role: 'user', content: 'hei' },
            { role: 'tool', tool_call_id: 't1', content: 'kortti 4111 1111 1111 1111' },
          ],
        }),
        /CREDIT_CARD/,
      );
    });

    it('(b) lets a checksum-invalid code through: 010190-123A is not a hetu', async () => {
      // The mod-31 check character for 010190-123 is M. Presidio validates the checksum, so a
      // code with a wrong check character is not FI_PERSONAL_IDENTITY_CODE by design.
      expect((await chat('zdr/strong', 'koodi 010190-123A')).status).toBe(200);
    });

    it('(c) refuses non-ZDR and non-alias models and client routing overrides', async () => {
      await expectRefused(
        chat('openrouter/openai/gpt-4o', 'x'),
        /zdr_guard: model must be a zdr\//,
      );
      await expectRefused(
        chat('anthropic/claude-haiku-5.5', 'x'),
        /zdr_guard: model must be a zdr\//,
      );
      await expectRefused(chat('zdr/unknown', 'x'), /zdr_guard: alias 'zdr\/unknown' is not/);
      await expectRefused(
        chat('zdr/strong', 'x', { extra_body: { provider: { zdr: false } } }),
        /client routing fields not allowed/,
      );
      await expectRefused(
        chat('zdr/strong', 'x', { provider: { data_collection: 'allow' } }),
        /client routing fields not allowed/,
      );
      await expectRefused(
        post('/v1/embeddings', { model: 'openrouter/openai/text-embedding-3-small', input: 'x' }),
        /zdr_guard/,
      );
    });

    it('(d) embeddings carry the ZDR provider block', async () => {
      const r = await post('/v1/embeddings', { model: 'zdr/embed', input: 'hei' });
      expect(r.status).toBe(200);
      expect(last()?.path).toBe('/embeddings');
      expect(last()?.body.provider).toMatchObject({ zdr: true, data_collection: 'deny' });
    });

    it('(d) transcription sends multipart with provider[zdr] form fields', async () => {
      // Verifiable here: LiteLLM forwards provider[zdr]=true and provider[data_collection]=deny as
      // multipart fields to /audio/transcriptions. NOT verifiable here: whether OpenRouter reads
      // them (its docs list only file/model/language/temperature/response_format/
      // timestamp_granularities for multipart). STT ZDR rests on the account + key guardrail.
      const form = new FormData();
      form.set('model', 'zdr/stt');
      form.set('language', 'fi');
      form.set('response_format', 'json');
      form.set('file', new Blob([Buffer.from('RIFF....WAVEfmt ')], { type: 'audio/wav' }), 'a.wav');
      const r = await fetch(`${base}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${MASTER_KEY}` },
        body: form,
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ text: 'hei maailma' });
      const up = last();
      expect(up?.path).toBe('/audio/transcriptions');
      for (const [name, value] of [
        ['model', 'openai/whisper-large-v3'],
        ['provider[zdr]', 'true'],
        ['provider[data_collection]', 'deny'],
        ['response_format', 'json'],
      ]) {
        expect(up?.body).toContain(`name="${name}"\r\n\r\n${value}\r\n`);
      }
    });

    it.each(['zdr/strong', 'zdr/fast'])('(e) %s keeps an image part intact', async (model) => {
      const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } };
      const r = await chat(model, [{ type: 'text', text: 'mitä kuvassa on?' }, image]);
      expect(r.status).toBe(200);
      expect(last()?.body.messages.at(-1).content).toContainEqual(image);
    });

    it('(f) streaming with include_usage ends with a usage chunk', async () => {
      const r = await chat('zdr/strong', 'hei', {
        stream: true,
        stream_options: { include_usage: true },
      });
      expect(r.status).toBe(200);
      const events = (await r.text())
        .split('\n')
        .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
        .map((l) => JSON.parse(l.slice(6)));
      expect(events.at(-1)?.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 1 });
      expect(last()?.body.stream_options).toEqual({ include_usage: true });
    });
  },
);
