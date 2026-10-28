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
import {
  type Collision,
  type PseudoClient,
  type PseudoLog,
  pseudoExtension,
} from '@pa/pi-ext-pseudo';
import { sandboxExtension } from '@pa/pi-ext-sandbox';
import { type Child, subagentsExtension } from '@pa/pi-ext-subagents';
import { topicsExtension } from '@pa/pi-ext-topics';
import { DEFAULT_AGENT_ID, WEB_SEARCH_TOOL } from '@pa/protocol';
import { type AgentProfile, type Agents, liveAgentId } from '../agents.ts';
import { type Ask, approvalGate } from '../approval.ts';
import type { ClaimStore } from '../claims.ts';
import {
  allowedToolNames,
  type McpServers,
  mcpExtension,
  mcpToolCheck,
  writeTools,
} from '../mcp.ts';
import type { MemoryStore } from '../memory.ts';
import { type Searcher, webSearchExtensions } from '../search-tool.ts';
import { messageUsage, type RecordUsage, usageExtension } from '../usage.ts';
import { pathGuard, type WorkHooks } from './guard.ts';
import { type Catalog, piModelId, policyOf, resolveModelId, thinkingLevel } from './models.ts';

/**
 * The tool names a profile can allow: Pi's built-ins that a session gets (`bash` only with the
 * broker; never `powershell`) and the extension tools below. `subagent` is the profile flag.
 */
export const PROFILE_TOOLS = [
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'find',
  'ls',
  'recall',
  'memory',
  WEB_SEARCH_TOOL,
];

/** The chat row fields a session build reads: agent, model policy (phase-10), confidence trial. */
export type ChatModel = {
  agentId: string;
  modelId: string | null;
  reasoning: string;
  dataPolicy: string;
  confidence: boolean;
};

/** Phase-21 decision 4: the prompt paragraph of a chat with `confidence` on. */
export const CONFIDENCE_PROMPT =
  'Luottamusmerkinnät: kirjoita jokaisen proosavirkkeen perään merkintä ⟦N⟧, jossa N on luku 1–9 sen mukaan, kuinka varma olet virkkeen sisällöstä: 1 on arvaus ja 9 on varma. Kirjoita merkintä heti virkkeen päättävän välimerkin perään, esimerkiksi: Helsinki on Suomen pääkaupunki.⟦9⟧ Älä koskaan kirjoita merkintää koodilohkoon, taulukkoon, otsikkoon tai luettelomerkin (`-`, `1.`) perään. Muuten vastaa täsmälleen niin kuin ilman merkintöjä.';

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
  /** Each model call of a chat and of its subagent children (phase-13 decision 11). */
  onUsage?: RecordUsage;
  /** Runs `web_search` for profiles that allow it (phase-14); unset: no such tool. */
  search?: Searcher;
  /** Loads `pi-ext-pseudo` per chat when set; `log` receives its logs with the chat id. */
  pseudo?: {
    client: PseudoClient;
    log: (chatId: string, ...args: Parameters<PseudoLog>) => void;
    /** Holds user input that names an issued surrogate until the user answers (phase 12). */
    awaitCollision?: (chatId: string, collisions: Collision[]) => Promise<boolean>;
  };
  /** Loads `pi-ext-memory` when `pseudo` is set; `onChange` runs after each write or parked write. */
  memory?: {
    store: MemoryStore;
    /** Phase 17: the per-turn claims block and the claims part of `recall`. */
    claims?: Pick<ClaimStore, 'relevant' | 'recallLines'>;
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
  /** The profile object the session was built with; a reload replaces only changed ones. */
  profile: AgentProfile | undefined;
  /** The session, once the build resolved. */
  ready?: AgentSession;
};

const samePolicy = (a: ChatModel, b: ChatModel) =>
  a.agentId === b.agentId &&
  a.modelId === b.modelId &&
  a.reasoning === b.reasoning &&
  a.dataPolicy === b.dataPolicy &&
  a.confidence === b.confidence;

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
        agentId: DEFAULT_AGENT_ID,
        modelId: null,
        reasoning: 'auto',
        dataPolicy: 'zdr',
        confidence: false,
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
      // A policy or profile change during the build (or an eviction) means a stale session:
      // rebuild it, so an `open` session never outlives "Palauta ZDR" and a saved profile reaches
      // the chat (phase-15 decision 4). A running one stays until it settles.
      const built = this.entries.get(chatId);
      if (built && this.fresh(built, now)) return session;
      if (built && !(await this.evict(chatId))) return session;
    }
  }

  has(chatId: string): boolean {
    return this.entries.has(chatId);
  }

  /** The policy the chat's open session was built with; the row can be newer (phase 20). */
  builtWith(chatId: string): ChatModel | undefined {
    return this.entries.get(chatId)?.chat;
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
      if (now && this.fresh(e, now)) return true;
      if (this.running(chatId)) return false;
      this.entries.delete(chatId);
      e.unsubscribe?.();
      e.ready?.dispose();
      return true;
    }
  }

  /** Built with the stored policy and the current profile object of its agent. */
  private fresh(e: Entry, now: ChatModel): boolean {
    return samePolicy(e.chat, now) && e.profile === this.profileOf(now.agentId);
  }

  /** The chat's profile; a deleted agent's chat runs with the default agent (phase-16 decision 3). */
  private profileOf(agentId: string): AgentProfile | undefined {
    const agents = this.opts.agents();
    return agents.get(liveAgentId(agents, agentId));
  }

  private mcpOf(profile: AgentProfile) {
    return [...new Set(profile.tools.mcp)].flatMap((n) => this.opts.mcp?.get(n) ?? []);
  }

  /**
   * The tools "Hyväksy automaattisesti" lets run in a chat of this agent (phase-21 decision 7):
   * `approval.always` minus MCP writes and `web_search`, which still ask.
   */
  autoApproveTools(agentId: string): string[] {
    const profile = this.profileOf(agentId);
    if (!profile) return [];
    const writes = this.mcpOf(profile).flatMap(writeTools);
    return profile.approval.always.filter((t) => t !== WEB_SEARCH_TOOL && !writes.includes(t));
  }

  /**
   * The chat's session entries without building a session (the export, phase-15 decision 15): the
   * open session's manager, else the JSONL file opened once, else an empty manager.
   */
  reader(chatId: string): Pick<AgentSession, 'sessionManager'> {
    const ready = this.entries.get(chatId)?.ready;
    if (ready) return ready;
    const path = SessionManager.findById(this.cwd, chatId, this.sessionDir);
    return {
      sessionManager: path
        ? SessionManager.open(path, this.sessionDir)
        : SessionManager.inMemory(this.cwd),
    };
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
    // `build` reads the same profile before its first await.
    const profile = this.profileOf(chat.agentId);
    const session = this.build(chatId, chat, manager);
    const entry: Entry = { session, lastUsed: Date.now(), chat, profile };
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
    const profile = this.profileOf(chat.agentId);
    if (!profile) throw new Error(`Agent profile ${chat.agentId} not found`);
    const agentId = profile.id;
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
    const mcp = this.mcpOf(profile);
    const mcpTools = mcp.flatMap(allowedToolNames);
    // MCP writes always ask (decision 0005); `never` cannot remove them.
    const mcpWrites = mcp.flatMap(writeTools);
    const policy = {
      always: [...profile.approval.always, ...mcpWrites],
      never: profile.approval.never.filter((t) => !mcpWrites.includes(t)),
    };
    const { search } = this.opts;
    // A search the guard approved skips the gate (a profile may list web_search in `always`).
    const searchApproved = new Set<string>();
    const [searchTool, searchGuard] =
      search && tools.includes(WEB_SEARCH_TOOL)
        ? webSearchExtensions({
            chatId,
            agentId,
            search,
            ask: this.opts.approval.ask,
            timeoutMs: this.opts.approval.timeoutMs,
            approved: searchApproved,
          })
        : [];
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      systemPrompt: chat.confidence ? `${profile.prompt}\n\n${CONFIDENCE_PROMPT}` : profile.prompt,
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
        // Before pseudo: records the search query as the model wrote it (phase-14 decision 7).
        ...(searchTool ? [searchTool] : []),
        // Pseudo first: the guard must check the restored (real) path.
        ...(pseudo
          ? [
              pseudoExtension({
                client: pseudo.client,
                sessionId: chatId,
                log: (...args) => pseudo.log(chatId, ...args),
                ...(pseudo.awaitCollision
                  ? {
                      awaitCollision: (c: Collision[]) =>
                        pseudo.awaitCollision?.(chatId, c) ?? Promise.resolve(false),
                    }
                  : {}),
              }),
            ]
          : []),
        // After pseudo: a restored query that differs names a vault entity and asks.
        ...(searchGuard ? [searchGuard] : []),
        // After pseudo (the user approves real values), before the guard.
        approvalGate({
          chatId,
          policy,
          ask: this.opts.approval.ask,
          timeoutMs: this.opts.approval.timeoutMs,
          approved: searchApproved,
          autoTools: this.autoApproveTools(agentId),
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
                // Children never touch memory and never search (the entity guard lives here).
                tools: tools.filter(
                  (t) => t !== 'memory' && t !== 'recall' && t !== WEB_SEARCH_TOOL,
                ),
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
                onUsage: (m) =>
                  this.opts.onUsage?.({ kind: 'subagent', chatId, agentId }, messageUsage(m)),
              }),
            ]
          : []),
        pathGuard(this.cwd, chatId, this.opts.work),
        // LiteLLM's cost and the thinking time into each assistant message (phase-13).
        usageExtension({ kind: 'chat', chatId, agentId }, this.opts.onUsage),
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
                  const id = await memory.store.park(chatId, w);
                  memory.onChange(chatId);
                  return id;
                },
                applyNow: async (w) => {
                  await memory.store.applyWrite(w, chatId);
                  memory.onChange(chatId);
                },
                onTaint: () => memory.store.markTainted(chatId),
                ...(memory.claims
                  ? {
                      relevant: memory.claims.relevant,
                      recallClaims: memory.claims.recallLines,
                    }
                  : {}),
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
