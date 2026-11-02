import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { type FakeTurn, startFakeLlm } from '@nolla/fake-llm';
import { afterEach } from 'vitest';

export async function bootPi(opts: {
  dataDir: string;
  llmUrl: string;
  extensions: ExtensionFactory[];
  sessionManager?: SessionManager;
  bind?: boolean;
  tools?: string[];
}) {
  process.env.PI_OFFLINE = '1';
  process.env.PI_SKIP_VERSION_CHECK = '1';
  process.env.PI_TELEMETRY = '0';
  const agentDir = join(opts.dataDir, 'agent');
  const cwd = join(opts.dataDir, 'work');
  const sessionDir = join(opts.dataDir, 'sessions');
  for (const d of [agentDir, cwd, sessionDir]) mkdirSync(d, { recursive: true });
  const modelsPath = join(agentDir, 'models.json');
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        zdr: {
          baseUrl: opts.llmUrl,
          api: 'openai-completions',
          apiKey: 'test-key',
          models: [
            {
              id: 'zdr/strong',
              name: 'x',
              reasoning: false,
              input: ['text'],
              contextWindow: 100000,
              maxTokens: 4000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  // In-memory settings: no retry on fake-llm errors, no compaction.
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noExtensions: true,
    extensionFactories: opts.extensions,
  });
  await resourceLoader.reload();
  const sessionManager = opts.sessionManager ?? SessionManager.create(cwd, sessionDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath,
  });
  const model = modelRuntime.getModel('zdr', 'zdr/strong');
  if (!model) throw new Error('model zdr/zdr/strong not found');
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    settingsManager,
    sessionManager,
    resourceLoader,
    tools: opts.tools ?? ['read', 'write', 'edit'],
  });
  if (opts.bind !== false) await session.bindExtensions({});
  return { session, sessionManager, agentDir, cwd, sessionDir };
}

export type Seen = { type: string; keys: string[]; event: any };
type Handler = (event: any, ctx: ExtensionContext) => unknown;

export const EVENTS = [
  'session_start',
  'input',
  'before_agent_start',
  'agent_start',
  'agent_end',
  'agent_settled',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_call',
  'tool_result',
  'tool_execution_end',
  'context',
  'context_with_system',
] as const;

/** Extension that records every event in EVENTS and runs an optional handler per event. */
export function probe(
  seen: Seen[],
  handlers: Partial<Record<(typeof EVENTS)[number], Handler>> = {},
): ExtensionFactory {
  return (pi) => {
    for (const type of EVENTS) {
      (pi.on as (t: string, h: Handler) => void)(type, (event, ctx) => {
        seen.push({ type, keys: Object.keys(event).sort(), event });
        return handlers[type]?.(event, ctx);
      });
    }
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
/** Registers a teardown that runs after the current test. */
export const onCleanup = (c: () => Promise<void>) => void cleanups.push(c);

/** Fresh temp dataDir, fresh fake-llm, booted Pi. Torn down after each test. */
export async function setup(
  turns: FakeTurn[],
  extensions: ExtensionFactory[],
  opts: { bind?: boolean; tools?: string[] } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pa-contract-'));
  const llm = await startFakeLlm(turns);
  const pi = await bootPi({ dataDir, llmUrl: llm.url, extensions, ...opts });
  cleanups.push(async () => {
    pi.session.dispose();
    await llm.close();
  });
  return { llm, dataDir, ...pi };
}

export const keysOf = (seen: Seen[], type: string) => seen.find((s) => s.type === type)?.keys;
export const eventOf = (seen: Seen[], type: string) => seen.find((s) => s.type === type)?.event;

/** Text of the last user message in an OpenAI chat request body. */
export function lastUserText(body: any): string {
  const user = body.messages.filter((m: any) => m.role === 'user').at(-1);
  return typeof user.content === 'string'
    ? user.content
    : user.content.map((c: any) => c.text).join('');
}

/** Content of the tool message in an OpenAI chat request body. */
export const toolMessageContent = (body: any) =>
  body.messages.find((m: any) => m.role === 'tool')?.content;
