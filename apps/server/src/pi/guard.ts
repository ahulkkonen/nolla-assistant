import { resolve, sep } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

export const GUARD_REASON = 'path outside workspace';

/** Blocks read/write/edit calls whose path resolves outside `cwd`. */
// ponytail: lexical check only; a symlink inside cwd can still point out. Add realpath checks when tools can create symlinks (bash, phase 5).
export const pathGuard =
  (cwd: string): ExtensionFactory =>
  (pi) => {
    pi.on('tool_call', (event) => {
      if (event.toolName !== 'read' && event.toolName !== 'write' && event.toolName !== 'edit')
        return;
      const path = (event.input as { path?: unknown }).path;
      if (typeof path !== 'string' || !resolve(cwd, path).startsWith(cwd + sep)) {
        return { block: true, reason: GUARD_REASON };
      }
    });
  };
