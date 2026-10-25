import { chats, type Db, tags, topicProposals, topics } from '@pa/db';
import type { PseudoClient } from '@pa/pi-ext-pseudo';
import type { ServerMessage } from '@pa/protocol';
import { and, count, eq, like } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { type BridgeDeps, broadcast, chatRow, summary, textOf } from './bridge.ts';
import type { SessionRegistry } from './pi/registry.ts';

const DEBOUNCE_MS = 2000;
const TIMEOUT_MS = 20_000;
/** ~4 chars per token: rerun after ~3K new tokens, send the last ~2K tokens. */
const RERUN_CHARS = 12_000;
const TAIL_CHARS = 8000;

export const SYSTEM_PROMPT = `Olet keskustelujen luokittelija. Saat käyttäjän aihelistan ja keskustelun lopun. Vastaa pelkällä JSON-objektilla, ilman muuta tekstiä:
{"title": string, "topics": [string], "proposed_topic": {"name": string, "why": string} | null, "summary": string}

Säännöt:
- title: 3–6 sanaa keskustelun kielellä (yleensä suomi). Ei emojeja. Ei henkilöiden nimiä.
- topics: 0–3 aiheen id:tä, vain annetusta listasta. Tärkein ensin. Tyhjä lista, jos mikään ei sovi.
- proposed_topic: uusi aihe vain, jos mikään listan aihe ei sovi ja keskustelu on asiapitoinen. Muuten null.
- summary: 3–5 virkettä keskustelun sisällöstä hakua varten, keskustelun kielellä.`;

const REPAIR =
  'Vastauksesi ei ollut kelvollista JSONia annetussa muodossa. Vastaa uudelleen pelkällä JSON-objektilla.';

const Reply = z.object({
  title: z.string().trim().min(1).max(80),
  topics: z.array(z.string()),
  proposed_topic: z.object({ name: z.string().trim().min(1).max(80), why: z.string() }).nullable(),
  summary: z.string(),
});

const parse = (text: string) => {
  try {
    return Reply.safeParse(JSON.parse(text.replace(/^\s*```(?:json)?|```\s*$/g, ''))).data;
  } catch {
    // The parser error quotes the reply text: never log it.
    return undefined;
  }
};

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

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
      })
      .from(topicProposals)
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
  rooms: BridgeDeps['rooms'];
  userId: string;
  litellmUrl: string;
  litellmMasterKey: string;
  pseudo?: PseudoClient | undefined;
  log: FastifyBaseLogger;
}) {
  const { db, registry, rooms, userId, pseudo, log } = deps;
  const timers = new Map<string, NodeJS.Timeout>();
  // ponytail: in memory, so a restart reruns long chats once. Store it on the chat if that matters.
  const lastRunChars = new Map<string, number>();
  let chain = Promise.resolve();
  let closed = false;
  let jsonMode = true;

  const complete = async (messages: ChatMessage[]): Promise<string> => {
    for (;;) {
      const res = await fetch(`${deps.litellmUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${deps.litellmMasterKey}`,
        },
        body: JSON.stringify({
          model: 'zdr/task-small',
          stream: false,
          messages,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // The alias may reject `response_format`; the prompt asks for JSON only anyway.
      if (res.status === 400 && jsonMode) {
        jsonMode = false;
        continue;
      }
      if (!res.ok) throw new Error(`title call status ${res.status}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
      return body.choices?.[0]?.message?.content ?? '';
    }
  };

  const run = async (chatId: string) => {
    const chat = chatRow(db, userId, chatId);
    if (!chat || chat.titleLocked) return;
    const session = await registry.get(chatId);
    // A new run started: its own settle schedules the job again.
    if (!session.isIdle) return;
    const transcript = session.sessionManager
      .getBranch()
      .flatMap((e) =>
        e.type === 'message' && (e.message.role === 'user' || e.message.role === 'assistant')
          ? [`${e.message.role === 'user' ? 'Käyttäjä' : 'Avustaja'}: ${textOf(e.message)}`]
          : [],
      )
      .join('\n\n');
    if (!transcript) return;
    if (chat.title && transcript.length - (lastRunChars.get(chatId) ?? 0) <= RERUN_CHARS) return;

    const list = db
      .select({ id: topics.id, name: topics.name, description: topics.description })
      .from(topics)
      .where(eq(topics.userId, userId))
      .all();
    // Static prompt first, then the topic list, then the transcript (prompt caching order).
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Aiheet:\n${JSON.stringify(list)}\n\nKeskustelu:\n${transcript.slice(-TAIL_CHARS)}`,
      },
    ];
    let content = await complete(messages);
    let reply = parse(content);
    if (!reply) {
      content = await complete([
        ...messages,
        { role: 'assistant', content },
        { role: 'user', content: REPAIR },
      ]);
      reply = parse(content);
    }
    if (!reply) return log.warn({ chatId }, 'title reply invalid');

    const known = new Set(list.map((t) => t.id));
    const ids = [...new Set(reply.topics)].filter((id) => known.has(id)).slice(0, 3);
    const title = pseudo ? (await pseudo.unmask(reply.title)).restored : reply.title;
    const proposed = reply.proposed_topic;
    const { summary: chatSummary } = reply;
    const result = db.transaction((tx) => {
      const r = tx
        .update(chats)
        .set({
          title,
          titleMasked: reply.title,
          // Keep a topic the user chose when the model picks none.
          topicId: ids[0] ?? chat.topicId,
          summary: chatSummary,
          updatedAt: new Date().toISOString(),
        })
        // A rename during the call wins.
        .where(and(eq(chats.id, chatId), eq(chats.titleLocked, false)))
        .returning()
        .get();
      if (!r) return;
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
      const added = !!proposed && !dup;
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
    broadcast(rooms, chatId, { type: 'chat.titled', chatId, title, topicId: r.topicId });
    broadcast(rooms, chatId, { type: 'chat.updated', chat: summary(r) });
    if (added) broadcast(rooms, chatId, topicState(db, userId));
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
