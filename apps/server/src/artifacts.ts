import { createHash } from 'node:crypto';
import { type Artifact, artifactKind, artifactTitle, type Message } from '@pa/protocol';

const MAX_INPUT = 200_000;
const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

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

/** Artifacts in an assistant text: `html`, `jsx`/`tsx`, `mermaid` and `vega-lite` blocks. */
export function extractArtifacts(messageId: string, text: string): Artifact[] {
  const out: Artifact[] = [];
  for (const { lang, content } of fencedBlocks(text)) {
    const kind = artifactKind(lang);
    if (!kind) continue;
    const index = out.length;
    out.push({
      id: createHash('sha1').update(`${messageId}:${index}`).digest('hex'),
      kind,
      title: artifactTitle(kind, content) ?? `${lang} #${index + 1}`,
      language: lang,
      content,
    });
  }
  return out;
}

/** Artifacts of every assistant message, in order (for `chat.state`). */
export const messageArtifacts = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === 'assistant' ? extractArtifacts(m.id, m.text) : []));
