// Phase-3 egress gate (plan §13), phase-10 gate item 2 and phase-14 gate item 1: LiteLLM +
// Presidio from infra/compose.yaml against a mock OpenRouter. Decision records:
// docs/decisions/0004-litellm-openrouter-zdr.md, docs/decisions/phase-10-models.md,
// docs/decisions/phase-14-search.md.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NO_ENDPOINT_ERROR,
  NO_ENDPOINT_MODEL,
  SEARCH_ANNOTATIONS,
  startMockOpenRouter,
} from './mock-openrouter.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const MASTER_KEY = 'sk-egress-test';
const ZDR_KEY = 'test';
const OPEN_KEY = 'test-open';
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
        OPENROUTER_API_KEY: ZDR_KEY,
        OPENROUTER_OPEN_API_KEY: OPEN_KEY,
        LITELLM_MASTER_KEY: MASTER_KEY,
        EGRESS_MOCK_PORT: String(mock.port),
        // compose.yaml requires these for services this suite does not start.
        PSEUDO_VAULT_KEY: process.env.PSEUDO_VAULT_KEY ?? 'x'.repeat(40),
        BROKER_TOKEN: process.env.BROKER_TOKEN ?? 'x'.repeat(40),
        GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID ?? 'unused',
        GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? 'unused',
        USER_GOOGLE_EMAIL: process.env.USER_GOOGLE_EMAIL ?? 'unused@example.invalid',
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

    /**
     * Asserts LiteLLM refused with 400 and nothing reached the upstream. LiteLLM itself sends one
     * GET /v1/models (no prompt) shortly after startup, which can overlap a probe; it is ignored.
     */
    async function expectRefused(res: Promise<Response>, message: RegExp) {
      const before = mock.requests.length;
      const r = await res;
      expect(r.status).toBe(400);
      expect(JSON.stringify(await r.json())).toMatch(message);
      expect(mock.requests.slice(before).filter((q) => q.path !== '/v1/models')).toEqual([]);
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
      expect(up?.headers.authorization).toBe(`Bearer ${ZDR_KEY}`);
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
      await expectRefused(
        chat('zdr/unknown', 'x'),
        /zdr_guard: 'zdr\/unknown' is not a ZDR-pinned alias or zdr\/<vendor>\/<model>/,
      );
      await expectRefused(
        chat('zdr/strong', 'x', { extra_body: { provider: { zdr: false } } }),
        /zdr_guard: request fields not allowed/,
      );
      await expectRefused(
        chat('zdr/strong', 'x', { provider: { data_collection: 'allow' } }),
        /zdr_guard: request fields not allowed/,
      );
      await expectRefused(
        post('/v1/embeddings', { model: 'openrouter/openai/text-embedding-3-small', input: 'x' }),
        /zdr_guard/,
      );
    });

    it('(c) refuses a top-level key outside the allowlist; listed keys pass', async () => {
      await expectRefused(
        chat('zdr/strong', 'x', { x_custom: true }),
        /zdr_guard: request fields not allowed: \['x_custom'\]/,
      );
      await expectRefused(
        post('/v1/embeddings', { model: 'zdr/embed', input: 'x', x_custom: 1 }),
        /zdr_guard: request fields not allowed: \['x_custom'\]/,
      );
      const listed = {
        temperature: 0.2,
        top_p: 0.9,
        stop: ['###'],
        seed: 1,
        n: 1,
        user: 'u1',
        metadata: { app: 'pa' },
        prompt_cache_key: 'k1',
      };
      expect((await chat('zdr/strong', 'hei', listed)).status).toBe(200);
      expect(last()?.body).toMatchObject({ temperature: 0.2, top_p: 0.9, seed: 1 });
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

    describe('phase-14 web search', () => {
      const fnTool = {
        type: 'function',
        function: { name: 'web_search', parameters: { type: 'object', properties: {} } },
      };

      it('zdr/search carries the fixed web plugin and the EU ZDR block; annotations come back', async () => {
        const r = await post('/v1/chat/completions', {
          model: 'zdr/search',
          stream: false,
          max_tokens: 600,
          messages: [
            { role: 'system', content: 'Listaa tulokset.' },
            { role: 'user', content: 'Helsingin sää' },
          ],
        });
        expect(r.status).toBe(200);
        const res = (await r.json()) as any;
        expect(res.choices[0].message.annotations).toEqual(SEARCH_ANNOTATIONS);
        expect(res.usage.cost).toBe(0.00001);
        const up = last();
        expect(up?.path).toBe('/chat/completions');
        expect(up?.body.model).toBe('anthropic/claude-haiku-5.5');
        expect(up?.body.plugins).toEqual([{ id: 'web', engine: 'exa', max_results: 5 }]);
        expect(up?.body.reasoning).toEqual({ effort: 'none' });
        expect(up?.body.provider).toEqual({
          zdr: true,
          data_collection: 'deny',
          order: ['google-vertex/europe', 'amazon-bedrock/eu-west-1'],
          allow_fallbacks: false,
        });
        expect(up?.body.messages.at(-1)).toEqual({ role: 'user', content: 'Helsingin sää' });
        expect(up?.headers.authorization).toBe(`Bearer ${ZDR_KEY}`);
      });

      it('refuses client plugins and web_search_options on every model', async () => {
        for (const model of ['zdr/strong', 'zdr/search', 'zdr/acme/model-1']) {
          await expectRefused(
            chat(model, 'x', { plugins: [{ id: 'web' }] }),
            /zdr_guard: request fields not allowed: \['plugins'\]/,
          );
          await expectRefused(
            chat(model, 'x', { web_search_options: { search_context_size: 'high' } }),
            /zdr_guard: request fields not allowed: \['web_search_options'\]/,
          );
        }
      });

      it('refuses server tools; a function tool named web_search passes without a plugin', async () => {
        for (const type of ['openrouter:web_search', 'web_search', 'web_search_preview'])
          await expectRefused(
            chat('zdr/strong', 'x', { tools: [fnTool, { type }] }),
            /zdr_guard: only function tools are allowed/,
          );
        expect((await chat('zdr/strong', 'hei', { tools: [fnTool] })).status).toBe(200);
        expect(last()?.body.tools).toEqual([fnTool]);
        expect(last()?.body).not.toHaveProperty('plugins');
      });

      it('refuses zdr/search outside chat completions', async () => {
        await expectRefused(
          post('/v1/embeddings', { model: 'zdr/search', input: 'x' }),
          /zdr_guard: zdr\/search is allowed on chat completions only/,
        );
      });

      it('the presidio backstop also covers search queries', async () => {
        await expectRefused(
          chat('zdr/search', 'hetu 010190-123M'),
          /Blocked entity detected: FI_PERSONAL_IDENTITY_CODE/,
        );
      });
    });

    describe('phase-10 wildcard routes', () => {
      const ZDR_ROUTE = { zdr: true, data_collection: 'deny' };

      it('zdr/<id> takes zdr/* with the ZDR block and key; the id is not in the cost map', async () => {
        expect((await chat('zdr/acme/model-1', 'hei')).status).toBe(200);
        const up = last();
        expect(up?.path).toBe('/chat/completions');
        expect(up?.body.model).toBe('acme/model-1');
        expect(up?.body.provider).toEqual(ZDR_ROUTE);
        expect(up?.headers.authorization).toBe(`Bearer ${ZDR_KEY}`);
      });

      it('open/<id> takes open/* with data_collection deny, no zdr flag, and the open key', async () => {
        expect((await chat('open/acme/model-1', 'hei')).status).toBe(200);
        const up = last();
        expect(up?.body.model).toBe('acme/model-1');
        expect(up?.body.provider).toEqual({ data_collection: 'deny' });
        expect(up?.headers.authorization).toBe(`Bearer ${OPEN_KEY}`);
      });

      it.each([false, true])(
        'client reasoning and tools reach the upstream unchanged (stream: %s)',
        async (stream) => {
          const reasoning = { effort: 'max' };
          const tools = [
            {
              type: 'function',
              function: {
                name: 'hae',
                description: 'Hakee muistiinpanoista',
                parameters: { type: 'object', properties: { q: { type: 'string' } } },
              },
            },
          ];
          const r = await chat('zdr/acme/model-1', 'hei', { reasoning, tools, stream });
          expect(r.status).toBe(200);
          await r.text();
          const up = last()?.body;
          expect(up.reasoning).toEqual(reasoning);
          expect(up.tools).toEqual(tools);
          expect(up.provider).toEqual(ZDR_ROUTE);
        },
      );

      it('zdr/strong keeps its own deployment and the EU order', async () => {
        expect((await chat('zdr/strong', 'hei')).status).toBe(200);
        expect(last()?.body.model).toBe('anthropic/claude-sonnet-5.5');
        expect(last()?.body.provider).toEqual({
          ...ZDR_ROUTE,
          order: ['google-vertex/europe', 'amazon-bedrock'],
          allow_fallbacks: false,
        });
      });

      it('refuses ~aliases, :variants, open/<alias> and wildcards outside chat', async () => {
        for (const model of [
          'zdr/~openai/gpt-sol-latest',
          'zdr/acme/model-1:free',
          'open/strong',
        ]) {
          await expectRefused(
            chat(model, 'x'),
            /zdr_guard: .+ is not a ZDR-pinned alias or (zdr|open)\/<vendor>\/<model>/,
          );
        }
        await expectRefused(
          post('/v1/embeddings', { model: 'zdr/openai/text-embedding-3-small', input: 'x' }),
          /zdr_guard: zdr\/<vendor>\/<model> is allowed on chat completions only/,
        );
      });

      it('passes an OpenRouter 404 data-policy refusal through as 404', async () => {
        const r = await chat(`zdr/${NO_ENDPOINT_MODEL}`, 'hei');
        expect(r.status).toBe(404);
        expect(JSON.stringify(await r.json())).toContain(NO_ENDPOINT_ERROR.error.message);
      });

      // Keep last: it recreates the litellm container without the open key.
      it('without OPENROUTER_OPEN_API_KEY, open/ fails closed and zdr/ still works', async () => {
        env.OPENROUTER_OPEN_API_KEY = ''; // what compose passes when the variable is unset
        compose('up', '-d', '--wait', '--wait-timeout', '120', 'litellm');
        base = `http://${compose('port', 'litellm', '4000')}`;
        await expectRefused(
          chat('open/acme/model-1', 'x'),
          /zdr_guard: open\/ models are off: OPENROUTER_OPEN_API_KEY is not set/,
        );
        expect((await chat('zdr/acme/model-1', 'hei')).status).toBe(200);
      }, 150_000);
    });
  },
);
