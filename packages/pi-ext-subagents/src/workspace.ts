import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Work-dir policy (docs/decisions/phase-11-files.md decisions 4, 7 and 8). pa-server (path guard,
// file routes) and every subagent child (child.ts) use it; a child cannot import the server app.

export const TRASH = '.trash';
export const GUARD_REASON = 'path outside workspace';
/** Per file in the work dir: upload, agent `write`/`edit`, saved artifact. */
export const MAX_WORK_FILE = 200 * 1024 ** 2;
/** Per user, both roots together (work dir with its trash, chat uploads). */
export const USER_QUOTA = 10 * 1024 ** 3;

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'find', 'grep']);
/** Tools that list or search a folder tree: on the root they would show `.trash`. */
const SEARCH_TOOLS = new Set(['ls', 'find', 'grep']);
const ROOT_REASON = `${GUARD_REASON}: anna työkansion alikansio, ls, find ja grep eivät toimi juuressa`;

/**
 * The absolute path a Pi 1.3.0 file tool acts on (`resolveToCwd` in `utils/paths.js`): Unicode
 * spaces become spaces, one leading `@` goes, `~` is the home dir, `file://` URLs are decoded.
 * Throws on a bad `file://` URL, as Pi does.
 */
export function piPath(root: string, path: string): string {
  let p = path.replace(UNICODE_SPACES, ' ');
  if (p.startsWith('@')) p = p.slice(1);
  if (p === '~') p = homedir();
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  else if (p.startsWith('file://')) p = fileURLToPath(p);
  return resolve(root, p);
}

/** The other names Pi's `read` tries when the path does not exist (`resolveReadPath`). */
const readVariants = (abs: string) => {
  const curly = (s: string) => s.replace(/'/g, '\u2019');
  const nfd = abs.normalize('NFD');
  return [abs, abs.replace(/ (AM|PM)\./gi, '\u202F$1.'), nfd, curly(abs), curly(nfd)];
};

const escapes = (rel: string) => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
/** A root-level name that is the trash folder. Lowercase: on a case-insensitive disk `.Trash` is it. */
export const isTrashName = (name: string) => name.toLowerCase() === TRASH;
const inTrash = (rel: string) => isTrashName(rel.split(sep)[0] ?? '');

/** Lexical check only: `p` is in `root` and, unless `trash`, outside `root/.trash`. */
export const within = (root: string, p: string, trash = false) => {
  const rel = relative(root, p);
  return !escapes(rel) && (trash || !inTrash(rel));
};

/**
 * The real path of `abs` when it stays inside `root` and outside `root/.trash` (unless `trash`),
 * also after every symlink in its existing part. Missing trailing parts are fine (a write creates
 * them); a dangling symlink is not (a write would follow it). Undefined otherwise.
 */
export async function realInside(
  root: string,
  abs: string,
  trash = false,
): Promise<string | undefined> {
  if (!within(root, abs, trash)) return undefined;
  const realRoot = await realpath(root);
  const tail: string[] = [];
  for (let probe = abs; ; probe = dirname(probe)) {
    try {
      const real = join(await realpath(probe), ...tail);
      return within(realRoot, real, trash) ? real : undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      if (
        await lstat(probe).then(
          () => true,
          () => false,
        )
      )
        return undefined;
      tail.unshift(basename(probe));
    }
  }
}

/**
 * The entry `abs` itself, as the file routes and the origins see it: its parent folder resolved,
 * its last part kept (a symlink stays a symlink). Undefined when the parent leaves `root` or is in
 * the trash, when `abs` is the root, or when `abs` would be the trash folder.
 */
export async function entryPath(root: string, abs: string): Promise<string | undefined> {
  if (!within(root, abs) || relative(root, abs) === '') return undefined;
  const parent = await realInside(root, dirname(abs));
  const entry = parent && join(parent, basename(abs));
  return entry && within(await realpath(root), entry) ? entry : undefined;
}

/** Bytes of the regular files under `dir`; symlinks are not followed. 0 when `dir` is missing. */
// ponytail: a full walk per call; keep a running total per write if work dirs reach 100k files.
// ponytail: apparent size (`st.size`), so a sparse file counts in full; `st.blocks * 512` counts disk use.
export async function dirBytes(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = entries.filter((e) => e.isFile());
  let total = 0;
  for (let i = 0; i < files.length; i += 64) {
    const sizes = await Promise.all(
      files.slice(i, i + 64).map((e) =>
        lstat(join(e.parentPath, e.name)).then(
          (s) => s.size,
          () => 0,
        ),
      ),
    );
    total += sizes.reduce((a, b) => a + b, 0);
  }
  return total;
}

const bytes = (s: unknown) => (typeof s === 'string' ? Buffer.byteLength(s) : 0);
const gb = (n: number) => (n / 1024 ** 3).toFixed(1).replace('.', ',');

/** The size limits as Finnish tool errors for the model (decision 8); undefined when it fits. */
export function limitReason(size: number, used: number): string | undefined {
  if (size > MAX_WORK_FILE)
    return `Kirjoitus estetty: tiedostosta tulisi ${Math.ceil(size / 1024 ** 2)} Mt, mutta yhden tiedoston raja on 200 Mt. Jaa sisältö pienempiin tiedostoihin.`;
  if (used + size > USER_QUOTA)
    return `Kirjoitus estetty: tallennustila on täynnä (käytössä ${gb(used)} Gt / 10 Gt). Pyydä käyttäjää vapauttamaan tilaa Tiedostot-näkymässä, esimerkiksi tyhjentämällä roskakori.`;
  return undefined;
}

/**
 * The block reason for a Pi file tool call, or undefined to let it run. `used` gives the user's
 * total bytes for the size check of `write` and `edit`.
 */
export async function checkFileTool(
  root: string,
  tool: string,
  input: Record<string, unknown>,
  used: () => Promise<number>,
): Promise<string | undefined> {
  if (!FILE_TOOLS.has(tool)) return undefined;
  const writes = tool === 'write' || tool === 'edit';
  const search = SEARCH_TOOLS.has(tool);
  // Without a path, `ls`, `find` and `grep` run on the cwd: the root, which holds `.trash`.
  if (input.path === undefined && search) return ROOT_REASON;
  if (typeof input.path !== 'string') return GUARD_REASON;
  let abs: string;
  try {
    abs = piPath(root, input.path);
  } catch {
    return GUARD_REASON;
  }
  for (const p of tool === 'read' ? readVariants(abs) : [abs]) {
    const real = await realInside(root, p);
    if (!real) return GUARD_REASON;
    // `.`, the root, or a link to it: the only folder above `.trash`.
    if (search && real === (await realpath(root))) return ROOT_REASON;
  }
  if (!writes) return undefined;
  const old = await stat(abs).then(
    (s) => (s.isFile() ? s.size : 0),
    () => 0,
  );
  const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input];
  const size =
    tool === 'write'
      ? bytes(input.content)
      : edits.reduce((n, e) => n + bytes(e.newText) - bytes(e.oldText), old);
  return limitReason(size, (await used()) - old);
}
