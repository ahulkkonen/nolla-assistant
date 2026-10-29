import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, test } from 'vitest';
import { anchorOf, childrenOf, LEAF_MARK, newestLeaf, versionsOf } from './versions.ts';

// Phase 24 decisions 1 to 4 on an in-memory Pi tree.

const user = (sm: SessionManager, text: string) => {
  // As pi-ext-pseudo: a `pseudo-spans` custom entry before each user message (R3).
  sm.appendCustomEntry('pseudo-spans', { spans: [] });
  return sm.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
};
const reply = (sm: SessionManager, text: string) =>
  sm.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'zdr',
    model: 'm',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  });
const byId = (sm: SessionManager) => new Map(sm.getEntries().map((e) => [e.id, e]));
const entry = (sm: SessionManager, id: string) => {
  const e = sm.getEntry(id);
  if (!e) throw new Error(`no entry ${id}`);
  return e;
};

test('the anchor skips pseudo-spans and pa-leaf entries', () => {
  const sm = SessionManager.inMemory();
  user(sm, 'eka');
  const a1 = reply(sm, 'vastaus');
  sm.appendCustomEntry(LEAF_MARK, {});
  const u2 = user(sm, 'toka');
  expect(anchorOf(byId(sm), entry(sm, u2))).toBe(a1);
});

test('root siblings are versions; the shown one has its place', () => {
  const sm = SessionManager.inMemory();
  const u1 = user(sm, 'eka');
  reply(sm, 'vastaus 1');
  // An edit rewinds to the parent of u1 (its pseudo-spans entry) and prompts again.
  sm.branch(entry(sm, u1).parentId ?? '');
  const u1b = user(sm, 'eka muokattu');
  const a1b = reply(sm, 'vastaus 2');
  expect(anchorOf(byId(sm), entry(sm, u1))).toBeNull();
  expect(versionsOf(sm).get(u1b)).toEqual({ index: 2, count: 2, ids: [u1, u1b] });
  expect(versionsOf(sm).has(u1)).toBe(false); // not on the shown branch
  sm.branch(a1b);
  const u2 = user(sm, 'jatko');
  reply(sm, 'vastaus 3');
  expect([...versionsOf(sm).keys()]).toEqual([u1b]);
  expect(versionsOf(sm).has(u2)).toBe(false);
});

test('equal texts are one version at the place of the first; it points at the newest', () => {
  const sm = SessionManager.inMemory();
  user(sm, 'alku');
  const a0 = reply(sm, 'ok');
  const u1 = user(sm, 'sama');
  reply(sm, 'virhe');
  sm.branch(a0);
  const u2 = user(sm, 'toinen');
  reply(sm, 'vastaus');
  sm.branch(a0);
  const retried = user(sm, 'sama'); // a retry: same masked text
  reply(sm, 'nyt toimii');
  expect(versionsOf(sm).get(retried)).toEqual({ index: 1, count: 2, ids: [retried, u2] });
  expect(u1).not.toBe(retried);
});

test('newestLeaf follows the last child down to an entry without children', () => {
  const sm = SessionManager.inMemory();
  const u1 = user(sm, 'eka');
  const a1 = reply(sm, 'vastaus');
  const u2 = user(sm, 'toka');
  reply(sm, 'vanha');
  sm.branch(u2);
  const newer = reply(sm, 'uudempi');
  const mark = sm.appendCustomEntry(LEAF_MARK, {});
  const children = childrenOf(sm.getEntries());
  expect(newestLeaf(children, u1)).toBe(mark);
  expect(newestLeaf(children, newer)).toBe(mark);
  expect(newestLeaf(children, mark)).toBe(mark);
  expect(children.get(a1)?.length).toBe(1);
});
