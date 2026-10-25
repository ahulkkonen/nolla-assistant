import { createHash } from 'node:crypto';
import type { Artifact, Message } from '@pa/protocol';

const KINDS: Record<string, Artifact['kind']> = {
  html: 'html',
  jsx: 'react',
  tsx: 'react',
  mermaid: 'mermaid',
};
const MIN_CODE_LINES = 30;
// Closing fence: same characters, at least as long as the opening one.
const FENCE = /^(`{3,}|~{3,})([^\n`]*)\n([\s\S]*?)\n\1[`~]*[ \t]*$/gm;
const HTML_HEADING = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i;
const MD_HEADING = /^#{1,6}[ \t]+(.+)$/m;

const headingOf = (lang: string, content: string) => {
  const html = HTML_HEADING.exec(content)?.[1];
  if (html) return html.replace(/<[^>]*>/g, '').trim();
  if (lang === 'md' || lang === 'markdown') return MD_HEADING.exec(content)?.[1]?.trim();
  return undefined;
};

/** Artifacts in an assistant text: `html`, `jsx`/`tsx`, `mermaid` blocks and code over 30 lines. */
export function extractArtifacts(messageId: string, text: string): Artifact[] {
  const out: Artifact[] = [];
  for (const [, , info = '', content = ''] of text.matchAll(FENCE)) {
    const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const kind = KINDS[lang] ?? (content.split('\n').length > MIN_CODE_LINES ? 'code' : undefined);
    if (!kind) continue;
    const index = out.length;
    out.push({
      id: createHash('sha1').update(`${messageId}${index}`).digest('hex'),
      kind,
      title: headingOf(lang, content) || `${lang || 'code'} #${index + 1}`,
      ...(lang ? { language: lang } : {}),
      content,
    });
  }
  return out;
}

/** Artifacts of every assistant message, in order (for `chat.state`). */
export const messageArtifacts = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === 'assistant' ? extractArtifacts(m.id, m.text) : []));
