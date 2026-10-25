import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type AgentSession,
  type AgentSessionEventListener,
  createAgentSession,
  DefaultResourceLoader,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { pathGuard } from './guard.ts';

type RegistryOptions = {
  dataDir: string;
  userId: string;
  model: string;
  extensionFactories?: InlineExtension[];
};
type Entry = { session: Promise<AgentSession>; lastUsed: number; unsubscribe?: () => void };

export class SessionRegistry {
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly cwd: string;
  private readonly entries = new Map<string, Entry>();
  private runtime: Promise<ModelRuntime> | undefined;
  private readonly opts: RegistryOptions;

  constructor(opts: RegistryOptions) {
    this.opts = opts;
    this.agentDir = resolve(opts.dataDir, 'pi', opts.userId);
    this.sessionDir = resolve(opts.dataDir, 'sessions', opts.userId);
    this.cwd = resolve(opts.dataDir, 'work', opts.userId);
    for (const d of [this.agentDir, this.sessionDir, this.cwd]) mkdirSync(d, { recursive: true });
  }

  create(chatId: string): Promise<AgentSession> {
    return this.track(chatId, () =>
      SessionManager.create(this.cwd, this.sessionDir, { id: chatId }),
    );
  }

  /** Opens the chat's session. Pi writes the JSONL only after the first message, so a missing file means an empty chat. */
  get(chatId: string): Promise<AgentSession> {
    return this.track(chatId, () => {
      const path = SessionManager.findById(this.cwd, chatId, this.sessionDir);
      return path
        ? SessionManager.open(path, this.sessionDir)
        : SessionManager.create(this.cwd, this.sessionDir, { id: chatId });
    });
  }

  has(chatId: string): boolean {
    return this.entries.has(chatId);
  }

  /** Subscribes once per open session; the listener is removed on eviction and dispose. */
  subscribe(chatId: string, session: AgentSession, listener: AgentSessionEventListener): void {
    const e = this.entries.get(chatId);
    if (e && !e.unsubscribe) e.unsubscribe = session.subscribe(listener);
  }

  async evictIdle(maxIdleMs = 30 * 60_000): Promise<void> {
    const cutoff = Date.now() - maxIdleMs;
    for (const [chatId, e] of [...this.entries]) {
      if (e.lastUsed >= cutoff) continue;
      const session = await e.session.catch(() => undefined);
      if (this.entries.get(chatId) !== e || (session && !session.isIdle)) continue;
      this.entries.delete(chatId);
      e.unsubscribe?.();
      session?.dispose();
    }
  }

  async dispose(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(
      all.map(async (e) => {
        e.unsubscribe?.();
        const s = await e.session;
        await s.abort();
        s.dispose();
      }),
    );
  }

  /** Shared model runtime. Pi cannot create one without built-in providers, so the test asserts only `zdr` resolves credentials (invariant 2 guard). */
  modelRuntime(): Promise<ModelRuntime> {
    this.runtime ??= ModelRuntime.create({
      authPath: resolve(this.agentDir, 'auth.json'),
      modelsPath: resolve(this.agentDir, 'models.json'),
    });
    return this.runtime;
  }

  private track(chatId: string, manager: () => SessionManager): Promise<AgentSession> {
    const existing = this.entries.get(chatId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.session;
    }
    const session = this.build(manager);
    this.entries.set(chatId, { session, lastUsed: Date.now() });
    session.catch(() => {
      if (this.entries.get(chatId)?.session === session) this.entries.delete(chatId);
    });
    return session;
  }

  private async build(manager: () => SessionManager): Promise<AgentSession> {
    const sessionManager = manager();
    const modelRuntime = await this.modelRuntime();
    const model = modelRuntime.getModel('zdr', this.opts.model);
    if (!model) throw new Error(`Model zdr/${this.opts.model} not found in models.json`);
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      noContextFiles: true,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [pathGuard(this.cwd), ...(this.opts.extensionFactories ?? [])],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir: this.agentDir,
      modelRuntime,
      model,
      sessionManager,
      resourceLoader,
      tools: ['read', 'write', 'edit'],
    });
    await session.bindExtensions({});
    return session;
  }
}
