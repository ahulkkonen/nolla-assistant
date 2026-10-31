import type { Artifact } from '@pa/protocol';
import { ImageDown, PanelRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import { type Doc, documentFor, exportFigure, type Scheme } from '../render.ts';
import { useStore } from '../store.ts';
import type { Refused } from '../viz.ts';
import { IconButton } from './IconButton.tsx';
import { SandboxFrame } from './Sandbox.tsx';

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
 * decision 4), for the thread's inline figures and the panel (`fill`). `doc` is null until the
 * document of this artifact is ready.
 */
export function useFigure(a: Artifact | undefined, fill = false) {
  const [doc, setDoc] = useState<(Doc & { id: string; error?: string }) | null>(null);
  const scheme = useScheme();
  const frame = useRef<HTMLIFrameElement>(null);

  // Keyed by content, not object identity: a streaming upsert of another artifact must not reload
  // this one. The old document stays up until the new one is ready.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by content, not by object identity
  useEffect(() => {
    if (!a) return;
    let live = true;
    documentFor(a, scheme, fill).then(
      (d) => live && setDoc({ id: a.id, ...d }),
      (err: unknown) =>
        live &&
        setDoc({ id: a.id, html: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [a?.id, a?.content, a?.kind, scheme, fill]);

  // A chart that fails inside the sandbox (Vega's own errors), or is not drawn in time, falls back
  // like a refused spec. A layout effect: the frame cannot load before `loaded` is set.
  const loaded = useRef(() => {});
  // The chart page answers an export only once drawn (its `viz-svg` listener comes after).
  const [drawn, setDrawn] = useState<string | null>(null);
  const chartHtml = doc?.rows ? doc.html : null;
  useLayoutEffect(() => {
    if (!chartHtml) return;
    const fail = (error: string) =>
      setDoc((d) => d && { ...d, html: null, refused: { error, rows: d.rows ?? [] } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Decision 6: 30 s from the frame's load event (a lazy frame off screen has not loaded), then
    // 10 s from the runtime's "viz-loaded" report (its script runs). Later load events (the
    // posted document's own) start nothing.
    loaded.current = () => {
      timer ??= setTimeout(() => fail('Kaavion piirto ei alkanut.'), LOAD_TIMEOUT);
    };
    const onMessage = (e: MessageEvent<{ type?: string; message?: unknown }>) => {
      if (e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === 'viz-loaded') {
        clearTimeout(timer);
        timer = setTimeout(() => fail('Kaavion piirto kesti yli 10 sekuntia.'), RENDER_TIMEOUT);
      }
      if (e.data?.type === 'viz-ready') {
        clearTimeout(timer);
        setDrawn(chartHtml);
      }
      if (e.data?.type === 'viz-error') fail(String(e.data.message));
    };
    addEventListener('message', onMessage);
    return () => {
      clearTimeout(timer);
      loaded.current = () => {};
      removeEventListener('message', onMessage);
    };
  }, [chartHtml]);

  const ready = a && doc?.id === a.id ? doc : null;
  const canExport = !!ready?.html && (!ready.rows || drawn === ready.html);
  const exportAs = (format: 'svg' | 'png') => {
    if (!a || !canExport) return;
    exportFigure(a, format, frame.current).catch((err: unknown) =>
      useStore.getState().pushError(`Vienti epäonnistui: ${(err as Error).message}`),
    );
  };
  return { doc: ready, frame, onLoad: () => loaded.current(), canExport, exportAs };
}

/**
 * Heights of drawn figures by artifact id: a figure that mounts again (the reply's end, another
 * chat and back) keeps its height instead of the placeholder's.
 */
const heights = new Map<string, number>();
const PLACEHOLDER = 240;

/**
 * A ```vega-lite or ```mermaid block in the thread (phase-20 decision 3): a card with a 36 px
 * header (48 under 768) of the kind and two actions, then the figure's own sandbox page.
 */
export function InlineFigure({ a, onOpen }: { a: Artifact; onOpen: () => void }) {
  const { doc, frame, onLoad, canExport, exportAs } = useFigure(a);
  const [height, setHeight] = useState(() => heights.get(a.id));
  const onSize = (h: number) => {
    heights.set(a.id, h);
    setHeight(h);
  };
  return (
    <figure aria-label={a.title} className="overflow-hidden rounded-lg border bg-card font-sans">
      {/* The icons' ink 16 px from the edge, as the label and the chart (UI review); phones keep
          their 44 px targets at 4 px. */}
      <div className="flex h-9 items-center gap-1 pr-[9px] pl-4 max-md:h-12 max-md:gap-2 max-md:pr-1">
        <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">
          {a.kind === 'mermaid' ? 'Kaavio' : 'Kuvaaja'}
        </span>
        <IconButton label="Avaa paneelissa" className="size-7" onClick={onOpen}>
          <PanelRight size={16} />
        </IconButton>
        <IconButton
          label="Lataa PNG"
          className="size-7"
          disabled={!canExport}
          onClick={() => exportAs('png')}
        >
          <ImageDown size={16} />
        </IconButton>
      </div>
      {doc?.refused ? (
        <ChartFallback refused={doc.refused} className="max-h-120 rounded-none border-0" />
      ) : doc?.error ? (
        <p className="px-4 pb-4 text-meta text-muted-foreground">
          Kaavion näyttäminen epäonnistui: {doc.error}
        </p>
      ) : (
        // Decision 5: 240 px and "Piirretään…" until the page tells its height.
        <div className="relative" style={{ height: height ?? PLACEHOLDER }}>
          {doc?.html && (
            <SandboxFrame
              ref={frame}
              title={a.title}
              html={doc.html}
              themed
              onLoad={onLoad}
              onSize={onSize}
            />
          )}
          {height === undefined && (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-meta text-muted-foreground">
              Piirretään…
            </p>
          )}
        </div>
      )}
    </figure>
  );
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
              // biome-ignore lint/suspicious/noArrayIndexKey: no ids; position is the identity
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
