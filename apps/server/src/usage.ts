import { readFileSync } from 'node:fs';
import type { ExtensionFactory, MessageEndEvent } from '@earendil-works/pi-coding-agent';
import { chats, type Db, usage } from '@nolla/db';
import type { CallUsage, ChatUsage, ServerMessage } from '@nolla/protocol';
import { and, count, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Catalog } from './pi/models.ts';

/**
 * Usage and cost (docs/decisions/phase-13-thread.md decisions 11 to 15). Per reply the numbers live
 * in the Pi message (`usage` plus the `pa` key); per call, for totals, in the `usage` table; per
 * chat as running totals on `chats`. Prices stay in USD.
 */

/**
 * pa-server's key on a Pi assistant message. Pi stores it with the message. Phase 26: `queueMs`
 * from the request to its response headers, `writeMs` from the first text token to the end.
 */
export type PaMeta = { costUsd?: number; thinkingMs?: number; queueMs?: number; writeMs?: number };
/** Phase 26: the model call is sent, or its response headers came; `at` is epoch ms. */
export type OnPhase = (phase: 'sent' | 'headers', at: number) => void;
/** `search`: one `web_search` call to `zdr/search` (phase-14 decision 11). */
type UsageKind = 'chat' | 'task' | 'subagent' | 'search';
export type UsageAt = { kind: UsageKind; chatId: string | null; agentId?: string | null };
type Warn = (msg: string, data?: object) => void;
/** Writes one call. `warn` reports a cost that could not be used. */
export type RecordUsage = ((at: UsageAt, u: CallUsage | undefined) => void) & { warn?: Warn };

type AgentMessage = MessageEndEvent['message'];

const count0 = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
const tokensOf = (u: CallUsage) => u.input + u.output + u.cacheRead + u.cacheWrite;
/** A billed cost above this per call is a broken value; the estimate is used instead. */
const MAX_CALL_USD = 1000;

/** A billed cost in USD, or undefined when it is missing or out of range (`warn` reports that). */
function billed(x: unknown, warn?: Warn): number | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_CALL_USD) return x;
  warn?.('usage cost out of range; the estimate is used', {
    cost: typeof x === 'number' ? x : typeof x,
  });
  return undefined;
}

type Alias = {
  id: string;
  name: string;
  cost: Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', number>;
};
let aliases: Map<string, Alias> | undefined;
/**
 * The fixed aliases of `infra/models.json` (names and EU prices). Without the file: no aliases, so
 * an estimate prices at zero and a name stays the id.
 */
const aliasMap = () => {
  if (!aliases)
    try {
      const file = new URL('../../../infra/models.json', import.meta.url);
      aliases = new Map(
        (JSON.parse(readFileSync(file, 'utf8')).models as Alias[]).map((m) => [m.id, m]),
      );
    } catch {
      aliases = new Map();
    }
  return aliases;
};
export const alias = (id: string) => aliasMap().get(id);
/** Every alias of `infra/models.json` (the agent editor's model list, phase 15). */
export const aliasList = () => [...aliasMap().values()];

/**
 * Captures LiteLLM's cost and the thinking time of each assistant message (decisions 8 and 11).
 * Pi computes its own cost from `models.json` and drops `usage.cost` of the usage chunk, so the
 * raw chunk is read here and the cost goes into the stored message as `pa.costUsd`. Phase 26: the
 * request's wait for its headers and the writing time, and `onPhase` at the request and the
 * headers. Pi sends both before the message's `message_start`. No model has a `promptCache`
 * tier, so Pi's cache warmer never replays a request that these handlers would count.
 */
export function usageExtension(
  at: UsageAt,
  record?: RecordUsage,
  onPhase?: OnPhase,
): ExtensionFactory {
  return (pi) => {
    // Billed costs by the chunk's response id: a stopped stream's cost can never land on another
    // message. The usage chunk is the last chunk, so the clear at `message_start` comes before it.
    const costs = new Map<string | undefined, number>();
    let thinkFrom: number | undefined;
    let thinkTo: number | undefined;
    let sentAt: number | undefined;
    let headersAt: number | undefined;
    let textFrom: number | undefined;
    /** `responseId:timestamp` of the recorded messages: a repeated `message_end` writes no row. */
    const recorded = new Set<string>();
    pi.on('turn_start', () => costs.clear());
    pi.on('message_start', (e) => {
      if (e.message.role !== 'assistant') return;
      costs.clear();
      thinkFrom = thinkTo = textFrom = undefined;
    });
    pi.on('before_provider_request', () => {
      sentAt = Date.now();
      headersAt = undefined;
      onPhase?.('sent', sentAt);
    });
    pi.on('after_provider_response', () => {
      headersAt = Date.now();
      onPhase?.('headers', headersAt);
    });
    pi.on('provider_stream_event', (e) => {
      const d = e.data as { id?: unknown; usage?: { cost?: unknown } } | null;
      const c = billed(d?.usage?.cost, record?.warn);
      if (c !== undefined) costs.set(typeof d?.id === 'string' ? d.id : undefined, c);
    });
    // `thinking_end` comes only when the stream ends; the last delta marks the end of the thinking.
    pi.on('message_update', (e) => {
      const t = e.assistantMessageEvent.type;
      if (t === 'thinking_start') thinkFrom ??= performance.now();
      else if (t === 'thinking_delta') thinkTo = performance.now();
      else if (t === 'text_delta') textFrom ??= Date.now();
    });
    pi.on('message_end', (e) => {
      const m = e.message;
      if (m.role !== 'assistant') return;
      const key = `${m.responseId ?? ''}:${m.timestamp}`;
      if (recorded.has(key)) return;
      recorded.add(key);
      const pa: PaMeta = {};
      const cost = costs.get(m.responseId);
      if (cost !== undefined) pa.costUsd = cost;
      if (thinkFrom !== undefined) pa.thinkingMs = Math.round((thinkTo ?? thinkFrom) - thinkFrom);
      if (sentAt !== undefined && headersAt !== undefined) pa.queueMs = headersAt - sentAt;
      if (textFrom !== undefined) pa.writeMs = Date.now() - textFrom;
      costs.clear();
      thinkFrom = thinkTo = sentAt = headersAt = textFrom = undefined;
      const changed = Object.keys(pa).length > 0;
      const message = changed ? ({ ...m, pa } as AgentMessage) : m;
      record?.(at, messageUsage(message));
      return changed ? { message } : undefined;
    });
  };
}

/**
 * A Pi assistant message (from the session or a child's RPC record) as one call; undefined without
 * tokens. The cost is `pa.costUsd` when LiteLLM gave one, else Pi's estimate.
 */
export function messageUsage(m: unknown): CallUsage | undefined {
  const msg = m as {
    role?: unknown;
    model?: unknown;
    usage?: {
      input?: unknown;
      output?: unknown;
      cacheRead?: unknown;
      cacheWrite?: unknown;
      reasoning?: unknown;
      cost?: { total?: unknown };
    };
    pa?: PaMeta;
  } | null;
  if (msg?.role !== 'assistant' || typeof msg.model !== 'string') return undefined;
  const u = msg.usage ?? {};
  const call = {
    model: msg.model,
    input: count0(u.input),
    output: count0(u.output),
    cacheRead: count0(u.cacheRead),
    cacheWrite: count0(u.cacheWrite),
    reasoning: count0(u.reasoning),
  };
  if (call.input + call.output + call.cacheRead + call.cacheWrite === 0) return undefined;
  const cost = billed(msg.pa?.costUsd);
  return cost !== undefined
    ? { ...call, costUsd: cost, estimated: false }
    : { ...call, costUsd: count0(u.cost?.total), estimated: true };
}

/**
 * An OpenAI `usage` object of a non-streamed LiteLLM call (the title job, consolidation) as one
 * call; undefined without tokens. Without `cost`, the alias price in `infra/models.json` estimates.
 */
export function rawUsage(model: string, raw: unknown, warn?: Warn): CallUsage | undefined {
  const r = (raw ?? {}) as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
    cost?: unknown;
  };
  const cacheRead = count0(r.prompt_tokens_details?.cached_tokens);
  const cacheWrite = count0(r.prompt_tokens_details?.cache_write_tokens);
  const call = {
    model,
    input: Math.max(0, count0(r.prompt_tokens) - cacheRead - cacheWrite),
    output: count0(r.completion_tokens),
    cacheRead,
    cacheWrite,
    reasoning: count0(r.completion_tokens_details?.reasoning_tokens),
  };
  if (call.input + call.output + cacheRead + cacheWrite === 0) return undefined;
  const cost = billed(r.cost, warn);
  if (cost !== undefined) return { ...call, costUsd: cost, estimated: false };
  const p = alias(model)?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const usd =
    (p.input * call.input +
      p.output * call.output +
      p.cacheRead * cacheRead +
      p.cacheWrite * cacheWrite) /
    1_000_000;
  return { ...call, costUsd: usd, estimated: true };
}

/**
 * Writes one `usage` row. A row with a chat adds to the chat's running totals in the same
 * transaction and takes the chat's agent when `at` names none, through `agentOf` (the agent that
 * runs the chat, phase-16 decision 3); a chat deleted meanwhile gives a row without a chat. A
 * failure only warns: usage never stops a reply.
 */
export function usageRecorder(
  db: Db,
  userId: string,
  warn: Warn,
  now: () => Date = () => new Date(),
  agentOf: (agentId: string) => string = (id) => id,
): RecordUsage {
  const record = (at: UsageAt, u: CallUsage | undefined) => {
    if (!u) return;
    try {
      db.transaction((tx) => {
        const chat = at.chatId
          ? tx
              .update(chats)
              .set({
                costUsd: sql`${chats.costUsd} + ${u.costUsd}`,
                tokens: sql`${chats.tokens} + ${tokensOf(u)}`,
                input: sql`${chats.input} + ${u.input}`,
                output: sql`${chats.output} + ${u.output}`,
                cacheRead: sql`${chats.cacheRead} + ${u.cacheRead}`,
                cacheWrite: sql`${chats.cacheWrite} + ${u.cacheWrite}`,
              })
              .where(and(eq(chats.id, at.chatId), eq(chats.userId, userId)))
              .returning({ agentId: chats.agentId })
              .get()
          : undefined;
        tx.insert(usage)
          .values({
            userId,
            chatId: chat ? at.chatId : null,
            agentId: at.agentId ?? (chat ? agentOf(chat.agentId) : null),
            kind: at.kind,
            ...u,
            createdAt: now().toISOString(),
          })
          .run();
      });
    } catch (err) {
      warn('usage write failed', {
        kind: at.kind,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  };
  return Object.assign(record, { warn });
}

/** A chat row's running totals as `ChatUsage` (phase-13 decision 13, phase-16 decision 12). */
export const chatUsage = (
  r: Pick<
    typeof chats.$inferSelect,
    'costUsd' | 'tokens' | 'input' | 'output' | 'cacheRead' | 'cacheWrite'
  >,
): ChatUsage => ({
  costUsd: r.costUsd,
  tokens: r.tokens,
  input: r.input,
  output: r.output,
  cacheRead: r.cacheRead,
  cacheWrite: r.cacheWrite,
});

const TZ = 'Europe/Helsinki';
const ym = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit' });
/** 'YYYY-MM' of an instant in Helsinki. */
export const monthOf = (d: Date) => ym.format(d);

/** The instant of midnight on the 1st of `month` in Helsinki (DST never changes on the 1st). */
function monthStart(month: string): string {
  const [y = 0, m = 1] = month.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, 1);
  const wall = Date.parse(
    `${new Date(utc).toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T')}Z`,
  );
  return new Date(utc - (wall - utc)).toISOString();
}
const nextMonth = (month: string) => {
  const [y = 0, m = 1] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/** The catalog name, the alias name of `infra/models.json`, or the id. */
function modelName(model: string, catalog: Pick<Catalog, 'get'>) {
  return catalog.get(model.replace(/^(zdr|open)\//, ''))?.name ?? alias(model)?.name ?? model;
}

/**
 * `usage.state` (decision 15): the user's calls of `month` grouped by model, highest cost first,
 * and the months from the first row to `now`, newest first, at most 24.
 */
export function usageMonth(
  db: Db,
  userId: string,
  month: string,
  catalog: Pick<Catalog, 'get'>,
  now: Date = new Date(),
): Extract<ServerMessage, { type: 'usage.state' }> {
  const inMonth = and(
    eq(usage.userId, userId),
    gte(usage.createdAt, monthStart(month)),
    lt(usage.createdAt, monthStart(nextMonth(month))),
  );
  const totals = {
    calls: count(),
    tokens:
      sql<number>`sum(${usage.input} + ${usage.output} + ${usage.cacheRead} + ${usage.cacheWrite})`.mapWith(
        Number,
      ),
    costUsd: sql<number>`sum(${usage.costUsd})`.mapWith(Number),
    estimated: sql<number>`max(${usage.estimated})`.mapWith(Number),
  };
  const byCost = desc(sql`sum(${usage.costUsd})`);
  const rows = db
    .select({
      model: usage.model,
      ...totals,
      reasoning: sql<number>`sum(${usage.reasoning})`.mapWith(Number),
      // Phase-16 decision 13: the split for the cache hit rate.
      input: sql<number>`sum(${usage.input})`.mapWith(Number),
      output: sql<number>`sum(${usage.output})`.mapWith(Number),
      cacheRead: sql<number>`sum(${usage.cacheRead})`.mapWith(Number),
      cacheWrite: sql<number>`sum(${usage.cacheWrite})`.mapWith(Number),
    })
    .from(usage)
    .where(inMonth)
    .groupBy(usage.model)
    .orderBy(byCost)
    .all();
  // Phase-15 decision 19: per agent, and the month's web searches.
  const agents = db
    .select({ agentId: usage.agentId, ...totals })
    .from(usage)
    .where(inMonth)
    .groupBy(usage.agentId)
    .orderBy(byCost)
    .all();
  const searches =
    db
      .select({ n: count() })
      .from(usage)
      .where(and(inMonth, eq(usage.kind, 'search')))
      .get()?.n ?? 0;
  const first = db
    .select({ at: sql<string | null>`min(${usage.createdAt})` })
    .from(usage)
    .where(eq(usage.userId, userId))
    .get()?.at;
  const months = [monthOf(now)];
  const oldest = first ? monthOf(new Date(first)) : months[0];
  while (months.length < 24 && (months.at(-1) ?? '') > (oldest ?? '')) {
    const [y = 0, m = 1] = (months.at(-1) ?? '').split('-').map(Number);
    months.push(m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`);
  }
  return {
    type: 'usage.state',
    month,
    months,
    rows: rows.map((r) => ({
      ...r,
      name: modelName(r.model, catalog),
      estimated: r.estimated > 0,
    })),
    agents: agents.map((a) => ({ ...a, estimated: a.estimated > 0 })),
    searches,
  };
}
