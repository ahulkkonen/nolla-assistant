import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';
import { textOf } from './session-text.ts';

/**
 * Phase 24 (docs/decisions/phase-24-edit-in-place.md, decisions 1 to 4): the versions of a user
 * message are the user entries with the same anchor, in file order; Pi's tree holds them all.
 */

/** The place of a user entry among its versions; `ids[k]` is the entry that version k + 1 shows. */
export type VersionInfo = { index: number; count: number; ids: string[] };
export type Children = Map<string | null, SessionEntry[]>;

/** The custom marker a switch appends at the new leaf, so a reopened file shows the same branch. */
export const LEAF_MARK = 'pa-leaf';

/**
 * Entries outside the conversation: `pseudo-spans` and `pa-leaf` (custom), and the settings Pi
 * may append at a leaf before a prompt (a model or thinking change on a rebuilt session).
 */
const SKIP = new Set<SessionEntry['type']>([
  'custom',
  'model_change',
  'thinking_level_change',
  'label',
  'session_info',
  'usage',
]);

const isUser = (e: SessionEntry) => e.type === 'message' && e.message.role === 'user';

/** The nearest ancestor of `entry` that is part of the conversation; null at the root. */
export function anchorOf(byId: Map<string, SessionEntry>, entry: SessionEntry): string | null {
  for (let id = entry.parentId; id !== null; ) {
    const e = byId.get(id);
    if (!e) return null;
    if (!SKIP.has(e.type)) return e.id;
    id = e.parentId;
  }
  return null;
}

/** `id` itself or its nearest ancestor that is part of the conversation (skips `SKIP`). */
export function conversationAt(
  sm: Pick<SessionManager, 'getEntry'>,
  id: string,
): SessionEntry | undefined {
  let e = sm.getEntry(id);
  while (e && SKIP.has(e.type)) e = e.parentId === null ? undefined : sm.getEntry(e.parentId);
  return e;
}

/** Parent id → children, in file order (P3). */
export function childrenOf(entries: SessionEntry[]): Children {
  const children: Children = new Map();
  for (const e of entries) {
    const list = children.get(e.parentId);
    if (list) list.push(e);
    else children.set(e.parentId, [e]);
  }
  return children;
}

/** The newest branch below `id`: the last child, down to an entry without children (decision 2). */
export function newestLeaf(children: Children, id: string): string {
  for (let next = children.get(id)?.at(-1); next; next = children.get(id)?.at(-1)) id = next.id;
  return id;
}

/**
 * The user entries of the shown branch that have more than one version. Equal masked texts are one
 * version, at the place of the first; its `ids` entry is the newest of them (a retry repeats the
 * text, so it never shows as a version).
 */
// ponytail: one O(n) pass over every entry per call; cache per session if a long chat opens slowly.
export function versionsOf(
  sm: Pick<SessionManager, 'getEntries' | 'getBranch'>,
): Map<string, VersionInfo> {
  const entries = sm.getEntries();
  const byId = new Map(entries.map((e) => [e.id, e]));
  /** anchor → masked text → entry ids, both in file order. */
  const groups = new Map<string | null, Map<string, string[]>>();
  for (const e of entries) {
    if (e.type !== 'message' || !isUser(e)) continue;
    const anchor = anchorOf(byId, e);
    let texts = groups.get(anchor);
    if (!texts) groups.set(anchor, (texts = new Map()));
    const text = textOf(e.message);
    const ids = texts.get(text);
    if (ids) ids.push(e.id);
    else texts.set(text, [e.id]);
  }
  const out = new Map<string, VersionInfo>();
  for (const e of sm.getBranch()) {
    if (e.type !== 'message' || !isUser(e)) continue;
    const texts = groups.get(anchorOf(byId, e));
    if (!texts || texts.size < 2) continue;
    const keys = [...texts.keys()];
    out.set(e.id, {
      index: keys.indexOf(textOf(e.message)) + 1,
      count: keys.length,
      ids: [...texts.values()].map((ids) => ids.at(-1) ?? ''),
    });
  }
  return out;
}
