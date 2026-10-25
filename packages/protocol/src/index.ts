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

export const ChatSummary = z.object({
  id: z.string(),
  title: z.string().nullable(),
  topicId: id64.nullable(),
  agentId: id64,
  pinned: z.boolean(),
  archived: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type ChatSummary = z.infer<typeof ChatSummary>;

export const ToolStatus = z.enum(['running', 'ok', 'error', 'denied']);
export type ToolStatus = z.infer<typeof ToolStatus>;

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
  }),
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
  z.object({
    type: z.literal('push.subscribe'),
    subscription: z.object({
      endpoint: z.url(),
      expirationTime: z.number().nullable().optional(),
      keys: z.object({ p256dh: z.string().max(512), auth: z.string().max(512) }),
    }),
  }),
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
  z.object({ type: z.literal('chat.state'), chat: ChatSummary, messages: z.array(Message) }),
  z.object({ type: z.literal('chat.list'), chats: z.array(ChatSummary) }),
  z.object({ type: z.literal('chat.created'), chat: ChatSummary }),
  z.object({
    type: z.literal('chat.titled'),
    chatId: id64,
    title: z.string(),
    topicId: id64.nullable(),
  }),
  z.object({ type: z.literal('chat.updated'), chat: ChatSummary }),
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
    artifact: z.object({
      id: z.string(),
      kind: z.enum(['html', 'react', 'code', 'mermaid', 'file']),
      title: z.string(),
      language: z.string().optional(),
      content: z.string(),
      mime: z.string().optional(),
    }),
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
