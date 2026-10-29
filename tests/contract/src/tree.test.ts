import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, test } from 'vitest';
import { setup } from './harness.ts';

// Pi tree facts that phase 24 builds on (docs/decisions/phase-24-edit-in-place.md, P1-P3).

const userIds = (sm: SessionManager) =>
  sm.getEntries().flatMap((e) => (e.type === 'message' && e.message.role === 'user' ? [e.id] : []));
/** Text of the user and assistant messages (Pi 1.4.0 puts a system message first). */
const texts = (msgs: { role: string; content?: unknown }[]) =>
  msgs
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content as { type: string; text?: string }[])
            .map((c) => (c.type === 'text' ? c.text : ''))
            .join(''),
    );

/** Two turns, then a rewind to the second user entry and a new second turn (a sibling). */
async function twoVersions() {
  const pi = await setup([{ text: 'eka' }, { text: 'toka' }, { text: 'uusi' }], []);
  await pi.session.prompt('ensimmäinen');
  await pi.session.prompt('toinen');
  const [, second] = userIds(pi.sessionManager);
  await pi.session.navigateTree(second ?? '');
  await pi.session.prompt('toinen muokattu');
  return { ...pi, second: second ?? '' };
}

test('navigateTree to a user entry leaves the leaf on its parent and refreshes session.messages', async () => {
  const { session, sessionManager } = await setup([{ text: 'eka' }, { text: 'toka' }], []);
  await session.prompt('ensimmäinen');
  await session.prompt('toinen');
  const second = sessionManager.getEntry(userIds(sessionManager)[1] ?? '');
  await session.navigateTree(second?.id ?? '');
  expect(sessionManager.getLeafId()).toBe(second?.parentId);
  expect(texts(session.messages)).toEqual(['ensimmäinen', 'eka']);
});

test('navigateTree to an assistant entry puts the leaf on it', async () => {
  const { session, sessionManager, second } = await twoVersions();
  const oldReply = sessionManager.getChildren(second)[0];
  if (!oldReply) throw new Error('no old reply');
  await session.navigateTree(oldReply.id);
  expect(sessionManager.getLeafId()).toBe(oldReply.id);
  expect(texts(session.messages)).toEqual(['ensimmäinen', 'eka', 'toinen', 'toka']);
});

test('navigateTree throws while a reply streams', async () => {
  const { session, sessionManager } = await setup(
    [{ text: 'eka' }, { text: 'hidas', reasoning: 'mietin ensin pitkään', thinkMs: 400 }],
    [],
  );
  await session.prompt('ensimmäinen');
  const first = userIds(sessionManager)[0] ?? '';
  const run = session.prompt('toinen');
  await new Promise((r) => setTimeout(r, 100));
  await expect(session.navigateTree(first)).rejects.toThrow(/current response/);
  await run;
});

test('getChildren keeps file order; versions are siblings under one parent', async () => {
  const { sessionManager, second } = await twoVersions();
  const parent = sessionManager.getEntry(second)?.parentId ?? '';
  const kids = sessionManager.getChildren(parent);
  expect(kids.map((e) => e.id)).toEqual(userIds(sessionManager).slice(1));
  const order = sessionManager.getEntries().map((e) => e.id);
  expect(kids.map((e) => order.indexOf(e.id))).toEqual(
    [...kids.map((e) => order.indexOf(e.id))].sort((a, b) => a - b),
  );
});

test('after open the leaf is the last file entry; a pa-leaf entry keeps the shown branch', async () => {
  const { session, sessionManager, sessionDir, second } = await twoVersions();
  const file = sessionManager.getSessionFile() ?? '';
  // An edit needs no marker: the new branch is last in the file.
  const last = sessionManager.getEntries().at(-1)?.id;
  expect(SessionManager.open(file, sessionDir).getLeafId()).toBe(last);
  // A switch back to the old version: navigateTree, then the custom marker.
  const oldReply = sessionManager.getChildren(second)[0];
  await session.navigateTree(oldReply?.id ?? '');
  const mark = sessionManager.appendCustomEntry('pa-leaf', {});
  const reopened = SessionManager.open(file, sessionDir);
  expect(reopened.getLeafId()).toBe(mark);
  expect(reopened.getBranch().map((e) => e.id)).toContain(second);
  // A custom entry never enters the model context.
  const ctx = reopened.buildSessionContext();
  expect(texts(ctx.messages)).toEqual(['ensimmäinen', 'eka', 'toinen', 'toka']);
  expect(JSON.stringify(ctx.messages)).not.toContain('pa-leaf');
});
