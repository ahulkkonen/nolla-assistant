import { randomUUID } from 'node:crypto';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ServerMessage } from '@pa/protocol';
import type { AgentProfile } from './agents.ts';

export const DENIED_REASON = 'käyttäjä esti työkalun';
export const TIMEOUT_REASON = 'hyväksyntä aikakatkaistiin';
export const UNATTENDED_REASON = 'ajastettu ajo: työkalu vaatii hyväksynnän';

type ApprovalRequest = Extract<ServerMessage, { type: 'approval.request' }>;
export type AskInput = Pick<
  ApprovalRequest,
  'chatId' | 'callId' | 'tool' | 'args' | 'reason' | 'expiresAt'
>;
/** Resolves with the user's answer, or `false` (request dropped) when `signal` aborts. */
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
    timeoutMs?: number | undefined;
  }): ExtensionFactory =>
  (pi) => {
    pi.on('tool_call', async (event, ctx) => {
      const tool = event.toolName;
      if (policy.never.includes(tool) || !policy.always.includes(tool)) return;
      const auto = ask.unattended?.get(chatId);
      if (auto) return auto.includes(tool) ? undefined : { block: true, reason: UNATTENDED_REASON };
      if (ctx.signal?.aborted) return { block: true, reason: DENIED_REASON };
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout;
      const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
      const reason = `Työkalu ${tool} vaatii hyväksynnän.`;
      const req = { chatId, callId: event.toolCallId, tool, args: event.input, reason, expiresAt };
      if (await ask(req, signal)) return;
      return { block: true, reason: timeout.aborted ? TIMEOUT_REASON : DENIED_REASON };
    });
  };

type Outcome = Extract<ServerMessage, { type: 'approval.resolved' }>['outcome'];
type Pending = { request: ApprovalRequest; finish: (outcome: Outcome) => void };
const RESOLVED_KEEP = 200;

/** Server side of the gate: pending requests survive a socket reconnect, not a restart. */
export function approvals(send: (chatId: string, msg: ServerMessage) => void) {
  const pending = new Map<string, Pending>();
  /** requestId to chatId of recently resolved requests, so a late answer gets `expired`. */
  const resolved = new Map<string, string>();
  /** chatId to the tools that run without asking; the gate denies any other gated tool at once. */
  const unattended = new Map<string, string[]>();
  const ask: Ask & { unattended: typeof unattended } = Object.assign(
    (req: AskInput, signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        if (signal.aborted) return resolve(false);
        const requestId = randomUUID();
        const request: ApprovalRequest = { type: 'approval.request', requestId, ...req };
        const finish = (outcome: Outcome) => {
          if (!pending.delete(requestId)) return;
          signal.removeEventListener('abort', onAbort);
          resolved.set(requestId, req.chatId);
          if (resolved.size > RESOLVED_KEEP) resolved.delete(resolved.keys().next().value ?? '');
          send(req.chatId, { type: 'approval.resolved', chatId: req.chatId, requestId, outcome });
          resolve(outcome === 'approved');
        };
        const onAbort = () => finish('expired');
        signal.addEventListener('abort', onAbort, { once: true });
        pending.set(requestId, { request, finish });
        // Real values go to the room only, never to the log.
        send(req.chatId, request);
      }),
    { unattended },
  );
  return {
    ask,
    unattended,
    /** Returns false when the request is unknown or already resolved. */
    respond(requestId: string, approve: boolean): boolean {
      const p = pending.get(requestId);
      p?.finish(approve ? 'approved' : 'denied');
      return !!p;
    },
    /** Ends every open request of a chat as `expired` (the tool is denied). */
    cancel(chatId: string) {
      for (const p of [...pending.values()]) if (p.request.chatId === chatId) p.finish('expired');
    },
    /** Chat id of a recently resolved request, for a late answer. */
    resolvedChat: (requestId: string) => resolved.get(requestId),
    /** Open requests, for one chat or all. */
    list: (chatId?: string) =>
      [...pending.values()].map((p) => p.request).filter((r) => !chatId || r.chatId === chatId),
  };
}
export type Approvals = ReturnType<typeof approvals>;
