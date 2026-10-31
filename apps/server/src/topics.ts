import { chats, type Db, tags, topicProposals, topics } from '@pa/db';
import type { PseudoClient } from '@pa/pi-ext-pseudo';
import type { ServerMessage } from '@pa/protocol';
import { and, count, eq, like } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { chatRow, summary } from './chats.ts';
import { embed } from './embeddings.ts';
import { type ChatMessage, taskSmall } from './llm.ts';
import type { SessionRegistry } from './pi/registry.ts';
import { indexChat } from './search.ts';
import { transcript as branch } from './session-text.ts';
import { broadcast, type Rooms } from './socket.ts';
import type { RecordUsage } from './usage.ts';

// tests/memory-eval imports `taskSmall` from here; it lives in llm.ts.
export { taskSmall };

const DEBOUNCE_MS = 2000;
/** ~4 chars per token: rerun after ~3K new tokens, send the last ~2K tokens. */
const RERUN_CHARS = 12_000;
const TAIL_CHARS = 8000;
/**
 * Phase-22 decision 4: a proposed topic whose name vector has at least this cosine with an existing
 * topic or an open proposal is a duplicate.
 */
// ponytail: the search threshold (`RELATED_MIN`) reused for short names; re-check with real proposals.
export const PROPOSAL_DUPLICATE_MIN = 0.86;

/** The vectors are normalized: the dot product is the cosine. */
const cosine = (v: Float32Array, o: Float32Array) =>
  v.reduce((sum, x, i) => sum + x * (o[i] ?? 0), 0);
/** Whether `v` is a duplicate of one of `others`. */
export const nearDuplicate = (v: Float32Array, others: Float32Array[]) =>
  others.some((o) => cosine(v, o) >= PROPOSAL_DUPLICATE_MIN);

export const SYSTEM_PROMPT = `Olet keskustelujen luokittelija. Saat käyttäjän aihelistan ja keskustelun lopun. Vastaa pelkällä JSON-objektilla, ilman muuta tekstiä:
{"title": string, "topics": [string], "proposed_topic": {"name": string, "why": string} | null, "summary": string}

Säännöt:
- title: 3–6 sanaa keskustelun kielellä (yleensä suomi). Ei emojeja. Ei henkilöiden nimiä.
- topics: 0–3 aiheen id:tä, vain annetusta listasta. Tärkein ensin. Tyhjä lista, jos mikään ei sovi.
- proposed_topic: uusi aihe vain, jos mikään listan aihe ei sovi, keskustelu on asiapitoinen ja aihe on laaja teema, joka kattaisi useamman kuin yhden keskustelun. Ei yksittäisen pyynnön mukaan nimettyä aihetta. Muuten null.
- why: enintään kaksi lyhyttä virkettä siitä, mitä aihe kattaa. Älä koskaan aloita sanalla "Keskustelussa".
- summary: 3–5 virkettä keskustelun sisällöstä hakua varten, keskustelun kielellä.`;

const Reply = z.object({
  title: z.string().trim().min(1).max(80),
  topics: z.array(z.string()),
  proposed_topic: z.object({ name: z.string().trim().min(1).max(80), why: z.string() }).nullable(),
  summary: z.string(),
});

/**
 * Whether a proposed topic name is close to an existing topic or an open proposal by embedding
 * cosine. When the model cannot load, only the same name is a duplicate.
 */
async function duplicateProposal(
  db: Db,
  userId: string,
  name: string,
  list: { id: string; name: string }[],
  log: FastifyBaseLogger,
) {
  const open = db
    .select({ id: topicProposals.id, name: topicProposals.name })
    .from(topicProposals)
    .where(and(eq(topicProposals.userId, userId), eq(topicProposals.status, 'pending')))
    .all();
  const items = [...list, ...open];
  const names = items.map((t) => t.name);
  if (!names.length) return false;
  try {
    // e5 wants `query: ` on both sides for a symmetric comparison.
    const [v, ...others] = await embed([name, ...names], 'query');
    if (!nearDuplicate(v as Float32Array, others)) return false;
    const scores = others.map((o) => cosine(v as Float32Array, o));
    const score = Math.max(...scores);
    // Ids and the score only: names are user text.
    log.warn(
      { score, matchId: items[scores.indexOf(score)]?.id },
      'topic proposal dropped as duplicate',
    );
    return true;
  } catch (err) {
    log.warn({ error: err instanceof Error ? err.name : 'unknown' }, 'proposal embedding failed');
    return names.includes(name);
  }
}

/** Topics with chat counts and the pending inbox. */
export function topicState(db: Db, userId: string): ServerMessage {
  return {
    type: 'topic.state',
    topics: db
      .select({
        id: topics.id,
        name: topics.name,
        description: topics.description,
        count: count(chats.id),
      })
      .from(topics)
      .leftJoin(chats, eq(chats.topicId, topics.id))
      .where(eq(topics.userId, userId))
      .groupBy(topics.id)
      .all(),
    proposals: db
      .select({
        id: topicProposals.id,
        name: topicProposals.name,
        why: topicProposals.why,
        chatId: topicProposals.chatId,
        chatTitle: chats.title,
      })
      .from(topicProposals)
      .innerJoin(chats, eq(chats.id, topicProposals.chatId))
      .where(and(eq(topicProposals.userId, userId), eq(topicProposals.status, 'pending')))
      .all(),
  };
}

/**
 * Title, topics and summary job (plan §8, phase-4 decision 1). One direct call to the LiteLLM
 * alias `zdr/task-small` over the masked transcript; the title is restored only after the call.
 */
export function titleJobs(deps: {
  db: Db;
  registry: SessionRegistry;
  rooms: Rooms;
  userId: string;
  litellmUrl: string;
  litellmMasterKey: string;
  pseudo?: PseudoClient | undefined;
  log: FastifyBaseLogger;
  onUsage?: RecordUsage | undefined;
}) {
  const { db, registry, rooms, userId, pseudo, log } = deps;
  const timers = new Map<string, NodeJS.Timeout>();
  // ponytail: in memory, so a restart reruns long chats once. Store it on the chat if that matters.
  const lastRunChars = new Map<string, number>();
  let chain = Promise.resolve();
  let closed = false;
  const ask = taskSmall(deps.litellmUrl, deps.litellmMasterKey, deps.onUsage);

  const run = async (chatId: string) => {
    const chat = chatRow(db, userId, chatId);
    if (!chat) return;
    // A locked title (rename, automation) stays; the summary is still written.
    const locked = chat.titleLocked;
    const session = await registry.get(chatId);
    // A new run started: its own settle schedules the job again.
    if (!session.isIdle) return;
    const transcript = branch(session)
      .map((m) => `${m.role === 'user' ? 'Käyttäjä' : 'Avustaja'}: ${m.text}`)
      .join('\n\n');
    if (!transcript) return;
    if (chat.summary && transcript.length - (lastRunChars.get(chatId) ?? 0) <= RERUN_CHARS) return;

    const list = db
      .select({ id: topics.id, name: topics.name, description: topics.description })
      .from(topics)
      .where(eq(topics.userId, userId))
      .all();
    // Topic names are typed by the user (invariant 1): masked, and not sent at all without pseudo.
    // Only names and descriptions go through the mask; the ids stay exact for the `known` filter.
    const texts = list.map((t) => [t.name, t.description]);
    const masked = pseudo && list.length ? (await pseudo.mask(chatId, texts)).masked : [];
    const sentList = (masked as (string | null)[][]).map(([name, description], i) => ({
      id: list[i]?.id,
      name,
      description,
    }));
    // Static prompt first, then the topic list, then the transcript (prompt caching order).
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Aiheet:\n${JSON.stringify(sentList)}\n\nKeskustelu:\n${transcript.slice(-TAIL_CHARS)}`,
      },
    ];
    const reply = await ask(Reply, messages, chatId);
    if (!reply) return log.warn({ chatId }, 'title reply invalid');

    const known = new Set(list.map((t) => t.id));
    const ids = [...new Set(reply.topics)].filter((id) => known.has(id)).slice(0, 3);
    const title = pseudo ? (await pseudo.unmask(reply.title)).restored : reply.title;
    // The model writes surrogates for the masked topic names: restore before store and compare.
    const proposed =
      pseudo && reply.proposed_topic
        ? ((await pseudo.unmask(reply.proposed_topic)).restored as typeof reply.proposed_topic)
        : reply.proposed_topic;
    const similar = proposed
      ? await duplicateProposal(db, userId, proposed.name, list, log)
      : false;
    const { summary: chatSummary } = reply;
    const result = db.transaction((tx) => {
      const r = tx
        .update(chats)
        .set(
          locked
            ? { summary: chatSummary, updatedAt: new Date().toISOString() }
            : {
                title,
                titleMasked: reply.title,
                // Keep a topic the user chose when the model picks none.
                topicId: ids[0] ?? chat.topicId,
                summary: chatSummary,
                updatedAt: new Date().toISOString(),
              },
        )
        // A rename during the call wins.
        .where(
          locked ? eq(chats.id, chatId) : and(eq(chats.id, chatId), eq(chats.titleLocked, false)),
        )
        .returning()
        .get();
      if (!r) return;
      if (locked) return { r, added: false };
      tx.delete(tags)
        .where(and(eq(tags.chatId, chatId), like(tags.tag, 'topic:%')))
        .run();
      if (ids.length > 1)
        tx.insert(tags)
          .values(ids.slice(1).map((id) => ({ chatId, userId, tag: `topic:${id}` })))
          .run();
      const dup =
        proposed &&
        tx
          .select({ id: topicProposals.id })
          .from(topicProposals)
          .where(
            and(
              eq(topicProposals.userId, userId),
              eq(topicProposals.status, 'pending'),
              eq(topicProposals.name, proposed.name),
            ),
          )
          .get();
      const added = !!proposed && !similar && !dup;
      if (added)
        tx.insert(topicProposals)
          .values({
            userId,
            chatId,
            name: proposed.name,
            why: proposed.why,
            createdAt: new Date().toISOString(),
          })
          .run();
      return { r, added };
    });
    if (!result) return;
    lastRunChars.set(chatId, transcript.length);
    const { r, added } = result;
    log.debug({ chatId, topics: ids.length, proposal: added }, 'chat titled');
    if (!locked)
      broadcast(rooms, chatId, { type: 'chat.titled', chatId, title, topicId: r.topicId });
    broadcast(rooms, chatId, { type: 'chat.updated', chat: summary(r) });
    if (added) broadcast(rooms, chatId, topicState(db, userId));
    await indexChat(db, userId, chatId);
  };

  /** Debounced per chat; jobs run one at a time. */
  const scheduleTitleJob = (chatId: string) => {
    if (closed) return;
    clearTimeout(timers.get(chatId));
    timers.set(
      chatId,
      setTimeout(() => {
        timers.delete(chatId);
        chain = chain
          .then(() => (closed ? undefined : run(chatId)))
          .catch((err: unknown) =>
            log.warn(
              { chatId, error: err instanceof Error ? err.message : 'unknown' },
              'title job failed',
            ),
          );
      }, DEBOUNCE_MS),
    );
  };

  const close = async () => {
    closed = true;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    await chain;
  };

  return { scheduleTitleJob, close };
}
