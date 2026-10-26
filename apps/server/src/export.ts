import { topics } from '@pa/db';
import { ATTACHMENT_MARKER } from '@pa/pi-ext-memory';
import { PseudoDownError } from '@pa/pi-ext-pseudo';
import { type ChatExport, type ExportFormat, ExportQuery, TOOL_STATUS_WORD } from '@pa/protocol';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { extractArtifacts } from './artifacts.ts';
import { type BridgeDeps, chatRow, history, restorer, transcript } from './bridge.ts';
import { chatFiles } from './files.ts';
import { ChatNotFound } from './pi/registry.ts';

/** One chat to a file (docs/decisions/phase-9-ui.md 7.11). */

type Deps = Pick<BridgeDeps, 'db' | 'registry' | 'pseudo' | 'agents'>;

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

/** Document names in a masked user text's attachment markers, in order. */
const markerNames = (text: string) =>
  text
    .split(ATTACHMENT_MARKER)
    .slice(1)
    .map((b) => b.slice(0, b.indexOf(']\n')));

/**
 * The export of one chat; undefined when the user has no such chat. `unmask` restores through the
 * thread's own path (`history` with the sidecar restorer) and throws `PseudoDownError` when the
 * sidecar fails. Masked, the sidecar is never called.
 */
export async function chatExport(
  { db, registry, pseudo, agents }: Deps,
  userId: string,
  chatId: string,
  unmask: boolean,
): Promise<ChatExport | undefined> {
  const r = chatRow(db, userId, chatId);
  if (!r) return undefined;
  const session = await registry.get(chatId);
  let down = false;
  const restore = restorer(unmask ? pseudo : undefined, () => {
    down = true;
  });
  const messages = await history(session, chatFiles(db, userId, chatId), restore);
  if (down) throw new PseudoDownError('sidecar down');
  // Masked: document names as the model saw them; it never saw image names.
  const seen = unmask
    ? undefined
    : new Map(transcript(session).map((t) => [t.id, markerNames(t.text)]));
  const topic = r.topicId
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
    },
    messages: messages.map((m) => {
      const names = seen?.get(m.id) ?? [];
      return {
        role: m.role,
        createdAt: m.createdAt,
        text: m.text,
        attachments: m.attachments.map(({ id: _, ...a }) => ({
          ...a,
          name: !seen ? a.name : a.kind === 'document' ? (names.shift() ?? null) : null,
        })),
        tools: m.tools.map(({ name, status }) => ({ name, status })),
        artifacts:
          m.role === 'assistant' ? extractArtifacts(m.id, m.text).map(({ id: _, ...a }) => a) : [],
      };
    }),
  };
}

/** The title, else the first user line (as the sidebar labels it). */
const titleOf = (e: ChatExport) =>
  e.chat.title ??
  e.messages
    .find((m) => m.role === 'user' && m.text.trim())
    ?.text.trim()
    .split('\n')[0] ??
  'Uusi keskustelu';

/** `<title-slug>-<yyyy-mm-dd>-<masked|avoin>.<format>`; ASCII only, so no `filename*`. */
export function fileName(e: ChatExport, format: ExportFormat) {
  const slug =
    titleOf(e)
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 60)
      .replace(/^-|-$/g, '') || 'keskustelu';
  const date = new Date(e.chat.createdAt).toLocaleDateString('sv-SE', { timeZone: TZ });
  return `${slug}-${date}-${e.masked ? 'masked' : 'avoin'}.${format}`;
}

export function toMarkdown(e: ChatExport): string {
  const { chat } = e;
  const lines = [
    `# ${titleOf(e)}`,
    '',
    `- Päivämäärä: ${day.format(new Date(chat.createdAt))}`,
    `- Agentti: ${chat.agent.name}`,
    ...(chat.topic ? [`- Aihe: ${chat.topic}`] : []),
    `- Nimet: ${e.masked ? 'niin kuin malli näki ne' : 'oikeat nimet, sisältää henkilötietoja'}`,
  ];
  for (const m of e.messages) {
    lines.push('', `## ${m.role === 'user' ? 'Sinä' : chat.agent.name} · ${when(m.createdAt)}`);
    if (m.text) lines.push('', m.text);
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
