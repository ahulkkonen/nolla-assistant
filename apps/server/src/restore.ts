/**
 * Surrogates back to real values for display: `restorer` wraps one `pseudo.unmask` per text and
 * stops calling the sidecar after its first failure; `release` restores the part of streamed
 * masked text that no surrogate can still extend.
 *
 * It only reads from the sidecar. It must not mask, store real values or send frames; callers
 * decide where the restored text goes and what `onDown` reports.
 */
import type { PseudoClient } from '@nolla/pi-ext-pseudo';
import type { Annotation } from '@nolla/protocol';
import { isHigh, isLow } from './session-text.ts';

type Restored = { text: string; annotations: Annotation[]; hold: number };
export type Restore = ((text: string) => Promise<Restored>) & { reset(): void };

/**
 * Surrogates back to real values for display. After the first sidecar failure it calls `onDown`
 * once and returns masked text without annotations, skipping the sidecar until `reset()`.
 */
export function restorer(pseudo: PseudoClient | undefined, onDown: () => void): Restore {
  let failed = false;
  const restore = async (text: string): Promise<Restored> => {
    if (!pseudo || failed || !text) return { text, annotations: [], hold: 0 };
    try {
      const { restored, spans, hold } = await pseudo.unmask(text);
      const annotations = spans.map((s) => ({
        start: s.start,
        end: s.end,
        entityId: s.entity_id,
        modelSaw: s.surrogate_form,
      }));
      return { text: restored, annotations, hold: Math.min(Math.max(hold, 0), text.length) };
    } catch {
      // Once, also when parallel calls fail together (`history`).
      if (!failed) onDown();
      failed = true;
      return { text, annotations: [], hold: 0 };
    }
  };
  return Object.assign(restore, {
    reset: () => {
      failed = false;
    },
  });
}

/**
 * Restores the releasable part of streamed masked text (offsets are UTF-16 code units). `pending`
 * is unmasked whole; the sidecar's `hold` (masked tail that may start a surrogate) stays back
 * unless `final`. The cut never splits a UTF-16 pair and moves back to the start of any restored
 * span it would split. Returns the restored prefix with chunk-relative annotations and the masked
 * rest.
 */
export async function release(restore: Restore, pending: string, final: boolean) {
  const r = await restore(pending);
  let cut = pending.length - (final ? 0 : r.hold);
  if (!final && cut > 0 && (isLow(pending.charCodeAt(cut)) || isHigh(pending.charCodeAt(cut - 1))))
    cut--;
  let shift = 0;
  const annotations: Annotation[] = [];
  for (const a of r.annotations) {
    const start = a.start - shift;
    const end = start + a.modelSaw.length;
    if (end > cut) {
      if (start < cut) cut = start;
      break;
    }
    annotations.push(a);
    shift += a.end - a.start - a.modelSaw.length;
  }
  return { out: { text: r.text.slice(0, cut + shift), annotations }, rest: pending.slice(cut) };
}
