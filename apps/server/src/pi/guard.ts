import { realpath } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { checkFileTool, GUARD_REASON, piPath, realInside } from '@pa/pi-ext-subagents/workspace';

export { GUARD_REASON };

/** The work-dir side of a session (phase-11 decisions 6 and 7). */
export type WorkHooks = {
  /** The user's total bytes, both roots, for the size check. */
  used(): Promise<number>;
  /** After a `write` or `edit` that succeeded; `path` is relative to the work dir, '/'-separated. */
  written(path: string, chatId: string, messageId: string | null): void;
};

/**
 * Blocks file tool calls whose path (as Pi resolves it, after symlinks) leaves `cwd` or reaches
 * `.trash`, and writes past the size limits. Records the chat and message of each written file.
 */
export const pathGuard =
  (cwd: string, chatId: string, work?: WorkHooks): ExtensionFactory =>
  (pi) => {
    pi.on('tool_call', async (event) => {
      const used = work ? () => work.used() : async () => 0;
      const reason = await checkFileTool(cwd, event.toolName, event.input, used);
      if (reason) return { block: true, reason };
    });
    if (!work) return;
    pi.on('tool_result', async (event, ctx) => {
      if (event.isError || (event.toolName !== 'write' && event.toolName !== 'edit')) return;
      const { path } = event.input;
      const abs = typeof path === 'string' ? await realInside(cwd, piPath(cwd, path)) : undefined;
      if (!abs) return;
      // A nested call (`<parent>/<n>`) belongs to its parent's tool call.
      const callId = event.parentToolCallId ?? event.toolCallId;
      const entry = ctx.sessionManager
        .getBranch()
        .findLast(
          (e) =>
            e.type === 'message' &&
            e.message.role === 'assistant' &&
            e.message.content.some((b) => b.type === 'toolCall' && b.id === callId),
        );
      const rel = relative(await realpath(cwd), abs)
        .split(sep)
        .join('/');
      work.written(rel, chatId, entry?.id ?? null);
    });
  };
