import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, watch } from 'node:fs';
import { basename, join } from 'node:path';
import { automationRuns, chats, type Db, topics } from '@pa/db';
import type { ServerMessage } from '@pa/protocol';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import cron from 'node-cron';
import { parse } from 'yaml';
import { z } from 'zod';
import type { SessionRegistry } from './pi/registry.ts';

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
  /** Sends `text` to the chat's session the way `user.message` does. Resolves when the run ends. */
  prompt: (chatId: string, text: string) => Promise<void>;
  log: FastifyBaseLogger;
};

export type Automations = ReturnType<typeof startAutomations>;

export function startAutomations({ dir, db, userId, registry, prompt, log }: AutomationsDeps) {
  let list: Automation[] = [];
  let tasks: { stop(): void }[] = [];
  let closed = false;

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

  const fire = async (a: Automation) => {
    let chatId: string | null = null;
    try {
      const now = new Date();
      const at = now.toLocaleString('sv-SE', { timeZone: a.timezone }).slice(0, 16);
      const title = `${a.id} ${at}`;
      chatId = randomUUID();
      db.insert(chats)
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
        .run();
      await registry.create(chatId, a.agentId);
      if (a.deliver !== 'chat') log.info({ id: a.id }, 'push not available until phase 7');
      await prompt(chatId, a.prompt);
      record(a.id, 'ok', chatId, null);
      log.info({ id: a.id, chatId }, 'automation ran');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      record(a.id, 'error', chatId, error);
      log.warn({ id: a.id, chatId, error }, 'automation failed');
    }
  };

  const schedule = () => {
    for (const t of tasks) t.stop();
    list = loadAutomations(dir, (file, err) =>
      log.warn({ file, error: err instanceof Error ? err.message : String(err) }, 'bad automation'),
    );
    tasks = list
      .filter((a) => a.enabled)
      .map((a) => cron.schedule(a.cron, () => fire(a), { timezone: a.timezone, noOverlap: true }));
  };
  schedule();

  let timer: NodeJS.Timeout | undefined;
  const watcher = existsSync(dir)
    ? watch(dir, () => {
        clearTimeout(timer);
        timer = setTimeout(() => !closed && schedule(), 1000);
      })
    : undefined;

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
        automations: list.map(({ id, cron, agentId, enabled }) => ({
          id,
          cron,
          agentId,
          enabled,
          lastRunAt: runs.get(id)?.lastRunAt ?? null,
          lastStatus: runs.get(id)?.lastStatus ?? null,
          lastChatId: runs.get(id)?.lastChatId ?? null,
        })),
      };
    },
    /** Runs one automation now, even when disabled. Returns false for an unknown id. */
    async runNow(id: string) {
      const a = list.find((x) => x.id === id);
      if (a) await fire(a);
      return !!a;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      watcher?.close();
      for (const t of tasks) t.stop();
    },
  };
}
