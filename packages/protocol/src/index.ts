import { z } from 'zod';

/** Shared pieces used by both directions. */
export const Annotation = z.object({
  start: z.int().min(0),
  end: z.int().min(0),
  entityId: z.int(),
  modelSaw: z.string(),
});
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
  topicId: z.string().nullable(),
  agentId: z.string(),
  pinned: z.boolean(),
  archived: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type ChatSummary = z.infer<typeof ChatSummary>;

export const ToolStatus = z.enum(['running', 'ok', 'error', 'denied']);
export type ToolStatus = z.infer<typeof ToolStatus>;

export const ToolRow = z.object({
  callId: z.string(),
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
  attachments: z.array(AttachmentRef),
  tools: z.array(ToolRow),
  createdAt: z.string(),
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
  lastSeen: z.string().nullable(),
});
export type VaultEntity = z.infer<typeof VaultEntity>;

export const VaultPending = z.object({
  id: z.int(),
  kind: z.string(),
  text: z.string(),
  detector: z.string(),
  score: z.number(),
  chatId: z.string(),
});
export type VaultPending = z.infer<typeof VaultPending>;

/** Client to server messages. `auth.login` is itself a union on `method`. */
const authLogin = z.literal('auth.login');
export const AuthLogin = z.discriminatedUnion('method', [
  z.object({ type: authLogin, method: z.literal('password'), password: z.string() }),
  z.object({ type: authLogin, method: z.literal('passkey'), assertion: z.unknown() }),
]);
export type AuthLogin = z.infer<typeof AuthLogin>;

export const ClientMessage = z.discriminatedUnion('type', [
  AuthLogin,
  z.object({
    type: z.literal('chat.create'),
    agentId: z.string().default('assistant'),
    topicId: z.string().optional(),
  }),
  z.object({ type: z.literal('chat.open'), chatId: z.string() }),
  z.object({ type: z.literal('chat.list'), archived: z.boolean().optional() }),
  z.object({ type: z.literal('chat.archive'), chatId: z.string(), archived: z.boolean() }),
  z.object({
    type: z.literal('chat.rename'),
    chatId: z.string(),
    title: z.string().min(1).max(120),
  }),
  z.object({ type: z.literal('chat.pin'), chatId: z.string(), pinned: z.boolean() }),
  z.object({
    type: z.literal('user.message'),
    chatId: z.string(),
    text: z.string().max(100_000),
    attachments: z.array(AttachmentRef).default([]),
    agentId: z.string().optional(),
  }),
  z.object({ type: z.literal('user.stop'), chatId: z.string() }),
  z.object({ type: z.literal('approval.respond'), requestId: z.string(), approve: z.boolean() }),
  z.object({ type: z.literal('vault.list') }),
  z.object({ type: z.literal('vault.merge'), fromIds: z.array(z.int()).min(1), intoId: z.int() }),
  z.object({ type: z.literal('vault.split'), entityId: z.int(), spanIds: z.array(z.int()) }),
  z.object({ type: z.literal('vault.pin'), entityId: z.int(), pinned: z.boolean() }),
  z.object({ type: z.literal('vault.allowlist'), entityId: z.int(), allowlisted: z.boolean() }),
  z.object({ type: z.literal('vault.regenerate'), entityId: z.int() }),
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
    text: z.string(),
  }),
  z.object({ type: z.literal('memory.approve'), pendingId: z.int(), approve: z.boolean() }),
  z.object({ type: z.literal('topic.list') }),
  z.object({
    type: z.literal('topic.accept'),
    proposalId: z.int(),
    name: z.string().optional(),
    mergeIntoTopicId: z.string().optional(),
  }),
  z.object({ type: z.literal('topic.reject'), proposalId: z.int() }),
  z.object({
    type: z.literal('search.query'),
    q: z.string().min(1).max(500),
    limit: z.int().min(1).max(50).default(20),
  }),
  z.object({ type: z.literal('push.subscribe'), subscription: z.unknown() }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Server to client messages. */
export const ServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('auth.state'),
    authenticated: z.boolean(),
    userId: z.string().optional(),
  }),
  z.object({ type: z.literal('chat.state'), chat: ChatSummary, messages: z.array(Message) }),
  z.object({ type: z.literal('chat.list'), chats: z.array(ChatSummary) }),
  z.object({ type: z.literal('chat.created'), chat: ChatSummary }),
  z.object({
    type: z.literal('chat.titled'),
    chatId: z.string(),
    title: z.string(),
    topicId: z.string().nullable(),
  }),
  z.object({ type: z.literal('chat.updated'), chat: ChatSummary }),
  z.object({
    type: z.literal('message.delta'),
    chatId: z.string(),
    messageId: z.string(),
    text: z.string(),
    annotations: z.array(Annotation),
  }),
  z.object({ type: z.literal('message.final'), chatId: z.string(), message: Message }),
  z.object({
    type: z.literal('tool.start'),
    chatId: z.string(),
    callId: z.string(),
    name: z.string(),
    argsPreview: z.string(),
  }),
  z.object({
    type: z.literal('tool.update'),
    chatId: z.string(),
    callId: z.string(),
    output: z.string(),
  }),
  z.object({
    type: z.literal('tool.end'),
    chatId: z.string(),
    callId: z.string(),
    status: ToolStatus,
    summary: z.string(),
  }),
  z.object({
    type: z.literal('subagent.state'),
    chatId: z.string(),
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
    chatId: z.string(),
    requestId: z.string(),
    tool: z.string(),
    args: z.unknown(),
    reason: z.string(),
    expiresAt: z.string(),
  }),
  z.object({
    type: z.literal('artifact.upsert'),
    chatId: z.string(),
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
    chatId: z.string(),
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
        chatId: z.string(),
      }),
    ),
    consolidation: z.object({ id: z.int(), diff: z.string() }).nullable(),
  }),
  z.object({
    type: z.literal('topic.state'),
    topics: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        count: z.int().min(0),
      }),
    ),
    proposals: z.array(
      z.object({ id: z.int(), name: z.string(), why: z.string(), chatId: z.string() }),
    ),
  }),
  z.object({
    type: z.literal('search.results'),
    q: z.string(),
    results: z.array(
      z.object({
        chatId: z.string(),
        messageId: z.string().nullable(),
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
    chatId: z.string().optional(),
    requestId: z.string().optional(),
  }),
  z.object({ type: z.literal('pong') }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Parse helpers for untrusted socket input. */
export const parseClientMessage = (raw: unknown): ReturnType<typeof ClientMessage.safeParse> =>
  ClientMessage.safeParse(raw);
export const parseServerMessage = (raw: unknown): ReturnType<typeof ServerMessage.safeParse> =>
  ServerMessage.safeParse(raw);
