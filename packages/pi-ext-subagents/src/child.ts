import { resolve, sep } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

/**
 * Loaded into every child after `pi-ext-pseudo` (so arguments are real values). Keeps file tools
 * inside the child's cwd and asks the parent (`ctx.ui.confirm` over RPC) for tools in
 * `PA_APPROVAL_ALWAYS`; the parent forwards the question to the user.
 */
const always = new Set((process.env.PA_APPROVAL_ALWAYS ?? '').split(',').filter(Boolean));
const cwd = process.cwd();

const extension: ExtensionFactory = (pi) => {
  pi.on('tool_call', async (event, ctx) => {
    const tool = event.toolName;
    if (tool === 'read' || tool === 'write' || tool === 'edit') {
      const path = (event.input as { path?: unknown }).path;
      // ponytail: lexical check like the server's pathGuard; symlinks inside cwd can still point out.
      if (typeof path !== 'string' || !resolve(cwd, path).startsWith(cwd + sep))
        return { block: true, reason: 'path outside workspace' };
    }
    if (always.has(tool) && !(await ctx.ui.confirm(tool, JSON.stringify(event.input))))
      return { block: true, reason: 'käyttäjä esti työkalun' };
  });
};
export default extension;
