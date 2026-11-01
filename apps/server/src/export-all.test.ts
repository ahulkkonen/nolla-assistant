import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { inflateRawSync } from 'node:zlib';
import { authSessions, claims, type Db } from '@pa/db';
import { type AttachmentRef, ChatExport, type ExportJob } from '@pa/protocol';
import { afterEach, expect, test } from 'vitest';
import { api, bootChat, bootPseudo, login, runCleanups, tempDir } from './test-utils.ts';
import {
  EXPORT_VERSION,
  ExportFormatError,
  exportDecrypt,
  exportEncrypt,
  type ZipEntry,
  ZipTooLarge,
  zip,
} from './zip.ts';

afterEach(runCleanups);

const has = (cmd: string) => spawnSync(cmd, ['-h'], { stdio: 'ignore' }).error === undefined;

/** Phase 17: one claim with a real name (the open export carries it, the masked one does not). */
const seedClaim = (db: Db) =>
  db
    .insert(claims)
    .values({
      userId: 'aleksi',
      kind: 'relationship',
      text: 'Matti Virtanen on käyttäjän esihenkilö.',
      confidence: 0.9,
      status: 'active',
      recordedAt: new Date().toISOString(),
    })
    .run();

/** The entries of a zip from its central directory: name to content. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const csize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const data = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.set(name, inflateRawSync(buf.subarray(data, data + csize)));
    at += 46 + nameLen;
  }
  return out;
}

/** An export file back to plain bytes through `exportDecrypt`. */
async function decrypt(file: Buffer, passphrase: string): Promise<Buffer> {
  const dir = tempDir('pa-dec-');
  writeFileSync(join(dir, 'x.zip.enc'), file);
  await exportDecrypt(join(dir, 'x.zip.enc'), join(dir, 'x.zip'), passphrase);
  return readFileSync(join(dir, 'x.zip'));
}

const collect = async (entries: ZipEntry[], max?: number) => {
  const parts: Buffer[] = [];
  for await (const p of zip(entries, max)) parts.push(p);
  return Buffer.concat(parts);
};

test('zip: entries round-trip, UTF-8 names, cap', async () => {
  const big = Buffer.alloc(200_000, 'a');
  async function* chunks() {
    yield Buffer.from('ensimmäinen ');
    yield Buffer.from('toinen');
  }
  const archive = await collect([
    { name: 'a.txt', data: Buffer.from('hei') },
    { name: 'kansio/ääkköset.md', data: chunks(), mtime: new Date(2026, 9, 26, 17, 20) },
    { name: 'tyhjä', data: Buffer.alloc(0) },
    { name: 'iso.bin', data: big },
  ]);
  const files = unzip(archive);
  expect([...files.keys()]).toEqual(['a.txt', 'kansio/ääkköset.md', 'tyhjä', 'iso.bin']);
  expect(files.get('kansio/ääkköset.md')?.toString()).toBe('ensimmäinen toinen');
  expect(files.get('tyhjä')?.length).toBe(0);
  expect(files.get('iso.bin')?.equals(big)).toBe(true);
  // The stock unzip agrees on CRCs and names.
  if (has('unzip')) {
    const path = join(tempDir('pa-zip-'), 'a.zip');
    writeFileSync(path, archive);
    const t = spawnSync('unzip', ['-t', path], { encoding: 'utf8' });
    expect(t.status).toBe(0);
    expect(t.stdout).toContain('No errors detected');
  }
  await expect(collect([{ name: 'x', data: Buffer.alloc(10) }], 5)).rejects.toBeInstanceOf(
    ZipTooLarge,
  );
});

test('encrypt: round trip; a flipped byte, a wrong passphrase or a version-1 file writes nothing', {
  timeout: 20_000,
}, async () => {
  const plain = Buffer.concat([Buffer.from('salainen '), Buffer.alloc(70_000, 7)]);
  const cipher = await exportEncrypt('oikein hevonen akku');
  const file = await buffer(Readable.from([plain.subarray(0, 5), plain.subarray(5)]).pipe(cipher));
  expect(file.subarray(0, 9).toString('latin1')).toBe(
    `PAEXPORT${String.fromCharCode(EXPORT_VERSION)}`,
  );
  expect((await decrypt(file, 'oikein hevonen akku')).equals(plain)).toBe(true);
  const dir = tempDir('pa-dec-');
  const fails = async (bytes: Buffer, passphrase = 'oikein hevonen akku') => {
    writeFileSync(join(dir, 'x.zip.enc'), bytes);
    const err = await exportDecrypt(join(dir, 'x.zip.enc'), join(dir, 'x.zip'), passphrase).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(readdirSync(dir)).toEqual(['x.zip.enc']);
    return err;
  };
  // A changed byte anywhere: in the ciphertext, the header (the AAD) or the tag.
  for (const at of [file.length >> 1, 12, file.length - 1]) {
    const bad = Buffer.from(file);
    bad[at] = (bad[at] ?? 0) ^ 1;
    expect(await fails(bad)).toBeInstanceOf(Error);
  }
  expect(await fails(file, 'väärä salasana')).toBeInstanceOf(Error);
  const old = Buffer.concat([Buffer.from('Salted__'), Buffer.alloc(64, 1)]);
  const err = await fails(old);
  expect(err).toBeInstanceOf(ExportFormatError);
  expect((err as Error).message).toMatch(/^version 1 file/);
  const v9 = Buffer.from(file);
  v9[8] = 9;
  expect(((await fails(v9)) as Error).message).toBe('unknown export version 9');
});

const REPLY = 'Hei Pekka Laaksonen.';

/** A pseudo boot with one chat turn; `start` posts `POST /api/export`. */
async function bootExport(attach?: (cookie: string, port: number) => Promise<AttachmentRef[]>) {
  const b = await bootPseudo({ 'Matti Virtanen': 'Pekka Laaksonen' }, [{ text: REPLY }]);
  const { port } = b.config;
  const { cookie } = await login(port);
  const attachments = attach ? await attach(cookie, port) : [];
  b.c.send({ type: 'user.message', chatId: b.chat.id, text: 'Olen Matti Virtanen', attachments });
  await b.c.idle();
  const start = (body: object) =>
    api(port, '/api/export', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { ...b, port, cookie, attachments, start };
}

/** Polls `GET /api/export` until the job leaves `building`. */
async function settle(port: number, cookie: string): Promise<ExportJob> {
  for (;;) {
    const { job } = (await (await api(port, '/api/export', { headers: { cookie } })).json()) as {
      job: ExportJob;
    };
    if (job.status !== 'building') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('export job: open export has chats, vault, memory, work dir and uploads; download once', {
  timeout: 60_000,
}, async () => {
  const { c, chat, config, srv, port, cookie, start, attachments } = await bootExport(
    async (cookie, port) => {
      const form = new FormData();
      form.append('files', new Blob(['liite 42'], { type: 'text/plain' }), 'Matti Virtanen.txt');
      const up = await api(port, '/api/files', { method: 'POST', body: form, headers: { cookie } });
      return ((await up.json()) as { files: AttachmentRef[] }).files;
    },
  );
  const { dataDir } = config;
  const work = srv.registry.cwd;
  mkdirSync(join(work, 'muistiinpanot'));
  writeFileSync(join(work, 'muistiinpanot', 'a.txt'), 'työtiedosto');
  mkdirSync(join(work, '.trash'));
  writeFileSync(join(work, '.trash', 'pois.txt'), 'roskis');
  symlinkSync(join(dataDir, 'app.db'), join(work, 'linkki'));
  writeFileSync(join(dataDir, 'memory', 'aleksi', 'USER.md'), 'Käyttäjä on Matti Virtanen.');
  seedClaim(srv.db);

  const res = await start({ passphrase: 'pitkä salasana 42', unmask: true });
  expect(res.status).toBe(202);
  const { job: started } = (await res.json()) as { job: ExportJob };
  expect(started).toMatchObject({ status: 'building', masked: false, done: 0 });
  // A second start while it runs.
  expect((await start({ passphrase: 'pitkä salasana 42' })).status).toBe(409);
  const job = await settle(port, cookie);
  expect(job).toMatchObject({
    status: 'ready',
    error: null,
    fileName: expect.stringMatching(/^pa-vienti-\d{4}-\d{2}-\d{2}-avoin\.zip\.enc$/),
  });
  expect(job.done).toBe(job.total);
  // Progress reached the sockets.
  expect(c.inbox.some((m) => m.type === 'export.state' && m.job?.status === 'ready')).toBe(true);

  const url = `/api/export/${job.id}/download`;
  expect((await api(port, url)).status).toBe(401);
  const dl = await api(port, url, { headers: { cookie } });
  expect(dl.status).toBe(200);
  expect(dl.headers.get('content-type')).toBe('application/octet-stream');
  expect(dl.headers.get('cache-control')).toBe('no-store');
  expect(dl.headers.get('content-disposition')).toBe(`attachment; filename="${job.fileName}"`);
  const file = Buffer.from(await dl.arrayBuffer());
  expect(file.length).toBe(job.size);
  const entries = unzip(await decrypt(file, 'pitkä salasana 42'));
  const names = [...entries.keys()];
  const md = names.find((n) => /^keskustelut\/.*-avoin-.{8}\.md$/.test(n)) ?? '';
  expect(md.endsWith(`-${chat.id.slice(0, 8)}.md`)).toBe(true);
  expect(entries.get(md)?.toString()).toContain('> Olen Matti Virtanen');
  const e = ChatExport.parse(
    JSON.parse(entries.get(md.replace(/\.md$/, '.json'))?.toString() ?? ''),
  );
  expect(e.messages.map((m) => m.text)).toEqual(['Olen Matti Virtanen', 'Hei Matti Virtanen.']);
  expect(JSON.parse(entries.get('vault.json')?.toString() ?? '')).toHaveProperty('entities');
  expect(entries.get('muisti/USER.md')?.toString()).toBe('Käyttäjä on Matti Virtanen.');
  expect(entries.get('muisti/MEMORY.md')?.toString()).toBe('');
  expect(JSON.parse(entries.get('muisti/havainnot.json')?.toString() ?? '')).toMatchObject([
    { text: 'Matti Virtanen on käyttäjän esihenkilö.', evidence: [], entityIds: [] },
  ]);
  expect(entries.get('tyokansio/muistiinpanot/a.txt')?.toString()).toBe('työtiedosto');
  expect(entries.get(`liitteet/${attachments[0]?.id}-Matti Virtanen.txt`)?.toString()).toBe(
    'liite 42',
  );
  expect(names.some((n) => n.includes('.trash') || n.includes('linkki'))).toBe(false);
  const manifest = JSON.parse(entries.get('manifest.json')?.toString() ?? '');
  expect(manifest).toMatchObject({ version: 1, masked: false, chats: 1, omitted: [] });
  expect(manifest.skipped).toEqual([{ path: 'tyokansio/linkki', reason: 'symlink' }]);
  expect(manifest.entries.map((x: { path: string }) => x.path).sort()).toEqual(
    names.filter((n) => n !== 'manifest.json').sort(),
  );

  // Once: the file and the job are gone.
  expect((await api(port, url, { headers: { cookie } })).status).toBe(410);
  expect(readdirSync(join(dataDir, 'exports'))).toEqual([]);
  expect(await (await api(port, '/api/export', { headers: { cookie } })).json()).toEqual({
    job: null,
  });
});

test('export job: masked export has only chats; bad passphrase, cancel, pseudo down', {
  timeout: 60_000,
}, async () => {
  const { config, sc, srv, port, cookie, start } = await bootExport();
  const { dataDir } = config;
  seedClaim(srv.db);

  const short = await start({ passphrase: 'lyhyt' });
  expect(short.status).toBe(400);
  expect(await short.json()).toMatchObject({ error: 'bad_message', path: 'passphrase' });

  // Cancel while it builds: nothing stays.
  const { job: cancelled } = (await (await start({ passphrase: 'pitkä salasana 42' })).json()) as {
    job: ExportJob;
  };
  expect(
    (await api(port, `/api/export/${cancelled.id}`, { method: 'DELETE', headers: { cookie } }))
      .status,
  ).toBe(204);
  expect(await (await api(port, '/api/export', { headers: { cookie } })).json()).toEqual({
    job: null,
  });
  expect(existsSync(join(dataDir, 'exports', cancelled.id))).toBe(false);

  expect((await start({ passphrase: 'pitkä salasana 42' })).status).toBe(202);
  const job = await settle(port, cookie);
  expect(job).toMatchObject({ status: 'ready', masked: true });
  expect(job.fileName).toMatch(/-masked\.zip\.enc$/);
  const dl = await api(port, `/api/export/${job.id}/download`, { headers: { cookie } });
  const entries = unzip(await decrypt(Buffer.from(await dl.arrayBuffer()), 'pitkä salasana 42'));
  const names = [...entries.keys()];
  expect(names.every((n) => n.startsWith('keskustelut/') || n === 'manifest.json')).toBe(true);
  expect(names).toHaveLength(3);
  const text = [...entries.values()].map((b) => b.toString()).join('\n');
  expect(text).toContain('Pekka Laaksonen');
  expect(text).not.toContain('Matti');
  expect(JSON.parse(entries.get('manifest.json')?.toString() ?? '')).toMatchObject({
    masked: true,
    omitted: ['vault.json', 'muisti/', 'tyokansio/', 'liitteet/'],
  });

  // Real names need a fresh login (the passkey rule); a masked export does not.
  const age = (createdAt: string) => srv.db.update(authSessions).set({ createdAt }).run();
  age(new Date(Date.now() - 11 * 60_000).toISOString());
  const stale = await start({ passphrase: 'pitkä salasana 42', unmask: true });
  expect([stale.status, await stale.json()]).toEqual([403, { error: 'reauth' }]);
  age(new Date().toISOString());

  // The sidecar goes down mid-way: the open export fails and keeps no file.
  await sc.close();
  expect((await start({ passphrase: 'pitkä salasana 42', unmask: true })).status).toBe(202);
  expect(await settle(port, cookie)).toMatchObject({ status: 'failed', error: 'pseudo_down' });
  expect(readdirSync(join(dataDir, 'exports'))).toEqual([]);
});

test('export job: real names need a sidecar (503)', { timeout: 30_000 }, async () => {
  const { config } = await bootChat([]);
  const { cookie } = await login(config.port);
  const res = await api(config.port, '/api/export', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: 'pitkä salasana 42', unmask: true }),
  });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: 'pseudo_down' });
});
