import type { Artifact } from '@pa/protocol';
import { clsx } from 'clsx';
import { Check, Copy, Download, ExternalLink, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import runtimeUrl from '../artifact-runtime.ts?worker&url';
import { useStore } from '../store.ts';
import { IconButton } from './IconButton.tsx';

const EMPTY: Artifact[] = [];
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";
const EXT: Record<string, string> = { html: 'html', react: 'jsx', mermaid: 'mmd' };

/** `</script` inside inline code would end the script element early. */
const inline = (js: string) => js.replace(/<\/(script)/gi, '<\\/$1');
const page = (body: string, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width,initial-scale=1">${head}</head><body>${body}</body></html>`;
const BASE_STYLE = '<style>body{margin:16px;font-family:system-ui,sans-serif}</style>';

let runtime: Promise<string> | undefined;
const loadRuntime = () => {
  runtime ??= fetch(runtimeUrl).then((r) => r.text());
  return runtime;
};

let worker: Worker | undefined;
let seq = 0;
function transpile(source: string): Promise<string> {
  worker ??= new Worker(new URL('../transpile.worker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent<{ id: number; code?: string; error?: string }>) => {
      if (e.data.id !== id) return;
      w.removeEventListener('message', onMessage);
      if (e.data.code !== undefined) resolve(e.data.code);
      else reject(new Error(e.data.error ?? 'transpile failed'));
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ id, source });
  });
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The sandboxed document for an artifact; `code` and `file` have none. */
async function documentFor(a: Artifact, dark: boolean): Promise<string | null> {
  if (a.kind === 'html') {
    // Our CSP goes first in <head>; a later, looser policy cannot widen it.
    return /<head[^>]*>/i.test(a.content)
      ? a.content.replace(
          /<head[^>]*>/i,
          (m) => `${m}<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
        )
      : page(a.content);
  }
  if (a.kind === 'react') {
    const [rt, code] = await Promise.all([loadRuntime(), transpile(a.content)]);
    const boot = `(function(){var exports={},module={exports:exports};function require(n){if(n==='react')return React;if(n==='react-dom/client'||n==='react-dom')return ReactDOMClient;throw new Error('Moduulia ei ole saatavilla: '+n)}try{${code}
;var C=module.exports.default||exports.default;ReactDOMClient.createRoot(document.getElementById('root')).render(React.createElement(C))}catch(e){document.body.textContent='Virhe: '+e.message}})();`;
    return page(
      `<div id="root"></div><script>${inline(rt)}</script><script>${inline(boot)}</script>`,
      BASE_STYLE,
    );
  }
  if (a.kind === 'mermaid') {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
    });
    const { svg } = await mermaid.render(`m${a.id.replace(/\W/g, '')}`, a.content);
    return page(svg, BASE_STYLE);
  }
  return null;
}

/** Whether the page is dark now (system preference unless the user chose a theme). */
const isDark = (theme: string) =>
  theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);

function download(a: Artifact) {
  const ext = EXT[a.kind] ?? a.language ?? 'txt';
  const url = URL.createObjectURL(new Blob([a.content], { type: a.mime ?? 'text/plain' }));
  const link = Object.assign(document.createElement('a'), {
    href: url,
    download: `${a.title.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 60) || 'artefakti'}.${ext}`,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * A new tab gets a script-free wrapper page around a sandboxed iframe: a blob URL shares the app's
 * origin, so the artifact must never run in it directly.
 */
function openInTab(a: Artifact, doc: string | null) {
  const html = doc
    ? `<!doctype html><meta charset="utf-8"><title>${escapeHtml(a.title)}</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style><iframe sandbox="allow-scripts" srcdoc="${doc.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`
    : `<!doctype html><meta charset="utf-8"><title>${escapeHtml(a.title)}</title><pre>${escapeHtml(a.content)}</pre>`;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Right panel (> 1200 px beside the thread, 768–1200 px over it, < 768 px full screen) with one
 * tab per artifact of the chat.
 */
export function ArtifactPanel() {
  const open = useStore((s) => s.openArtifact);
  const list = useStore((s) => (s.openArtifact ? s.artifacts[s.openArtifact.chatId] : undefined));
  const theme = useStore((s) => s.theme);
  const artifacts = list ?? EMPTY;
  const a = artifacts.find((x) => x.id === open?.id);
  const [doc, setDoc] = useState<{ id: string; html: string | null; error?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!a) return;
    let live = true;
    setDoc(null);
    documentFor(a, isDark(theme)).then(
      (html) => live && setDoc({ id: a.id, html }),
      (err: unknown) =>
        live &&
        setDoc({ id: a.id, html: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [a, theme]);

  if (!open || !a) return null;
  const close = () => useStore.setState({ openArtifact: null });
  const ready = doc?.id === a.id ? doc : null;

  return (
    <aside
      aria-label="Artefaktit"
      className="fixed inset-0 z-30 flex flex-col bg-bg pt-[env(safe-area-inset-top)] md:absolute md:inset-y-0 md:right-0 md:left-auto md:w-120 md:border-l md:border-border xl:static xl:z-auto xl:shrink-0"
    >
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <div role="tablist" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {artifacts.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={x.id === a.id}
              onClick={() => useStore.setState({ openArtifact: { chatId: open.chatId, id: x.id } })}
              className={clsx(
                'h-9 max-w-48 shrink-0 truncate rounded-md px-3 text-secondary max-md:h-11',
                x.id === a.id ? 'bg-bg-sunken text-fg' : 'text-fg-muted hover:text-fg',
              )}
            >
              {x.title}
            </button>
          ))}
        </div>
        <IconButton
          label={copied ? 'Kopioitu' : 'Kopioi'}
          onClick={() =>
            void navigator.clipboard.writeText(a.content).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </IconButton>
        <IconButton label="Lataa" onClick={() => download(a)}>
          <Download size={16} />
        </IconButton>
        <IconButton
          label="Avaa uudessa välilehdessä"
          onClick={() => openInTab(a, ready?.html ?? null)}
        >
          <ExternalLink size={16} />
        </IconButton>
        <IconButton label="Sulje artefaktit" onClick={close}>
          <X size={20} />
        </IconButton>
      </div>
      <div role="tabpanel" aria-label={a.title} className="min-h-0 flex-1 overflow-auto">
        {a.kind === 'code' || a.kind === 'file' ? (
          <pre className="p-4 font-mono text-secondary whitespace-pre">{a.content}</pre>
        ) : ready?.error ? (
          <p className="p-4 text-fg-muted">Artefaktin näyttäminen epäonnistui: {ready.error}</p>
        ) : ready?.html ? (
          <iframe
            title={a.title}
            sandbox="allow-scripts"
            srcDoc={ready.html}
            className="block size-full border-0 bg-bg"
          />
        ) : (
          <p className="p-4 text-fg-muted">Ladataan…</p>
        )}
      </div>
    </aside>
  );
}
