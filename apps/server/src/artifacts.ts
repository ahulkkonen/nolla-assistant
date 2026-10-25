import { createHash } from 'node:crypto';
import type { Artifact, Message } from '@pa/protocol';

const KINDS: Record<string, Artifact['kind']> = {
  html: 'html',
  jsx: 'react',
  tsx: 'react',
  mermaid: 'mermaid',
};
const MIN_CODE_LINES = 30;
const MAX_INPUT = 200_000;
const TITLE_SCAN = 4096;
const MAX_TITLE = 120;
const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' };

const clean = (s: string) =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot);/g, (_, e: string) => ENTITIES[e] ?? '')
    .trim()
    .slice(0, MAX_TITLE);

/** First `<h1>`..`<h6>` text, or for markdown the first `#` heading, in the first 4 KB. */
function headingOf(lang: string, content: string): string | undefined {
  const head = content.slice(0, TITLE_SCAN);
  for (let i = head.indexOf('<h'); i >= 0; i = head.indexOf('<h', i + 2)) {
    if (!'123456'.includes(head[i + 2] ?? 'x')) continue;
    const gt = head.indexOf('>', i);
    const end = gt < 0 ? -1 : head.indexOf('</h', gt);
    if (end < 0) break;
    return clean(head.slice(gt + 1, end));
  }
  if (lang !== 'md' && lang !== 'markdown') return undefined;
  const line = head.split('\n').find((l) => /^#{1,6}[ \t]/.test(l));
  return line ? clean(line.replace(/^#+/, '')) : undefined;
}

/** Fenced blocks (CommonMark-like): `{ lang, content }`; an unterminated block is ignored. */
function fencedBlocks(text: string) {
  const blocks: { lang: string; content: string }[] = [];
  let open: { fence: string; lang: string; start: number } | undefined;
  const lines = text.slice(0, MAX_INPUT).split('\n');
  lines.forEach((line, i) => {
    if (!open) {
      const m = OPEN.exec(line);
      const fence = m?.[1] ?? '';
      const info = m?.[2] ?? '';
      // A backtick fence's info string must not contain backticks.
      if (m && !(fence[0] === '`' && info.includes('`')))
        open = { fence, lang: info.trim().split(/\s+/)[0]?.toLowerCase() ?? '', start: i + 1 };
      return;
    }
    const close = CLOSE.exec(line)?.[1];
    if (close && close[0] === open.fence[0] && close.length >= open.fence.length) {
      blocks.push({ lang: open.lang, content: lines.slice(open.start, i).join('\n') });
      open = undefined;
    }
  });
  return blocks;
}

/** Artifacts in an assistant text: `html`, `jsx`/`tsx`, `mermaid` blocks and code over 30 lines. */
export function extractArtifacts(messageId: string, text: string): Artifact[] {
  const out: Artifact[] = [];
  for (const { lang, content } of fencedBlocks(text)) {
    const kind = KINDS[lang] ?? (content.split('\n').length > MIN_CODE_LINES ? 'code' : undefined);
    if (!kind) continue;
    const index = out.length;
    out.push({
      id: createHash('sha1').update(`${messageId}:${index}`).digest('hex'),
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
