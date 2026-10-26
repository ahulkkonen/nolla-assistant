/**
 * The artifact sandbox (brief 7.5), shared by the artifact panel and the HTML file preview
 * (phase-11 decision 9): our CSP meta first, a white page, an iframe that may run scripts only.
 */
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";
export const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
/** The document keeps its own white page in both schemes (brief 7.5). */
export const SCHEME_META = '<meta name="color-scheme" content="light">';

/**
 * An HTML document for the sandbox. Our CSP is always the first element, before anything of the
 * document's own (even a <script> ahead of <head>); a later, looser policy cannot widen it.
 */
export const htmlDocument = (html: string) =>
  `<!doctype html>${CSP_META}${SCHEME_META}${html.replace(/^\s*<!doctype[^>]*>/i, '')}`;

/** Its own white page in both schemes, with radius 12 and a border. */
export function SandboxFrame({ title, html }: { title: string; html: string }) {
  return (
    <iframe
      title={title}
      sandbox="allow-scripts"
      srcDoc={html}
      className="block size-full rounded-lg border bg-white"
    />
  );
}
