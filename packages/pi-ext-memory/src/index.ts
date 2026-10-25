import { isAbsolute, relative } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export type Target = 'user' | 'memory';
export type MemoryWrite = {
  action: 'add' | 'replace' | 'remove';
  target: Target;
  text: string;
  replace?: string | undefined;
};
export type Snippet = { chatId: string; title: string; snippet: string; date: string };
export type MemoryLog = (level: 'warn' | 'debug', msg: string, data?: object) => void;

/** Characters after the change (plan §7). */
export const CAPS: Record<Target, number> = { user: 1500, memory: 2500 };
export const FILES: Record<Target, string> = { user: 'USER.md', memory: 'MEMORY.md' };
export const FULL = 'Muisti on täynnä: tiivistä ensin (`replace`/`remove`)';
const NOT_FOUND = 'Tekstiä ei löytynyt muistista.';

/** Applies one write to `current`; returns the new text or an error for the agent. */
export function applyOp(current: string, w: MemoryWrite): { text: string } | { error: string } {
  let text: string;
  if (w.action === 'add') text = current.trim() ? `${current.trimEnd()}\n${w.text}` : w.text;
  else {
    const old = w.action === 'replace' ? w.replace : w.text;
    if (!old || !current.includes(old)) return { error: NOT_FOUND };
    text = current.replace(old, w.action === 'replace' ? w.text : '').replace(/\n{3,}/g, '\n\n');
  }
  return text.length > CAPS[w.target] ? { error: FULL } : { text };
}

/** Untrusted tool output taints the turn (phase-8 decision 3). */
function untrusted(toolName: string, input: Record<string, unknown>, cwd: string) {
  if (['bash', 'recall', 'subagent'].includes(toolName) || toolName.startsWith('mcp__'))
    return true;
  if (toolName !== 'read' || typeof input.path !== 'string') return false;
  const rel = relative(cwd, isAbsolute(input.path) ? input.path : `${cwd}/${input.path}`);
  return rel.startsWith('..') || isAbsolute(rel) || rel === 'files' || rel.startsWith('files/');
}

const text = (t: string, isError = false) => ({
  content: [{ type: 'text' as const, text: t }],
  details: undefined,
  ...(isError ? { isError: true } : {}),
});

/**
 * Memory injection, `recall` and `memory` tools (plan §7). Add `recall` and `memory` to the host
 * `tools`. `mask` failing means nothing is injected (invariant 1).
 */
export function memoryExtension(opts: {
  userId: string;
  chatId: string;
  files: { read(target: Target): Promise<string> };
  mask: (text: string) => Promise<string> | string;
  recentTitles: () => Promise<string[]>;
  recall: (q: string, o: { since?: string; topic?: string }) => Promise<Snippet[]>;
  /** Parks a tainted write; resolves with the pending id. */
  park: (write: MemoryWrite) => Promise<number>;
  applyNow: (write: MemoryWrite) => Promise<void>;
  log: MemoryLog;
}): ExtensionFactory {
  let tainted = false;
  // The raw template and its masked form: unchanged files give byte-identical messages.
  let cache: { raw: string; masked: string } | undefined;

  return (pi) => {
    pi.on('before_agent_start', async (event) => {
      if (event.messageType !== 'user') return;
      const [user, memory, titles] = await Promise.all([
        opts.files.read('user'),
        opts.files.read('memory'),
        opts.recentTitles(),
      ]);
      const raw = `## Käyttäjä\n${user}\n\n## Muisti\n${memory}\n\n## Viimeisimmät keskustelut\n${titles.map((t) => `- ${t}`).join('\n')}`;
      if (cache?.raw !== raw) {
        try {
          cache = { raw, masked: await opts.mask(raw) };
        } catch (err) {
          cache = undefined;
          opts.log('warn', 'memory not injected: mask failed', {
            error: err instanceof Error ? err.name : 'unknown',
          });
          return;
        }
      }
      return { message: { customType: 'memory', display: false, content: cache.masked } };
    });

    pi.on('agent_start', () => {
      tainted = false;
    });

    pi.on('tool_result', (event, ctx) => {
      if (untrusted(event.toolName, event.input, ctx.cwd)) tainted = true;
    });

    pi.registerTool({
      name: 'recall',
      label: 'recall',
      description:
        'Search earlier chats (summaries and transcripts). Returns at most 5 snippets with dates and chat ids.',
      parameters: Type.Object({
        query: Type.String(),
        since: Type.Optional(Type.String({ description: 'ISO date, e.g. 2026-10-01' })),
        topic: Type.Optional(Type.String({ description: 'Topic id' })),
      }),
      async execute(_id, p) {
        const hits = await opts.recall(p.query, {
          ...(p.since ? { since: p.since } : {}),
          ...(p.topic ? { topic: p.topic } : {}),
        });
        if (!hits.length) return text('Ei osumia.');
        return text(
          hits
            .slice(0, 5)
            .map((h) => `- [${h.date.slice(0, 10)}] ${h.title} (${h.chatId}): ${h.snippet}`)
            .join('\n'),
        );
      },
    });

    pi.registerTool({
      name: 'memory',
      label: 'memory',
      description: `Edit long-term memory. target "user" = USER.md (who the user is, preferences; max ${CAPS.user} chars), "memory" = MEMORY.md (durable facts; max ${CAPS.memory} chars). add appends text; replace swaps the exact text in "replace" for "text"; remove deletes the exact text.`,
      parameters: Type.Object({
        action: Type.Union([Type.Literal('add'), Type.Literal('replace'), Type.Literal('remove')]),
        target: Type.Union([Type.Literal('user'), Type.Literal('memory')]),
        text: Type.String(),
        replace: Type.Optional(Type.String()),
      }),
      async execute(_id, p) {
        const write: MemoryWrite = { ...p };
        const r = applyOp(await opts.files.read(p.target), write);
        if ('error' in r) return text(r.error, true);
        if (tainted) return text(`Kirjoitus odottaa hyväksyntääsi (id ${await opts.park(write)})`);
        await opts.applyNow(write);
        return text('Tallennettu.');
      },
    });
  };
}
