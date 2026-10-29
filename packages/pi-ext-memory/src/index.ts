import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
export const NOT_FOUND = 'Tekstiä ei löytynyt muistista.';
/** The bridge appends inlined documents after this marker (untrusted text). */
export const ATTACHMENT_MARKER = '\n\n[Liite: ';
/** Phase 17: the per-turn claims message (decision 1). */
export const CLAIMS_TYPE = 'memory-claims';
export const CLAIMS_HEADER =
  '## Muistista tähän viestiin\nTaustatietoa käyttäjästä. Käytä vain, jos se liittyy viestiin. Suluissa laji, varmuus ja aika.';
/** Claim ids per session; then no more blocks (decision 8). */
export const CLAIMS_SESSION_CAP = 40;
const CLAIMS_TIMEOUT_MS = 1000;
const BAD_SINCE = 'since: anna ISO-päivämäärä (VVVV-KK-PP) tai -aika.';
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Applies one write to `current`; returns the new text or an error for the agent. Only a write
 * that grows the text past the cap fails, so shrinking writes always pass.
 */
export function applyOp(current: string, w: MemoryWrite): { text: string } | { error: string } {
  let text: string;
  if (w.action === 'add') text = current.trim() ? `${current.trimEnd()}\n${w.text}` : w.text;
  else {
    const old = w.action === 'replace' ? w.replace : w.text;
    if (!old || !current.includes(old)) return { error: NOT_FOUND };
    text = current.replace(old, w.action === 'replace' ? w.text : '').replace(/\n{3,}/g, '\n\n');
  }
  return text.length > CAPS[w.target] && text.length > current.length ? { error: FULL } : { text };
}

/** One line, no control characters, at most 80 chars. */
export const sanitizeTitle = (t: string) =>
  t
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .slice(0, 80);

/**
 * Allowlist (phase-8 decision 3): only `memory` and a `read` of a real path inside `cwd` and not
 * under `files/` keep the turn clean. Every other tool taints it.
 */
export function cleanTool(toolName: string, input: Record<string, unknown>, cwd: string) {
  if (toolName === 'memory') return true;
  if (toolName !== 'read' || typeof input.path !== 'string') return false;
  let p = input.path.replace(/^@/, '');
  if (p === '~' || p.startsWith('~/')) p = homedir() + p.slice(1);
  try {
    const rel = relative(realpathSync(cwd), realpathSync(resolve(cwd, p)));
    return (
      rel !== '' &&
      !rel.startsWith('..') &&
      !isAbsolute(rel) &&
      rel !== 'files' &&
      !rel.startsWith(`files${sep}`)
    );
  } catch {
    return false;
  }
}

/**
 * The turn taint (phase-8 decision 3, phase-25 decision 5): a turn is tainted from the first tool
 * that `cleanTool` does not allow, or from the start when the prompt carries an attachment. It
 * resets at `agent_start`. Memory parking and the harness card share one per session.
 */
export function turnTaint(onTaint?: () => void) {
  let tainted = false;
  let reported = false;
  /** An attachment arrived with the prompt: the next run starts tainted. */
  let attached = false;
  const taint = () => {
    tainted = true;
    if (reported) return;
    reported = true;
    onTaint?.();
  };
  const extension: ExtensionFactory = (pi) => {
    pi.on('input', (event) => {
      if (!event.text?.includes(ATTACHMENT_MARKER)) return;
      attached = true;
      taint();
    });
    pi.on('agent_start', () => {
      tainted = attached;
      attached = false;
    });
    // Both: `tool_call` covers a write later in the same batch, `tool_result` any late result.
    pi.on('tool_call', (event, ctx) => {
      if (!cleanTool(event.toolName, event.input, ctx.cwd)) taint();
    });
    pi.on('tool_result', (event, ctx) => {
      if (!cleanTool(event.toolName, event.input, ctx.cwd)) taint();
    });
  };
  return { extension, tainted: () => tainted };
}
export type TurnTaint = ReturnType<typeof turnTaint>;

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
  mask: (text: string) => Promise<string>;
  /** Read once when the session is built. */
  recentTitles: () => Promise<string[]>;
  /** `since` is a normalised ISO datetime. */
  recall: (q: string, o: { since?: string; topic?: string }) => Promise<Snippet[]>;
  /** Parks a tainted write unvalidated; resolves with the pending id, rejects with a message for the agent. */
  park: (write: MemoryWrite) => Promise<number>;
  applyNow: (write: MemoryWrite) => Promise<void>;
  /**
   * Phase 17: real block lines and their claim ids for a masked prompt; `exclude` = ids already in
   * the session. The extension masks the block.
   */
  relevant?: (
    maskedPrompt: string,
    exclude: number[],
  ) => Promise<{ ids: number[]; lines: string[] }>;
  /** Phase 17: `recall` lines for claims (real; the pseudo extension masks the tool result). */
  recallClaims?: (q: string) => Promise<string[]>;
  /** Phase 17: called once per session, the first time a turn is tainted (`chats.tainted`). */
  onTaint?: () => void;
  /** Phase 25: the session's shared taint; the host loads its extension. Unset: an own one. */
  taint?: TurnTaint;
  log: MemoryLog;
}): ExtensionFactory {
  const taint = opts.taint ?? turnTaint(opts.onTaint);
  /** Raw template last injected in this session; unchanged content is not injected again. */
  let injected: string | undefined;

  return (pi) => {
    if (!opts.taint) taint.extension(pi);
    const titles = opts
      .recentTitles()
      .then((ts) => ts.map(sanitizeTitle))
      .catch(() => []);

    pi.on('before_agent_start', async (event) => {
      if (event.messageType !== 'user') return;
      const [user, memory, ts] = await Promise.all([
        opts.files.read('user'),
        opts.files.read('memory'),
        titles,
      ]);
      const raw = `## Käyttäjä\n${user}\n\n## Muisti\n${memory}\n\n## Viimeisimmät keskustelut\n${ts.map((t) => `- ${t}`).join('\n')}`;
      if (raw === injected) return;
      let content: string;
      try {
        content = await opts.mask(raw);
      } catch (err) {
        opts.log('warn', 'memory not injected: mask failed', {
          error: err instanceof Error ? err.name : 'unknown',
        });
        return;
      }
      injected = raw;
      return { message: { customType: 'memory', display: false, content } };
    });

    // Phase 17 decision 1: relevant claims after the user message, masked, once per session. The
    // injected ids come from the branch each turn, so a rebuilt session or a fork stays right.
    pi.on('before_agent_start', async (event, ctx) => {
      if (event.messageType !== 'user' || !opts.relevant) return;
      const claimIds = new Set(
        ctx.sessionManager
          .getBranch()
          .flatMap((e) =>
            e.type === 'custom_message' && e.customType === CLAIMS_TYPE
              ? ((e.details as { claimIds?: number[] } | undefined)?.claimIds ?? [])
              : [],
          ),
      );
      if (claimIds.size >= CLAIMS_SESSION_CAP) return;
      let content: string;
      let ids: number[];
      try {
        const r = await Promise.race([
          opts.relevant(event.prompt, [...claimIds]),
          new Promise<never>((_, j) =>
            setTimeout(() => j(new Error('timeout')), CLAIMS_TIMEOUT_MS),
          ),
        ]);
        ids = r.ids.slice(0, CLAIMS_SESSION_CAP - claimIds.size);
        if (!ids.length) return;
        content = await opts.mask(`${CLAIMS_HEADER}\n${r.lines.slice(0, ids.length).join('\n')}`);
      } catch (err) {
        opts.log('warn', 'memory claims not injected', {
          error: err instanceof Error ? err.message : 'unknown',
        });
        return;
      }
      return {
        message: { customType: CLAIMS_TYPE, display: false, content, details: { claimIds: ids } },
      };
    });

    pi.registerTool({
      name: 'recall',
      label: 'recall',
      description:
        'Search earlier chats (summaries and transcripts) and learned claims about the user. Returns at most 5 snippets with dates and chat ids, and up to 3 claims with a quote.',
      parameters: Type.Object({
        query: Type.String(),
        since: Type.Optional(
          Type.String({ description: 'Chats created on or after this ISO date, e.g. 2026-10-01' }),
        ),
        topic: Type.Optional(Type.String({ description: 'Topic id' })),
      }),
      async execute(_id, p) {
        if (p.since && (!ISO.test(p.since) || Number.isNaN(Date.parse(p.since))))
          return text(BAD_SINCE, true);
        const [hits, claimLines] = await Promise.all([
          opts.recall(p.query, {
            ...(p.since ? { since: new Date(p.since).toISOString() } : {}),
            ...(p.topic ? { topic: p.topic } : {}),
          }),
          opts.recallClaims?.(p.query) ?? [],
        ]);
        if (!hits.length && !claimLines.length) return text('Ei osumia.');
        const chunks = hits
          .slice(0, 5)
          .map((h) => `- [${h.date.slice(0, 10)}] ${h.title} (${h.chatId}): ${h.snippet}`)
          .join('\n');
        return text(
          [chunks, claimLines.length ? `Havainnot:\n${claimLines.join('\n')}` : '']
            .filter(Boolean)
            .join('\n\n'),
        );
      },
    });

    pi.registerTool({
      name: 'memory',
      label: 'memory',
      description: `Edit long-term memory. target "user" = USER.md (who the user is, preferences; max ${CAPS.user} chars). target "memory" = durable facts about the user, stored as claims: add stores "text" as a new fact; replace replaces the one fact that contains "replace" with "text"; remove ends the one fact that contains "text". For "user", add appends text; replace swaps the exact text in "replace" for "text"; remove deletes the exact text.`,
      parameters: Type.Object({
        action: Type.Union([Type.Literal('add'), Type.Literal('replace'), Type.Literal('remove')]),
        target: Type.Union([Type.Literal('user'), Type.Literal('memory')]),
        text: Type.String(),
        replace: Type.Optional(Type.String()),
      }),
      async execute(_id, p) {
        const write: MemoryWrite = { ...p };
        // Tainted: validated at approve time against the file as it is then.
        if (taint.tainted()) {
          try {
            return text(`Kirjoitus odottaa hyväksyntääsi (id ${await opts.park(write)})`);
          } catch (err) {
            return text(err instanceof Error ? err.message : 'park failed', true);
          }
        }
        // Phase 17: MEMORY.md is generated from claims; the host checks target `memory` writes.
        if (p.target === 'user') {
          const r = applyOp(await opts.files.read(p.target), write);
          if ('error' in r) return text(r.error, true);
        }
        try {
          await opts.applyNow(write);
        } catch (err) {
          return text(err instanceof Error ? err.message : 'write failed', true);
        }
        return text('Tallennettu.');
      },
    });
  };
}
