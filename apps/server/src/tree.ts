import { constants } from 'node:fs';
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { chats, type Db, fileOrigins, files, fileTrash } from '@nolla/db';
import type { PseudoClient } from '@nolla/pi-ext-pseudo';
import {
  dirBytes,
  entryPath,
  isTrashName,
  MAX_WORK_FILE,
  realInside,
  TRASH,
  USER_QUOTA,
  within,
} from '@nolla/pi-ext-subagents/workspace';
import {
  type Artifact,
  artifactExt,
  type FileError,
  type FileUsage,
  PREVIEW_MAX,
  type PreviewKind,
  type TrashEntry,
  TreeAttach,
  type TreeEntry,
  type TreeListing,
  TreeMkdir,
  TreeMove,
  TreeQuery,
  TreeRawQuery,
  TreeRestore,
  TreeSaveArtifact,
} from '@nolla/protocol';
import { and, desc, eq, inArray, lt, notInArray, or, sql, sum } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import { extractArtifacts } from './artifacts.ts';
import { chatRow } from './chats.ts';
import { attachFile, MAX_FILE_BYTES, MAX_FILES, rfc5987 } from './files.ts';
import { ChatNotFound, type SessionRegistry } from './pi/registry.ts';
import { restorer } from './restore.ts';
import { textOf } from './session-text.ts';

// The Files screen (docs/decisions/phase-11-files.md): the work dir tree, the uploads list, the
// trash, the size cache and the file origins.

const TRASH_MS = 30 * 86_400_000;
/** `bash` writes through the sandbox broker, past every hook: a cached size lives one minute. */
const SIZE_TTL_MS = 60_000;
const DIR_MIME = 'inode/directory';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const TYPES: Record<string, [mime: string, kind: PreviewKind | null]> = {
  png: ['image/png', 'image'],
  jpg: ['image/jpeg', 'image'],
  jpeg: ['image/jpeg', 'image'],
  webp: ['image/webp', 'image'],
  gif: ['image/gif', 'image'],
  svg: ['image/svg+xml', 'image'],
  pdf: ['application/pdf', 'pdf'],
  md: ['text/markdown', 'markdown'],
  markdown: ['text/markdown', 'markdown'],
  html: ['text/html', 'html'],
  htm: ['text/html', 'html'],
  txt: ['text/plain', 'text'],
  log: ['text/plain', 'text'],
  csv: ['text/csv', 'text'],
  tsv: ['text/tab-separated-values', 'text'],
  json: ['application/json', 'code'],
  docx: [DOCX, null],
};
for (const ext of 'js mjs cjs ts tsx jsx py rb go rs java kt swift c h cpp hpp cs php sh bash zsh sql yaml yml toml xml css scss ini mmd r lua'.split(
  ' ',
))
  TYPES[ext] = ['text/plain', 'code'];

/** Mime and preview kind from the name; unknown types are download only. */
const typeOf = (name: string) => {
  const [mime, kind] = TYPES[extname(name).slice(1).toLowerCase()] ?? [
    'application/octet-stream',
    null,
  ];
  return { mime, kind };
};
/** Preview kind of an upload row (the upload route allows only these mimes and docx). */
const kindOfMime = (mime: string): PreviewKind | null =>
  mime.startsWith('image/')
    ? 'image'
    : mime === 'application/pdf'
      ? 'pdf'
      : mime === 'text/markdown'
        ? 'markdown'
        : mime.startsWith('text/')
          ? 'text'
          : null;
const previewOf = (kind: PreviewKind | null, size: number) =>
  kind && size <= PREVIEW_MAX[kind] ? kind : null;
const isText = (kind: PreviewKind | null) => kind !== null && kind !== 'image' && kind !== 'pdf';

const toPosix = (p: string) => p.split(sep).join('/');
const rel = (realRoot: string, abs: string) => toPosix(relative(realRoot, abs));
const isDir = (p: string) =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );
const errno = (err: unknown) => (err as NodeJS.ErrnoException).code;
const eexist = () => Object.assign(new Error('exists'), { code: 'EEXIST' });

/**
 * A file or folder name: NFC, no separators, no control or format characters (bidi overrides),
 * at most 200 UTF-8 bytes.
 */
function cleanWorkName(name: string): string | undefined {
  const n = Buffer.from(
    name
      .normalize('NFC')
      .replace(/[\p{Cc}\p{Cf}\u2028\u2029/\\]/gu, '')
      .trim(),
  )
    .subarray(0, 200)
    .toString()
    .replace(/\uFFFD+$/, '');
  return n && n !== '.' && n !== '..' ? n : undefined;
}
const validName = (name: string) => cleanWorkName(name) === name;
/** A new entry in the root must not be the trash folder (decision 4): `_.trash` instead. */
const notTrash = (dir: string, realRoot: string, name: string) =>
  dir === realRoot && isTrashName(name) ? `_${name}` : name;

/**
 * The real path of `path` (route input) when it and everything it points to stay inside and out
 * of the trash (decision 4). Routes act on this resolved path, never on the input.
 */
const at = (realRoot: string, path: string) => realInside(realRoot, resolve(realRoot, path));

/** Runs `create` on `name` in `dir`, or on "name (2).ext" and up while the name exists. */
async function claim<T>(
  dir: string,
  name: string,
  create: (path: string) => Promise<T>,
): Promise<[string, T]> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const path = join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    try {
      return [path, await create(path)];
    } catch (err) {
      if (errno(err) !== 'EEXIST' || i >= 1000) throw err;
    }
  }
}

/**
 * Moves `from` to `to` without replacing an existing `to`. A file goes by `link` + `unlink`, where
 * EEXIST is atomic; a folder or a symlink by a check and `rename`.
 */
// ponytail: for folders and symlinks a `to` made between the check and the rename is replaced;
// Node has no RENAME_NOREPLACE.
const renameNew = (from: string) => async (to: string) => {
  if ((await lstat(from)).isFile()) {
    try {
      await link(from, to);
      await unlink(from);
      return;
    } catch (err) {
      // A disk without hard links falls back to the check below.
      if (errno(err) !== 'EPERM' && errno(err) !== 'ENOTSUP') throw err;
    }
  }
  if (await exists(to)) throw eexist();
  await rename(from, to);
};

/**
 * Opens a work-dir file for reading: not through a symlink at the end (`O_NOFOLLOW`), not
 * blocking on a FIFO (`O_NONBLOCK`), a regular file by `fstat`. On Linux the path that the fd
 * really has (`/proc/self/fd`) must still be inside: a folder swapped for a symlink after the
 * check shows there. The caller streams from the handle.
 */
// ponytail: without /proc (macOS dev machines) a folder swap between check and open is not seen.
export async function openFile(realRoot: string, real: string) {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fh = await open(real, flags).catch(() => undefined);
  if (!fh) return undefined;
  const st = await fh.stat();
  const opened = await readlink(`/proc/self/fd/${fh.fd}`).catch(() => real);
  if (st.isFile() && within(realRoot, opened))
    return { fh, size: st.size, ino: st.ino, dev: st.dev };
  await fh.close();
  return undefined;
}

/**
 * `.trash` when it is a real folder (decision 5); null when it is missing and `create` is off;
 * undefined when something else (a file, a symlink) is there.
 */
async function binOf(root: string, create: boolean): Promise<string | null | undefined> {
  const bin = join(root, TRASH);
  if (create)
    await mkdir(bin).catch((err: unknown) => {
      if (errno(err) !== 'EEXIST') throw err;
    });
  const st = await lstat(bin).catch((err: unknown) => {
    if (errno(err) === 'ENOENT') return null;
    throw err;
  });
  if (st === null) return null;
  return st.isDirectory() ? bin : undefined;
}

/** "<title>.<ext>" for "Tallenna tiedostoksi" (decision 12). */
export function artifactName(a: Artifact): string {
  const ext = artifactExt(a);
  const stem = cleanWorkName(a.title) ?? 'artefakti';
  return stem.toLowerCase().endsWith(`.${ext}`) ? stem : `${stem}.${ext}`;
}

/** The newest assistant message of the branch with the artifact, as masked text. */
function findArtifact(session: AgentSession, artifactId: string) {
  for (const e of session.sessionManager.getBranch().toReversed()) {
    if (e.type !== 'message' || e.message.role !== 'assistant') continue;
    const text = textOf(e.message);
    if (extractArtifacts(e.id, text).some((a) => a.id === artifactId))
      return { entryId: e.id, text };
  }
  return undefined;
}

/** An upload passed the quota while it streamed. */
export class QuotaExceeded extends Error {}

export type WorkStore = ReturnType<typeof workStore>;

/** Work dirs: the size cache and the bytes in flight (decision 7), the file origins (decision 6). */
export function workStore(db: Db, dataDir: string) {
  const sizes = new Map<string, { bytes: Promise<number>; at: number }>();
  /** userId → bytes that uploads are writing now; every quota check adds them. */
  const inflight = new Map<string, number>();
  const root = (userId: string) => resolve(dataDir, 'work', userId);
  /** The work dir with its trash. */
  const workBytes = (userId: string) => {
    const hit = sizes.get(userId);
    if (hit && Date.now() - hit.at < SIZE_TTL_MS) return hit.bytes;
    const bytes = dirBytes(root(userId));
    sizes.set(userId, { bytes, at: Date.now() });
    return bytes;
  };
  const uploadBytes = (userId: string) =>
    Number(
      db
        .select({ total: sum(files.size) })
        .from(files)
        .where(eq(files.userId, userId))
        .get()?.total ?? 0,
    );
  /** After a change of the work dir: the next `used` walks it again. */
  const changed = (userId: string) => void sizes.delete(userId);
  const flight = (userId: string, delta: number) =>
    inflight.set(userId, (inflight.get(userId) ?? 0) + delta);
  /** `path` and everything under it. Lengths in SQL: SQLite counts characters, not UTF-16 units. */
  // ponytail: the prefix match cannot use the primary key index; a range query
  // (`path >= p || '/' AND path < p || '0'`) is the upgrade if origins reach many thousands.
  const under = (userId: string, path: string) =>
    and(
      eq(fileOrigins.userId, userId),
      or(
        eq(fileOrigins.path, path),
        sql`substr(${fileOrigins.path}, 1, length(${path}) + 1) = ${path} || '/'`,
      ),
    );
  const dropOrigins = (userId: string, path: string) =>
    void db.delete(fileOrigins).where(under(userId, path)).run();
  return {
    root,
    workBytes,
    uploadBytes,
    changed,
    dropOrigins,
    /** Both roots and the uploads in flight, in bytes. */
    used: async (userId: string) =>
      (await workBytes(userId)) + uploadBytes(userId) + (inflight.get(userId) ?? 0),
    /**
     * Pipes an upload into the work dir. Its bytes count as in flight, so a parallel upload or an
     * agent write sees them; past the quota it stops mid-stream with `QuotaExceeded`. Each chunk
     * reads the size again (a cached promise until something changed).
     */
    // ponytail: a walk during the stream also sees the partial file, so near the limit the check
    // can refuse a little early. It never lets a file through late.
    async stream(userId: string, src: Readable, dest: Writable) {
      let n = 0;
      try {
        await pipeline(
          src,
          async function* (chunks: AsyncIterable<Buffer>) {
            for await (const chunk of chunks) {
              const settled = (await workBytes(userId)) + uploadBytes(userId);
              // Check and count with no await in between: two streams cannot both take the rest.
              if (settled + (inflight.get(userId) ?? 0) + chunk.length > USER_QUOTA)
                throw new QuotaExceeded();
              flight(userId, chunk.length);
              n += chunk.length;
              yield chunk;
            }
          },
          dest,
        );
      } finally {
        flight(userId, -n);
        changed(userId);
      }
    },
    /** A tool call or a saved artifact wrote `path` (relative to the work dir). */
    written(userId: string, path: string, chatId: string, messageId: string | null) {
      changed(userId);
      const now = new Date().toISOString();
      try {
        db.insert(fileOrigins)
          .values({ userId, path, chatId, messageId, updatedAt: now })
          .onConflictDoUpdate({
            target: [fileOrigins.userId, fileOrigins.path],
            set: { chatId, messageId, updatedAt: now },
          })
          .run();
      } catch {
        // The chat was deleted meanwhile (foreign key): there is no origin to keep.
      }
    },
    /** Moves the origins of `from` and everything under it to `to`. */
    moveOrigins(userId: string, from: string, to: string) {
      db.transaction((tx) => {
        tx.delete(fileOrigins).where(under(userId, to)).run();
        tx.update(fileOrigins)
          .set({ path: sql`${to} || substr(${fileOrigins.path}, length(${from}) + 1)` })
          .where(under(userId, from))
          .run();
      });
    },
  };
}

/** Removes trash entries of `bin` (a checked `.trash`) now, with their rows and origins. */
async function dropTrash(db: Db, work: WorkStore, userId: string, bin: string, ids: string[]) {
  for (const id of ids) {
    await rm(join(bin, id), { recursive: true, force: true });
    db.delete(fileTrash)
      .where(and(eq(fileTrash.userId, userId), eq(fileTrash.id, id)))
      .run();
    work.dropOrigins(userId, `${TRASH}/${id}`);
  }
  if (ids.length) work.changed(userId);
}

const deletedMs = async (bin: string, id: string) =>
  Number(/^(\d{13})-/.exec(id)?.[1] ?? (await lstat(join(bin, id))).mtimeMs);

/** The daily job: deletes trash entries older than 30 days (decision 5). Returns how many. */
export async function purgeTrash(db: Db, work: WorkStore, userId: string, now = Date.now()) {
  const bin = await binOf(work.root(userId), false);
  // Something else than a folder is there: touch nothing.
  if (bin === undefined) return 0;
  // A read error other than "missing" throws: an empty list would drop every row below.
  const ids = bin === null ? [] : await readdir(bin);
  const old: string[] = [];
  for (const id of ids) {
    const ms = await deletedMs(bin as string, id).catch(() => now);
    if (now - ms > TRASH_MS) old.push(id);
  }
  if (bin) await dropTrash(db, work, userId, bin, old);
  // Rows whose entry is gone. Explicit for no entries: drizzle's `notInArray([])` is `true`.
  const own = eq(fileTrash.userId, userId);
  db.delete(fileTrash)
    .where(ids.length ? and(own, notInArray(fileTrash.id, ids)) : own)
    .run();
  return old.length;
}

type Origin = NonNullable<TreeEntry['origin']>;
type Failure = { error: [number, FileError] };
const failure = (status: number, error: FileError): Failure => ({ error: [status, error] });

export function treeRoutes(
  app: FastifyInstance,
  auth: preHandlerHookHandler,
  deps: {
    db: Db;
    dataDir: string;
    work: WorkStore;
    registry: SessionRegistry;
    pseudo?: PseudoClient | undefined;
  },
) {
  const { db, dataDir, work, registry, pseudo } = deps;
  const fail = (reply: FastifyReply, code: number, error: FileError) =>
    reply.code(code).send({ error });
  /** The user's work dir as a real path; created on first use. */
  const rootOf = async (userId: string) => {
    const root = work.root(userId);
    await mkdir(root, { recursive: true });
    return realpath(root);
  };
  /** The work-dir folder at `path` (route input), resolved, or the error to answer. */
  const folderAt = async (userId: string, path: string) => {
    const realRoot = await rootOf(userId);
    const dir = await at(realRoot, path);
    if (!dir) return failure(400, 'bad_path');
    if (!(await isDir(dir))) return failure(404, 'not_found');
    return { realRoot, dir };
  };
  /** The work-dir file at `path`, open for reading (`openFile`), or the error to answer. */
  const fileAt = async (userId: string, path: string) => {
    const realRoot = await rootOf(userId);
    const real = await at(realRoot, path);
    if (!real) return failure(400, 'bad_path');
    const file = await openFile(realRoot, real);
    return file ? { realRoot, real, ...file } : failure(404, 'not_found');
  };
  /** The entry at `path` itself (a symlink stays one), for delete and move (`entryPath`). */
  const entryAtPath = async (realRoot: string, path: string) =>
    entryPath(realRoot, resolve(realRoot, path));

  const originsOf = (userId: string, paths: string[]): Map<string, Origin> =>
    new Map(
      paths.length
        ? db
            .select({
              path: fileOrigins.path,
              chatId: fileOrigins.chatId,
              messageId: fileOrigins.messageId,
              chatTitle: chats.title,
            })
            .from(fileOrigins)
            .leftJoin(chats, eq(chats.id, fileOrigins.chatId))
            .where(and(eq(fileOrigins.userId, userId), inArray(fileOrigins.path, paths)))
            .all()
            .map(({ path, ...o }) => [path, o])
        : [],
    );

  /** A work-dir entry; undefined for a symlink that leads out or into the trash, or a socket. */
  async function entryOf(
    realRoot: string,
    abs: string,
    origins: Map<string, Origin>,
  ): Promise<TreeEntry | undefined> {
    const real = await realInside(realRoot, abs);
    const st = real ? await stat(real).catch(() => undefined) : undefined;
    if (!st || (!st.isFile() && !st.isDirectory())) return undefined;
    const name = basename(abs);
    const path = rel(realRoot, abs);
    const modifiedAt = st.mtime.toISOString();
    if (st.isDirectory())
      return {
        name,
        path,
        type: 'dir',
        size: 0,
        mime: DIR_MIME,
        modifiedAt,
        preview: null,
        origin: null,
      };
    const { mime, kind } = typeOf(name);
    const preview = previewOf(kind, st.size);
    return {
      name,
      path,
      type: 'file',
      size: st.size,
      mime,
      modifiedAt,
      preview,
      origin: origins.get(path) ?? null,
    };
  }

  const entryAt = async (userId: string, realRoot: string, abs: string) =>
    entryOf(realRoot, abs, originsOf(userId, [rel(realRoot, abs)]));

  /** Liitteet: the uploads, newest first; keyset on (createdAt, id). */
  function listUploads(userId: string, cursor: string | undefined, limit: number): TreeListing {
    const [after, afterId] = cursor?.split('|') ?? [];
    const rows = db
      .select({ f: files, chatTitle: chats.title })
      .from(files)
      .leftJoin(chats, eq(chats.id, files.chatId))
      .where(
        and(
          eq(files.userId, userId),
          after && afterId
            ? or(lt(files.createdAt, after), and(eq(files.createdAt, after), lt(files.id, afterId)))
            : undefined,
        ),
      )
      .orderBy(desc(files.createdAt), desc(files.id))
      .limit(limit + 1)
      .all();
    const page = rows.slice(0, limit);
    const last = page.at(-1)?.f;
    return {
      root: 'files',
      path: '',
      entries: page.map(({ f, chatTitle }) => ({
        name: f.name,
        path: f.id,
        type: 'file',
        size: f.size,
        mime: f.mime,
        modifiedAt: f.createdAt,
        preview: previewOf(kindOfMime(f.mime), f.size),
        origin: f.chatId ? { chatId: f.chatId, messageId: null, chatTitle } : null,
      })),
      nextCursor: rows.length > limit && last ? `${last.createdAt}|${last.id}` : null,
    };
  }

  type Named = { name: string; dir: boolean };
  const collator = new Intl.Collator('fi', { numeric: true, sensitivity: 'base' });
  /** Folders first, then names; a code-point tie-break keeps the order total for the cursor. */
  const order = (a: Named, b: Named) =>
    Number(b.dir) - Number(a.dir) ||
    collator.compare(a.name, b.name) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  app.get('/api/files/tree', { preHandler: auth }, async (req, reply) => {
    const q = TreeQuery.safeParse(req.query);
    if (!q.success) return fail(reply, 400, 'bad_message');
    const { root, path, cursor, limit } = q.data;
    if (root === 'files') return listUploads(req.userId, cursor, limit);
    const l = await folderAt(req.userId, path);
    if ('error' in l) return fail(reply, ...l.error);
    const { realRoot, dir } = l;
    // ponytail: each page reads and sorts the whole folder (O(n log n)); keep the sorted names
    // per folder if folders reach 100k entries.
    const names = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => dir !== realRoot || !isTrashName(d.name))
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort(order);
    const after = cursor ? { dir: cursor.startsWith('d:'), name: cursor.slice(2) } : undefined;
    const start = after ? names.findIndex((n) => order(n, after) > 0) : 0;
    const page = start < 0 ? [] : names.slice(start, start + limit);
    const paths = page.map((n) => join(dir, n.name));
    const origins = originsOf(
      req.userId,
      paths.map((p) => rel(realRoot, p)),
    );
    const entries = await Promise.all(paths.map((p) => entryOf(realRoot, p, origins)));
    const last = page.at(-1);
    const listing: TreeListing = {
      root,
      path: rel(realRoot, dir),
      entries: entries.filter((e) => e !== undefined),
      nextCursor:
        last && start + limit < names.length ? `${last.dir ? 'd' : 'f'}:${last.name}` : null,
    };
    return listing;
  });

  app.get('/api/files/tree/raw', { preHandler: auth }, async (req, reply) => {
    const q = TreeRawQuery.safeParse(req.query);
    if (!q.success) return fail(reply, 400, 'bad_message');
    const { root, path, download } = q.data;
    let file: { fh: FileHandle; name: string; mime: string; kind: PreviewKind | null };
    if (root === 'files') {
      const row = db
        .select()
        .from(files)
        .where(and(eq(files.id, path), eq(files.userId, req.userId)))
        .get();
      const fh = row && (await open(join(dataDir, row.path)).catch(() => undefined));
      if (!row || !fh) return fail(reply, 404, 'not_found');
      file = { fh, name: row.name, mime: row.mime, kind: kindOfMime(row.mime) };
    } else {
      const l = await fileAt(req.userId, path);
      if ('error' in l) return fail(reply, ...l.error);
      const name = basename(l.real);
      file = { fh: l.fh, name, ...typeOf(name) };
    }
    // Text, Markdown, code and HTML go as text/plain: the client renders them (HTML in the
    // artifact sandbox). Never text/html from this origin (decision 10).
    const inline = download === '0' && file.kind !== null;
    const type = !inline
      ? 'application/octet-stream'
      : file.kind === 'image' || file.kind === 'pdf'
        ? file.mime
        : 'text/plain; charset=utf-8';
    // The browser's PDF viewer needs a same-origin frame without a CSP sandbox.
    const pdf = inline && file.kind === 'pdf';
    return reply
      .type(type)
      .header(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${rfc5987(file.name)}`,
      )
      .header(
        'Content-Security-Policy',
        pdf ? "frame-ancestors 'self'" : "sandbox; default-src 'none'",
      )
      .header('X-Frame-Options', pdf ? 'SAMEORIGIN' : 'DENY')
      .header('Cache-Control', 'private, no-cache')
      .send(file.fh.createReadStream());
  });

  app.post(
    '/api/files/tree/upload',
    { preHandler: auth, bodyLimit: MAX_FILES * MAX_WORK_FILE + 1024 ** 2 },
    async (req, reply) => {
      const q = TreeQuery.pick({ path: true }).safeParse(req.query);
      if (!q.success) return fail(reply, 400, 'bad_message');
      const { userId } = req;
      const l = await folderAt(userId, q.data.path);
      if ('error' in l) return fail(reply, ...l.error);
      const { realRoot, dir } = l;
      const stored: string[] = [];
      const undo = () => Promise.all(stored.map((p) => rm(p, { force: true })));
      const refuse = async (code: number, error: FileError) => {
        await undo();
        return fail(reply, code, error);
      };
      try {
        // The route's limit replaces the plugin's 25 MB default (tree.test.ts proves it).
        for await (const part of req.parts({ limits: { fileSize: MAX_WORK_FILE } })) {
          if (part.type === 'field') continue;
          const name = notTrash(dir, realRoot, cleanWorkName(part.filename) ?? 'tiedosto');
          // `wx`: a name taken meanwhile, or a symlink put there, is never written through.
          const [target, fh] = await claim(dir, name, (p) => open(p, 'wx'));
          stored.push(target);
          await work.stream(userId, part.file, fh.createWriteStream());
          if (part.file.truncated) return refuse(413, 'too_large');
        }
      } catch (err) {
        if (err instanceof QuotaExceeded) return refuse(413, 'quota');
        await undo();
        throw err;
      }
      if (!stored.length) return fail(reply, 400, 'empty');
      const entries = await Promise.all(stored.map((p) => entryOf(realRoot, p, new Map())));
      return reply.code(201).send({ entries: entries.filter((e) => e !== undefined) });
    },
  );

  app.post('/api/files/tree/mkdir', { preHandler: auth }, async (req, reply) => {
    const b = TreeMkdir.safeParse(req.body);
    if (!b.success) return fail(reply, 400, 'bad_message');
    const realRoot = await rootOf(req.userId);
    const target = await at(realRoot, b.data.path);
    if (!target || target === realRoot) return fail(reply, 400, 'bad_path');
    if (!validName(basename(target))) return fail(reply, 400, 'bad_name');
    if (!(await isDir(dirname(target)))) return fail(reply, 404, 'not_found');
    try {
      await mkdir(target);
    } catch (err) {
      if (errno(err) === 'EEXIST') return fail(reply, 409, 'exists');
      throw err;
    }
    return reply.code(201).send({ entry: await entryOf(realRoot, target, new Map()) });
  });

  /** Rename and move in one: `to` is the full new path. A symlink moves as itself. */
  app.post('/api/files/tree/move', { preHandler: auth }, async (req, reply) => {
    const b = TreeMove.safeParse(req.body);
    if (!b.success) return fail(reply, 400, 'bad_message');
    const { userId } = req;
    const realRoot = await rootOf(userId);
    const from = await entryAtPath(realRoot, b.data.from);
    const to = await entryAtPath(realRoot, b.data.to);
    if (!from || !to || to.startsWith(from + sep)) return fail(reply, 400, 'bad_path');
    if (!validName(basename(to))) return fail(reply, 400, 'bad_name');
    if (!(await exists(from)) || !(await isDir(dirname(to)))) return fail(reply, 404, 'not_found');
    if (to !== from) {
      try {
        await renameNew(from)(to);
      } catch (err) {
        if (errno(err) === 'EEXIST') return fail(reply, 409, 'exists');
        // A folder into itself through a symlink.
        if (errno(err) === 'EINVAL') return fail(reply, 400, 'bad_path');
        throw err;
      }
      work.moveOrigins(userId, rel(realRoot, from), rel(realRoot, to));
    }
    return { entry: await entryAt(userId, realRoot, to) };
  });

  /** Delete: into `.trash/<epoch ms>-<name>` (decision 5). A symlink goes as itself. */
  app.delete('/api/files/tree', { preHandler: auth }, async (req, reply) => {
    const q = TreeQuery.pick({ path: true }).safeParse(req.query);
    if (!q.success) return fail(reply, 400, 'bad_message');
    const { userId } = req;
    const realRoot = await rootOf(userId);
    const abs = await entryAtPath(realRoot, q.data.path);
    if (!abs) return fail(reply, 400, 'bad_path');
    const st = await lstat(abs).catch(() => undefined);
    if (!st) return fail(reply, 404, 'not_found');
    const bin = await binOf(realRoot, true);
    if (!bin) return fail(reply, 409, 'bad_path');
    const name = basename(abs);
    const short = cleanWorkName(name) ?? 'nimetön';
    const size = st.isDirectory() ? await dirBytes(abs) : st.size;
    let ts = Date.now();
    for (; ; ts++) {
      try {
        await renameNew(abs)(join(bin, `${ts}-${short}`));
        break;
      } catch (err) {
        if (errno(err) !== 'EEXIST') throw err;
      }
    }
    const id = `${ts}-${short}`;
    const originalPath = rel(realRoot, abs);
    const deletedAt = new Date(ts).toISOString();
    db.insert(fileTrash).values({ userId, id, originalPath, deletedAt }).run();
    work.moveOrigins(userId, originalPath, `${TRASH}/${id}`);
    const entry: TrashEntry = {
      id,
      name,
      originalPath,
      type: st.isDirectory() ? 'dir' : 'file',
      size,
      deletedAt,
    };
    return { entry };
  });

  const trashId = (id: string) => id === basename(id) && id !== '.' && id !== '..';

  app.get('/api/files/tree/trash', { preHandler: auth }, async (req, reply) => {
    const q = TreeQuery.pick({ cursor: true, limit: true }).safeParse(req.query);
    if (!q.success) return fail(reply, 400, 'bad_message');
    const { cursor, limit } = q.data;
    const bin = await binOf(await rootOf(req.userId), false);
    if (bin === undefined) return fail(reply, 409, 'bad_path');
    // Newest first: an id starts with its 13-digit deletion time.
    const ids = bin ? (await readdir(bin)).sort().reverse() : [];
    const start = cursor ? ids.findIndex((id) => id < cursor) : 0;
    const page = start < 0 || !bin ? [] : ids.slice(start, start + limit);
    const rows = new Map(
      (page.length
        ? db
            .select()
            .from(fileTrash)
            .where(and(eq(fileTrash.userId, req.userId), inArray(fileTrash.id, page)))
            .all()
        : []
      ).map((r) => [r.id, r]),
    );
    const entries = await Promise.all(
      page.map(async (id): Promise<TrashEntry | undefined> => {
        try {
          const st = await lstat(join(bin as string, id));
          const row = rows.get(id);
          const originalPath = row?.originalPath ?? id.replace(/^\d+-/, '');
          return {
            id,
            name: basename(originalPath),
            originalPath,
            type: st.isDirectory() ? 'dir' : 'file',
            size: st.isDirectory() ? await dirBytes(join(bin as string, id)) : st.size,
            deletedAt: row?.deletedAt ?? new Date(await deletedMs(bin as string, id)).toISOString(),
          };
        } catch {
          // Gone meanwhile (purge, another screen): skip it.
          return undefined;
        }
      }),
    );
    const last = page.at(-1);
    return {
      entries: entries.filter((e) => e !== undefined),
      nextCursor: last && start + limit < ids.length ? last : null,
    };
  });

  app.post('/api/files/tree/restore', { preHandler: auth }, async (req, reply) => {
    const b = TreeRestore.safeParse(req.body);
    if (!b.success || !trashId(b.data.id)) return fail(reply, 400, 'bad_message');
    const { userId } = req;
    const { id } = b.data;
    const realRoot = await rootOf(userId);
    const bin = await binOf(realRoot, false);
    if (bin === undefined) return fail(reply, 409, 'bad_path');
    const src = bin && join(bin, id);
    if (!src || !(await exists(src))) return fail(reply, 404, 'not_found');
    const row = db
      .select()
      .from(fileTrash)
      .where(and(eq(fileTrash.userId, userId), eq(fileTrash.id, id)))
      .get();
    const original = row?.originalPath ?? id.replace(/^\d+-/, '');
    // Back where it was; into the root when that folder cannot be made or now leads out.
    let target = await at(realRoot, original);
    const made =
      target &&
      target !== realRoot &&
      (await mkdir(dirname(target), { recursive: true }).then(
        () => true,
        () => false,
      ));
    if (!target || !made)
      target = join(realRoot, notTrash(realRoot, realRoot, basename(original) || id));
    const [final] = await claim(dirname(target), basename(target), renameNew(src));
    db.delete(fileTrash)
      .where(and(eq(fileTrash.userId, userId), eq(fileTrash.id, id)))
      .run();
    work.moveOrigins(userId, `${TRASH}/${id}`, rel(realRoot, final));
    return { entry: await entryAt(userId, realRoot, final) };
  });

  /** Deletes for good: one entry (`id`) or the whole trash. */
  app.delete('/api/files/tree/trash', { preHandler: auth }, async (req, reply) => {
    const q = TreeRestore.partial().safeParse(req.query);
    if (!q.success || (q.data.id !== undefined && !trashId(q.data.id)))
      return fail(reply, 400, 'bad_message');
    const bin = await binOf(await rootOf(req.userId), false);
    if (bin === undefined) return fail(reply, 409, 'bad_path');
    if (q.data.id && !(bin && (await exists(join(bin, q.data.id)))))
      return fail(reply, 404, 'not_found');
    if (bin)
      await dropTrash(db, work, req.userId, bin, q.data.id ? [q.data.id] : await readdir(bin));
    return reply.code(204).send();
  });

  app.get('/api/files/tree/usage', { preHandler: auth }, async (req): Promise<FileUsage> => {
    const bin = await binOf(await rootOf(req.userId), false);
    const [total, trash] = await Promise.all([work.workBytes(req.userId), bin ? dirBytes(bin) : 0]);
    const uploads = work.uploadBytes(req.userId);
    return {
      used: total + uploads,
      quota: USER_QUOTA,
      work: Math.max(0, total - trash),
      trash,
      files: uploads,
      maxFileSize: MAX_WORK_FILE,
      maxAttachSize: MAX_FILE_BYTES,
    };
  });

  /** A work-dir file as a message attachment: a snapshot copy into the uploads (decision 11). */
  app.post('/api/files/tree/attach', { preHandler: auth }, async (req, reply) => {
    const b = TreeAttach.safeParse(req.body);
    if (!b.success) return fail(reply, 400, 'bad_message');
    const { userId } = req;
    const l = await fileAt(userId, b.data.path);
    if ('error' in l) return fail(reply, ...l.error);
    try {
      if (l.size > MAX_FILE_BYTES) return fail(reply, 413, 'too_large');
      if ((await work.used(userId)) + l.size > USER_QUOTA) return fail(reply, 413, 'quota');
      const name = basename(l.real);
      const { mime, kind } = typeOf(name);
      const r = await attachFile(
        db,
        dataDir,
        userId,
        { handle: l.fh, name, mime, text: isText(kind) },
        b.data.chatId,
      );
      if (r === 'unsupported') return fail(reply, 415, 'unsupported');
      if (r === 'too_large') return fail(reply, 413, 'too_large');
      return { file: r };
    } finally {
      await l.fh.close();
    }
  });

  /** "Tallenna tiedostoksi": the artifact with real values into the work dir (decision 12). */
  app.post('/api/files/tree/artifact', { preHandler: auth }, async (req, reply) => {
    const b = TreeSaveArtifact.safeParse(req.body);
    if (!b.success) return fail(reply, 400, 'bad_message');
    const { userId } = req;
    const { chatId, artifactId } = b.data;
    if (!chatRow(db, userId, chatId)) return fail(reply, 404, 'not_found');
    const session = await registry.get(chatId).catch((err: unknown) => {
      if (err instanceof ChatNotFound) return undefined;
      throw err;
    });
    const found = session && findArtifact(session, artifactId);
    if (!found) return fail(reply, 404, 'not_found');
    let down = false;
    const { text } = await restorer(pseudo, () => {
      down = true;
    })(found.text);
    // A masked copy on disk would break decision 16 (files hold real values).
    if (down) return fail(reply, 503, 'pseudo_down');
    const artifact = extractArtifacts(found.entryId, text).find((a) => a.id === artifactId);
    if (!artifact) return fail(reply, 404, 'not_found');
    const l = await folderAt(userId, b.data.dir);
    if ('error' in l) return fail(reply, ...l.error);
    const { realRoot, dir } = l;
    const content = Buffer.from(artifact.content);
    if (content.length > MAX_WORK_FILE) return fail(reply, 413, 'too_large');
    if ((await work.used(userId)) + content.length > USER_QUOTA) return fail(reply, 413, 'quota');
    const name = notTrash(dir, realRoot, artifactName(artifact));
    const [target] = await claim(dir, name, (p) => writeFile(p, content, { flag: 'wx' }));
    work.written(userId, rel(realRoot, target), chatId, found.entryId);
    return reply.code(201).send({ entry: await entryAt(userId, realRoot, target) });
  });
}
