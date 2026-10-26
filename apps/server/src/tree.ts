import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { chats, type Db, fileOrigins, files, fileTrash } from '@pa/db';
import type { PseudoClient } from '@pa/pi-ext-pseudo';
import {
  dirBytes,
  MAX_WORK_FILE,
  realInside,
  TRASH,
  USER_QUOTA,
} from '@pa/pi-ext-subagents/workspace';
import {
  type Artifact,
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
} from '@pa/protocol';
import { and, desc, eq, inArray, lt, notInArray, or, sql, sum } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import { extractArtifacts } from './artifacts.ts';
import { chatRow, restorer, textOf } from './bridge.ts';
import { attachFile, MAX_FILE_BYTES, MAX_FILES, rfc5987 } from './files.ts';
import { ChatNotFound, type SessionRegistry } from './pi/registry.ts';

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

/** A file or folder name: no separators or control characters, at most 200 UTF-8 bytes. */
function cleanWorkName(name: string): string | undefined {
  const n = Buffer.from(name.replace(/[\p{Cc}\u2028\u2029/\\]/gu, '').trim())
    .subarray(0, 200)
    .toString()
    .replace(/\uFFFD+$/, '');
  return n && n !== '.' && n !== '..' ? n : undefined;
}
const validName = (name: string) => cleanWorkName(name) === name;

/**
 * `path` (route input) under the real root, when it and everything it points to stay inside and
 * out of the trash (decision 4). The entry itself: a symlink is not replaced by its target.
 */
async function at(realRoot: string, path: string): Promise<string | undefined> {
  const abs = resolve(realRoot, path);
  return (await realInside(realRoot, abs)) ? abs : undefined;
}

/** Creates `name` in `dir` with `create`, or "name (2).ext" and up while the name exists. */
async function claim(dir: string, name: string, create: (path: string) => Promise<void>) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const path = join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    try {
      await create(path);
      return path;
    } catch (err) {
      if (errno(err) !== 'EEXIST' || i >= 1000) throw err;
    }
  }
}

/** `rename` that refuses an existing target (Node has no RENAME_NOREPLACE). */
// ponytail: check then rename; a file created in between is replaced. Fine for one user.
const renameNew = (from: string) => async (to: string) => {
  if (await exists(to)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
  await rename(from, to);
};

const EXT: Record<string, string> = {
  mermaid: 'mmd',
  python: 'py',
  javascript: 'js',
  typescript: 'ts',
  shell: 'sh',
  bash: 'sh',
  yaml: 'yml',
  markdown: 'md',
  rust: 'rs',
  ruby: 'rb',
  kotlin: 'kt',
  csharp: 'cs',
};

/** "<title>.<ext>" for "Tallenna tiedostoksi" (decision 11). */
function artifactName(a: Artifact): string {
  const lang =
    a.kind === 'html' || a.kind === 'mermaid'
      ? a.kind
      : a.kind === 'react'
        ? a.language === 'tsx'
          ? 'tsx'
          : 'jsx'
        : (a.language ?? '');
  const ext = EXT[lang] ?? (/^[a-z0-9]{1,8}$/.test(lang) ? lang : 'txt');
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

export type WorkStore = ReturnType<typeof workStore>;

/** Work dirs: the cached size (decision 7) and the file origins (decision 6). */
export function workStore(db: Db, dataDir: string) {
  const sizes = new Map<string, { bytes: Promise<number>; at: number }>();
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
  /** `path` and everything under it. Lengths in SQL: SQLite counts characters, not UTF-16 units. */
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
    /** Both roots, in bytes. */
    used: async (userId: string) => (await workBytes(userId)) + uploadBytes(userId),
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

/** Removes trash entries now, with their rows and origins. */
async function dropTrash(db: Db, work: WorkStore, userId: string, ids: string[]) {
  const bin = join(work.root(userId), TRASH);
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
  const bin = join(work.root(userId), TRASH);
  const ids = await readdir(bin).catch(() => [] as string[]);
  const old: string[] = [];
  for (const id of ids) if (now - (await deletedMs(bin, id)) > TRASH_MS) old.push(id);
  await dropTrash(db, work, userId, old);
  // Rows whose entry is gone.
  db.delete(fileTrash)
    .where(and(eq(fileTrash.userId, userId), notInArray(fileTrash.id, ids)))
    .run();
  return old.length;
}

type Origin = NonNullable<TreeEntry['origin']>;

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
  /** The work-dir entry at `path` (route input) of the wanted type, or the error to answer. */
  const locate = async (userId: string, path: string, want: 'dir' | 'file' | 'any') => {
    const realRoot = await rootOf(userId);
    const abs = await at(realRoot, path);
    if (!abs) return { error: [400, 'bad_path'] as [number, FileError] };
    const st = await (want === 'any' ? lstat : stat)(abs).catch(() => undefined);
    if (!st || (want === 'dir' && !st.isDirectory()) || (want === 'file' && !st.isFile()))
      return { error: [404, 'not_found'] as [number, FileError] };
    return { realRoot, abs, st };
  };

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
    const l = await locate(req.userId, path, 'dir');
    if ('error' in l) return fail(reply, ...l.error);
    const { realRoot, abs: dir } = l;
    const names = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => dir !== realRoot || d.name.toLowerCase() !== TRASH)
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
    let file: { abs: string; name: string; mime: string; kind: PreviewKind | null };
    if (root === 'files') {
      const row = db
        .select()
        .from(files)
        .where(and(eq(files.id, path), eq(files.userId, req.userId)))
        .get();
      if (!row) return fail(reply, 404, 'not_found');
      file = {
        abs: join(dataDir, row.path),
        name: row.name,
        mime: row.mime,
        kind: kindOfMime(row.mime),
      };
    } else {
      const l = await locate(req.userId, path, 'file');
      if ('error' in l) return fail(reply, ...l.error);
      file = { abs: l.abs, name: basename(l.abs), ...typeOf(basename(l.abs)) };
    }
    // Text, Markdown, code and HTML go as text/plain: the client renders them (HTML in the
    // artifact sandbox). Never text/html from this origin (decision 9).
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
      .send(createReadStream(file.abs));
  });

  app.post(
    '/api/files/tree/upload',
    { preHandler: auth, bodyLimit: MAX_FILES * MAX_WORK_FILE + 1024 ** 2 },
    async (req, reply) => {
      const q = TreeQuery.pick({ path: true }).safeParse(req.query);
      if (!q.success) return fail(reply, 400, 'bad_message');
      const { userId } = req;
      const l = await locate(userId, q.data.path, 'dir');
      if ('error' in l) return fail(reply, ...l.error);
      const { realRoot, abs: dir } = l;
      const before = await work.used(userId);
      const stored: string[] = [];
      let added = 0;
      const undo = () => Promise.all(stored.map((p) => rm(p, { force: true })));
      const refuse = async (code: number, error: FileError) => {
        await undo();
        return fail(reply, code, error);
      };
      try {
        for await (const part of req.parts({ limits: { fileSize: MAX_WORK_FILE } })) {
          if (part.type === 'field') continue;
          if (before + added >= USER_QUOTA) {
            part.file.resume();
            return refuse(413, 'quota');
          }
          const name = cleanWorkName(part.filename) ?? 'tiedosto';
          const target = await claim(dir, name, (p) => writeFile(p, '', { flag: 'wx' }));
          stored.push(target);
          await pipeline(part.file, createWriteStream(target));
          if (part.file.truncated) return refuse(413, 'too_large');
          added += part.file.bytesRead;
          if (before + added > USER_QUOTA) return refuse(413, 'quota');
        }
      } catch (err) {
        await undo();
        throw err;
      }
      if (!stored.length) return fail(reply, 400, 'empty');
      work.changed(userId);
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

  /** Rename and move in one: `to` is the full new path. */
  app.post('/api/files/tree/move', { preHandler: auth }, async (req, reply) => {
    const b = TreeMove.safeParse(req.body);
    if (!b.success) return fail(reply, 400, 'bad_message');
    const { userId } = req;
    const realRoot = await rootOf(userId);
    const from = await at(realRoot, b.data.from);
    const to = await at(realRoot, b.data.to);
    if (!from || !to || from === realRoot || to === realRoot || to.startsWith(from + sep))
      return fail(reply, 400, 'bad_path');
    if (!validName(basename(to))) return fail(reply, 400, 'bad_name');
    if (!(await exists(from)) || !(await isDir(dirname(to)))) return fail(reply, 404, 'not_found');
    if (to !== from) {
      try {
        await renameNew(from)(to);
      } catch (err) {
        if (errno(err) === 'EEXIST') return fail(reply, 409, 'exists');
        throw err;
      }
      work.moveOrigins(userId, rel(realRoot, from), rel(realRoot, to));
    }
    return { entry: await entryAt(userId, realRoot, to) };
  });

  /** Delete: into `.trash/<epoch ms>-<name>` (decision 5). */
  app.delete('/api/files/tree', { preHandler: auth }, async (req, reply) => {
    const q = TreeQuery.pick({ path: true }).safeParse(req.query);
    if (!q.success) return fail(reply, 400, 'bad_message');
    const { userId } = req;
    const l = await locate(userId, q.data.path, 'any');
    if ('error' in l) return fail(reply, ...l.error);
    const { realRoot, abs, st } = l;
    if (abs === realRoot) return fail(reply, 400, 'bad_path');
    const bin = join(realRoot, TRASH);
    await mkdir(bin, { recursive: true });
    const name = basename(abs);
    const short = cleanWorkName(name) ?? 'nimetön';
    let ts = Date.now();
    while (await exists(join(bin, `${ts}-${short}`))) ts++;
    const id = `${ts}-${short}`;
    const size = st.isDirectory() ? await dirBytes(abs) : st.size;
    await rename(abs, join(bin, id));
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
    const bin = join(await rootOf(req.userId), TRASH);
    // Newest first: an id starts with its 13-digit deletion time.
    const ids = (await readdir(bin).catch(() => [] as string[])).sort().reverse();
    const start = cursor ? ids.findIndex((id) => id < cursor) : 0;
    const page = start < 0 ? [] : ids.slice(start, start + limit);
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
      page.map(async (id): Promise<TrashEntry> => {
        const st = await lstat(join(bin, id));
        const row = rows.get(id);
        const originalPath = row?.originalPath ?? id.replace(/^\d+-/, '');
        return {
          id,
          name: basename(originalPath),
          originalPath,
          type: st.isDirectory() ? 'dir' : 'file',
          size: st.isDirectory() ? await dirBytes(join(bin, id)) : st.size,
          deletedAt: row?.deletedAt ?? new Date(await deletedMs(bin, id)).toISOString(),
        };
      }),
    );
    const last = page.at(-1);
    return { entries, nextCursor: last && start + limit < ids.length ? last : null };
  });

  app.post('/api/files/tree/restore', { preHandler: auth }, async (req, reply) => {
    const b = TreeRestore.safeParse(req.body);
    if (!b.success || !trashId(b.data.id)) return fail(reply, 400, 'bad_message');
    const { userId } = req;
    const { id } = b.data;
    const realRoot = await rootOf(userId);
    const src = join(realRoot, TRASH, id);
    if (!(await exists(src))) return fail(reply, 404, 'not_found');
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
    if (!target || !made) target = join(realRoot, basename(original) || id);
    const final = await claim(dirname(target), basename(target), renameNew(src));
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
    const bin = join(await rootOf(req.userId), TRASH);
    const ids = q.data.id ? [q.data.id] : await readdir(bin).catch(() => [] as string[]);
    if (q.data.id && !(await exists(join(bin, q.data.id)))) return fail(reply, 404, 'not_found');
    await dropTrash(db, work, req.userId, ids);
    return reply.code(204).send();
  });

  app.get('/api/files/tree/usage', { preHandler: auth }, async (req): Promise<FileUsage> => {
    const bin = join(await rootOf(req.userId), TRASH);
    const [total, trash] = await Promise.all([work.workBytes(req.userId), dirBytes(bin)]);
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

  /** A work-dir file as a message attachment: a snapshot copy into the uploads (decision 10). */
  app.post('/api/files/tree/attach', { preHandler: auth }, async (req, reply) => {
    const b = TreeAttach.safeParse(req.body);
    if (!b.success) return fail(reply, 400, 'bad_message');
    const { userId } = req;
    const l = await locate(userId, b.data.path, 'file');
    if ('error' in l) return fail(reply, ...l.error);
    const { abs, st } = l;
    if ((await work.used(userId)) + st.size > USER_QUOTA) return fail(reply, 413, 'quota');
    const name = basename(abs);
    const { mime, kind } = typeOf(name);
    const r = await attachFile(
      db,
      dataDir,
      userId,
      { path: abs, name, mime, text: isText(kind) },
      b.data.chatId,
    );
    if (r === 'unsupported') return fail(reply, 415, 'unsupported');
    if (r === 'too_large') return fail(reply, 413, 'too_large');
    return { file: r };
  });

  /** "Tallenna tiedostoksi": the artifact with real values into the work dir (decision 11). */
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
    // A masked copy on disk would break decision 12 (files hold real values).
    if (down) return fail(reply, 503, 'pseudo_down');
    const artifact = extractArtifacts(found.entryId, text).find((a) => a.id === artifactId);
    if (!artifact) return fail(reply, 404, 'not_found');
    const l = await locate(userId, b.data.dir, 'dir');
    if ('error' in l) return fail(reply, ...l.error);
    const { realRoot, abs: dir } = l;
    const content = Buffer.from(artifact.content);
    if (content.length > MAX_WORK_FILE) return fail(reply, 413, 'too_large');
    if ((await work.used(userId)) + content.length > USER_QUOTA) return fail(reply, 413, 'quota');
    const target = await claim(dir, artifactName(artifact), (p) =>
      writeFile(p, content, { flag: 'wx' }),
    );
    work.written(userId, rel(realRoot, target), chatId, found.entryId);
    return reply.code(201).send({ entry: await entryAt(userId, realRoot, target) });
  });
}
