import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const WEB = join(import.meta.dirname, '../../../apps/web');

const newest = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((max, e) => {
    const p = join(dir, e.name);
    return Math.max(max, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }, 0);

/** Builds the web app when `dist` is missing or older than any file in `src`. */
export default function globalSetup() {
  const index = join(WEB, 'dist/index.html');
  if (existsSync(index) && statSync(index).mtimeMs >= newest(join(WEB, 'src'))) return;
  execFileSync('pnpm', ['--filter', '@nolla/web', 'build'], { stdio: 'inherit' });
}
