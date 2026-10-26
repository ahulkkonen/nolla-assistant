import type { ExtensionFactory, ToolResultEventResult } from '@earendil-works/pi-coding-agent';
import type { Collision, Json, PseudoClient } from './client.ts';

export * from './client.ts';

export type PseudoLog = (level: 'warn' | 'debug', msg: string, data?: object) => void;

/** Logged (at `warn`) whenever the sidecar fails; the host tells the user. */
export const PSEUDO_DOWN = 'pseudo_down';
/** Logged (at `warn`) when user input names an issued surrogate; the input waits for `awaitCollision`. */
export const PSEUDO_COLLISION = 'pseudo_collision';
/** Logged (at `warn`) when collisions keep coming after three answers: the input is dropped, nothing waits. */
export const PSEUDO_COLLISION_DROPPED = 'pseudo_collision_dropped';

/**
 * Masks everything that enters the Pi session and unmasks tool arguments (plan §6, invariant 1).
 * Fails closed: with the sidecar down, input is dropped, tool calls are blocked, tool output is
 * replaced by an error and a failed leak scan aborts the turn. Logs carry kinds, ids and lengths
 * only, never text.
 */
export function pseudoExtension(opts: {
  client: PseudoClient;
  sessionId: string;
  log?: PseudoLog;
  /**
   * When set, what the user types is checked for names equal to issued surrogates (phase-12
   * decision 5). The input waits for this: true once the user answered every collision (the text
   * is masked again), false to drop it. Unset (a child process, no user to ask): no check.
   */
  awaitCollision?: (collisions: Collision[]) => Promise<boolean>;
}): ExtensionFactory {
  const { client, sessionId, log = () => {}, awaitCollision } = opts;
  const down = (hook: string, err: unknown) =>
    log('warn', PSEUDO_DOWN, { hook, error: err instanceof Error ? err.name : 'unknown' });

  return (pi) => {
    pi.on('input', async (event) => {
      if (!event.text) return;
      // Another extension's message may carry surrogates; only what a person sent is checked.
      const userInput = !!awaitCollision && event.source !== 'extension';
      try {
        let r = await client.mask(sessionId, event.text, { userInput });
        // Fail closed until the user answers in the vault; a later answer can raise a new collision.
        for (let round = 0; r.collisions?.length; round++) {
          const data = {
            hook: 'input',
            pendingIds: r.collisions.map((c) => c.pending_id),
            kinds: r.collisions.map((c) => c.kind),
          };
          if (round >= 3 || !awaitCollision) {
            log('warn', PSEUDO_COLLISION_DROPPED, data);
            return { action: 'handled' };
          }
          // Waiting before the host hears of it, so an answer cannot come first.
          const answered = awaitCollision(r.collisions);
          log('warn', PSEUDO_COLLISION, data);
          if (!(await answered)) return { action: 'handled' };
          r = await client.mask(sessionId, event.text, { userInput });
        }
        const { masked, spans } = r;
        // Whitelist: `real_form` and anything added later stay out of the session file.
        const kept = spans.map(({ start, end, entity_id, kind, surrogate }) => ({
          start,
          end,
          entity_id,
          kind,
          surrogate,
        }));
        pi.appendEntry('pseudo-spans', { spans: kept });
        log('debug', 'pseudo input', { length: event.text.length, spans: spans.length });
        return { action: 'transform', text: masked };
      } catch (err) {
        down('input', err);
        return { action: 'handled' };
      }
    });

    pi.on('tool_call', async (event) => {
      try {
        const { restored } = await client.unmask(event.input as Json);
        // Pi executes the same object, so restore in place.
        Object.assign(event.input, restored);
      } catch (err) {
        down('tool_call', err);
        return { block: true, reason: PSEUDO_DOWN };
      }
    });

    pi.on('tool_result', async (event): Promise<ToolResultEventResult> => {
      // `details` is persisted too (the edit tool puts the real diff there). Images pass through
      // unmasked: an accepted phase-3 gap (phase-3.md). Other non-text blocks (MCP `resource`,
      // `resource_link`, ...) go through /mask as JSON; binary `data`/`blob` and `type` stay as they are.
      const bin: string[] = [];
      const other = (b: { type: string }) => b.type !== 'text' && b.type !== 'image';
      const value: { [k: string]: Json } = {
        content: event.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])),
        blocks: event.content.filter(other).map((b) => stash(b as unknown as Json, bin)),
      };
      if (event.structuredContent !== undefined)
        value.structuredContent = stash(event.structuredContent as Json, bin);
      if (event.details !== undefined) value.details = event.details as Json;
      try {
        const { masked } = await client.mask(sessionId, value);
        const texts = (masked.content as string[]).values();
        const blocks = (masked.blocks as Json[]).values();
        return {
          content: event.content.map((b) =>
            b.type === 'text'
              ? { ...b, text: texts.next().value ?? '' }
              : other(b)
                ? (unstash(blocks.next().value ?? null, bin) as unknown as typeof b)
                : b,
          ),
          ...(masked.structuredContent !== undefined
            ? { structuredContent: unstash(masked.structuredContent, bin) }
            : {}),
          // Pi keeps the old value when `details` is undefined, so null clears it.
          details: masked.details ?? null,
        } as ToolResultEventResult;
      } catch (err) {
        down('tool_result', err);
        return { content: [{ type: 'text', text: PSEUDO_DOWN }], details: null, isError: true };
      }
    });

    // Per message index: the JSON last sent to /scan and the scanned JSON. Unchanged messages are
    // served from here, so each turn sends only new or changed messages (e.g. a compaction summary).
    const scanned: { sent: string; out: string }[] = [];
    pi.on('context_with_system', async (event, ctx) => {
      const messages = event.messages as unknown as Msg[];
      const sent = messages.map((m) => JSON.stringify(m, withoutImageData));
      const todo = sent.flatMap((json, i) => (scanned[i]?.sent === json ? [] : [i]));
      try {
        if (todo.length) {
          // Each message goes as JSON, so the sidecar masks string values only: a phone surrogate
          // in a number (`"total":0.0107338`) once broke the JSON text it used to get.
          const r = await client.scan(
            sessionId,
            todo.map((i) => ({
              role: messages[i]?.role ?? 'user',
              content: JSON.parse(sent[i] ?? 'null') as Json,
            })),
          );
          const outs = todo.map((_, k) => r.messages[k]?.content);
          // Checked before caching: a bad result must not be served again on later turns.
          if (!outs.every((o) => o && typeof o === 'object' && !Array.isArray(o)))
            throw new Error('scan: bad message');
          todo.forEach((i, k) => {
            scanned[i] = { sent: sent[i] ?? '', out: JSON.stringify(outs[k]) };
          });
          for (const l of r.leaked)
            log('warn', 'pseudo leak', {
              kind: l.kind,
              entityId: l.entity_id,
              messageIndex: todo[l.message_index],
            });
        }
        scanned.length = messages.length;
        const out = scanned.map((c, i) => withImages(JSON.parse(c.out) as Msg, messages[i]));
        return { messages: out as unknown as typeof event.messages };
      } catch (err) {
        // Fail closed (phase-3.md): the scan is the backstop for real values that ingest missed.
        // Pi ignores a throw here, so abort the turn and send no transcript.
        down('context_with_system', err);
        ctx.abort();
        return { messages: event.messages.filter((m) => m.role === 'system') };
      }
    });
  };
}

type Msg = { role: string; content?: unknown };
const isImage = (v: unknown): v is { type: 'image'; data: string } =>
  typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'image';

/** JSON replacer: base64 image data is not text to scan. */
const withoutImageData = (_k: string, v: unknown) => (isImage(v) ? { ...v, data: '' } : v);

/** Puts the original image blocks back; /scan changes strings only, so positions are stable. */
function withImages(out: Msg, original: Msg | undefined): Msg {
  const src = original?.content;
  if (Array.isArray(src) && Array.isArray(out.content))
    out.content = out.content.map((b: unknown, i: number) => (isImage(src[i]) ? src[i] : b));
  return out;
}

const BLOCK_TYPES = new Set(['text', 'image', 'audio', 'resource', 'resource_link']);
const BIN = '\u0000bin:';
const keep = (k: string, x: string) =>
  k === 'data' || k === 'blob' || (k === 'type' && BLOCK_TYPES.has(x));
/** Replaces binary `data`/`blob` and block `type` values with placeholders that /mask leaves alone. */
function stash(v: Json, out: string[]): Json {
  if (Array.isArray(v)) return v.map((x) => stash(x, out));
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) =>
      typeof x === 'string' && keep(k, x)
        ? [k, `${BIN}${out.push(x) - 1}`]
        : [k, stash(x as Json, out)],
    ),
  );
}
function unstash(v: Json, out: string[]): Json {
  if (typeof v === 'string' && v.startsWith(BIN)) return out[Number(v.slice(BIN.length))] ?? '';
  if (Array.isArray(v)) return v.map((x) => unstash(x, out));
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unstash(x as Json, out)]));
}
