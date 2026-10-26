import { mkdirSync, rmSync } from 'node:fs';
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
import { type MemoryLog, memoryExtension } from '@pa/pi-ext-memory';
import { type PseudoClient, type PseudoLog, pseudoExtension } from '@pa/pi-ext-pseudo';
import { sandboxExtension } from '@pa/pi-ext-sandbox';
import { type Child, subagentsExtension } from '@pa/pi-ext-subagents';
import { topicsExtension } from '@pa/pi-ext-topics';
import type { Agents } from '../agents.ts';
import { type Ask, approvalGate } from '../approval.ts';
import {
  allowedToolNames,
  type McpServers,
  mcpExtension,
  mcpToolCheck,
  writeTools,
} from '../mcp.ts';
import type { MemoryStore } from '../memory.ts';
import { pathGuard, type WorkHooks } from './guard.ts';
import { type Catalog, piModelId, policyOf, resolveModelId, thinkingLevel } from './models.ts';

/** The chat row fields a session build reads: its agent and its model policy (phase-10). */
export type ChatModel = {
  agentId: string;
  modelId: string | null;
  reasoning: string;
  dataPolicy: string;
};

type RegistryOptions = {
  dataDir: string;
  userId: string;
  /** Current agent profiles; read at every session build. */
  agents: () => Agents;
  /** The chat's agent and model policy (DB row) for `get`; undefined when the row is gone. */
  getChat: (chatId: string) => ChatModel | undefined;
  /** Model catalog: thinking level of catalog models (phase-10 decision 7). */
  catalog: Pick<Catalog, 'get'>;
  approval: { ask: Ask; timeoutMs?: number };
  skillsDir: string;
  /** Work-dir size check and file origins (phase-11); unset: per-file limit only, no origins. */
  work?: WorkHooks;
  /** `sandbox-broker`; unset means no `bash` tool at all. */
  broker?: { url: string; token: string } | undefined;
  extensionFactories?: InlineExtension[];
  /** `infra/mcp.yaml`; a profile reaches the servers named in `tools.mcp`. */
  mcp?: McpServers;
  /** Warns about allowlisted MCP tools the session did not get. */
  mcpWarn?: (chatId: string, missing: string[]) => void;
  /** Called at every `agent_settled` through `pi-ext-topics`; `sessionId` is the chat id. */
  onSettled?: Parameters<typeof topicsExtension>[0]['onSettled'];
  /** Loads `pi-ext-pseudo` per chat when set; `log` receives its logs with the chat id. */
  pseudo?: { client: PseudoClient; log: (chatId: string, ...args: Parameters<PseudoLog>) => void };
  /** Loads `pi-ext-memory` when `pseudo` is set; `onChange` runs after each write or parked write. */
  memory?: {
    store: MemoryStore;
    onChange: (chatId: string) => void;
    log: (chatId: string, ...args: Parameters<MemoryLog>) => void;
  };
  /** Loads `pi-ext-subagents` for profiles with `subagents: true`. */
  subagents?: {
    litellm: { url: string; key: string };
    pseudoUrl?: string | undefined;
    onState: (chatId: string, children: Pick<Child, 'id' | 'label' | 'status'>[]) => void;
    log: (chatId: string, ...args: Parameters<PseudoLog>) => void;
  };
};
type Entry = {
  session: Promise<AgentSession>;
  lastUsed: number;
  unsubscribe?: () => void;
  /** The policy the session was built with. */
  chat: ChatModel;
  /** The session, once the build resolved. */
  ready?: AgentSession;
};

const samePolicy = (a: ChatModel, b: ChatModel) =>
  a.modelId === b.modelId && a.reasoning === b.reasoning && a.dataPolicy === b.dataPolicy;

async function stop(e: Entry) {
  e.unsubscribe?.();
  const s = await e.session;
  try {
    await s.abort();
  } finally {
    s.dispose();
  }
}

/** `get` on a chat whose row is gone (deleted while the session was loading). */
export class ChatNotFound extends Error {}

export class SessionRegistry {
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly cwd: string;
  private readonly entries = new Map<string, Entry>();
  /** chatId → prompts in flight (see `hold`). */
  private readonly prompting = new Map<string, number>();
  /** Chats with a queued or running subagent child (its result lands in the parent's branch). */
  private readonly children = new Set<string>();
  private runtime: Promise<ModelRuntime> | undefined;
  private readonly opts: RegistryOptions;

  constructor(opts: RegistryOptions) {
    this.opts = opts;
    this.agentDir = resolve(opts.dataDir, 'pi', opts.userId);
    this.sessionDir = resolve(opts.dataDir, 'sessions', opts.userId);
    this.cwd = resolve(opts.dataDir, 'work', opts.userId);
    for (const d of [this.agentDir, this.sessionDir, this.cwd]) mkdirSync(d, { recursive: true });
  }

  /** `chat` is passed in: `chat.create` builds the session before it inserts the row. */
  create(chatId: string, chat: ChatModel): Promise<AgentSession> {
    return this.track(chatId, chat, () =>
      SessionManager.create(this.cwd, this.sessionDir, { id: chatId }),
    );
  }

  /** Opens the chat's session. Pi writes the JSONL only after the first message, so a missing file means an empty chat. */
  async get(chatId: string): Promise<AgentSession> {
    for (;;) {
      const chat = this.opts.getChat(chatId) ?? {
        agentId: 'assistant',
        modelId: null,
        reasoning: 'auto',
        dataPolicy: 'zdr',
      };
      const session = await this.track(chatId, chat, () => {
        const path = SessionManager.findById(this.cwd, chatId, this.sessionDir);
        return path
          ? SessionManager.open(path, this.sessionDir)
          : SessionManager.create(this.cwd, this.sessionDir, { id: chatId });
      });
      // `chat.delete` may have run while the session loaded.
      const now = this.opts.getChat(chatId);
      if (now === undefined) {
        await this.remove(chatId);
        throw new ChatNotFound();
      }
      // A policy change during the build (or an eviction) means a stale session: rebuild it, so
      // an `open` session never outlives "Palauta ZDR". A running one stays until it settles.
      const built = this.entries.get(chatId)?.chat;
      if (built && samePolicy(built, now)) return session;
      if (built && !(await this.evict(chatId))) return session;
    }
  }

  has(chatId: string): boolean {
    return this.entries.has(chatId);
  }

  /**
   * Marks `run` (the chat's `session.prompt`) as active from the call on: Pi's `isIdle` turns
   * false only when the run starts, after the input hooks (masking) ran.
   */
  hold(chatId: string, run: Promise<unknown>): void {
    this.prompting.set(chatId, (this.prompting.get(chatId) ?? 0) + 1);
    const done = () => {
      const n = (this.prompting.get(chatId) ?? 1) - 1;
      if (n > 0) this.prompting.set(chatId, n);
      else this.prompting.delete(chatId);
    };
    run.then(done, done);
  }

  /**
   * Synchronous, so a check and a row write cannot be split: a held prompt, a built session that
   * is not idle (a run, Pi's retry delay, compaction), or a subagent child that has not ended.
   */
  running(chatId: string): boolean {
    const ready = this.entries.get(chatId)?.ready;
    return (
      this.prompting.has(chatId) ||
      this.children.has(chatId) ||
      (ready !== undefined && !ready.isIdle)
    );
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
      if (this.entries.get(chatId) !== e || this.running(chatId)) continue;
      this.entries.delete(chatId);
      e.unsubscribe?.();
      session?.dispose();
    }
  }

  /**
   * Drops the chat's session when it was built with another policy than the stored one, so the
   * next `get` rebuilds it (phase-10 decision 14). A session with the stored policy stays: it may
   * be about to take a prompt. The JSONL stays. False while the stale session runs.
   */
  async evict(chatId: string): Promise<boolean> {
    for (;;) {
      const e = this.entries.get(chatId);
      if (!e) return true;
      await e.session.catch(() => undefined);
      // Replaced or removed while loading: look again.
      if (this.entries.get(chatId) !== e) continue;
      const now = this.opts.getChat(chatId);
      if (now && samePolicy(e.chat, now)) return true;
      if (this.running(chatId)) return false;
      this.entries.delete(chatId);
      e.unsubscribe?.();
      e.ready?.dispose();
      return true;
    }
  }

  /** After a catalog change: new sessions and children read the new `models.json`; open ones keep their model. */
  resetModels(): void {
    this.runtime = undefined;
  }

  async dispose(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(all.map(stop));
  }

  /** Stops and drops the chat's session; the JSONL stays. */
  async drop(chatId: string): Promise<void> {
    const e = this.entries.get(chatId);
    this.entries.delete(chatId);
    this.children.delete(chatId);
    if (e) await stop(e).catch(() => {});
  }

  /** Stops and drops the chat's session, then deletes its JSONL file. */
  async remove(chatId: string): Promise<void> {
    await this.drop(chatId);
    const path = SessionManager.findById(this.cwd, chatId, this.sessionDir);
    if (path) rmSync(path, { force: true });
  }

  /** Shared model runtime. Pi cannot create one without built-in providers, so the test asserts only `zdr` and `open` resolve credentials (invariant 2 guard). */
  modelRuntime(): Promise<ModelRuntime> {
    this.runtime ??= ModelRuntime.create({
      authPath: resolve(this.agentDir, 'auth.json'),
      modelsPath: resolve(this.agentDir, 'models.json'),
    });
    return this.runtime;
  }

  private track(
    chatId: string,
    chat: ChatModel,
    manager: () => SessionManager,
  ): Promise<AgentSession> {
    const existing = this.entries.get(chatId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.session;
    }
    const session = this.build(chatId, chat, manager);
    const entry: Entry = { session, lastUsed: Date.now(), chat };
    this.entries.set(chatId, entry);
    session.then(
      (s) => {
        entry.ready = s;
      },
      () => {
        if (this.entries.get(chatId) === entry) this.entries.delete(chatId);
      },
    );
    return session;
  }

  private async build(
    chatId: string,
    chat: ChatModel,
    manager: () => SessionManager,
  ): Promise<AgentSession> {
    const { agentId } = chat;
    const profile = this.opts.agents().get(agentId);
    if (!profile) throw new Error(`Agent profile ${agentId} not found`);
    const sessionManager = manager();
    const { pseudo, subagents, memory } = this.opts;
    const withSubagents = profile.subagents && subagents;
    const modelRuntime = await this.modelRuntime();
    const modelPolicy = policyOf(chat);
    // The only prefix choice (phase-10 "What pa-server sends"); children follow it.
    const { provider, id: modelId } = piModelId(modelPolicy, profile);
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Model ${modelId} of chat ${chatId} not found in models.json`);
    const thinking = thinkingLevel(
      modelPolicy,
      modelPolicy.modelId === null
        ? undefined
        : this.opts.catalog.get(resolveModelId(modelPolicy.modelId)),
    );
    const { broker } = this.opts;
    // Pi's built-in `bash` is never enabled (invariant 8): `bash` stays only with the broker tool.
    const tools = profile.tools.allow.filter((t) => t !== 'bash' || broker);
    const skills = new Set(profile.skills);
    const mcp = [...new Set(profile.tools.mcp)].flatMap((n) => this.opts.mcp?.get(n) ?? []);
    const mcpTools = mcp.flatMap(allowedToolNames);
    // MCP writes always ask (decision 0005); `never` cannot remove them.
    const mcpWrites = mcp.flatMap(writeTools);
    const policy = {
      always: [...profile.approval.always, ...mcpWrites],
      never: profile.approval.never.filter((t) => !mcpWrites.includes(t)),
    };
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
        approvalGate({
          chatId,
          policy,
          ask: this.opts.approval.ask,
          timeoutMs: this.opts.approval.timeoutMs,
        }),
        ...(broker && tools.includes('bash')
          ? [
              sandboxExtension({
                brokerUrl: broker.url,
                token: broker.token,
                userId: this.opts.userId,
                chatId,
              }),
            ]
          : []),
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
                provider,
                model: modelId,
                // Children never touch memory.
                tools: tools.filter((t) => t !== 'memory' && t !== 'recall'),
                broker,
                approvalAlways: profile.approval.always.filter(
                  (t) => !profile.approval.never.includes(t),
                ),
                onState: (children) => {
                  if (children.some((c) => c.status === 'queued' || c.status === 'running'))
                    this.children.add(chatId);
                  else this.children.delete(chatId);
                  withSubagents.onState(chatId, children);
                },
                ask: this.opts.approval.ask,
                log: (...args) => withSubagents.log(chatId, ...args),
              }),
            ]
          : []),
        pathGuard(this.cwd, chatId, this.opts.work),
        // Fail closed: without the sidecar nothing could be masked (invariant 1).
        ...(memory && pseudo
          ? [
              memoryExtension({
                userId: this.opts.userId,
                chatId,
                files: { read: async (t) => memory.store.read(t) },
                mask: async (t) => (await pseudo.client.mask(chatId, t)).masked,
                recentTitles: async () => memory.store.recentTitles(chatId),
                recall: (q, o) => memory.store.recall(q, o),
                park: async (w) => {
                  const id = memory.store.park(chatId, w);
                  memory.onChange(chatId);
                  return id;
                },
                applyNow: async (w) => {
                  memory.store.applyWrite(w, chatId);
                  memory.onChange(chatId);
                },
                log: (...args) => memory.log(chatId, ...args),
              }),
            ]
          : []),
        ...(this.opts.onSettled ? [topicsExtension({ onSettled: this.opts.onSettled })] : []),
        // Only adds tools; the pseudo and approval handlers above see MCP calls too.
        ...(mcp.length
          ? [
              mcpExtension(mcp, resolve(this.agentDir, 'mcp.log')),
              mcpToolCheck(mcpTools, (missing) => this.opts.mcpWarn?.(chatId, missing)),
            ]
          : []),
        ...(this.opts.extensionFactories ?? []),
      ],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir: this.agentDir,
      modelRuntime,
      model,
      ...(thinking ? { thinkingLevel: thinking } : {}),
      sessionManager,
      resourceLoader,
      tools: [...tools, ...(withSubagents ? ['subagent'] : []), ...mcpTools],
    });
    await session.bindExtensions({});
    return session;
  }
}
