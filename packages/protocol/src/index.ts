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

/** One model call (phase-13 decision 12). `costUsd` is what OpenRouter billed unless `estimated`. */
export const CallUsage = z.object({
  /** The model id LiteLLM got, e.g. 'zdr/google/gemini-4-argon' or 'zdr/strong'. */
  model: z.string().max(200),
  input: z.int().min(0),
  output: z.int().min(0),
  cacheRead: z.int().min(0),
  cacheWrite: z.int().min(0),
  /** A part of `output`. */
  reasoning: z.int().min(0),
  costUsd: z.number().min(0),
  /** True: Pi's price table, not the billed cost. */
  estimated: z.boolean(),
});
export type CallUsage = z.infer<typeof CallUsage>;

const tokenCount = z.int().min(0).optional();
/**
 * The token split of a total (phase-16 decision 12): the client computes the prompt cache hit rate
 * as `cacheRead / (input + cacheRead + cacheWrite)`. Optional for older fixtures.
 */
const TokenSplit = {
  input: tokenCount,
  output: tokenCount,
  cacheRead: tokenCount,
  cacheWrite: tokenCount,
};
/** A chat's running totals (phase-13 decision 13). */
export const ChatUsage = z.object({
  costUsd: z.number().min(0),
  tokens: z.int().min(0),
  ...TokenSplit,
});
export type ChatUsage = z.infer<typeof ChatUsage>;

/** ECB reference rate: USD per 1 EUR on `date` (phase-13 decision 16). */
export const FxRate = z.object({ usdPerEur: z.number().positive(), date: z.iso.date() });
export type FxRate = z.infer<typeof FxRate>;

/** Where a forked chat came from (phase-13 decision 4). */
export const ForkLink = z.object({
  chatId: id64,
  /** The edited user message in the source chat. */
  messageId: id64,
  /** Null when the source chat has no title or is deleted. */
  title: z.string().nullable(),
  deleted: z.boolean(),
});
export type ForkLink = z.infer<typeof ForkLink>;

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
  /** The server always sets it; optional for older fixtures. */
  usage: ChatUsage.optional(),
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

/** The server-executed web search tool (docs/decisions/phase-14-search.md). */
export const WEB_SEARCH_TOOL = 'web_search';
/** `approval.request.reason` when a search query names a vault entity (phase-14 decision 7). */
export const SEARCH_ENTITY_REASON = 'Haku sisältää henkilötiedon';
/** Results per search: the `zdr/search` alias fixes `max_results` (phase-14 decision 4). */
export const SEARCH_MAX_RESULTS = 5;

/** One citation of a search as the tool row shows it; real values, http(s) links only. */
export const SearchCitation = z.object({
  title: z.string().max(1000),
  url: z
    .string()
    .max(2048)
    .regex(/^https?:\/\//i),
});
export type SearchCitation = z.infer<typeof SearchCitation>;

/** A `web_search` row: the query that ran and its citations, in result order. */
export const ToolSearch = z.object({
  query: z.string().max(2000),
  results: z.array(SearchCitation).max(SEARCH_MAX_RESULTS),
});
export type ToolSearch = z.infer<typeof ToolSearch>;

export const ToolRow = z.object({
  callId: id64,
  name: z.string(),
  status: ToolStatus,
  summary: z.string(),
  /** Set on a finished `web_search` row (phase-14). */
  search: ToolSearch.optional(),
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
  /** Assistant messages with tokens. */
  usage: CallUsage.optional(),
  /** Set when the message has thinking text; the text loads with `thinking.get`. */
  thinking: z.object({ ms: z.int().min(0).nullable() }).optional(),
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
  /**
   * `uncertain`: a low-score detection (confirm, allowlist, dismiss). `collision`: what the user
   * typed equals an issued surrogate of `entityId`, and the message waits; accept makes it a new
   * person, reject says it is that entity (phase-12 decision 9).
   */
  reason: z.enum(['uncertain', 'collision']),
  entityId: z.int().nullable(),
});
export type VaultPending = z.infer<typeof VaultPending>;

export const Artifact = z.object({
  id: z.string(),
  kind: z.enum(['html', 'react', 'code', 'mermaid', 'vega-lite', 'file']),
  title: z.string(),
  language: z.string().optional(),
  content: z.string(),
  mime: z.string().optional(),
});
export type Artifact = z.infer<typeof Artifact>;

/**
 * The artifact sandbox policy: the header of `GET /api/sandbox` and the meta tag of every sandbox
 * document. `font-src data:` serves the inlined fonts (phase-19 decision 3).
 */
export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

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
    usage: ChatUsage.optional(),
  }),
  /** The rate the file's euro amounts use; null: amounts in USD. */
  fx: FxRate.nullable().optional(),
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
      usage: CallUsage.optional(),
    }),
  ),
});
export type ChatExport = z.infer<typeof ChatExport>;

/**
 * Files screen (docs/decisions/phase-11-files.md). `work` is the agent's work dir, `files` the
 * chat uploads (read-only, flat, newest first).
 */
export const FileRoot = z.enum(['work', 'files']);
export type FileRoot = z.infer<typeof FileRoot>;

/** A path relative to a root, '/'-separated; '' is the root. The server checks the rest. */
export const TreePath = z
  .string()
  .max(4096)
  .refine((p) => !p.includes('\0'), 'NUL in path');

/** How the screen previews a file; null: download only (type or size cap, decision 9). */
export const PreviewKind = z.enum(['text', 'markdown', 'code', 'image', 'pdf', 'html']);
export type PreviewKind = z.infer<typeof PreviewKind>;

/** Preview caps in bytes per kind (decision 9); a bigger file is download only. */
export const PREVIEW_MAX: Record<PreviewKind, number> = {
  text: 1024 ** 2,
  markdown: 1024 ** 2,
  code: 1024 ** 2,
  html: 2 * 1024 ** 2,
  image: 20 * 1024 ** 2,
  pdf: 50 * 1024 ** 2,
};

export const TreeEntry = z.object({
  name: z.string(),
  /** Relative to the root, '/'-separated. In `files` it is the upload id. */
  path: z.string(),
  type: z.enum(['dir', 'file']),
  /** Bytes; 0 for a folder. */
  size: z.int().min(0),
  /** 'inode/directory' for a folder. */
  mime: z.string(),
  modifiedAt: z.iso.datetime(),
  preview: PreviewKind.nullable(),
  /** The chat that uploaded the file, or the chat and message whose tool call or artifact wrote it. */
  origin: z
    .object({ chatId: id64, messageId: id64.nullable(), chatTitle: z.string().nullable() })
    .nullable(),
});
export type TreeEntry = z.infer<typeof TreeEntry>;

/** Query of `GET /api/files/tree`. */
export const TreeQuery = z.object({
  root: FileRoot.default('work'),
  path: TreePath.default(''),
  /** `nextCursor` of the previous page. */
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const TreeListing = z.object({
  root: FileRoot,
  path: z.string(),
  entries: z.array(TreeEntry),
  nextCursor: z.string().nullable(),
});
export type TreeListing = z.infer<typeof TreeListing>;

/** Query of `GET /api/files/tree/raw`. `download=1` always sends an attachment. */
export const TreeRawQuery = z.object({
  root: FileRoot.default('work'),
  path: TreePath,
  download: z.enum(['0', '1']).default('0'),
});

export const TrashEntry = z.object({
  /** The entry name in `.trash`: `<epoch ms>-<name>`. */
  id: z.string(),
  name: z.string(),
  /** Where "Palauta" puts it back. */
  originalPath: z.string(),
  type: z.enum(['dir', 'file']),
  size: z.int().min(0),
  deletedAt: z.iso.datetime(),
});
export type TrashEntry = z.infer<typeof TrashEntry>;

export const TrashListing = z.object({
  entries: z.array(TrashEntry),
  nextCursor: z.string().nullable(),
});
export type TrashListing = z.infer<typeof TrashListing>;

/** `GET /api/files/tree/usage`: bytes. `used` = `work` + `trash` + `files`. */
export const FileUsage = z.object({
  used: z.int().min(0),
  quota: z.int().min(0),
  work: z.int().min(0),
  trash: z.int().min(0),
  files: z.int().min(0),
  /** Per file in the work dir (upload, agent write). */
  maxFileSize: z.int().min(0),
  /** Per chat attachment (model ingest). */
  maxAttachSize: z.int().min(0),
});
export type FileUsage = z.infer<typeof FileUsage>;

/** Bodies of the work-dir routes. */
export const TreeMkdir = z.object({ path: TreePath });
export const TreeMove = z.object({ from: TreePath, to: TreePath });
export const TreeRestore = z.object({ id: z.string().min(1).max(512) });
export const TreeAttach = z.object({ path: TreePath, chatId: id64.optional() });
export const TreeSaveArtifact = z.object({
  chatId: id64,
  artifactId: z.string().min(1).max(64),
  /** The work-dir folder to save into. */
  dir: TreePath.default(''),
});

/** `{ error }` codes of the file routes; the web maps each to a Finnish text. */
export const FileError = z.enum([
  'bad_message',
  'bad_path',
  'bad_name',
  'not_found',
  'exists',
  'empty',
  'too_large',
  'quota',
  'unsupported',
  'pseudo_down',
]);
export type FileError = z.infer<typeof FileError>;

/** Admin (docs/decisions/phase-15-admin.md). The agent every install has; it cannot be deleted. */
export const DEFAULT_AGENT_ID = 'assistant';
const toolNames = z.array(z.string().min(1).max(64));

/** `agents/<id>.yaml` (phase-5 decision 1); the loader and the editor use it. `prompt` is a path. */
export const AgentFile = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,64}$/),
    name: z.string().min(1).max(80),
    /** An alias (`zdr/strong`) or a ZDR catalog model (`zdr/google/gemini-4-argon`). */
    model: z
      .string()
      .regex(/^zdr\/(?:[A-Za-z0-9._-]+|[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/),
    prompt: z.string().min(1),
    skills: toolNames.default([]),
    tools: z.object({ allow: toolNames, mcp: toolNames.optional() }).strict(),
    approval: z
      .object({ always: toolNames.default([]), never: toolNames.default([]) })
      .strict()
      .default({ always: [], never: [] }),
    subagents: z.boolean().default(false),
  })
  .strict();
export type AgentFile = z.infer<typeof AgentFile>;

/** One profile file as the editor gets it. */
export const AgentDoc = z.object({
  id: z.string(),
  /** Null when the file fails the schema; `error` says why. */
  profile: AgentFile.nullable(),
  /** The file text as it is on disk. */
  yaml: z.string(),
  /** The prompt file's text. */
  prompt: z.string(),
  error: z.string().nullable(),
});
export type AgentDoc = z.infer<typeof AgentDoc>;

export const AgentPrompt = z.string().min(1).max(100_000);
/** Body of `POST /api/agents` and `PUT /api/agents/:id`: the YAML tab's text or the form's fields. */
export const AgentSave = z.union([
  z.object({ yaml: z.string().min(1).max(100_000), prompt: AgentPrompt }),
  z.object({ profile: z.record(z.string(), z.unknown()), prompt: AgentPrompt }),
]);
export type AgentSave = z.infer<typeof AgentSave>;

/** `GET /api/agents`. */
export const AgentList = z.object({
  defaultId: z.string(),
  agents: z.array(AgentDoc),
  options: z.object({
    /** The tool names a profile can allow. */
    tools: z.array(z.string()),
    /** The servers of `infra/mcp.yaml`. */
    mcp: z.array(z.string()),
    /** The folders of `skills/`. */
    skills: z.array(z.string()),
    /** The fixed aliases of `infra/models.json`; catalog models come from `models.state`. */
    aliases: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
});
export type AgentList = z.infer<typeof AgentList>;

/** Body of `POST /api/automations` and `PUT /api/automations/:id`; the server's schema checks it. */
export const AutomationSave = z.record(z.string(), z.unknown());
/** Body of `POST /api/automations/preview`; the answer is `{ runs: string[] }` (ISO 8601 UTC). */
export const CronPreview = z.object({
  cron: z.string().min(1).max(200),
  timezone: z.string().min(1).max(64).default('Europe/Helsinki'),
});

/** The automation form's schedule (phase-15 decision 8). `day`: 0 Sunday, 1 Monday … 6 Saturday. */
export type Schedule =
  | { kind: 'daily' | 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; day: number; hour: number; minute: number }
  | { kind: 'custom'; cron: string };

export function scheduleToCron(s: Schedule): string {
  if (s.kind === 'custom') return s.cron.trim();
  const dow = s.kind === 'weekly' ? String(s.day) : s.kind === 'daily' ? '*' : '1-5';
  return `${s.minute} ${s.hour} * * ${dow}`;
}

/** A preset when `cron` is one (`7` reads as Sunday), else `custom`. */
export function cronToSchedule(cron: string): Schedule {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-7])$/.exec(cron.trim());
  const minute = Number(m?.[1]);
  const hour = Number(m?.[2]);
  if (!m || minute > 59 || hour > 23) return { kind: 'custom', cron };
  if (m[3] === '*') return { kind: 'daily', hour, minute };
  if (m[3] === '1-5') return { kind: 'weekdays', hour, minute };
  return { kind: 'weekly', day: Number(m[3]) % 7, hour, minute };
}

/** `GET /api/auth/sessions`: one signed-in device. */
export const DeviceSession = z.object({
  id: z.string(),
  /** From the User-Agent at login, e.g. "Safari · iPhone"; null for older sessions. */
  label: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  /** The session of the request. */
  current: z.boolean(),
});
export type DeviceSession = z.infer<typeof DeviceSession>;

/** Body of `POST /api/export` (phase-15 decision 16). */
export const ExportStart = z.object({
  passphrase: z.string().min(12).max(1024),
  unmask: z.boolean().default(false),
});

export const ExportJob = z.object({
  id: z.string(),
  status: z.enum(['building', 'ready', 'failed']),
  masked: z.boolean(),
  done: z.int().min(0),
  total: z.int().min(0),
  error: z.enum(['pseudo_down', 'too_large', 'failed']).nullable(),
  /** Bytes of the encrypted file, when ready. */
  size: z.int().min(0).nullable(),
  fileName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** When a ready file is deleted. */
  expiresAt: z.iso.datetime().nullable(),
});
export type ExportJob = z.infer<typeof ExportJob>;

/** PBKDF2-HMAC-SHA256 rounds of the export file (OWASP 2023), the `-iter` of the command below. */
export const EXPORT_PBKDF2_ITER = 600_000;
/** The command that decrypts an export file into the zip; it asks for the passphrase. */
export const decryptCommand = (fileName: string) =>
  `openssl enc -d -aes-256-cbc -pbkdf2 -iter ${EXPORT_PBKDF2_ITER} -md sha256 -in ${fileName} -out ${fileName.replace(/\.enc$/, '')}`;

/** `{ error }` codes of the admin routes; `bad_message` also has `path` and `message`. */
export const AdminError = z.enum([
  'bad_message',
  'not_found',
  'exists',
  'default_agent',
  'in_use',
  'busy',
  'gone',
  'too_large',
  'pseudo_down',
]);
export type AdminError = z.infer<typeof AdminError>;

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
    /** The client's own id for the message; `message.accepted` maps it to the entry id. */
    localId: z.string().max(64).optional(),
  }),
  /** Runs the chat's last user turn again in place: the server rewinds the branch to before it. */
  z.object({
    type: z.literal('user.retry'),
    chatId: id64,
    /** A fresh client id: `message.accepted` maps it to the new entry of the message run again. */
    localId: z.string().max(64).optional(),
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
    action: z.enum(['confirm', 'dismiss', 'allowlist', 'accept', 'reject']),
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
  /** "Haarauta": a new chat from before `messageId`, which then gets `text` (phase-13 decision 1). */
  z.object({
    type: z.literal('chat.fork'),
    chatId: id64,
    /** A user message entry on the chat's current branch. */
    messageId: id64,
    text: z.string().min(1).max(100_000),
    /** The client's id for the edited text in the new chat (`message.accepted`). */
    localId: z.string().max(64).optional(),
  }),
  z.object({ type: z.literal('thinking.get'), chatId: id64, messageId: id64 }),
  z.object({ type: z.literal('usage.get'), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
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
  /** Answer to `models.list` and, to the sending socket only, to `models.favorite`. */
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
    /** Set for a chat that "Haarauta" started. */
    forkedFrom: ForkLink.nullable().optional(),
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
  /** A user message that this client sent with `localId` is stored as entry `messageId`. */
  z.object({
    type: z.literal('message.accepted'),
    chatId: id64,
    localId: z.string(),
    messageId: id64,
  }),
  /** The streamed message `messageId` (stream id) thinks now, or stopped thinking. */
  z.object({
    type: z.literal('message.thinking'),
    chatId: id64,
    messageId: id64,
    active: z.boolean(),
  }),
  /** Answer to `thinking.get`: the restored thinking text of one assistant entry. */
  z.object({
    type: z.literal('thinking.text'),
    chatId: id64,
    messageId: id64,
    text: z.string(),
    annotations: z.array(Annotation),
  }),
  /** At attach and after each new rate. Null: no rate yet, show USD. */
  z.object({ type: z.literal('fx.state'), rate: FxRate.nullable() }),
  /** Answer to `usage.get`: the user's model calls of `month`, grouped by model. */
  z.object({
    type: z.literal('usage.state'),
    month: z.string(),
    /** 'YYYY-MM', newest first, at most 24. */
    months: z.array(z.string()),
    rows: z.array(
      z.object({
        model: z.string(),
        /** Catalog name, alias name from infra/models.json, or the id. */
        name: z.string(),
        calls: z.int().min(0),
        tokens: z.int().min(0),
        reasoning: z.int().min(0),
        ...TokenSplit,
        costUsd: z.number().min(0),
        /** True when any call of the group is an estimate. */
        estimated: z.boolean(),
      }),
    ),
    /** Per agent id, highest cost first; null: a task without a chat (phase-15 decision 19). */
    agents: z
      .array(
        z.object({
          agentId: z.string().nullable(),
          calls: z.int().min(0),
          tokens: z.int().min(0),
          costUsd: z.number().min(0),
          estimated: z.boolean(),
        }),
      )
      .optional(),
    /** `web_search` calls in the month. */
    searches: z.int().min(0).optional(),
  }),
  /** The full export job (phase-15 decision 16); null after download or delete. */
  z.object({ type: z.literal('export.state'), job: ExportJob.nullable() }),
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
    /** Set when a `web_search` call ran (phase-14). */
    search: ToolSearch.optional(),
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
  /**
   * The chat's last user message waits: it names an issued surrogate, and the vault's pending lane
   * asks the user (phase-12 decision 7). The chat takes no new message until `chat.released`.
   */
  z.object({ type: z.literal('chat.held'), chatId: id64, pendingIds: z.array(z.int()) }),
  /** The held message runs (`resumed`) or is gone (`dropped`: the client gives its text back). */
  z.object({
    type: z.literal('chat.released'),
    chatId: id64,
    outcome: z.enum(['resumed', 'dropped']),
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
        /** Phase-15 editor fields; `name` is unset when the file has none (show the id). */
        name: z.string().optional(),
        timezone: z.string().optional(),
        prompt: z.string().optional(),
        autoApprove: z.array(z.string()).optional(),
        /** Null when disabled. */
        nextRunAt: z.iso.datetime().nullable().optional(),
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

export * from './format.ts';
