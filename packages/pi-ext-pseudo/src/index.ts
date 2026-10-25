import type { ExtensionFactory, ToolResultEventResult } from '@earendil-works/pi-coding-agent';
import type { Json, PseudoClient } from './client.ts';

export * from './client.ts';

export type PseudoLog = (level: 'warn' | 'debug', msg: string, data?: object) => void;

/** Logged (at `warn`) whenever the sidecar fails; the host tells the user. */
export const PSEUDO_DOWN = 'pseudo_down';

/**
 * Masks everything that enters the Pi session and unmasks tool arguments (plan §6, invariant 1).
 * Fails closed: with the sidecar down, input is dropped, tool calls are blocked and tool output is
 * replaced by an error. The leak scan fails open. Logs carry kinds, ids and lengths only, never text.
 */
export function pseudoExtension(opts: {
  client: PseudoClient;
  sessionId: string;
  log?: PseudoLog;
}): ExtensionFactory {
  const { client, sessionId, log = () => {} } = opts;
  const down = (hook: string, err: unknown) =>
    log('warn', PSEUDO_DOWN, { hook, error: err instanceof Error ? err.name : 'unknown' });

  return (pi) => {
    pi.on('input', async (event) => {
      if (!event.text) return;
      try {
        const { masked, spans } = await client.mask(sessionId, event.text);
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
      // unmasked: an accepted phase-3 gap (phase-3.md).
      const value: { [k: string]: Json } = {
        content: event.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])),
      };
      if (event.structuredContent !== undefined)
        value.structuredContent = event.structuredContent as Json;
      if (event.details !== undefined) value.details = event.details as Json;
      try {
        const { masked } = await client.mask(sessionId, value);
        const texts = (masked.content as string[]).values();
        return {
          content: event.content.map((b) =>
            b.type === 'text' ? { ...b, text: texts.next().value ?? '' } : b,
          ),
          structuredContent: masked.structuredContent,
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
    pi.on('context_with_system', async (event) => {
      const messages = event.messages as unknown as Msg[];
      const sent = messages.map((m) => JSON.stringify(m, withoutImageData));
      const todo = sent.flatMap((json, i) => (scanned[i]?.sent === json ? [] : [i]));
      try {
        if (todo.length) {
          const r = await client.scan(
            sessionId,
            todo.map((i) => ({ role: messages[i]?.role ?? 'user', content: sent[i] ?? '' })),
          );
          todo.forEach((i, k) => {
            const out = r.messages[k]?.content;
            if (typeof out !== 'string') throw new Error('scan: message count mismatch');
            scanned[i] = { sent: sent[i] ?? '', out };
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
        // Fail open (phase-3.md): ingest masking already holds; blocking would stop compaction.
        down('context_with_system', err);
        return undefined;
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
