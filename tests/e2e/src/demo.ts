// Local demo of the PWA with fakes: fake LLM (echo), fake pseudonymization sidecar, no Docker.
//   node tests/e2e/src/demo.ts        then open http://localhost:3000 (password: salasana)
// Build the web app first if apps/web/dist is missing: pnpm --filter @pa/web build
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeLlm } from '@pa/fake-llm';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import { hashPassword } from '@pa/server/src/auth/password.ts';
import { loadConfig } from '@pa/server/src/config.ts';
import { start } from '@pa/server/src/main.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const port = process.env.PORT || '3000';
const dataDir = process.env.DEMO_DATA_DIR || join(tmpdir(), 'pa-demo');
mkdirSync(join(dataDir, 'work/aleksi'), { recursive: true });
mkdirSync(join(dataDir, 'automations'), { recursive: true });

const DICT = {
  'Matti Virtanen': 'Pekka Laaksonen',
  'Liisa Korhonen': 'Anna Mäkinen',
  '010190-923E': '010190-900B',
};
const KEY = 'sk-demo';
let n = 0;

const llm = await startFakeLlm([], (body) => {
  const last = body.messages.at(-1);
  const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
  // Non-streaming calls are the title/topic job: answer its JSON shape.
  if (body.stream !== true) {
    return {
      text: JSON.stringify({
        title: `Demo ${++n}`,
        topics: [],
        proposed_topic: n === 1 ? { name: 'Demo', why: 'Demokeskustelut.' } : null,
        summary: 'Demokeskustelu paikallisella valemallilla.',
      }),
    };
  }
  if (/artefakti|html/i.test(text)) {
    return {
      text: 'Tässä sivu:\n\n```html\n<h1>Hei artefakti</h1>\n<p>Tämä sivu toimii hiekkalaatikossa.</p>\n```',
    };
  }
  return {
    text: `**Valemalli** sai viestin (maskattuna):\n\n> ${text}\n\nKirjoita *artefakti* niin saat HTML-artefaktin. Nimet Matti Virtanen ja Liisa Korhonen sekä hetu 010190-923E maskataan.`,
  };
});
const sidecar = await startFakeSidecar(DICT, {
  pending: [{ kind: 'person', text: 'Koski', detector: 'gliner', score: 0.42 }],
});
process.env.LITELLM_MASTER_KEY = KEY;
await start(
  loadConfig({
    DATA_DIR: dataDir,
    MODELS_DIR: process.env.MODELS_DIR,
    LITELLM_URL: llm.url,
    LITELLM_MASTER_KEY: KEY,
    OPENROUTER_CATALOG: llm.url,
    ECB_RATES: llm.url,
    PSEUDO_URL: sidecar.url,
    AUTH_ORIGIN: `http://localhost:${port}`,
    COOKIE_SECRET: 'd'.repeat(40),
    AUTH_PASSWORD_HASH: await hashPassword('salasana'),
    WEB_DIST: join(root, 'apps/web/dist'),
    HOST: '127.0.0.1',
    PORT: port,
    USER_ID: 'aleksi',
    LOG_LEVEL: 'warn',
    AUTOMATIONS_DIR: join(dataDir, 'automations'),
    AGENTS_DIR: join(dataDir, 'agents'),
  }),
);
console.log(`demo: http://127.0.0.1:${port}  password: salasana  data: ${dataDir}`);
