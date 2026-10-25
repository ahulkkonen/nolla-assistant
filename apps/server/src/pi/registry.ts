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
import { type PseudoClient, type PseudoLog, pseudoExtension } from '@pa/pi-ext-pseudo';
import { type Child, subagentsExtension } from '@pa/pi-ext-subagents';
import { topicsExtension } from '@pa/pi-ext-topics';
import type { Agents } from '../agents.ts';
import { type Ask, approvalGate } from '../approval.ts';
import { pathGuard } from './guard.ts';

type RegistryOptions = {
  dataDir: string;
  userId: string;
  /** Current agent profiles; read at every session build. */
  agents: () => Agents;
  /** The chat's `agentId` (DB row) for `get`. */
  getAgentId: (chatId: string) => string | undefined;
  approval: { ask: Ask; timeoutMs?: number };
  skillsDir: string;
  extensionFactories?: InlineExtension[];
  /** Called at every `agent_settled` through `pi-ext-topics`; `sessionId` is the chat id. */
  onSettled?: Parameters<typeof topicsExtension>[0]['onSettled'];
  /** Loads `pi-ext-pseudo` per chat when set; `log` receives its logs with the chat id. */
  pseudo?: { client: PseudoClient; log: (chatId: string, ...args: Parameters<PseudoLog>) => void };
  /** Loads `pi-ext-subagents` for profiles with `subagents: true`. */
  subagents?: {
    litellm: { url: string; key: string };
    pseudoUrl?: string | undefined;
    onState: (chatId: string, children: Pick<Child, 'id' | 'label' | 'status'>[]) => void;
    log: (chatId: string, ...args: Parameters<PseudoLog>) => void;
  };
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

  create(chatId: string, agentId: string): Promise<AgentSession> {
    return this.track(chatId, agentId, () =>
      SessionManager.create(this.cwd, this.sessionDir, { id: chatId }),
    );
  }

  /** Opens the chat's session. Pi writes the JSONL only after the first message, so a missing file means an empty chat. */
  get(chatId: string): Promise<AgentSession> {
    return this.track(chatId, this.opts.getAgentId(chatId) ?? 'assistant', () => {
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

  private track(
    chatId: string,
    agentId: string,
    manager: () => SessionManager,
  ): Promise<AgentSession> {
    const existing = this.entries.get(chatId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.session;
    }
    const session = this.build(chatId, agentId, manager);
    this.entries.set(chatId, { session, lastUsed: Date.now() });
    session.catch(() => {
      if (this.entries.get(chatId)?.session === session) this.entries.delete(chatId);
    });
    return session;
  }

  private async build(
    chatId: string,
    agentId: string,
    manager: () => SessionManager,
  ): Promise<AgentSession> {
    const profile = this.opts.agents().get(agentId);
    if (!profile) throw new Error(`Agent profile ${agentId} not found`);
    const sessionManager = manager();
    const { pseudo, subagents } = this.opts;
    const withSubagents = profile.subagents && subagents;
    const modelRuntime = await this.modelRuntime();
    const model = modelRuntime.getModel('zdr', profile.model);
    if (!model)
      throw new Error(`Model ${profile.model} of agent ${agentId} not found in models.json`);
    const skills = new Set(profile.skills);
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      systemPrompt: profile.prompt,
      noContextFiles: true,
      noExtensions: true,
      noSkills: skills.size === 0,
      ...(skills.size > 0
        ? {
            additionalSkillPaths: [this.opts.skillsDir],
            skillsOverride: (base) => ({
              ...base,
              skills: base.skills.filter((s) => skills.has(s.name)),
            }),
          }
        : {}),
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        // Pseudo first: the guard must check the restored (real) path.
        ...(pseudo
          ? [
              pseudoExtension({
                client: pseudo.client,
                sessionId: chatId,
                log: (...args) => pseudo.log(chatId, ...args),
              }),
            ]
          : []),
        // After pseudo (the user approves real values), before the guard.
        approvalGate({ chatId, policy: profile.approval, ...this.opts.approval }),
        ...(withSubagents
          ? [
              subagentsExtension({
                chatId,
                userId: this.opts.userId,
                dataDir: this.opts.dataDir,
                agentDir: this.agentDir,
                cwd: this.cwd,
                litellm: withSubagents.litellm,
                pseudoUrl: withSubagents.pseudoUrl,
                model: profile.model,
                tools: profile.tools.allow,
                approvalAlways: profile.approval.always.filter(
                  (t) => !profile.approval.never.includes(t),
                ),
                onState: (children) => withSubagents.onState(chatId, children),
                ask: this.opts.approval.ask,
                log: (...args) => withSubagents.log(chatId, ...args),
              }),
            ]
          : []),
        pathGuard(this.cwd),
        ...(this.opts.onSettled ? [topicsExtension({ onSettled: this.opts.onSettled })] : []),
        ...(this.opts.extensionFactories ?? []),
      ],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir: this.agentDir,
      modelRuntime,
      model,
      sessionManager,
      resourceLoader,
      tools: withSubagents ? [...profile.tools.allow, 'subagent'] : profile.tools.allow,
    });
    await session.bindExtensions({});
    return session;
  }
}
