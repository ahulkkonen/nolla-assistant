import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { checkFileTool, dirBytes } from './workspace.ts';

/**
 * Loaded into every child after `pi-ext-pseudo` (so arguments are real values). Keeps file tools
 * inside the child's cwd (the work dir) and out of `.trash`, checks the size limits of `write` and
 * `edit` (phase-11 decision 8), and asks the parent (`ctx.ui.confirm` over RPC) for tools in
 * `PA_APPROVAL_ALWAYS`; the parent forwards the question to the user.
 */
const always = new Set((process.env.PA_APPROVAL_ALWAYS ?? '').split(',').filter(Boolean));
const cwd = process.cwd();

const extension: ExtensionFactory = (pi) => {
  pi.on('tool_call', async (event, ctx) => {
    const tool = event.toolName;
    // ponytail: a child counts the work dir only (it has no database); uploads can push the
    // total past the quota by at most their own size. Pass the upload total in the env if it matters.
    const reason = await checkFileTool(cwd, tool, event.input, () => dirBytes(cwd));
    if (reason) return { block: true, reason };
    if (always.has(tool) && !(await ctx.ui.confirm(tool, JSON.stringify(event.input))))
      return { block: true, reason: 'käyttäjä esti työkalun' };
  });
};
export default extension;
