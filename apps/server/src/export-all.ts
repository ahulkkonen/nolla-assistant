import { randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { lstat, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { chats, files } from '@pa/db';
import { FILES } from '@pa/pi-ext-memory';
import { PseudoDownError } from '@pa/pi-ext-pseudo';
import { TRASH } from '@pa/pi-ext-subagents/workspace';
import { type ExportJob, ExportStart, type ServerMessage } from '@pa/protocol';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { BridgeDeps } from './bridge.ts';
import { chatExport, dateOf, fileName, toMarkdown } from './export.ts';
import type { MemoryStore } from './memory.ts';
import type { WorkStore } from './tree.ts';
import { opensslEncrypt, type ZipEntry, ZipTooLarge, zip } from './zip.ts';

// "Vie kaikki tiedot" (docs/decisions/phase-15-admin.md, decisions 13 to 18).

/** Input bytes per export (decision 18): below the ZIP64 limits, bounded disk use. */
export const EXPORT_MAX_BYTES = 2 * 1024 ** 3;
const TTL_MS = 60 * 60_000;
const TICK_MS = 250;
/** What a masked export leaves out: these parts hold real values (decision 15). */
const OMITTED = ['vault.json', 'muisti/', 'tyokansio/', 'liitteet/'];

type Deps = Pick<BridgeDeps, 'db' | 'registry' | 'pseudo' | 'agents' | 'fx'> & {
  dataDir: string;
  memory: Pick<MemoryStore, 'read'>;
  work: Pick<WorkStore, 'root' | 'workBytes' | 'uploadBytes'>;
  sendAll: (msg: ServerMessage) => void;
  warn: (msg: string, data?: object) => void;
};

type Job = ExportJob & {
  userId: string;
  dir: string;
  path: string;
  abort: AbortController;
  timer?: NodeJS.Timeout;
  downloading: boolean;
};

type Skipped = { path: string; reason: 'symlink' | 'unreadable' };
type WorkFile = { rel: string; abs: string; size: number; mtime: Date };

/** Regular files under `root` without `.trash`; symlinks are listed, never followed. */
async function workFiles(root: string) {
  const out: WorkFile[] = [];
  const skipped: Skipped[] = [];
  const walk = async (dir: string, rel: string) => {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (!rel && d.name === TRASH) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      const abs = join(dir, d.name);
      if (d.isSymbolicLink()) skipped.push({ path: `tyokansio/${r}`, reason: 'symlink' });
      else if (d.isDirectory()) await walk(abs, r);
      else if (d.isFile()) {
        const s = await lstat(abs);
        out.push({ rel: r, abs, size: s.size, mtime: s.mtime });
      }
    }
  };
  await walk(root, '').catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
  return { out, skipped };
}

/** A regular file whose folder is inside `root`, opened without following a symlink. */
async function openInside(abs: string, root: string) {
  const dir = await realpath(dirname(abs)).catch(() => '');
  if (dir !== root && !dir.startsWith(root + sep)) return undefined;
  const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (fh && !(await fh.stat()).isFile()) {
    await fh.close();
    return undefined;
  }
  return fh;
}

const view = ({ userId: _, dir: __, path: ___, abort, timer, downloading, ...j }: Job): ExportJob =>
  j;

export type ExportJobs = ReturnType<typeof exportJobs>;

export function exportJobs(deps: Deps) {
  const { db, pseudo, memory, work, sendAll, warn } = deps;
  const root = join(deps.dataDir, 'exports');
  // Jobs live in memory: what a restart left behind goes (decision 17).
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let job: Job | undefined;
  /** Downloaded or expired ids: 410 instead of 404. */
  const gone = new Set<string>();
  let last = 0;

  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - last < TICK_MS) return;
    last = now;
    sendAll({ type: 'export.state', job: job ? view(job) : null });
  };

  /** Ends `j`: aborts a build, deletes its folder, forgets it. */
  const drop = (j: Job) => {
    j.abort.abort();
    clearTimeout(j.timer);
    rmSync(j.dir, { recursive: true, force: true });
    if (job === j) {
      job = undefined;
      emit(true);
    }
  };

  async function* entries(j: Job, unmask: boolean): AsyncGenerator<ZipEntry> {
    const { userId } = j;
    const manifest = {
      version: 1,
      createdAt: j.createdAt,
      masked: !unmask,
      chats: 0,
      entries: [] as { path: string; size: number }[],
      skipped: [] as Skipped[],
      omitted: unmask ? [] : OMITTED,
    };
    const tick = () => {
      j.done++;
      emit();
    };
    /** A text entry; listed in the manifest once the zip took it. */
    async function* text(name: string, s: string): AsyncGenerator<ZipEntry> {
      const data = Buffer.from(s);
      yield { name, data };
      manifest.entries.push({ path: name, size: data.length });
    }
    /** A file entry, or a skipped one when it is not a regular file inside `root`. */
    async function* file(name: string, abs: string, root: string, size: number, mtime: Date) {
      const fh = root ? await openInside(abs, root) : undefined;
      if (!fh) manifest.skipped.push({ path: name, reason: 'unreadable' });
      else {
        yield { name, data: fh.createReadStream(), mtime } satisfies ZipEntry;
        manifest.entries.push({ path: name, size });
      }
      tick();
    }

    const rows = db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.userId, userId))
      .orderBy(asc(chats.createdAt))
      .all();
    const workRoot = await realpath(work.root(userId)).catch(() => '');
    const found = unmask && workRoot ? await workFiles(workRoot) : { out: [], skipped: [] };
    manifest.skipped.push(...found.skipped);
    const uploads = unmask ? db.select().from(files).where(eq(files.userId, userId)).all() : [];
    const filesRoot = await realpath(join(deps.dataDir, 'files')).catch(() => '');
    const bytes = [...found.out, ...uploads].reduce((n, f) => n + f.size, 0);
    if (bytes > EXPORT_MAX_BYTES) throw new ZipTooLarge('input over the cap');
    j.total = rows.length + (unmask ? 3 + found.out.length + uploads.length : 0) + 1;
    emit(true);

    for (const r of rows) {
      // No message cap here: one chat at a time is in memory (decision 14).
      const e = await chatExport(deps, userId, r.id, unmask, Number.POSITIVE_INFINITY);
      if (e) {
        const base = `keskustelut/${fileName(e, 'md').slice(0, -'.md'.length)}-${r.id.slice(0, 8)}`;
        yield* text(`${base}.md`, toMarkdown(e));
        yield* text(`${base}.json`, JSON.stringify(e, null, 2));
        manifest.chats++;
      }
      tick();
    }
    if (unmask) {
      if (!pseudo) throw new PseudoDownError('no sidecar');
      yield* text('vault.json', JSON.stringify(await pseudo.vaultList(), null, 2));
      tick();
      for (const t of ['user', 'memory'] as const) {
        yield* text(`muisti/${FILES[t]}`, memory.read(t));
        tick();
      }
      for (const f of found.out)
        yield* file(`tyokansio/${f.rel}`, f.abs, workRoot, f.size, f.mtime);
      for (const u of uploads) {
        // A name is one path segment in the archive.
        const name = `liitteet/${u.id}-${u.name.replace(/[/\\\p{Cc}]/gu, '_')}`;
        yield* file(name, join(deps.dataDir, u.path), filesRoot, u.size, new Date(u.createdAt));
      }
    }
    yield* text('manifest.json', JSON.stringify(manifest, null, 2));
    tick();
  }

  const run = async (j: Job, passphrase: string, unmask: boolean) => {
    const part = `${j.path}.part`;
    try {
      const cipher = await opensslEncrypt(passphrase);
      await pipeline(
        zip(entries(j, unmask), EXPORT_MAX_BYTES),
        cipher,
        createWriteStream(part, { mode: 0o600 }),
        { signal: j.abort.signal },
      );
      await rename(part, j.path);
      if (job !== j) return;
      const now = Date.now();
      Object.assign(j, {
        status: 'ready',
        size: (await stat(j.path)).size,
        expiresAt: new Date(now + TTL_MS).toISOString(),
      });
      j.timer = setTimeout(() => {
        gone.add(j.id);
        drop(j);
      }, TTL_MS);
      j.timer.unref();
      emit(true);
    } catch (err) {
      rmSync(j.dir, { recursive: true, force: true });
      if (j.abort.signal.aborted || job !== j) return;
      j.status = 'failed';
      j.error =
        err instanceof PseudoDownError
          ? 'pseudo_down'
          : err instanceof ZipTooLarge
            ? 'too_large'
            : 'failed';
      // The code and the error's name only: a message may hold a file name.
      warn('export failed', { error: j.error, name: err instanceof Error ? err.name : 'unknown' });
      emit(true);
    }
  };

  return {
    routes(app: FastifyInstance, auth: preHandlerHookHandler) {
      app.post('/api/export', { preHandler: auth }, async (req, reply) => {
        const body = ExportStart.safeParse(req.body);
        if (!body.success) {
          const issue = body.error.issues[0];
          return reply.code(400).send({
            error: 'bad_message',
            path: issue?.path.join('.') ?? '',
            message: issue?.message ?? 'invalid',
          });
        }
        const { passphrase, unmask } = body.data;
        if (job?.status === 'building') return reply.code(409).send({ error: 'busy' });
        if (unmask && !pseudo) return reply.code(503).send({ error: 'pseudo_down' });
        if (
          unmask &&
          (await work.workBytes(req.userId)) + work.uploadBytes(req.userId) > EXPORT_MAX_BYTES
        )
          return reply.code(413).send({ error: 'too_large' });
        if (job) drop(job);
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        const name = `pa-vienti-${dateOf(createdAt)}-${unmask ? 'avoin' : 'masked'}.zip.enc`;
        const dir = join(root, id);
        mkdirSync(dir, { mode: 0o700 });
        const j: Job = {
          id,
          status: 'building',
          masked: !unmask,
          done: 0,
          total: 0,
          error: null,
          size: null,
          fileName: name,
          createdAt,
          expiresAt: null,
          userId: req.userId,
          dir,
          path: join(dir, name),
          abort: new AbortController(),
          downloading: false,
        };
        job = j;
        void run(j, passphrase, unmask);
        emit(true);
        return reply.code(202).send({ job: view(j) });
      });

      app.get('/api/export', { preHandler: auth }, async (req) => ({
        job: job && job.userId === req.userId ? view(job) : null,
      }));

      app.delete<{ Params: { id: string } }>(
        '/api/export/:id',
        { preHandler: auth },
        async (req, reply) => {
          if (!job || job.id !== req.params.id || job.userId !== req.userId)
            return reply.code(404).send({ error: 'not_found' });
          drop(job);
          return reply.code(204).send();
        },
      );

      // Once (decision 17): a completed response deletes the file; an interrupted one keeps it.
      app.get<{ Params: { id: string } }>(
        '/api/export/:id/download',
        { preHandler: auth },
        async (req, reply) => {
          const j = job;
          if (!j || j.id !== req.params.id || j.userId !== req.userId)
            return gone.has(req.params.id)
              ? reply.code(410).send({ error: 'gone' })
              : reply.code(404).send({ error: 'not_found' });
          if (j.status !== 'ready' || j.downloading) return reply.code(409).send({ error: 'busy' });
          j.downloading = true;
          reply.raw.once('close', () => {
            if (!reply.raw.writableFinished) return void (j.downloading = false);
            gone.add(j.id);
            drop(j);
          });
          return reply
            .type('application/octet-stream')
            .header('Content-Disposition', `attachment; filename="${j.fileName}"`)
            .header('Content-Length', String(j.size))
            .header('Cache-Control', 'no-store')
            .send(createReadStream(j.path));
        },
      );
    },
    close() {
      if (job) {
        job.abort.abort();
        clearTimeout(job.timer);
      }
    },
  };
}
