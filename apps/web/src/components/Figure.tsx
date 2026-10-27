import type { Artifact } from '@pa/protocol';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import { type Doc, documentFor, exportFigure, type Scheme } from '../render.ts';
import { useStore } from '../store.ts';
import type { Refused } from '../viz.ts';

const RENDER_TIMEOUT = 10_000;
const LOAD_TIMEOUT = 30_000;

const darkQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
const onScheme = (cb: () => void) => {
  darkQuery?.addEventListener('change', cb);
  return () => darkQuery?.removeEventListener('change', cb);
};
/** The active scheme: the theme setting, or the OS while it is `system`. */
function useScheme(): Scheme {
  const theme = useStore((s) => s.theme);
  const osDark = useSyncExternalStore(onScheme, () => darkQuery?.matches ?? false);
  return theme === 'system' ? (osDark ? 'dark' : 'light') : theme;
}

/**
 * One artifact's sandbox document, its frame, the chart fallback and the export (phase-20
 * decision 4), for the thread's inline figures and the panel. `doc` is null until the document of
 * this artifact is ready.
 */
export function useFigure(a: Artifact | undefined) {
  const [doc, setDoc] = useState<(Doc & { id: string; error?: string }) | null>(null);
  const scheme = useScheme();
  const frame = useRef<HTMLIFrameElement>(null);

  // Keyed by content, not object identity: a streaming upsert of another artifact must not reload
  // this one. The old document stays up until the new one is ready.
  useEffect(() => {
    if (!a) return;
    let live = true;
    documentFor(a, scheme).then(
      (d) => live && setDoc({ id: a.id, ...d }),
      (err: unknown) =>
        live &&
        setDoc({ id: a.id, html: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [a?.id, a?.content, a?.kind, scheme]);

  // A chart that fails inside the sandbox (Vega's own errors), or is not drawn within 10 s,
  // falls back like a refused spec.
  const chartHtml = doc?.rows ? doc.html : null;
  useEffect(() => {
    if (!chartHtml) return;
    const fail = (error: string) =>
      setDoc((d) => d && { ...d, html: null, refused: { error, rows: d.rows ?? [] } });
    // 10 s from the frame's "loaded" report (its script runs); a frame that never reports fails
    // after 30 s.
    let timer = setTimeout(() => fail('Kaavion piirto ei alkanut.'), LOAD_TIMEOUT);
    const onMessage = (e: MessageEvent<{ type?: string; message?: unknown }>) => {
      if (e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === 'viz-loaded') {
        clearTimeout(timer);
        timer = setTimeout(() => fail('Kaavion piirto kesti yli 10 sekuntia.'), RENDER_TIMEOUT);
      }
      if (e.data?.type === 'viz-ready') clearTimeout(timer);
      if (e.data?.type === 'viz-error') fail(String(e.data.message));
    };
    addEventListener('message', onMessage);
    return () => {
      clearTimeout(timer);
      removeEventListener('message', onMessage);
    };
  }, [chartHtml]);

  const ready = a && doc?.id === a.id ? doc : null;
  const exportAs = (format: 'svg' | 'png') => {
    const theme = ready?.html ? ready.theme : undefined;
    if (!a || !theme) return;
    exportFigure(a, format, ready?.svg ?? frame.current, ready?.lifted ?? {}, theme).catch(
      (err: unknown) =>
        useStore.getState().pushError(`Vienti epäonnistui: ${(err as Error).message}`),
    );
  };
  return { doc: ready, frame, exportAs };
}

/** R6 fallback: the error and the spec's data as a table, outside the sandbox. */
export function ChartFallback({
  refused: { error, rows },
  className,
}: {
  refused: Refused;
  className?: string;
}) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) =>
    typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
  return (
    <div
      role="region"
      aria-label="Kaavion data"
      // A scrollable region must be focusable (brief 7.8).
      tabIndex={0}
      className={cn('size-full overflow-auto rounded-lg border p-4', className)}
    >
      <p className="font-semibold">Kaavio epäonnistui</p>
      <p className="mt-1 text-meta whitespace-pre-wrap text-muted-foreground">{error}</p>
      {cols.length > 0 && (
        <table className="mt-4 border-collapse text-body tabular-nums">
          <thead>
            <tr>
              {cols.map((c) => (
                <th
                  key={c}
                  className="border-b px-2 py-1 text-left text-meta font-medium text-muted-foreground"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 500).map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c} className="border-b px-2 py-1">
                    {cell(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
