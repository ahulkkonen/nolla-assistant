import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileTrash } from '@pa/db';
import type { FakeTurn } from '@pa/fake-llm';
import { dirBytes, USER_QUOTA } from '@pa/pi-ext-subagents/workspace';
import type {
  Artifact,
  AttachmentRef,
  FileUsage,
  TrashEntry,
  TrashListing,
  TreeEntry,
  TreeListing,
} from '@pa/protocol';
import { afterEach, expect, test } from 'vitest';
import { api, boot, bootChat, bootPseudo, login, runCleanups } from './test-utils.ts';
import { artifactName, purgeTrash, workStore } from './tree.ts';

afterEach(runCleanups);

type Booted = { config: { port: number; dataDir: string } };

/** HTTP helpers with the session cookie. */
async function client({ config }: Booted) {
  const { cookie } = await login(config.port);
  const call = (path: string, init: RequestInit = {}) =>
    api(config.port, path, { ...init, headers: { cookie, ...init.headers } });
  const send = (method: string, path: string, body: unknown) =>
    call(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const list = async (path = '', extra = '') =>
    (await (
      await call(`/api/files/tree?path=${encodeURIComponent(path)}${extra}`)
    ).json()) as TreeListing;
  const upload = (path: string, files: [string, string][]) => {
    const form = new FormData();
    for (const [name, data] of files) form.append('files', new Blob([data]), name);
    return call(`/api/files/tree/upload?path=${encodeURIComponent(path)}`, {
      method: 'POST',
      body: form,
    });
  };
  return { cookie, call, send, list, upload };
}

/** A server with a socket on a new chat, and the HTTP helpers. */
async function setup(turns: FakeTurn[] = []) {
  const b = await bootChat(turns);
  return { ...b, root: b.srv.registry.cwd, ...(await client(b)) };
}

const names = (l: TreeListing) => l.entries.map((e) => e.name);

test('auth: every tree route needs the session cookie', { timeout: 30_000 }, async () => {
  const { config, run } = await boot([]);
  await run();
  for (const [method, path] of [
    ['GET', '/api/files/tree'],
    ['GET', '/api/files/tree?root=files'],
    ['GET', '/api/files/tree/raw?path=a.txt'],
    ['POST', '/api/files/tree/upload'],
    ['POST', '/api/files/tree/mkdir'],
    ['POST', '/api/files/tree/move'],
    ['DELETE', '/api/files/tree?path=a.txt'],
    ['GET', '/api/files/tree/trash'],
    ['POST', '/api/files/tree/restore'],
    ['DELETE', '/api/files/tree/trash'],
    ['GET', '/api/files/tree/usage'],
    ['POST', '/api/files/tree/attach'],
    ['POST', '/api/files/tree/artifact'],
  ] as const)
    expect((await api(config.port, path, { method })).status, `${method} ${path}`).toBe(401);
});

test('list, mkdir, upload, move: folders first, natural order, pages, conflicts', {
  timeout: 30_000,
}, async () => {
  const { root, send, list, upload } = await setup();
  expect((await send('POST', '/api/files/tree/mkdir', { path: 'docs' })).status).toBe(201);
  expect((await send('POST', '/api/files/tree/mkdir', { path: 'docs' })).status).toBe(409);
  expect((await send('POST', '/api/files/tree/mkdir', { path: 'nope/x' })).status).toBe(404);
  expect((await send('POST', '/api/files/tree/mkdir', { path: 'a\nb' })).status).toBe(400);
  const up = await upload('', [
    ['a10.txt', 'kymmenen'],
    ['a2.txt', 'kaksi'],
    ['a2.txt', 'toinen'],
  ]);
  expect(up.status).toBe(201);
  const { entries } = (await up.json()) as { entries: TreeEntry[] };
  // A taken name gets " (2)".
  expect(entries.map((e) => e.path)).toEqual(['a10.txt', 'a2.txt', 'a2 (2).txt']);
  expect(entries[0]).toMatchObject({ type: 'file', size: 8, mime: 'text/plain', preview: 'text' });
  mkdirSync(join(root, '.trash'), { recursive: true });
  // Finnish collation: a space sorts before a dot, and numbers compare as numbers.
  expect(names(await list())).toEqual(['docs', 'a2 (2).txt', 'a2.txt', 'a10.txt']);
  // Pages of two, joined by the cursor.
  const first = await list('', '&limit=2');
  expect(names(first)).toEqual(['docs', 'a2 (2).txt']);
  const second = await list('', `&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`);
  expect(names(second)).toEqual(['a2.txt', 'a10.txt']);
  expect(second.nextCursor).toBeNull();

  const move = (from: string, to: string) => send('POST', '/api/files/tree/move', { from, to });
  const moved = await move('a2.txt', 'docs/b.txt');
  expect(moved.status).toBe(200);
  expect(((await moved.json()) as { entry: TreeEntry }).entry.path).toBe('docs/b.txt');
  expect(readFileSync(join(root, 'docs', 'b.txt'), 'utf8')).toBe('kaksi');
  expect((await move('a10.txt', 'docs/b.txt')).status).toBe(409);
  expect((await move('docs', 'docs/sub')).status).toBe(400);
  expect((await move('missing.txt', 'x.txt')).status).toBe(404);
  expect((await move('a10.txt', 'bad/\u0000')).status).toBe(400);
  expect(names(await list('docs'))).toEqual(['b.txt']);
  expect((await list('nope')).entries).toBeUndefined();
});

test('raw: preview types and headers; text and HTML never as text/html', {
  timeout: 30_000,
}, async () => {
  const { root, call, list } = await setup();
  writeFileSync(join(root, 'muistio.md'), '# Otsikko');
  writeFileSync(join(root, 'sivu.html'), '<script>alert(1)</script>');
  writeFileSync(join(root, 'raportti.pdf'), '%PDF-1.4\n');
  writeFileSync(join(root, 'data.bin'), Buffer.from([0, 1, 2]));
  const raw = (path: string, extra = '') =>
    call(`/api/files/tree/raw?path=${encodeURIComponent(path)}${extra}`);
  const md = await raw('muistio.md');
  expect(md.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(md.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''muistio.md");
  expect(md.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
  expect(md.headers.get('x-frame-options')).toBe('DENY');
  expect(await md.text()).toBe('# Otsikko');
  expect((await raw('sivu.html')).headers.get('content-type')).toBe('text/plain; charset=utf-8');
  const pdf = await raw('raportti.pdf');
  expect(pdf.headers.get('content-type')).toBe('application/pdf');
  expect(pdf.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  expect(pdf.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
  const bin = await raw('data.bin');
  expect(bin.headers.get('content-type')).toBe('application/octet-stream');
  expect(bin.headers.get('content-disposition')).toMatch(/^attachment;/);
  const dl = await raw('muistio.md', '&download=1');
  expect(dl.headers.get('content-disposition')).toMatch(/^attachment;/);
  expect(dl.headers.get('content-type')).toBe('application/octet-stream');
  expect((await raw('missing.md')).status).toBe(404);
  const byName = new Map((await list()).entries.map((e) => [e.name, e]));
  expect(byName.get('muistio.md')?.preview).toBe('markdown');
  expect(byName.get('sivu.html')?.preview).toBe('html');
  expect(byName.get('raportti.pdf')?.preview).toBe('pdf');
  expect(byName.get('data.bin')?.preview).toBeNull();
});

test('path safety: .., encoded .., absolute, trash and symlinks out are refused', {
  timeout: 30_000,
}, async () => {
  const { root, config, call, send, list, upload } = await setup();
  const secret = join(config.dataDir, 'secret.txt');
  writeFileSync(secret, 'salainen');
  mkdirSync(join(root, '.trash'), { recursive: true });
  writeFileSync(join(root, '.trash', '1793000000000-old.txt'), 'vanha');
  symlinkSync(config.dataDir, join(root, 'out'));
  symlinkSync(secret, join(root, 'secret-link.txt'));
  symlinkSync(join(root, '.trash'), join(root, 'bin'));
  symlinkSync(join(config.dataDir, 'missing'), join(root, 'dangling'));
  writeFileSync(join(root, 'ok.txt'), 'ok');
  const raw = (q: string) => call(`/api/files/tree/raw?path=${q}`);
  for (const q of [
    '../secret.txt',
    '%2e%2e%2fsecret.txt',
    '..%2F..%2Fapp.db',
    encodeURIComponent(secret),
    '.trash%2F1793000000000-old.txt',
    '.TRASH%2F1793000000000-old.txt',
    'out%2Fsecret.txt',
    'secret-link.txt',
    'bin%2F1793000000000-old.txt',
  ])
    expect((await raw(q)).status, q).toBe(400);
  // Double encoding is a literal folder name inside the root: not found, not an escape.
  expect((await raw('%252e%252e%252fsecret.txt')).status).toBe(404);
  expect((await call('/api/files/tree?path=..')).status).toBe(400);
  expect((await call('/api/files/tree?path=.trash')).status).toBe(400);
  expect((await upload('..', [['x.txt', 'x']])).status).toBe(400);
  expect((await upload('out', [['x.txt', 'x']])).status).toBe(400);
  expect((await send('POST', '/api/files/tree/mkdir', { path: '.trash/x' })).status).toBe(400);
  expect((await send('POST', '/api/files/tree/mkdir', { path: 'dangling/x' })).status).toBe(400);
  expect(
    (await send('POST', '/api/files/tree/move', { from: 'ok.txt', to: '../ok.txt' })).status,
  ).toBe(400);
  expect(
    (await send('POST', '/api/files/tree/move', { from: 'ok.txt', to: 'bin/ok.txt' })).status,
  ).toBe(400);
  expect((await call('/api/files/tree?path=..%2Fsecret.txt', { method: 'DELETE' })).status).toBe(
    400,
  );
  expect((await call('/api/files/tree?path=', { method: 'DELETE' })).status).toBe(400);
  expect((await send('POST', '/api/files/tree/attach', { path: 'secret-link.txt' })).status).toBe(
    400,
  );
  expect((await send('POST', '/api/files/tree/restore', { id: '../secret.txt' })).status).toBe(400);
  expect(
    (
      await call(`/api/files/tree/trash?id=${encodeURIComponent('../secret.txt')}`, {
        method: 'DELETE',
      })
    ).status,
  ).toBe(400);
  // The listing hides the trash and every link that leads out or into it.
  expect(names(await list())).toEqual(['ok.txt']);
  expect(readFileSync(secret, 'utf8')).toBe('salainen');
  expect(existsSync(join(config.dataDir, 'ok.txt'))).toBe(false);
  // A FIFO is not a file: refused at once, without blocking on open (O_NONBLOCK).
  execFileSync('mkfifo', [join(root, 'putki')]);
  expect((await raw('putki')).status).toBe(404);
  // A link inside is read at its resolved target.
  symlinkSync(join(root, 'ok.txt'), join(root, 'ok-link.txt'));
  expect(await (await raw('ok-link.txt')).text()).toBe('ok');
  // Delete moves a link itself, also one that leads out or nowhere; its target stays.
  for (const path of ['secret-link.txt', 'dangling'])
    expect((await call(`/api/files/tree?path=${path}`, { method: 'DELETE' })).status, path).toBe(
      200,
    );
  expect(readFileSync(secret, 'utf8')).toBe('salainen');
});

test('trash: delete, list, restore (also into a removed folder), delete for good, purge', {
  timeout: 30_000,
}, async () => {
  const { root, config, srv, call, send, list } = await setup();
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'a.txt'), 'abc');
  const del = async (path: string) => {
    const res = await call(`/api/files/tree?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { entry: TrashEntry }).entry;
  };
  const trash = async () =>
    ((await (await call('/api/files/tree/trash')).json()) as TrashListing).entries;
  const restore = async (id: string) =>
    ((await (await send('POST', '/api/files/tree/restore', { id })).json()) as { entry: TreeEntry })
      .entry;

  const a = await del('docs/a.txt');
  expect(a).toMatchObject({ name: 'a.txt', originalPath: 'docs/a.txt', type: 'file', size: 3 });
  expect(a.id).toMatch(/^\d{13}-a\.txt$/);
  expect(existsSync(join(root, '.trash', a.id))).toBe(true);
  // The trash counts toward the quota until it is emptied.
  const usage = (await (await call('/api/files/tree/usage')).json()) as FileUsage;
  expect(usage).toMatchObject({ used: 3, work: 0, trash: 3, files: 0 });
  expect(names(await list('docs'))).toEqual([]);
  expect((await trash()).map((e) => e.id)).toEqual([a.id]);
  expect((await restore(a.id)).path).toBe('docs/a.txt');
  expect(await trash()).toEqual([]);

  // The folder is gone too: restore makes it again. A taken name gets " (2)".
  const again = await del('docs/a.txt');
  const docs = await del('docs');
  expect(docs).toMatchObject({ type: 'dir', size: 0 });
  expect((await restore(again.id)).path).toBe('docs/a.txt');
  writeFileSync(join(root, 'docs', 'b.txt'), 'b');
  const b = await del('docs/b.txt');
  writeFileSync(join(root, 'docs', 'b.txt'), 'uusi');
  expect((await restore(b.id)).path).toBe('docs/b (2).txt');
  expect((await send('POST', '/api/files/tree/restore', { id: b.id })).status).toBe(404);

  // Delete for good: one entry, then the rest.
  const one = await call(`/api/files/tree/trash?id=${encodeURIComponent(docs.id)}`, {
    method: 'DELETE',
  });
  expect(one.status).toBe(204);
  expect(existsSync(join(root, '.trash', docs.id))).toBe(false);
  await del('docs/b (2).txt');
  expect((await call('/api/files/tree/trash', { method: 'DELETE' })).status).toBe(204);
  expect(await trash()).toEqual([]);

  // The daily job drops entries older than 30 days only.
  const fresh = await del('docs/a.txt');
  writeFileSync(join(root, 'old.txt'), 'old');
  const old = await del('old.txt');
  const oldId = `${Date.now() - 31 * 86_400_000}-old.txt`;
  renameSync(join(root, '.trash', old.id), join(root, '.trash', oldId));
  const work = workStore(srv.db, config.dataDir);
  expect(await purgeTrash(srv.db, work, 'aleksi')).toBe(1);
  expect((await trash()).map((e) => e.id)).toEqual([fresh.id]);
});

test('quota: 10 GB total on upload, attach, chat upload and the agent write', {
  timeout: 30_000,
}, async () => {
  const { root, call, send, upload, llm, c, chat } = await setup([
    { toolCalls: [{ name: 'write', args: { path: 'uusi.txt', content: 'x'.repeat(100) } }] },
    { text: 'Ei mahtunut.' },
  ]);
  // A sparse file: it counts its full size, but takes no disk.
  writeFileSync(join(root, 'iso.bin'), '');
  truncateSync(join(root, 'iso.bin'), USER_QUOTA - 50);
  writeFileSync(join(root, 'pieni.txt'), 'x'.repeat(60));
  const usage = (await (await call('/api/files/tree/usage')).json()) as FileUsage;
  expect(usage).toMatchObject({ used: USER_QUOTA + 10, quota: USER_QUOTA, trash: 0, files: 0 });
  expect(usage.maxFileSize).toBe(200 * 1024 ** 2);
  // Over the 25 MB attachment cap is `too_large`, checked before the quota.
  writeFileSync(join(root, 'suuri.txt'), '');
  truncateSync(join(root, 'suuri.txt'), 26 * 1024 ** 2);
  const big = await send('POST', '/api/files/tree/attach', { path: 'suuri.txt' });
  expect(await big.json()).toEqual({ error: 'too_large' });

  const up = await upload('', [['a.txt', 'x'.repeat(100)]]);
  expect(up.status).toBe(413);
  expect(await up.json()).toEqual({ error: 'quota' });
  expect(existsSync(join(root, 'a.txt'))).toBe(false);
  expect((await send('POST', '/api/files/tree/attach', { path: 'pieni.txt' })).status).toBe(413);
  const form = new FormData();
  form.append('files', new Blob(['hei'], { type: 'text/plain' }), 'liite.txt');
  expect((await call('/api/files', { method: 'POST', body: form })).status).toBe(413);

  c.send({ type: 'user.message', chatId: chat.id, text: 'Kirjoita' });
  const req = await c.next('approval.request');
  c.send({ type: 'approval.respond', requestId: req.requestId, approve: true });
  const end = await c.next('tool.end');
  expect(end.status).toBe('error');
  expect(end.summary).toContain('tallennustila on täynnä');
  await c.idle();
  expect(existsSync(join(root, 'uusi.txt'))).toBe(false);
  expect(JSON.stringify(llm.requests[1]?.body)).toContain('Pyydä käyttäjää vapauttamaan tilaa');
});

test('origin: an agent write records its chat and message; move and trash keep it', {
  timeout: 30_000,
}, async () => {
  const { send, call, list, c, chat } = await setup([
    { toolCalls: [{ name: 'write', args: { path: 'raportti.md', content: '# Q3' } }] },
    { text: 'Kirjoitettu.' },
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kirjoita raportti' });
  const req = await c.next('approval.request');
  c.send({ type: 'approval.respond', requestId: req.requestId, approve: true });
  expect((await c.next('tool.end')).status).toBe('ok');
  const toolMessage = (await c.next('message.final')).message;
  await c.idle();
  const origin = { chatId: chat.id, messageId: toolMessage.id, chatTitle: null };
  expect((await list()).entries[0]).toMatchObject({ name: 'raportti.md', origin });

  await send('POST', '/api/files/tree/mkdir', { path: 'arkisto' });
  await send('POST', '/api/files/tree/move', { from: 'raportti.md', to: 'arkisto/q3.md' });
  expect((await list('arkisto')).entries[0]).toMatchObject({ name: 'q3.md', origin });
  // A folder move carries the files under it.
  await send('POST', '/api/files/tree/move', { from: 'arkisto', to: 'vanhat' });
  expect((await list('vanhat')).entries[0]?.origin).toEqual(origin);
  const del = await call('/api/files/tree?path=vanhat', { method: 'DELETE' });
  const { entry } = (await del.json()) as { entry: TrashEntry };
  await send('POST', '/api/files/tree/restore', { id: entry.id });
  expect((await list('vanhat')).entries[0]?.origin).toEqual(origin);
});

test('guard: the agent cannot read the trash or follow a symlink out', {
  timeout: 30_000,
}, async () => {
  const { root, config, c, chat } = await setup([
    { toolCalls: [{ name: 'read', args: { path: '.trash/1793000000000-old.txt' } }] },
    { text: 'Estetty.' },
    { toolCalls: [{ name: 'read', args: { path: 'linkki/app.db' } }] },
    { text: 'Estetty.' },
    { toolCalls: [{ name: 'read', args: { path: '@../app.db' } }] },
    { text: 'Estetty.' },
  ]);
  mkdirSync(join(root, '.trash'));
  writeFileSync(join(root, '.trash', '1793000000000-old.txt'), 'vanha');
  symlinkSync(config.dataDir, join(root, 'linkki'));
  for (const text of ['Lue roskakori', 'Lue linkki', 'Lue @']) {
    c.send({ type: 'user.message', chatId: chat.id, text });
    const end = await c.next('tool.end');
    expect(end.status, text).toBe('denied');
    expect(end.summary).toContain('path outside workspace');
    await c.idle();
  }
});

test('attach: a work-dir file reaches the model through ingestAttachments as a snapshot', {
  timeout: 30_000,
}, async () => {
  const { root, send, llm, call, c, chat } = await setup([{ text: 'Luettu.' }]);
  writeFileSync(join(root, 'muistio.md'), '# Muistio\nversio 1');
  writeFileSync(join(root, 'skripti.py'), 'print(1)');
  writeFileSync(join(root, 'kuva.png'), 'ei oikea kuva');
  writeFileSync(join(root, 'data.bin'), Buffer.from([0, 1, 2]));
  const attach = (path: string, chatId?: string) =>
    send('POST', '/api/files/tree/attach', { path, chatId });
  const md = await attach('muistio.md', chat.id);
  expect(md.status).toBe(200);
  const { file } = (await md.json()) as { file: AttachmentRef };
  expect(file).toMatchObject({ name: 'muistio.md', mime: 'text/markdown', kind: 'document' });
  const py = (await (await attach('skripti.py')).json()) as { file: AttachmentRef };
  expect(py.file.mime).toBe('text/plain');
  expect((await attach('kuva.png')).status).toBe(415);
  expect((await attach('data.bin')).status).toBe(415);
  expect((await attach('puuttuu.md')).status).toBe(404);
  // Later edits do not change the attachment.
  writeFileSync(join(root, 'muistio.md'), 'versio 2');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Lue', attachments: [file] });
  await c.next('message.final');
  await c.idle();
  const body = JSON.stringify(llm.requests[0]?.body);
  expect(body).toContain('[Liite: muistio.md]\\n# Muistio\\nversio 1');
  c.send({ type: 'chat.open', chatId: chat.id });
  const state = await c.next('chat.state');
  expect(state.messages[0]?.attachments.map((a) => a.name)).toEqual(['muistio.md']);
  // Liitteet lists the copies with their chat.
  const uploads = (await (await call('/api/files/tree?root=files')).json()) as TreeListing;
  // Without `chatId` the copy binds to its chat when a message carries it (ingestAttachments).
  expect(uploads.entries.map((e) => [e.name, e.origin?.chatId ?? null, e.preview])).toEqual([
    ['skripti.py', null, 'text'],
    ['muistio.md', chat.id, 'markdown'],
  ]);
  const page = (await (await call('/api/files/tree?root=files&limit=1')).json()) as TreeListing;
  expect(page.entries.map((e) => e.name)).toEqual(['skripti.py']);
  const next = await call(
    `/api/files/tree?root=files&limit=1&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
  );
  expect(((await next.json()) as TreeListing).entries.map((e) => e.name)).toEqual(['muistio.md']);
  const raw = await call(`/api/files/tree/raw?root=files&path=${file.id}`);
  expect(await raw.text()).toBe('# Muistio\nversio 1');
});

test('artifactName: the extension is artifactExt; a title that ends in it keeps one', () => {
  const name = (kind: Artifact['kind'], language: string, title: string) =>
    artifactName({ id: 'a', kind, language, title, content: '' });
  expect([
    name('react', 'tsx', 'Kortti'),
    name('react', 'jsx', 'Kortti'),
    name('mermaid', 'mermaid', 'Prosessi'),
    name('vega-lite', 'vega-lite', 'Myynti.JSON'),
    name('html', 'html', '/'),
  ]).toEqual(['Kortti.tsx', 'Kortti.jsx', 'Prosessi.mmd', 'Myynti.JSON', 'artefakti.html']);
});

test('artifact: Tallenna tiedostoksi writes real values with the origin', {
  timeout: 30_000,
}, async () => {
  const reply = 'Tässä:\n\n```html\n<h1>Raportti</h1><p>Pekka Laaksonen</p>\n```';
  const b = await bootPseudo({ 'Matti Virtanen': 'Pekka Laaksonen' }, [{ text: reply }]);
  const { c, chat, sc, srv } = b;
  const { send } = await client(b);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Raportti Matti Virtanen' });
  const final = (await c.next('message.final')).message;
  const { artifact } = await c.next('artifact.upsert');
  await c.idle();
  const save = (body: object) => send('POST', '/api/files/tree/artifact', body);
  const res = await save({ chatId: chat.id, artifactId: artifact.id });
  expect(res.status).toBe(201);
  const { entry } = (await res.json()) as { entry: TreeEntry };
  expect(entry).toMatchObject({
    name: 'Raportti.html',
    preview: 'html',
    origin: { chatId: chat.id, messageId: final.id },
  });
  const disk = readFileSync(join(srv.registry.cwd, 'Raportti.html'), 'utf8');
  expect(disk).toBe('<h1>Raportti</h1><p>Matti Virtanen</p>');
  const again = (await (await save({ chatId: chat.id, artifactId: artifact.id })).json()) as {
    entry: TreeEntry;
  };
  expect(again.entry.name).toBe('Raportti (2).html');
  expect((await save({ chatId: chat.id, artifactId: 'nope' })).status).toBe(404);
  expect((await save({ chatId: 'other', artifactId: artifact.id })).status).toBe(404);
  expect((await save({ chatId: chat.id, artifactId: artifact.id, dir: 'puuttuu' })).status).toBe(
    404,
  );
  await sc.close();
  expect(await (await save({ chatId: chat.id, artifactId: artifact.id })).json()).toEqual({
    error: 'pseudo_down',
  });
});

test('upload: the route limit beats the 25 MB plugin default; a root .trash name is renamed', {
  timeout: 60_000,
}, async () => {
  const { upload, call } = await setup();
  const big = await upload('', [['iso.txt', 'x'.repeat(30 * 1024 ** 2)]]);
  expect(big.status).toBe(201);
  expect(((await big.json()) as { entries: TreeEntry[] }).entries[0]?.size).toBe(30 * 1024 ** 2);
  // A root-level `.trash` (any case) would stand in for the trash folder.
  const dot = await upload('', [['.TRASH', 'a']]);
  expect(((await dot.json()) as { entries: TreeEntry[] }).entries.map((e) => e.name)).toEqual([
    '_.TRASH',
  ]);
  expect((await call('/api/files/tree?path=_.TRASH', { method: 'DELETE' })).status).toBe(200);
  const again = await upload('', [['.trash', 'b']]);
  expect(((await again.json()) as { entries: TreeEntry[] }).entries[0]?.name).toBe('_.trash');
});

test('quota: an upload stops mid-request; of two parallel uploads near the limit one passes', {
  timeout: 30_000,
}, async () => {
  const { root, upload } = await setup();
  writeFileSync(join(root, 'harva.bin'), '');
  truncateSync(join(root, 'harva.bin'), USER_QUOTA - 150);
  const two = await upload('', [
    ['a.txt', 'x'.repeat(100)],
    ['b.txt', 'x'.repeat(100)],
  ]);
  expect(two.status).toBe(413);
  expect(await two.json()).toEqual({ error: 'quota' });
  expect(existsSync(join(root, 'a.txt')) || existsSync(join(root, 'b.txt'))).toBe(false);
  const both = await Promise.all([
    upload('', [['c.txt', 'x'.repeat(100)]]),
    upload('', [['d.txt', 'x'.repeat(100)]]),
  ]);
  expect(both.map((r) => r.status).sort()).toEqual([201, 413]);
});

test('trash folder: a symlink or a file in its place is refused; purge never wipes on errors', {
  timeout: 30_000,
}, async () => {
  const { root, config, srv, call, send } = await setup();
  const work = workStore(srv.db, config.dataDir);
  const later = Date.now() + 365 * 86_400_000;
  const row = (id: string) => ({
    userId: 'aleksi',
    id,
    originalPath: 'x.txt',
    deletedAt: new Date().toISOString(),
  });
  const rows = () => srv.db.select().from(fileTrash).all().length;
  const elsewhere = join(config.dataDir, 'muu');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, '1793000000000-x.txt'), 'x');
  symlinkSync(elsewhere, join(root, '.trash'));
  writeFileSync(join(root, 'a.txt'), 'a');
  srv.db.insert(fileTrash).values(row('1793000000000-x.txt')).run();
  expect((await call('/api/files/tree?path=a.txt', { method: 'DELETE' })).status).toBe(409);
  expect((await call('/api/files/tree/trash')).status).toBe(409);
  expect((await call('/api/files/tree/trash', { method: 'DELETE' })).status).toBe(409);
  const restore = await send('POST', '/api/files/tree/restore', { id: '1793000000000-x.txt' });
  expect(restore.status).toBe(409);
  expect(await purgeTrash(srv.db, work, 'aleksi', later)).toBe(0);
  expect(existsSync(join(elsewhere, '1793000000000-x.txt'))).toBe(true);
  expect(existsSync(join(root, 'a.txt'))).toBe(true);
  expect(rows()).toBe(1);

  unlinkSync(join(root, '.trash'));
  writeFileSync(join(root, '.trash'), 'ei kansio');
  expect((await call('/api/files/tree?path=a.txt', { method: 'DELETE' })).status).toBe(409);
  unlinkSync(join(root, '.trash'));

  // An unreadable trash makes the job fail, not drop the rows.
  mkdirSync(join(root, '.trash'));
  if (process.getuid?.() !== 0) {
    chmodSync(join(root, '.trash'), 0);
    await expect(purgeTrash(srv.db, work, 'aleksi', later)).rejects.toThrow();
    chmodSync(join(root, '.trash'), 0o755);
    expect(rows()).toBe(1);
  }
  // An empty trash: rows without entries go.
  expect(await purgeTrash(srv.db, work, 'aleksi', later)).toBe(0);
  expect(rows()).toBe(0);
});

test('guard after pseudo: the path, the size check and the origin use real values', {
  timeout: 30_000,
}, async () => {
  const b = await bootPseudo({ 'Matti Virtanen': 'Pekka' }, [
    { toolCalls: [{ name: 'write', args: { path: 'Pekka.txt', content: 'Pekka' } }] },
    { text: 'Kirjoitettu.' },
    { toolCalls: [{ name: 'write', args: { path: 'linkki.txt', content: 'uusi' } }] },
    { text: 'Kirjoitettu.' },
    { toolCalls: [{ name: 'write', args: { path: 'iso.txt', content: 'Pekka Pekka' } }] },
    { text: 'Ei mahtunut.' },
  ]);
  const { c, chat, srv } = b;
  const { list } = await client(b);
  const root = srv.registry.cwd;
  const turn = async (text: string) => {
    c.send({ type: 'user.message', chatId: chat.id, text });
    const req = await c.next('approval.request');
    c.send({ type: 'approval.respond', requestId: req.requestId, approve: true });
    const end = await c.next('tool.end');
    await c.idle();
    return end;
  };
  /** Ids of the assistant messages with a tool call, as `chat.state` has them. */
  const toolMessages = async () => {
    c.send({ type: 'chat.open', chatId: chat.id });
    const { messages } = await c.next('chat.state');
    return messages.filter((m) => m.tools.length).map((m) => m.id);
  };
  expect((await turn('Kirjoita Matti Virtanen')).status).toBe('ok');
  expect(readFileSync(join(root, 'Matti Virtanen.txt'), 'utf8')).toBe('Matti Virtanen');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'a.txt'), 'vanha');
  symlinkSync(join(root, 'docs', 'a.txt'), join(root, 'linkki.txt'));
  expect((await turn('Kirjoita linkkiin')).status).toBe('ok');
  const [first, second] = await toolMessages();
  const byName = new Map((await list()).entries.map((e) => [e.name, e]));
  // The origin sits on the names the user sees: the real file name and the link itself.
  expect(byName.get('Matti Virtanen.txt')?.origin?.messageId).toBe(first);
  expect(byName.get('linkki.txt')?.origin?.messageId).toBe(second);
  // 'Pekka Pekka' (11 bytes) would fit in 20; the real text (29 bytes) does not. The size cache
  // is empty since the last write, so the guard walks the dir again and sees the sparse file.
  const used = await dirBytes(root);
  writeFileSync(join(root, 'harva.bin'), '');
  truncateSync(join(root, 'harva.bin'), USER_QUOTA - used - 20);
  const third = await turn('Kirjoita iso');
  expect(third.status).toBe('error');
  expect(third.summary).toContain('tallennustila on täynnä');
  expect(existsSync(join(root, 'iso.txt'))).toBe(false);
});
