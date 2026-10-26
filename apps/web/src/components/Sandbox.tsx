import { SANDBOX_CSP } from '@pa/protocol';
import { type RefObject, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * The artifact sandbox (brief 7.5), shared by the artifact panel and the HTML file preview
 * (phase-11 decision 9). The frame loads `/api/sandbox`, which has its own CSP header (a `srcdoc`
 * frame inherits the app's CSP, which blocks every inline script), and posts the document to it
 * (phase-19 decision 2).
 */
export const SANDBOX_URL = '/api/sandbox';
export const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`;
/** A user's HTML file keeps its own white page in both schemes (brief 7.5). */
export const SCHEME_META = '<meta name="color-scheme" content="light">';

/**
 * An HTML document for the sandbox. Our CSP is always the first element, before anything of the
 * document's own (even a <script> ahead of <head>); a later, looser policy cannot widen it. `head`
 * follows it: the scheme, and for artifacts the fonts, tokens and kit (phase 19).
 */
export const htmlDocument = (html: string, head = SCHEME_META) =>
  `<!doctype html>${CSP_META}${head}${html.replace(/^\s*<!doctype[^>]*>/i, '')}`;

/**
 * Posts `html` once to the sandbox page in `win` when it says it is ready. Once only: a page that
 * navigated away and says "ready" again gets nothing.
 */
export function postWhenReady(win: () => Window | null | undefined, html: string) {
  let sent = false;
  const onMessage = (e: MessageEvent) => {
    const w = win();
    if (sent || !w || e.source !== w || e.data !== 'sandbox-ready') return;
    sent = true;
    w.postMessage(html, '*');
  };
  addEventListener('message', onMessage);
  return () => removeEventListener('message', onMessage);
}

/** Radius 12 and a border; `themed` pages use --card (phase-19 decision 6), files stay white. */
export function SandboxFrame({
  title,
  html,
  themed,
  ref,
}: {
  title: string;
  html: string;
  themed?: boolean;
  ref?: RefObject<HTMLIFrameElement | null>;
}) {
  const own = useRef<HTMLIFrameElement>(null);
  const frame = ref ?? own;
  useEffect(() => postWhenReady(() => frame.current?.contentWindow, html), [html, frame]);
  return (
    <iframe
      // A new document needs a fresh page: the sandbox page writes one document only.
      key={html}
      ref={frame}
      title={title}
      sandbox="allow-scripts"
      src={SANDBOX_URL}
      className={cn('block size-full rounded-lg border', themed ? 'bg-card' : 'bg-white')}
    />
  );
}
