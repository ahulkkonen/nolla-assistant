import type { Collision } from '@nolla/pi-ext-pseudo';
import type { ServerMessage } from '@nolla/protocol';

/**
 * User messages held because they name an issued surrogate (phase-12 decisions 7 and 8). The pseudo
 * extension's `input` hook waits on `wait`. A hold starts with `chat.held` and ends with
 * `chat.released`: `resumed` when every pending item is answered, `dropped` on stop, chat delete,
 * timeout, a merged or hidden entity, or a stale answer. A dropped hold closes its pending items
 * (`expire`), so a later answer cannot resume another message on the same item. In memory: after a
 * restart `orphans` releases the chats whose items were still open.
 */
export type CollisionWaits = ReturnType<typeof collisionWaits>;

type Hold = {
  chatId: string;
  ids: number[];
  open: Set<number>;
  entities: Set<number>;
  end: (ok: boolean) => void;
};

export function collisionWaits(opts: {
  /** To the chat's sockets. */
  notify: (chatId: string, msg: ServerMessage) => void;
  /** Closes pending items that no held message waits on any more. */
  expire: (pendingIds: number[]) => void;
  timeoutMs?: number;
}) {
  const { notify, expire, timeoutMs = 30 * 60_000 } = opts;
  const holds = new Set<Hold>();
  const orphans = new Set<string>();
  const released = (chatId: string, outcome: 'resumed' | 'dropped'): ServerMessage => ({
    type: 'chat.released',
    chatId,
    outcome,
  });
  /** Items of `ids` that no live hold waits on. */
  const unused = (ids: number[]) => ids.filter((id) => ![...holds].some((h) => h.ids.includes(id)));
  const each = (pick: (h: Hold) => boolean, ok: boolean) => {
    for (const h of [...holds]) if (pick(h)) h.end(ok);
  };
  return {
    wait: (chatId: string, collisions: Collision[]) =>
      new Promise<boolean>((resolve) => {
        const ids = [...new Set(collisions.map((c) => c.pending_id))];
        const timer = setTimeout(() => h.end(false), timeoutMs);
        timer.unref();
        const h: Hold = {
          chatId,
          ids,
          open: new Set(ids),
          entities: new Set(collisions.map((c) => c.entity_id)),
          end: (ok) => {
            if (!holds.delete(h)) return;
            clearTimeout(timer);
            notify(chatId, released(chatId, ok ? 'resumed' : 'dropped'));
            const stale = ok ? [] : unused(ids);
            if (stale.length) expire(stale);
            resolve(ok);
          },
        };
        holds.add(h);
        orphans.delete(chatId);
        notify(chatId, { type: 'chat.held', chatId, pendingIds: ids });
      }),
    held: (chatId: string) => [...holds].some((h) => h.chatId === chatId),
    /** For a socket that connects: the live holds, and the chats a restart released. */
    list: (): ServerMessage[] => [
      ...[...holds].map(
        (h): ServerMessage => ({ type: 'chat.held', chatId: h.chatId, pendingIds: h.ids }),
      ),
      ...[...orphans].map((chatId) => released(chatId, 'dropped')),
    ],
    answered(pendingId: number) {
      for (const h of [...holds]) if (h.open.delete(pendingId) && !h.open.size) h.end(true);
    },
    /** A stale answer (the item was closed meanwhile): nothing can resume the holds on it. */
    drop: (pendingId: number) => each((h) => h.ids.includes(pendingId), false),
    /** Merged or hidden entities: the question no longer stands. */
    dropEntities: (entityIds: number[]) =>
      each((h) => entityIds.some((e) => h.entities.has(e)), false),
    cancel: (chatId: string) => each((h) => h.chatId === chatId, false),
    /** The extension gave up (collisions after three answers): no hold, so release and close here. */
    gaveUp(chatId: string, pendingIds: number[]) {
      notify(chatId, released(chatId, 'dropped'));
      const stale = unused(pendingIds);
      if (stale.length) expire(stale);
    },
    /** Chats with collision items left open by a restart: released as dropped to every new socket. */
    orphan: (chatIds: string[]) => {
      for (const c of chatIds) orphans.add(c);
    },
  };
}
