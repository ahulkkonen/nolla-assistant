import { SANDBOX_CSP } from '@nolla/protocol';
import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * The artifact sandbox (brief 7.5), shared by the artifact panel and the HTML file preview
 * (phase-11 decision 9). The frame loads `/api/sandbox`, which has its own CSP header (a `srcdoc`
 * frame inherits the app's CSP, which blocks every inline script), and posts the document to it
 * (phase-19 decision 2).
 */
export const SANDBOX_URL = '/api/sandbox';
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`;
/** A user's HTML file keeps its own white page in both schemes (brief 7.5). */
const SCHEME_META = '<meta name="color-scheme" content="light">';

/**
 * An HTML document for the sandbox. Our CSP is always the first element, before anything of the
 * document's own (even a <script> ahead of <head>); a later, looser policy cannot widen it. `head`
 * follows it: the scheme, and for artifacts the fonts, tokens and kit (phase 19).
 */
export const htmlDocument = (html: string, head = SCHEME_META) =>
  `<!doctype html>${CSP_META}${head}${html.replace(/^\s*<!doctype[^>]*>/i, '')}`;

/**
 * Posts `html` once to the sandbox page in `win` when it says it is ready, then stops listening:
 * a page that navigated away and says "ready" again gets nothing.
 */
export function postWhenReady(win: () => Window | null | undefined, html: string) {
  const stop = () => removeEventListener('message', onMessage);
  const onMessage = (e: MessageEvent) => {
    const w = win();
    // The page is CSP-sandboxed: its messages come from the opaque origin "null", and a message
    // to it can only name '*' (a measured fact; our own origin never matches an opaque one).
    if (!w || e.source !== w || e.origin !== 'null' || e.data !== 'sandbox-ready') return;
    stop();
    w.postMessage(html, '*');
  };
  addEventListener('message', onMessage);
  return stop;
}

/**
 * A file's page: white, radius 12 and a border. A `themed` artifact page sits on the panel's own
 * --card surface without a frame (phase-19 decision 6). With `onSize` the frame is an inline
 * figure (phase-20 decision 5): lazy, and told its document's height by the page (`viz-size`),
 * from its own window only, clamped to 80–2400 px.
 */
export function SandboxFrame({
  title,
  html,
  themed,
  ref,
  onLoad,
  onSize,
}: {
  title: string;
  html: string;
  themed?: boolean;
  ref?: RefObject<HTMLIFrameElement | null>;
  /** The frame's load event: a chart's load timer starts there (phase-20 decision 6). */
  onLoad?: () => void;
  onSize?: (height: number) => void;
}) {
  const own = useRef<HTMLIFrameElement>(null);
  const frame = ref ?? own;
  // A layout effect: nothing runs between the frame's insert and the listener (decision 14).
  useLayoutEffect(() => postWhenReady(() => frame.current?.contentWindow, html), [html, frame]);
  useEffect(() => {
    if (!onSize) return;
    const onMessage = (e: MessageEvent<{ type?: string; height?: unknown }>) => {
      const h = e.data?.height;
      if (e.source !== frame.current?.contentWindow || e.data?.type !== 'viz-size') return;
      if (typeof h === 'number' && Number.isFinite(h)) onSize(Math.min(2400, Math.max(80, h)));
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, [onSize, frame]);
  return (
    <iframe
      // A new document needs a fresh page: the sandbox page writes one document only.
      key={html}
      ref={frame}
      title={title}
      sandbox="allow-scripts"
      src={SANDBOX_URL}
      {...(onSize ? { loading: 'lazy' as const } : {})}
      onLoad={onLoad}
      className={cn('block size-full', themed ? 'bg-card' : 'rounded-lg border bg-white')}
    />
  );
}
