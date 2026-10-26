/**
 * User inputs held because they name an issued surrogate (phase-12 decision 8). The pseudo
 * extension's `input` hook waits on `wait`; the bridge calls `answered` after a pending item is
 * resolved and `cancel` when the chat stops or goes away. In memory: a restart drops the held
 * inputs (fail closed, the client still has the text).
 */
export type CollisionWaits = ReturnType<typeof collisionWaits>;

export function collisionWaits(timeoutMs = 30 * 60_000) {
  const waits = new Set<{ chatId: string; open: Set<number>; done: (ok: boolean) => void }>();
  return {
    /** True once every pending id is answered; false on timeout or `cancel`. */
    wait: (chatId: string, pendingIds: number[]) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => w.done(false), timeoutMs);
        timer.unref();
        const w = {
          chatId,
          open: new Set(pendingIds),
          done: (ok: boolean) => {
            clearTimeout(timer);
            waits.delete(w);
            resolve(ok);
          },
        };
        waits.add(w);
      }),
    answered(pendingId: number) {
      for (const w of [...waits]) if (w.open.delete(pendingId) && !w.open.size) w.done(true);
    },
    cancel(chatId: string) {
      for (const w of [...waits]) if (w.chatId === chatId) w.done(false);
    },
  };
}
