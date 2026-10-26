import { z } from 'zod';

const id64 = z.string().max(64);

/** Shared pieces used by both directions. */
export const Annotation = z
  .object({
    start: z.int().min(0),
    end: z.int().min(0),
    entityId: z.int(),
    modelSaw: z.string(),
  })
  .refine((a) => a.end > a.start, 'end must be greater than start');
export type Annotation = z.infer<typeof Annotation>;

export const AttachmentRef = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.int().min(0),
  kind: z.enum(['image', 'document']),
});
export type AttachmentRef = z.infer<typeof AttachmentRef>;

/** Highest first, as OpenRouter lists them (docs/decisions/phase-10-models.md). */
export const ReasoningEffort = z.enum(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

/** An OpenRouter model id: vendor/model, lowercase, no `~alias`, no `:variant`. */
export const ModelId = z
  .string()
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);

export const DataPolicy = z.enum(['zdr', 'open']);
export type DataPolicy = z.infer<typeof DataPolicy>;

export const ModelPolicy = z.object({
  /** 'auto', an OpenRouter id, or null for the agent profile's fixed alias (older and automation chats). */
  modelId: z.union([z.literal('auto'), ModelId]).nullable(),
  /** 'auto' resolves on the server (phase-10 decision 7). */
  reasoning: z.union([z.literal('auto'), ReasoningEffort]),
  dataPolicy: DataPolicy,
});
export type ModelPolicy = z.infer<typeof ModelPolicy>;

/** The part of a policy that the client chooses. `dataPolicy` has its own message. */
export const ModelChoice = z.object({
  modelId: z.union([z.literal('auto'), ModelId]),
  reasoning: z.union([z.literal('auto'), ReasoningEffort]),
});
export type ModelChoice = z.infer<typeof ModelChoice>;

export const CatalogModel = z.object({
  id: ModelId,
  /** OpenRouter name without the "Vendor: " prefix, e.g. "Claude Opus 5.5". */
  name: z.string().max(120),
  zdr: z.boolean(),
  vision: z.boolean(),
  contextLength: z.int().min(0),
  /** USD per 1M tokens. */
  price: z.object({ input: z.number().min(0), output: z.number().min(0) }),
  /** Null when the model exposes no effort selection. */
  reasoning: z
    .object({
      /** Highest first, as OpenRouter lists them. */
      efforts: z.array(ReasoningEffort).min(1),
      /** What 'auto' resolves to (phase-10 decision 7). */
      recommended: ReasoningEffort,
      mandatory: z.boolean(),
    })
    .nullable(),
});
export type CatalogModel = z.infer<typeof CatalogModel>;

export const ChatSummary = z.object({
  id: z.string(),
  title: z.string().nullable(),
  topicId: id64.nullable(),
  agentId: id64,
  pinned: z.boolean(),
  archived: z.boolean(),
  /** True after a manual rename: automatic titling no longer changes the title. */
  titleLocked: z.boolean().optional(),
  modelPolicy: ModelPolicy,
  updatedAt: z.iso.datetime(),
});
export type ChatSummary = z.infer<typeof ChatSummary>;

export const ToolStatus = z.enum(['running', 'ok', 'error', 'denied']);
export type ToolStatus = z.infer<typeof ToolStatus>;
/** A tool status as a Finnish word: tool rows, announcements and the Markdown export. */
export const TOOL_STATUS_WORD: Record<ToolStatus, string> = {
  running: 'käynnissä',
  ok: 'valmis',
  error: 'virhe',
  denied: 'estetty',
};

export const ToolRow = z.object({
  callId: id64,
  name: z.string(),
  status: ToolStatus,
  summary: z.string(),
});
export type ToolRow = z.infer<typeof ToolRow>;

export const Message = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  annotations: z.array(Annotation),
  attachments: z.array(AttachmentRef).max(20),
  tools: z.array(ToolRow),
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof Message>;

export const VaultEntity = z.object({
  id: z.int(),
  kind: z.string(),
  canonical: z.string(),
  surrogate: z.string(),
  mode: z.enum(['realistic', 'placeholder']),
  pinned: z.boolean(),
  allowlisted: z.boolean(),
  seenCount: z.int().min(0),
  lastSeen: z.iso.datetime().nullable(),
});
export type VaultEntity = z.infer<typeof VaultEntity>;

export const VaultPending = z.object({
  id: z.int(),
  kind: z.string(),
  text: z.string(),
  detector: z.string(),
  score: z.number(),
  chatId: id64,
});
export type VaultPending = z.infer<typeof VaultPending>;

export const Artifact = z.object({
  id: z.string(),
  kind: z.enum(['html', 'react', 'code', 'mermaid', 'file']),
  title: z.string(),
  language: z.string().optional(),
  content: z.string(),
  mime: z.string().optional(),
});
export type Artifact = z.infer<typeof Artifact>;

/** A browser `PushSubscription` as JSON (`POST /api/push/subscribe` and `push.subscribe`). */
export const PushSubscription = z.object({
  endpoint: z.url().max(2048),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().max(512), auth: z.string().max(512) }),
});
export type PushSubscription = z.infer<typeof PushSubscription>;

export const ExportFormat = z.enum(['md', 'json']);
export type ExportFormat = z.infer<typeof ExportFormat>;

/** Query of `GET /api/chats/:id/export` (docs/decisions/phase-9-ui.md 7.11). */
export const ExportQuery = z.object({
  format: ExportFormat,
  unmask: z.enum(['0', '1']).default('0'),
});

/**
 * Body of `GET /api/chats/:id/export?format=json`, version 1. `masked`: the texts the model saw
 * (surrogates); else the real values restored from the vault. Times are ISO 8601 UTC.
 */
export const ChatExport = z.object({
  version: z.literal(1),
  masked: z.boolean(),
  chat: z.object({
    id: z.string(),
    /** Null for an untitled chat. */
    title: z.string().nullable(),
    createdAt: z.iso.datetime(),
    agent: z.object({ id: id64, name: z.string() }),
    /** The topic name; null in a masked export (a topic name has no masked form). */
    topic: z.string().nullable(),
  }),
  messages: z.array(
    z.object({
      role: Message.shape.role,
      createdAt: z.iso.datetime(),
      text: z.string(),
      /**
       * Listed, never embedded. In a masked export `name` is the name the model saw: null for an
       * image (it saw none) and for a document whose masked name is not certain.
       */
      attachments: z.array(
        AttachmentRef.omit({ id: true }).extend({ name: z.string().nullable() }),
      ),
      tools: z.array(ToolRow.pick({ name: true, status: true })),
      /** The artifacts in `text`; they also stay in it as fenced code blocks. */
      artifacts: z.array(Artifact.omit({ id: true })),
    }),
  ),
});
export type ChatExport = z.infer<typeof ChatExport>;

/** Client to server messages. `auth.login` is itself a union on `method`. */
const authLogin = z.literal('auth.login');
export const AuthLogin = z.discriminatedUnion('method', [
  z.object({
    type: authLogin,
    method: z.literal('password'),
    password: z.string().min(1).max(1024),
  }),
  z.object({ type: authLogin, method: z.literal('passkey'), assertion: z.unknown() }),
]);
export type AuthLogin = z.infer<typeof AuthLogin>;

export const ClientMessage = z.discriminatedUnion('type', [
  AuthLogin,
  z.object({
    type: z.literal('chat.create'),
    agentId: id64.default('assistant'),
    topicId: id64.optional(),
    /** Unset: Auto with automatic thinking. No `dataPolicy`: a new chat is always `zdr`. */
    model: ModelChoice.optional(),
  }),
  z.object({ type: z.literal('chat.setModel'), chatId: id64, ...ModelChoice.shape }),
  /** `open` only after a recorded ZDR refusal for the chat's model (phase-10 decision 9). */
  z.object({ type: z.literal('chat.setDataPolicy'), chatId: id64, dataPolicy: DataPolicy }),
  z.object({ type: z.literal('models.list') }),
  z.object({ type: z.literal('models.favorite'), modelId: ModelId, favorite: z.boolean() }),
  z.object({ type: z.literal('chat.open'), chatId: id64 }),
  z.object({ type: z.literal('chat.related'), chatId: id64 }),
  z.object({ type: z.literal('chat.list'), archived: z.boolean().optional() }),
  z.object({ type: z.literal('chat.archive'), chatId: id64, archived: z.boolean() }),
  z.object({
    type: z.literal('chat.rename'),
    chatId: id64,
    title: z.string().min(1).max(120),
  }),
  z.object({ type: z.literal('chat.pin'), chatId: id64, pinned: z.boolean() }),
  z.object({ type: z.literal('chat.delete'), chatId: id64 }),
  /** The chat this client shows in the foreground; `null` when hidden. Push skips focused chats. */
  z.object({ type: z.literal('chat.focus'), chatId: id64.nullable() }),
  z.object({
    type: z.literal('user.message'),
    chatId: id64,
    text: z.string().max(100_000),
    attachments: z.array(AttachmentRef).max(20).default([]),
    agentId: id64.optional(),
  }),
  z.object({ type: z.literal('user.stop'), chatId: id64 }),
  z.object({ type: z.literal('approval.respond'), requestId: id64, approve: z.boolean() }),
  z.object({ type: z.literal('vault.list') }),
  z
    .object({
      type: z.literal('vault.merge'),
      fromIds: z.array(z.int()).min(1).max(500),
      intoId: z.int(),
    })
    .refine((m) => !m.fromIds.includes(m.intoId), 'intoId must not be in fromIds'),
  z.object({
    type: z.literal('vault.split'),
    entityId: z.int(),
    spanIds: z.array(z.int()).max(500),
  }),
  z.object({ type: z.literal('vault.pin'), entityId: z.int(), pinned: z.boolean() }),
  z.object({ type: z.literal('vault.allowlist'), entityId: z.int(), allowlisted: z.boolean() }),
  z.object({ type: z.literal('vault.regenerate'), entityId: z.int() }),
  z.object({ type: z.literal('vault.neverDetect'), entityId: z.int() }),
  z.object({
    type: z.literal('vault.setMode'),
    entityId: z.int(),
    mode: z.enum(['realistic', 'placeholder']),
  }),
  z.object({
    type: z.literal('vault.pending.resolve'),
    pendingId: z.int(),
    action: z.enum(['confirm', 'dismiss', 'allowlist']),
  }),
  z.object({ type: z.literal('memory.list') }),
  z.object({
    type: z.literal('memory.edit'),
    target: z.enum(['user', 'memory']),
    text: z.string().max(2500),
  }),
  z.object({ type: z.literal('memory.approve'), pendingId: z.int(), approve: z.boolean() }),
  z.object({ type: z.literal('memory.consolidate') }),
  /** Accepts (optionally with the user's edited texts) or rejects a consolidation proposal. */
  z.object({
    type: z.literal('memory.consolidation.resolve'),
    id: z.int(),
    accept: z.boolean(),
    user: z.string().max(1500).optional(),
    memory: z.string().max(2500).optional(),
  }),
  z.object({ type: z.literal('topic.list') }),
  z.object({ type: z.literal('automations.list') }),
  z.object({ type: z.literal('automations.run'), id: id64 }),
  z.object({
    type: z.literal('topic.accept'),
    proposalId: z.int(),
    name: z.string().max(80).optional(),
    mergeIntoTopicId: id64.optional(),
  }),
  z.object({ type: z.literal('topic.reject'), proposalId: z.int() }),
  z.object({
    type: z.literal('search.query'),
    q: z.string().min(1).max(500),
    limit: z.int().min(1).max(50).default(20),
  }),
  z.object({ type: z.literal('push.subscribe'), subscription: PushSubscription }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export type ClientMessageInput = z.input<typeof ClientMessage>;

/** Server to client messages. */
export const ServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('auth.state'),
    authenticated: z.boolean(),
    userId: z.string().optional(),
  }),
  z.object({
    type: z.literal('integrations.state'),
    google: z.object({ connected: z.boolean() }),
  }),
  z.object({
    type: z.literal('agents.state'),
    agents: z.array(
      z.object({ id: id64, name: z.string(), model: z.string(), subagents: z.boolean() }),
    ),
  }),
  /** Answer to `models.list`; also sent to every socket after `models.favorite`. */
  z.object({
    type: z.literal('models.state'),
    /** What 'auto' routes to, e.g. 'google/gemini-4-argon'. */
    auto: ModelId,
    /** In `createdAt` order. */
    favorites: z.array(ModelId),
    catalog: z.array(CatalogModel),
    /** Null: no catalog yet. */
    fetchedAt: z.iso.datetime().nullable(),
  }),
  z.object({
    type: z.literal('chat.state'),
    chat: ChatSummary,
    messages: z.array(Message),
    artifacts: z.array(Artifact).optional(),
  }),
  z.object({ type: z.literal('chat.list'), chats: z.array(ChatSummary) }),
  z.object({ type: z.literal('chat.created'), chat: ChatSummary }),
  z.object({
    type: z.literal('chat.titled'),
    chatId: id64,
    title: z.string(),
    topicId: id64.nullable(),
  }),
  z.object({ type: z.literal('chat.updated'), chat: ChatSummary }),
  z.object({ type: z.literal('chat.deleted'), chatId: id64 }),
  z.object({
    type: z.literal('chat.related'),
    chatId: id64,
    related: z.array(z.object({ chatId: id64, title: z.string(), score: z.number() })),
  }),
  z.object({
    type: z.literal('message.delta'),
    chatId: id64,
    messageId: id64,
    text: z.string(),
    annotations: z.array(Annotation),
  }),
  z.object({ type: z.literal('message.final'), chatId: id64, message: Message }),
  z.object({
    type: z.literal('tool.start'),
    chatId: id64,
    callId: id64,
    name: z.string(),
    argsPreview: z.string(),
  }),
  z.object({
    type: z.literal('tool.update'),
    chatId: id64,
    callId: id64,
    output: z.string(),
  }),
  z.object({
    type: z.literal('tool.end'),
    chatId: id64,
    callId: id64,
    status: ToolStatus,
    summary: z.string(),
  }),
  z.object({
    type: z.literal('subagent.state'),
    chatId: id64,
    children: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        status: z.enum(['queued', 'running', 'done', 'error']),
      }),
    ),
  }),
  z.object({
    type: z.literal('approval.request'),
    chatId: id64,
    requestId: id64,
    /** The gated tool call; lets the client mark its tool row as waiting. */
    callId: id64.optional(),
    tool: z.string(),
    args: z.unknown(),
    reason: z.string(),
    expiresAt: z.iso.datetime(),
  }),
  /** A pending `approval.request` ended: answered (by any client), expired, or aborted. */
  z.object({
    type: z.literal('approval.resolved'),
    chatId: id64,
    requestId: id64,
    outcome: z.enum(['approved', 'denied', 'expired']),
  }),
  z.object({
    type: z.literal('artifact.upsert'),
    chatId: id64,
    artifact: Artifact,
  }),
  z.object({
    type: z.literal('agent.status'),
    chatId: id64,
    state: z.enum(['idle', 'running']),
  }),
  z.object({
    type: z.literal('vault.state'),
    entities: z.array(VaultEntity),
    pending: z.array(VaultPending),
  }),
  z.object({
    type: z.literal('memory.state'),
    user: z.string(),
    memory: z.string(),
    pending: z.array(
      z.object({
        id: z.int(),
        action: z.enum(['add', 'replace', 'remove']),
        target: z.enum(['user', 'memory']),
        text: z.string(),
        /** The old text: `replace`'s target, or the text `remove` deletes. */
        replace: z.string().optional(),
        chatId: id64,
      }),
    ),
    consolidation: z.object({ id: z.int(), diff: z.string() }).nullable(),
  }),
  z.object({
    type: z.literal('automations.state'),
    automations: z.array(
      z.object({
        id: z.string(),
        cron: z.string(),
        agentId: z.string(),
        enabled: z.boolean(),
        lastRunAt: z.string().nullable(),
        lastStatus: z.string().nullable(),
        lastChatId: z.string().nullable(),
        deliver: z.enum(['chat', 'push', 'both']).optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal('topic.state'),
    topics: z.array(
      z.object({
        id: id64,
        name: z.string(),
        description: z.string(),
        count: z.int().min(0),
      }),
    ),
    proposals: z.array(z.object({ id: z.int(), name: z.string(), why: z.string(), chatId: id64 })),
  }),
  z.object({
    type: z.literal('search.results'),
    q: z.string(),
    results: z.array(
      z.object({
        chatId: id64,
        messageId: id64.nullable(),
        title: z.string(),
        snippet: z.string(),
        score: z.number(),
      }),
    ),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    chatId: id64.optional(),
    requestId: id64.optional(),
  }),
  z.object({ type: z.literal('pong') }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
