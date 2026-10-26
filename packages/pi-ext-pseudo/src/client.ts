/**
 * Typed client for the `pseudo-svc` sidecar (contract: docs/decisions/phase-3.md). All offsets are
 * UTF-16 code units, i.e. JavaScript string indexes.
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Offsets are in the masked text. `real_form` is a real value: never log or persist it. */
export type MaskSpan = {
  start: number;
  end: number;
  entity_id: number;
  kind: string;
  surrogate: string;
  real_form: string;
  detector: string;
  score: number;
  pending: boolean;
};
/** Offsets are in the restored text. */
export type UnmaskSpan = { start: number; end: number; entity_id: number; surrogate_form: string };
export type Unresolved = { start: number; end: number; form: string };
export type Leak = {
  message_index: number;
  start: number;
  end: number;
  kind: string;
  entity_id: number;
};
/** `content` is the whole message as JSON; the sidecar masks its string values. */
export type ScanMessage = { role: string; content: Json };
/** User input equal to an issued surrogate of `entity_id`, parked in the pending lane (phase-12 decision 7). */
export type Collision = { pending_id: number; entity_id: number; kind: string };

/** `canonical` and pending `text` are real values: never log them. */
export type VaultEntityRow = {
  id: number;
  kind: string;
  canonical: string;
  surrogate: string;
  mode: 'realistic' | 'placeholder';
  pinned: boolean;
  allowlisted: boolean;
  seen_count: number;
  last_seen: string | null;
};
export type VaultPendingRow = {
  id: number;
  kind: string;
  text: string;
  detector: string;
  score: number;
  session_id: string;
  /** `collision`: `text` equals an issued surrogate of `entity_id`; answered with accept or reject. */
  reason: 'uncertain' | 'collision';
  entity_id: number | null;
};
/**
 * confirm, dismiss, allowlist: an uncertain detection. accept (a new person), reject (that entity): a
 * collision. expire: the host closes a collision whose held message was dropped. An answered item: 409.
 */
export type PendingAction = 'confirm' | 'dismiss' | 'allowlist' | 'accept' | 'reject' | 'expire';
export type VaultPatch = {
  pinned?: boolean;
  allowlisted?: boolean;
  mode?: 'realistic' | 'placeholder';
  regenerate?: true;
  never_detect?: true;
};

export class PseudoDownError extends Error {
  override name = 'PseudoDownError';
}

const TIMEOUT_MS = 5000;

export class PseudoClient {
  private readonly url: string;
  private readonly userId: string;

  constructor(url: string, userId: string) {
    this.url = url.replace(/\/+$/, '');
    this.userId = userId;
  }

  /**
   * A string is sent as `text`, anything else as `json`; the result has the same shape. `userInput`
   * (text the user typed) also checks for names equal to issued surrogates: with `collisions`,
   * `masked` is empty.
   */
  mask<T extends Json>(sessionId: string, value: T, opts: { userInput?: boolean } = {}) {
    return this.post<{ masked: T; spans: MaskSpan[]; collisions?: Collision[] }>('/mask', {
      session_id: sessionId,
      ...(typeof value === 'string' ? { text: value } : { json: value }),
      ...(opts.userInput ? { user_input: true } : {}),
    });
  }

  unmask<T extends Json>(value: T) {
    return this.post<{
      restored: T;
      spans: UnmaskSpan[];
      unresolved: Unresolved[];
      /** Trailing masked units that may start a surrogate; 0 for json. */
      hold: number;
    }>('/unmask', typeof value === 'string' ? { text: value } : { json: value });
  }

  /** Timeout grows with the batch: 5 s plus 1 s per 10 messages. */
  scan(sessionId: string, messages: ScanMessage[]) {
    return this.post<{ messages: ScanMessage[]; leaked: Leak[] }>(
      '/scan',
      { session_id: sessionId, messages },
      TIMEOUT_MS + 1000 * Math.ceil(messages.length / 10),
    );
  }

  /**
   * A forked chat (`to`) knows the entities that `from` had seen up to `until` (ISO 8601 UTC), so
   * its copied surrogates are not masked again (phase-13 decision 3).
   */
  forkSession(from: string, to: string, until: string) {
    return this.post<{ ok: true; entities: number }>('/session/fork', {
      from_session_id: from,
      to_session_id: to,
      until,
    });
  }

  /** Removes what `forkSession` copied into `sessionId` (a failed fork, a deleted chat). */
  dropFork(sessionId: string) {
    return this.post<{ ok: true; entities: number }>('/session/fork/drop', {
      session_id: sessionId,
    });
  }

  vaultList() {
    return this.post<{ entities: VaultEntityRow[]; pending: VaultPendingRow[] }>(
      `/vault/entities?user_id=${encodeURIComponent(this.userId)}`,
      null,
    );
  }

  vaultMerge(fromIds: number[], intoId: number) {
    return this.post<{ ok: true }>('/vault/merge', { from_ids: fromIds, into_id: intoId });
  }

  vaultSplit(entityId: number, spanIds: number[]) {
    return this.post<{ ok: true; new_entity_id: number }>('/vault/split', {
      entity_id: entityId,
      span_ids: spanIds,
    });
  }

  vaultUpdate(entityId: number, patch: VaultPatch) {
    return this.post<{ entity: VaultEntityRow }>(`/vault/entity/${entityId}`, patch);
  }

  vaultPending(pendingId: number, action: PendingAction) {
    return this.post<{ ok: true }>(`/vault/pending/${pendingId}`, { action });
  }

  vaultSeed(entities: { canonical: string; kind: string }[]) {
    return this.post<{ ok: true; ids: number[] }>('/vault/seed', { entities });
  }

  /** `body: null` sends a GET (the path carries `user_id`). */
  private async post<R>(path: string, body: object | null, timeout = TIMEOUT_MS): Promise<R> {
    const route = path.split('?')[0];
    try {
      const res = await fetch(this.url + path, {
        ...(body
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ user_id: this.userId, ...body }),
            }
          : {}),
        signal: AbortSignal.timeout(timeout),
      });
      // The status only: a body may echo real values.
      if (!res.ok) throw new PseudoDownError(`pseudo-svc ${route} status ${res.status}`);
      return (await res.json()) as R;
    } catch (err) {
      if (err instanceof PseudoDownError) throw err;
      throw new PseudoDownError(`pseudo-svc ${route} unreachable`, { cause: err });
    }
  }
}
