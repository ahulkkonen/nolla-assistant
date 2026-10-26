import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One commit of everything in `dir` per call, in a repository of its own (created on the first
 * call). Without git on PATH it warns once and stops committing. Used for the memory files
 * (phase-8 decision 1) and the editable profiles and automations (phase-15 decision 4).
 */
export function gitCommitter(
  dir: string,
  warn: (msg: string, data?: object) => void,
  what: string,
) {
  let git = true;
  return (note: string) => {
    if (!git) return;
    const opts = { cwd: dir, stdio: 'ignore', timeout: 10_000 } as const;
    const run = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=pa', '-c', 'user.email=pa@local', ...args], opts);
    try {
      if (!existsSync(join(dir, '.git'))) run('init', '-q');
      run('add', '-A');
      // Exit 0: nothing staged (e.g. an edit with the same text).
      if (spawnSync('git', ['diff', '--cached', '--quiet'], opts).status === 0) return;
      run('commit', '-qm', note);
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (missing) git = false;
      warn(missing ? `git not on PATH: ${what} are not versioned` : `${what} commit failed`, {
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  };
}
