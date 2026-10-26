import { spawnSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { inflateRawSync } from 'node:zlib';
import { type AttachmentRef, ChatExport, EXPORT_PBKDF2_ITER, type ExportJob } from '@pa/protocol';
import { afterEach, expect, test } from 'vitest';
import { api, bootChat, bootPseudo, login, runCleanups, tempDir } from './test-utils.ts';
import { opensslEncrypt, type ZipEntry, ZipTooLarge, zip } from './zip.ts';

afterEach(runCleanups);

const has = (cmd: string) => spawnSync(cmd, ['-h'], { stdio: 'ignore' }).error === undefined;

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

/** The OpenSSL `enc` format back to plain bytes, in Node. */
function decrypt(file: Buffer, passphrase: string): Buffer {
  expect(file.subarray(0, 8).toString()).toBe('Salted__');
  const km = pbkdf2Sync(passphrase, file.subarray(8, 16), EXPORT_PBKDF2_ITER, 48, 'sha256');
  const d = createDecipheriv('aes-256-cbc', km.subarray(0, 32), km.subarray(32));
  return Buffer.concat([d.update(file.subarray(16)), d.final()]);
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

test('encrypt: openssl decrypts the file', { timeout: 20_000 }, async () => {
  const plain = Buffer.concat([Buffer.from('salainen '), Buffer.alloc(70_000, 7)]);
  const cipher = await opensslEncrypt('oikein hevonen akku');
  const file = await buffer(Readable.from([plain.subarray(0, 5), plain.subarray(5)]).pipe(cipher));
  expect(decrypt(file, 'oikein hevonen akku').equals(plain)).toBe(true);
  expect(() => decrypt(file, 'väärä salasana')).toThrow();
  if (!has('openssl')) return;
  const dir = tempDir('pa-enc-');
  writeFileSync(join(dir, 'x.zip.enc'), file);
  const args = ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', String(EXPORT_PBKDF2_ITER)];
  const r = spawnSync(
    'openssl',
    [...args, '-md', 'sha256', '-in', join(dir, 'x.zip.enc'), '-pass', 'pass:oikein hevonen akku'],
    { maxBuffer: 1 << 24 },
  );
  expect(r.status).toBe(0);
  expect(Buffer.from(r.stdout).equals(plain)).toBe(true);
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
  const entries = unzip(decrypt(file, 'pitkä salasana 42'));
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
  const { config, sc, port, cookie, start } = await bootExport();
  const { dataDir } = config;

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
  const entries = unzip(decrypt(Buffer.from(await dl.arrayBuffer()), 'pitkä salasana 42'));
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
