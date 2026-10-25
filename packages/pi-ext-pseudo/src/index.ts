import type { ExtensionFactory, ToolResultEventResult } from '@earendil-works/pi-coding-agent';
import type { Json, PseudoClient } from './client.ts';

export * from './client.ts';

export type PseudoLog = (level: 'warn' | 'debug', msg: string, data?: object) => void;

/** Logged (at `warn`) whenever the sidecar fails; the host tells the user. */
export const PSEUDO_DOWN = 'pseudo_down';

type Block = { type: string; text?: string };
type LooseMessage = { role: string; content?: string | Block[] };

/**
 * Masks everything that enters the Pi session and unmasks tool arguments (plan §6, invariant 1).
 * Fails closed: with the sidecar down, input is dropped, tool calls are blocked and tool output is
 * replaced by an error. Logs carry kinds, ids and lengths only, never text.
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
        // `real_form` stays out of the session file (masked-only sessions).
        pi.appendEntry('pseudo-spans', { spans: spans.map(({ real_form: _, ...s }) => s) });
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
      const content = event.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));
      const value =
        event.structuredContent === undefined
          ? { content }
          : { content, structuredContent: event.structuredContent as Json };
      try {
        const { masked } = await client.mask(sessionId, value);
        const texts = masked.content.values();
        return {
          // Images pass through; text blocks are replaced in order.
          content: event.content.map((b) =>
            b.type === 'text' ? { ...b, text: texts.next().value ?? '' } : b,
          ),
          structuredContent: 'structuredContent' in masked ? masked.structuredContent : undefined,
        } as ToolResultEventResult;
      } catch (err) {
        down('tool_result', err);
        return { content: [{ type: 'text', text: PSEUDO_DOWN }], isError: true };
      }
    });

    pi.on('context_with_system', async (event) => {
      const messages = structuredClone(event.messages) as unknown as LooseMessage[];
      const parts: { index: number; text: string; set: (t: string) => void }[] = [];
      messages.forEach((m, index) => {
        if (typeof m.content === 'string')
          parts.push({ index, text: m.content, set: (t) => (m.content = t) });
        else
          for (const b of m.content ?? [])
            if (b.type === 'text' && typeof b.text === 'string')
              parts.push({ index, text: b.text, set: (t) => (b.text = t) });
      });
      try {
        const scanned = await client.scan(
          sessionId,
          parts.map((p) => ({ role: messages[p.index]?.role ?? 'user', content: p.text })),
        );
        scanned.messages.forEach((m, i) => parts[i]?.set(m.content));
        for (const l of scanned.leaked)
          log('warn', 'pseudo leak', {
            kind: l.kind,
            entityId: l.entity_id,
            messageIndex: parts[l.message_index]?.index,
          });
        return { messages: messages as unknown as typeof event.messages };
      } catch (err) {
        // Ingest masking already holds; blocking here would also stop compaction.
        down('context_with_system', err);
        return undefined;
      }
    });
  };
}
