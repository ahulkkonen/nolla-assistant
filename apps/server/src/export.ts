import { topics } from '@pa/db';
import { PseudoDownError } from '@pa/pi-ext-pseudo';
import {
  type ChatExport,
  type ExportFormat,
  ExportQuery,
  formatCost,
  formatTokens,
  stripConfidence,
  TOOL_STATUS_WORD,
} from '@pa/protocol';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { extractArtifacts } from './artifacts.ts';
import type { BridgeDeps } from './bridge.ts';
import { chatRow, ownUsage, threadFiles } from './chats.ts';
import { history } from './history.ts';
import { ChatNotFound } from './pi/registry.ts';
import { restorer } from './restore.ts';
import { transcript } from './session-text.ts';
import { chatUsage } from './usage.ts';

/** One chat to a file (docs/decisions/phase-9-ui.md 7.11). */

type Deps = Pick<BridgeDeps, 'db' | 'registry' | 'pseudo' | 'agents' | 'fx'>;

/** More messages than this answer 413: the file is built in memory, one `/unmask` per message. */
export const MAX_EXPORT_MESSAGES = 2000;
export class ExportTooLarge extends Error {}

const TZ = 'Europe/Helsinki';
const day = new Intl.DateTimeFormat('fi-FI', {
  timeZone: TZ,
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
});
const time = new Intl.DateTimeFormat('fi-FI', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
/** "26.10.2026 klo 17.20" (brief 7.9). */
const when = (iso: string) => `${day.format(new Date(iso))} klo ${time.format(new Date(iso))}`;

/**
 * The export of one chat; undefined when the user has no such chat. `unmask` restores through the
 * thread's own path (`history` with the sidecar restorer) and throws `PseudoDownError` when the
 * sidecar fails or is not configured. Masked, the sidecar is never called, and the topic (a real
 * name with no masked form) is left out.
 */
export async function chatExport(
  { db, registry, pseudo, agents, fx }: Deps,
  userId: string,
  chatId: string,
  unmask: boolean,
  maxMessages = MAX_EXPORT_MESSAGES,
): Promise<ChatExport | undefined> {
  const r = chatRow(db, userId, chatId);
  if (!r) return undefined;
  // Without a sidecar the file would say "avoin" over texts nobody restored.
  if (unmask && !pseudo) throw new PseudoDownError('no sidecar');
  // The entries only: no agent session is built for an export (phase-15 decision 15).
  const session = registry.reader(chatId);
  if (transcript(session).length > maxMessages) throw new ExportTooLarge();
  let down = false;
  const restore = restorer(unmask ? pseudo : undefined, () => {
    down = true;
  });
  const blocks = new Map<string, string[]>();
  const messages = ownUsage(await history(session, threadFiles(db, userId, r), restore, blocks), r);
  if (down) throw new PseudoDownError('sidecar down');
  const topic =
    unmask && r.topicId
      ? db
          .select({ name: topics.name })
          .from(topics)
          .where(and(eq(topics.id, r.topicId), eq(topics.userId, userId)))
          .get()?.name
      : undefined;
  return {
    version: 1,
    masked: !unmask,
    chat: {
      id: r.id,
      title: unmask ? r.title : r.titleMasked,
      createdAt: r.createdAt,
      agent: { id: r.agentId, name: agents().get(r.agentId)?.name ?? r.agentId },
      topic: topic ?? null,
      usage: chatUsage(r),
    },
    fx: fx.get(),
    messages: messages.map((m) => {
      const text = stripConfidence(m.text);
      // Masked: the document names the model saw, only when their count matches; never image names.
      const names = blocks.get(m.id) ?? [];
      const docs = m.attachments.filter((a) => a.kind === 'document').length;
      let doc = 0;
      return {
        role: m.role,
        createdAt: m.createdAt,
        text,
        attachments: m.attachments.map(({ id: _, ...a }) => ({
          ...a,
          name: unmask
            ? a.name
            : a.kind === 'document' && names.length === docs
              ? (names[doc++] ?? null)
              : null,
        })),
        tools: m.tools.map(({ name, status }) => ({ name, status })),
        artifacts:
          m.role === 'assistant' ? extractArtifacts(m.id, text).map(({ id: _, ...a }) => a) : [],
        ...(m.usage ? { usage: m.usage } : {}),
        ...(m.versions ? { version: m.versions } : {}),
      };
    }),
  };
}

/** One Markdown line: a line break or a run of spaces in a name must not start a new block. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The title, else the first user line (as the sidebar labels it), on one line. */
const titleOf = (e: ChatExport) =>
  oneLine(
    e.chat.title ??
      e.messages
        .find((m) => m.role === 'user' && m.text.trim())
        ?.text.trim()
        .split('\n')[0] ??
      '',
  ) || 'Uusi keskustelu';

/** A message body as a blockquote: its own `#` lines cannot pass for the file's headings. */
const quote = (s: string) =>
  s
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');

/** Lower-case ASCII words joined by `-`, at most `max` characters; '' when nothing is left. */
export const slug = (s: string, max = 60) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, max)
    .replace(/^-|-$/g, '');

/** 'YYYY-MM-DD' of an instant in Helsinki. */
export const dateOf = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: TZ });

/** `<title-slug>-<yyyy-mm-dd>-<masked|avoin>.<format>`; ASCII only, so no `filename*`. */
export function fileName(e: ChatExport, format: ExportFormat) {
  const name = slug(titleOf(e)) || 'keskustelu';
  return `${name}-${dateOf(e.chat.createdAt)}-${e.masked ? 'masked' : 'avoin'}.${format}`;
}

export function toMarkdown(e: ChatExport): string {
  const { chat } = e;
  const agent = oneLine(chat.agent.name);
  const lines = [
    `# ${titleOf(e)}`,
    '',
    `- Päivämäärä: ${day.format(new Date(chat.createdAt))}`,
    `- Agentti: ${agent}`,
    ...(chat.topic ? [`- Aihe: ${oneLine(chat.topic)}`] : []),
    `- Nimet: ${e.masked ? 'niin kuin malli näki ne' : 'oikeat nimet, sisältää henkilötietoja'}`,
  ];
  // Phase 13: costs are not personal data, so the masked form has them too. Older chats have none.
  const fx = e.fx ?? null;
  const rate = fx ? ` (EKP ${fx.date.split('-').reverse().join('.')})` : '';
  if (chat.usage?.tokens)
    lines.push(
      `- Kustannus: ${formatCost(chat.usage.costUsd, fx)} · ${formatTokens(chat.usage.tokens)}${rate}`,
    );
  for (const m of e.messages) {
    // Phase 24: the export holds the shown branch; an edited message says which version it is.
    const version = m.version ? ` (versio ${m.version.index}/${m.version.count})` : '';
    lines.push('', `## ${m.role === 'user' ? 'Sinä' : agent} · ${when(m.createdAt)}${version}`);
    if (m.text) lines.push('', quote(m.text));
    if (m.attachments.length)
      lines.push(
        '',
        'Liitteet:',
        '',
        ...m.attachments.map((a) => `- ${a.name === null ? 'kuva' : `\`${a.name}\``} (${a.mime})`),
      );
    if (m.tools.length)
      lines.push(
        '',
        'Työkalut:',
        '',
        ...m.tools.map((t) => `- \`${t.name}\` · ${TOOL_STATUS_WORD[t.status]}`),
      );
    if (m.usage) {
      const { costUsd, estimated, input, output, cacheRead, cacheWrite } = m.usage;
      const cost = formatCost(costUsd, fx, { reply: true, estimated });
      lines.push(
        '',
        `Kustannus: ${cost} · ${formatTokens(input + output + cacheRead + cacheWrite)}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function exportRoutes(app: FastifyInstance, auth: preHandlerHookHandler, deps: Deps) {
  app.get<{ Params: { id: string } }>(
    '/api/chats/:id/export',
    { preHandler: auth },
    async (req, reply) => {
      const q = ExportQuery.safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: 'bad_request' });
      const { format, unmask } = q.data;
      let e: ChatExport | undefined;
      try {
        e = await chatExport(deps, req.userId, req.params.id, unmask === '1');
      } catch (err) {
        if (err instanceof PseudoDownError) return reply.code(503).send({ error: 'pseudo_down' });
        if (err instanceof ExportTooLarge) return reply.code(413).send({ error: 'too_large' });
        // `chat.delete` ran while the session loaded.
        if (!(err instanceof ChatNotFound)) throw err;
      }
      if (!e) return reply.code(404).send({ error: 'not_found' });
      return reply
        .type(format === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${fileName(e, format)}"`)
        .header('Cache-Control', 'no-store')
        .send(format === 'md' ? toMarkdown(e) : JSON.stringify(e, null, 2));
    },
  );
}
