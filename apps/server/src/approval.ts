import { randomUUID } from 'node:crypto';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ServerMessage } from '@pa/protocol';
import type { AgentProfile } from './agents.ts';

export const DENIED_REASON = 'käyttäjä esti työkalun';
export const TIMEOUT_REASON = 'hyväksyntä aikakatkaistiin';
export const UNATTENDED_REASON = 'ajastettu ajo: työkalu vaatii hyväksynnän';

type ApprovalRequest = Extract<ServerMessage, { type: 'approval.request' }>;
export type AskInput = Pick<ApprovalRequest, 'chatId' | 'tool' | 'args' | 'reason' | 'expiresAt'>;
/** Resolves with the user's answer; drops the request when `signal` aborts. */
export type Ask = (req: AskInput, signal: AbortSignal) => Promise<boolean>;

/**
 * Inline extension on `tool_call`. Tools in `policy.always` wait for the user; tools in
 * `policy.never` and all others pass. Load it after `pseudoExtension`, so `args` are real values.
 */
export const approvalGate =
  ({
    chatId,
    policy,
    ask,
    timeoutMs = 10 * 60_000,
  }: {
    chatId: string;
    policy: AgentProfile['approval'];
    /** `unattended` (see `approvals`): chats with no one to ask. */
    ask: Ask & { unattended?: Map<string, string[]> };
    timeoutMs?: number;
  }): ExtensionFactory =>
  (pi) => {
    pi.on('tool_call', async (event, ctx) => {
      const tool = event.toolName;
      if (policy.never.includes(tool) || !policy.always.includes(tool)) return;
      const auto = ask.unattended?.get(chatId);
      if (auto) return auto.includes(tool) ? undefined : { block: true, reason: UNATTENDED_REASON };
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout;
      const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
      const reason = `Työkalu ${tool} vaatii hyväksynnän.`;
      const answer = ask({ chatId, tool, args: event.input, reason, expiresAt }, signal);
      const aborted = new Promise<false>((r) => signal.addEventListener('abort', () => r(false)));
      if (await Promise.race([answer, aborted])) return;
      return { block: true, reason: timeout.aborted ? TIMEOUT_REASON : DENIED_REASON };
    });
  };

type Pending = { request: ApprovalRequest; resolve: (ok: boolean) => void };

/** Server side of the gate: pending requests survive a socket reconnect, not a restart. */
export function approvals(send: (chatId: string, msg: ServerMessage) => void) {
  const pending = new Map<string, Pending>();
  /** chatId to the tools that run without asking; the gate denies any other gated tool at once. */
  const unattended = new Map<string, string[]>();
  const ask: Ask & { unattended: typeof unattended } = Object.assign(
    (req: AskInput, signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        const requestId = randomUUID();
        const request: ApprovalRequest = { type: 'approval.request', requestId, ...req };
        pending.set(requestId, { request, resolve });
        signal.addEventListener('abort', () => pending.delete(requestId));
        // Real values go to the room only, never to the log.
        send(req.chatId, request);
      }),
    { unattended },
  );
  return {
    ask,
    unattended,
    /** Returns false when the request is unknown or already answered. */
    respond(requestId: string, approve: boolean): boolean {
      const p = pending.get(requestId);
      if (!p) return false;
      pending.delete(requestId);
      p.resolve(approve);
      return true;
    },
    /** Open requests, for one chat or all. */
    list: (chatId?: string) =>
      [...pending.values()].map((p) => p.request).filter((r) => !chatId || r.chatId === chatId),
  };
}
export type Approvals = ReturnType<typeof approvals>;
