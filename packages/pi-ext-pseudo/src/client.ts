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
export type ScanMessage = { role: string; content: string };

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

  /** A string is sent as `text`, anything else as `json`; the result has the same shape. */
  mask<T extends Json>(sessionId: string, value: T) {
    return this.post<{ masked: T; spans: MaskSpan[] }>('/mask', {
      session_id: sessionId,
      ...(typeof value === 'string' ? { text: value } : { json: value }),
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

  private async post<R>(path: string, body: object, timeout = TIMEOUT_MS): Promise<R> {
    try {
      const res = await fetch(this.url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: this.userId, ...body }),
        signal: AbortSignal.timeout(timeout),
      });
      // The status only: a body may echo real values.
      if (!res.ok) throw new PseudoDownError(`pseudo-svc ${path} status ${res.status}`);
      return (await res.json()) as R;
    } catch (err) {
      if (err instanceof PseudoDownError) throw err;
      throw new PseudoDownError(`pseudo-svc ${path} unreachable`, { cause: err });
    }
  }
}
