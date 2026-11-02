/**
 * A Pi session branch as protocol messages: tool rows with their status and search view, the
 * files of each user message, versions, usage and receipt times, restored through `Restore`.
 *
 * It reads the session and the given files only. It must not write to the session, the database
 * or a socket; `chat.state`, the stream finals and the export all build on it.
 */
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import {
  type Message,
  type ToolRow,
  ToolSearch,
  type ToolStatus,
  WEB_SEARCH_TOOL,
} from '@nolla/protocol';
import { DENIED_REASON, TIMEOUT_REASON } from './approval.ts';
import { type chatFiles, splitBlocks } from './files.ts';
import { GUARD_REASON } from './pi/guard.ts';
import type { Restore } from './restore.ts';
import { SEARCH_DENIED, SEARCH_UNATTENDED } from './search-tool.ts';
import { type AgentMessage, textOf, thinkingOf } from './session-text.ts';
import { messageUsage, type PaMeta } from './usage.ts';
import { versionsOf } from './versions.ts';

const DENY_REASONS = [
  GUARD_REASON,
  DENIED_REASON,
  TIMEOUT_REASON,
  SEARCH_DENIED,
  SEARCH_UNATTENDED,
];
export const toolStatus = (isError: boolean, text: string): ToolStatus =>
  !isError ? 'ok' : DENY_REASONS.some((r) => text.includes(r)) ? 'denied' : 'error';

/**
 * A `web_search` result's `details` (masked in the session) for its tool row, through `restore`:
 * real values, or masked ones when `restore` does not restore (a masked export).
 */
export async function searchView(
  details: unknown,
  restore: Restore,
): Promise<ToolSearch | undefined> {
  const d = ToolSearch.safeParse(details);
  if (!d.success) return undefined;
  const { query, results } = d.data;
  // One sidecar call: no part holds a newline (search-tool.ts collapses whitespace).
  const parts = [query, ...results.flatMap((r) => [r.title, r.url])];
  const lines = (await restore(parts.join('\n'))).text.split('\n');
  if (lines.length !== parts.length) return d.data;
  return {
    query: lines[0] ?? query,
    results: results.map((r, i) => ({
      title: lines[1 + 2 * i] ?? r.title,
      url: lines[2 + 2 * i] ?? r.url,
    })),
  };
}

export function toolRows(
  m: AgentMessage,
  statuses: Map<string, ToolStatus>,
  searches: Map<string, ToolSearch>,
): ToolRow[] {
  if (m.role !== 'assistant') return [];
  return m.content.flatMap((b) => {
    if (b.type !== 'toolCall') return [];
    const search = searches.get(b.id);
    const row = {
      callId: b.id,
      name: b.name,
      status: statuses.get(b.id) ?? 'running',
      summary: '',
    };
    return [search ? { ...row, search } : row];
  });
}

export function toMessage(id: string, m: AgentMessage, tools: ToolRow[]): Message {
  const msg: Message = {
    id,
    role: m.role === 'user' ? 'user' : 'assistant',
    text: textOf(m),
    annotations: [],
    attachments: [],
    tools,
    createdAt: new Date(m.timestamp).toISOString(),
  };
  // Phase 13: cost and tokens per call, and whether the row "Ajatteli … s" has a text to load.
  const usage = messageUsage(m);
  if (usage) msg.usage = usage;
  const pa = (m as { pa?: PaMeta }).pa;
  if (thinkingOf(m)) msg.thinking = { ms: pa?.thinkingMs ?? null };
  // Phase 26: the receipt's queue and writing times.
  if (pa?.queueMs !== undefined || pa?.writeMs !== undefined)
    msg.phases = {
      ...(pa.queueMs !== undefined ? { queueMs: pa.queueMs } : {}),
      ...(pa.writeMs !== undefined ? { writeMs: pa.writeMs } : {}),
    };
  return msg;
}

/**
 * The files of the user message at `at`: uploaded after `prev` (the previous user message) and up
 * to its own time.
 */
// ponytail: timestamp window, not a stored message link; a file uploaded but sent with a later message shows on the earlier one. Add files.messageId if that happens.
export function filesOf(files: ReturnType<typeof chatFiles>, prev: string, at: string) {
  return files
    .filter((f) => f.createdAt > prev && f.createdAt <= at)
    .map(({ createdAt: _, ...ref }) => ref);
}

/**
 * Rebuilds messages from the Pi branch. A user message gets the chat's files uploaded after the
 * previous user message and up to its own timestamp; the appended `[Liite: ...]` blocks are cut
 * from its text (`splitBlocks`); `blocks` gets their names per message id, as the text has them
 * (masked when `restore` does not restore). The export (export.ts) uses both.
 */
export async function history(
  session: Pick<AgentSession, 'sessionManager'>,
  files: ReturnType<typeof chatFiles>,
  restore: Restore,
  blocks?: Map<string, string[]>,
): Promise<Message[]> {
  const entries = session.sessionManager.getBranch();
  const statuses = new Map<string, ToolStatus>();
  const searches = new Map<string, ToolSearch>();
  for (const e of entries) {
    if (e.type === 'message' && e.message.role === 'toolResult') {
      const r = e.message;
      statuses.set(r.toolCallId, toolStatus(r.isError, textOf(r)));
      const found =
        r.toolName === WEB_SEARCH_TOOL && !r.isError && (await searchView(r.details, restore));
      if (found) searches.set(r.toolCallId, found);
    }
  }
  const versions = versionsOf(session.sessionManager);
  let prev = '';
  const messages = entries.flatMap((e) => {
    if (e.type !== 'message' || (e.message.role !== 'user' && e.message.role !== 'assistant'))
      return [];
    const m = toMessage(e.id, e.message, toolRows(e.message, statuses, searches));
    if (m.role === 'user') {
      m.attachments = filesOf(files, prev, m.createdAt);
      prev = m.createdAt;
      const v = versions.get(e.id);
      if (v) m.versions = { index: v.index, count: v.count };
    }
    return [m];
  });
  // ponytail: 8 /unmask calls at a time; a batch endpoint in the sidecar would cut the round trips.
  for (let i = 0; i < messages.length; i += 8)
    await Promise.all(
      messages.slice(i, i + 8).map(async (m) => {
        const { text, annotations } = await restore(m.text);
        const docs = m.attachments.filter((a) => a.kind === 'document').map((a) => a.name);
        const { own, names } = splitBlocks(text, docs);
        m.text = own;
        m.annotations = annotations.filter((a) => a.end <= own.length);
        if (names.length) blocks?.set(m.id, names);
      }),
    );
  return messages;
}
