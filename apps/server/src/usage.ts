import { readFileSync } from 'node:fs';
import type { ExtensionFactory, MessageEndEvent } from '@earendil-works/pi-coding-agent';
import { chats, type Db, usage } from '@pa/db';
import type { CallUsage, ServerMessage } from '@pa/protocol';
import { and, count, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Catalog } from './pi/models.ts';

/**
 * Usage and cost (docs/decisions/phase-13-thread.md decisions 11 to 15). Per reply the numbers live
 * in the Pi message (`usage` plus the `pa` key); per call, for totals, in the `usage` table; per
 * chat as running totals on `chats`. Prices stay in USD.
 */

/** pa-server's key on a Pi assistant message. Pi stores it with the message. */
export type PaMeta = { costUsd?: number; thinkingMs?: number };
export type UsageKind = 'chat' | 'task' | 'subagent';
export type UsageAt = { kind: UsageKind; chatId: string | null; agentId?: string | null };
export type RecordUsage = (at: UsageAt, u: CallUsage | undefined) => void;

type AgentMessage = MessageEndEvent['message'];

const count0 = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
const isCost = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const tokensOf = (u: CallUsage) => u.input + u.output + u.cacheRead + u.cacheWrite;

type Alias = {
  id: string;
  name: string;
  cost: Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', number>;
};
let aliases: Map<string, Alias> | undefined;
/** The fixed aliases of `infra/models.json` (names and EU prices). */
const alias = (id: string) => {
  aliases ??= new Map(
    (
      JSON.parse(readFileSync(new URL('../../../infra/models.json', import.meta.url), 'utf8'))
        .models as Alias[]
    ).map((m) => [m.id, m]),
  );
  return aliases.get(id);
};

/**
 * Captures LiteLLM's cost and the thinking time of each assistant message (decisions 8 and 11).
 * Pi computes its own cost from `models.json` and drops `usage.cost` of the usage chunk, so the
 * raw chunk is read here and the cost goes into the stored message as `pa.costUsd`.
 */
export function usageExtension(at: UsageAt, record?: RecordUsage): ExtensionFactory {
  return (pi) => {
    // Cleared at `message_end` only: a short stream can run ahead of the `message_start` handler.
    let cost: number | undefined;
    let thinkFrom: number | undefined;
    let thinkTo: number | undefined;
    pi.on('provider_stream_event', (e) => {
      const c = (e.data as { usage?: { cost?: unknown } } | null)?.usage?.cost;
      if (isCost(c)) cost = c;
    });
    // `thinking_end` comes only when the stream ends; the last delta marks the end of the thinking.
    pi.on('message_update', (e) => {
      const t = e.assistantMessageEvent.type;
      if (t === 'thinking_start') thinkFrom ??= performance.now();
      else if (t === 'thinking_delta') thinkTo = performance.now();
    });
    pi.on('message_end', (e) => {
      if (e.message.role !== 'assistant') return;
      const pa: PaMeta = {};
      if (cost !== undefined) pa.costUsd = cost;
      if (thinkFrom !== undefined) pa.thinkingMs = Math.round((thinkTo ?? thinkFrom) - thinkFrom);
      cost = thinkFrom = thinkTo = undefined;
      const changed = Object.keys(pa).length > 0;
      const message = changed ? ({ ...e.message, pa } as AgentMessage) : e.message;
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
  const msg = m as { role?: unknown; model?: unknown; usage?: any; pa?: PaMeta } | null;
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
  const billed = msg.pa?.costUsd;
  return isCost(billed)
    ? { ...call, costUsd: billed, estimated: false }
    : { ...call, costUsd: count0(u.cost?.total), estimated: true };
}

/**
 * An OpenAI `usage` object of a non-streamed LiteLLM call (the title job, consolidation) as one
 * call; undefined without tokens. Without `cost`, the alias price in `infra/models.json` estimates.
 */
export function rawUsage(model: string, raw: unknown): CallUsage | undefined {
  const r = (raw ?? {}) as any;
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
  if (isCost(r.cost)) return { ...call, costUsd: r.cost, estimated: false };
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
 * transaction and takes the chat's agent when `at` names none. A failure only warns: usage never
 * stops a reply.
 */
export function usageRecorder(
  db: Db,
  userId: string,
  warn: (msg: string, data?: object) => void,
  now: () => Date = () => new Date(),
): RecordUsage {
  return (at, u) => {
    if (!u) return;
    try {
      db.transaction((tx) => {
        const chat = at.chatId
          ? tx
              .update(chats)
              .set({
                costUsd: sql`${chats.costUsd} + ${u.costUsd}`,
                tokens: sql`${chats.tokens} + ${tokensOf(u)}`,
              })
              .where(and(eq(chats.id, at.chatId), eq(chats.userId, userId)))
              .returning({ agentId: chats.agentId })
              .get()
          : undefined;
        tx.insert(usage)
          .values({
            userId,
            chatId: at.chatId,
            agentId: at.agentId ?? chat?.agentId ?? null,
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
}

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
export function modelName(model: string, catalog: Pick<Catalog, 'get'>) {
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
  const rows = db
    .select({
      model: usage.model,
      calls: count(),
      tokens:
        sql<number>`sum(${usage.input} + ${usage.output} + ${usage.cacheRead} + ${usage.cacheWrite})`.mapWith(
          Number,
        ),
      reasoning: sql<number>`sum(${usage.reasoning})`.mapWith(Number),
      costUsd: sql<number>`sum(${usage.costUsd})`.mapWith(Number),
      estimated: sql<number>`max(${usage.estimated})`.mapWith(Number),
    })
    .from(usage)
    .where(
      and(
        eq(usage.userId, userId),
        gte(usage.createdAt, monthStart(month)),
        lt(usage.createdAt, monthStart(nextMonth(month))),
      ),
    )
    .groupBy(usage.model)
    .orderBy(desc(sql`sum(${usage.costUsd})`))
    .all();
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
  };
}
