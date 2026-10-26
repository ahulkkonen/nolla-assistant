import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, watch } from 'node:fs';
import { basename, join } from 'node:path';
import { automationRuns, chats, type Db, topics } from '@pa/db';
import type { ServerMessage } from '@pa/protocol';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import cron from 'node-cron';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Agents } from './agents.ts';
import { transcript } from './bridge.ts';
import type { SessionRegistry } from './pi/registry.ts';
import { indexChat } from './search.ts';

export const TOPIC_NAME = 'Automaatiot';

const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** `automations/<id>.yaml`, decision 6 of docs/decisions/phase-5.md. */
const AutomationFile = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  cron: z.string().refine((c) => cron.validate(c), 'invalid cron expression'),
  timezone: z.string().refine(validZone, 'invalid timezone').default('Europe/Helsinki'),
  agentId: z.string().min(1).max(64).default('assistant'),
  prompt: z.string().min(1),
  deliver: z.enum(['chat', 'push', 'both']).default('chat'),
  enabled: z.boolean().default(true),
  /** Gated tools that run without asking; any other gated tool is denied (nobody is there to approve). */
  autoApprove: z.array(z.string()).default([]),
});
export type Automation = z.infer<typeof AutomationFile>;

/** Reads every `*.yaml` in `dir`. A bad file goes to `onError` and is skipped. */
export function loadAutomations(
  dir: string,
  onError: (file: string, err: unknown) => void = () => {},
): Automation[] {
  if (!existsSync(dir)) return [];
  const out: Automation[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()) {
    try {
      const a = AutomationFile.parse(parse(readFileSync(join(dir, file), 'utf8')));
      if (a.id !== basename(file, '.yaml')) throw new Error(`id ${a.id} does not match file name`);
      out.push(a);
    } catch (err) {
      onError(file, err);
    }
  }
  return out;
}

export type AutomationsDeps = {
  dir: string;
  db: Db;
  userId: string;
  registry: SessionRegistry;
  agents: () => Agents;
  /** The approval store's unattended map: chatId to auto-approved tools, set during a run. */
  unattended: Map<string, string[]>;
  /** Sends `text` to the chat's session the way `user.message` does. Resolves when the run ends. */
  prompt: (chatId: string, text: string) => Promise<void>;
  /** Web Push for `deliver: push | both`, after a successful run. */
  notify?: (chatId: string) => Promise<void>;
  log: FastifyBaseLogger;
};

export type Automations = ReturnType<typeof startAutomations>;

export function startAutomations({
  dir,
  db,
  userId,
  registry,
  agents,
  unattended,
  prompt,
  notify,
  log,
}: AutomationsDeps) {
  let list: Automation[] = [];
  let tasks: { stop(): void }[] = [];
  let closed = false;
  const running = new Set<string>();
  mkdirSync(dir, { recursive: true });

  const topicId = () => {
    const found = db
      .select({ id: topics.id })
      .from(topics)
      .where(and(eq(topics.userId, userId), eq(topics.name, TOPIC_NAME)))
      .get();
    if (found) return found.id;
    const id = randomUUID();
    db.insert(topics)
      .values({ id, userId, name: TOPIC_NAME, createdAt: new Date().toISOString() })
      .run();
    return id;
  };

  const record = (
    id: string,
    lastStatus: 'ok' | 'error',
    lastChatId: string | null,
    lastError: string | null,
  ) => {
    const row = { userId, lastRunAt: new Date().toISOString(), lastStatus, lastChatId, lastError };
    db.insert(automationRuns)
      .values({ id, ...row })
      .onConflictDoUpdate({ target: automationRuns.id, set: row })
      .run();
  };

  /** Returns true when skipped because the automation is already running. */
  const fire = async (a: Automation): Promise<boolean> => {
    if (running.has(a.id)) {
      log.info({ id: a.id }, 'automation still running, skipped');
      return true;
    }
    running.add(a.id);
    let chatId: string | null = null;
    let built = false;
    try {
      if (!agents().has(a.agentId)) throw new Error(`agent ${a.agentId} not found`);
      const now = new Date();
      const at = now.toLocaleString('sv-SE', { timeZone: a.timezone }).slice(0, 16);
      const title = `${a.id} ${at}`;
      chatId = randomUUID();
      // No model or policy columns: the profile's alias under ZDR (phase-10 decision 12).
      const row = db
        .insert(chats)
        .values({
          id: chatId,
          userId,
          agentId: a.agentId,
          topicId: topicId(),
          title,
          titleMasked: title,
          titleLocked: true,
          // Directory key only, as in `chat.create`.
          sessionPath: `sessions/${userId}/`,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .returning()
        .get();
      unattended.set(chatId, a.autoApprove);
      const session = await registry.create(chatId, row);
      built = true;
      // Nobody is there to consent: an automation never runs without ZDR (phase-10 proof 5).
      if (row.dataPolicy !== 'zdr' || session.model?.provider !== 'zdr')
        throw new Error('automation chat is not zdr');
      await prompt(chatId, a.prompt);
      const last = session.messages.findLast((m) => m.role === 'assistant');
      if (last && 'stopReason' in last && last.stopReason === 'error')
        throw new Error(last.errorMessage ?? 'model call failed');
      // The bridge indexes on `agent_settled`, but no socket listens to this chat.
      indexChat(db, userId, chatId, transcript(session)).catch((err: unknown) =>
        log.warn(
          { id: a.id, chatId, error: err instanceof Error ? err.message : 'unknown' },
          'index failed',
        ),
      );
      record(a.id, 'ok', chatId, null);
      log.info({ id: a.id, chatId }, 'automation ran');
      if (a.deliver !== 'chat') void notify?.(chatId);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn({ id: a.id, chatId, error }, 'automation failed');
      // Nobody listens to this session; opening the chat later rebuilds it from the JSONL.
      if (built && chatId) await registry.drop(chatId);
      try {
        record(a.id, 'error', chatId, error);
      } catch (recordErr) {
        log.warn(
          { id: a.id, error: recordErr instanceof Error ? recordErr.message : 'unknown' },
          'recording automation run failed',
        );
      }
    } finally {
      if (chatId) unattended.delete(chatId);
      running.delete(a.id);
    }
    return false;
  };

  const schedule = () => {
    for (const t of tasks) t.stop();
    list = loadAutomations(dir, (file, err) =>
      log.warn({ file, error: err instanceof Error ? err.message : String(err) }, 'bad automation'),
    ).filter((a) => {
      const known = agents().has(a.agentId);
      if (!known) log.warn({ id: a.id, agentId: a.agentId }, 'automation skipped: unknown agent');
      return known;
    });
    tasks = list
      .filter((a) => a.enabled)
      .map((a) => cron.schedule(a.cron, () => fire(a), { timezone: a.timezone, noOverlap: true }));
  };
  schedule();

  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(dir, () => {
    clearTimeout(timer);
    timer = setTimeout(() => !closed && schedule(), 1000);
  });

  return {
    state(): ServerMessage {
      const runs = new Map(
        db
          .select()
          .from(automationRuns)
          .where(eq(automationRuns.userId, userId))
          .all()
          .map((r) => [r.id, r]),
      );
      return {
        type: 'automations.state',
        automations: list.map(({ id, cron, agentId, enabled, deliver }) => ({
          id,
          cron,
          agentId,
          enabled,
          deliver,
          lastRunAt: runs.get(id)?.lastRunAt ?? null,
          lastStatus: running.has(id) ? 'running' : (runs.get(id)?.lastStatus ?? null),
          lastChatId: runs.get(id)?.lastChatId ?? null,
        })),
      };
    },
    /** Starts one run in the background, even when disabled. Undefined for an unknown id. */
    runNow(id: string) {
      const a = list.find((x) => x.id === id);
      if (!a) return undefined;
      if (running.has(id)) return { skipped: true };
      void fire(a);
      return { skipped: false };
    },
    close() {
      closed = true;
      clearTimeout(timer);
      watcher.close();
      for (const t of tasks) t.stop();
    },
  };
}
