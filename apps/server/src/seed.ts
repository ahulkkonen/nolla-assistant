import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { writeAtomic } from './git.ts';

/** Image file (relative path) to the sha256 it had when it was copied (phase-16 decision 21). */
export const SEED_MANIFEST = '.seeded.json';
type Manifest = Record<string, string>;
type Warn = (msg: string, data?: object) => void;

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Regular files under `root`, relative and '/'-separated. */
const filesOf = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split('\\').join('/'));

function readManifest(path: string): Manifest | undefined {
  try {
    const m = JSON.parse(readFileSync(path, 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keeps the editable copy `dir` of the image folder `bundled` (phase-15 decision 4) in step with
 * the image (phase-16 decision 21). A missing `dir` is copied whole. Else, per image file: a copy
 * that still has its seeded hash (never edited) takes the new image file; an edited copy stays and
 * is logged; a file new in the image is copied; a file the user deleted stays deleted. Without a
 * manifest every existing file counts as edited. `what` names the files in the log line.
 */
export function seedDir(dir: string, bundled: string, what: string, warn: Warn) {
  if (!existsSync(bundled) || resolve(dir) === resolve(bundled)) return;
  const image = Object.fromEntries(filesOf(bundled).map((f) => [f, sha256(join(bundled, f))]));
  if (!existsSync(dir)) {
    // Copy, then rename: a crash mid-copy leaves only `.seeding`, and the next start retries.
    const seeding = `${dir}.seeding`;
    rmSync(seeding, { recursive: true, force: true });
    cpSync(bundled, seeding, { recursive: true });
    writeAtomic(join(seeding, SEED_MANIFEST), JSON.stringify(image, null, 2));
    renameSync(seeding, dir);
    return;
  }
  const path = join(dir, SEED_MANIFEST);
  const old = readManifest(path);
  const next: Manifest = { ...old };
  for (const [f, hash] of Object.entries(image)) {
    const copy = join(dir, f);
    if (!existsSync(copy)) {
      if (old && f in old) continue;
      mkdirSync(dirname(copy), { recursive: true });
      copyFileSync(join(bundled, f), copy);
      next[f] = hash;
      continue;
    }
    const now = sha256(copy);
    if (now === hash) next[f] = hash;
    else if (old?.[f] === now) {
      writeAtomic(copy, readFileSync(join(bundled, f), 'utf8'));
      next[f] = hash;
    } else warn(`${what} file edited by user, not updated`, { file: f });
  }
  if (JSON.stringify(next) !== JSON.stringify(old))
    writeAtomic(path, JSON.stringify(next, null, 2));
}
