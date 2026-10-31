import { randomUUID } from 'node:crypto';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { type ApprovalView, isHarnessTool, type ServerMessage } from '@pa/protocol';
import type { AgentProfile } from './agents.ts';

export const DENIED_REASON = 'käyttäjä esti työkalun';
export const TIMEOUT_REASON = 'hyväksyntä aikakatkaistiin';
export const UNATTENDED_REASON = 'ajastettu ajo: työkalu vaatii hyväksynnän';
export const CALL_ID_REASON = 'työkalukutsujen tunnisteet puuttuvat tai toistuvat: viesti hylätty';

/** Per-call records are keyed by tool and call id: two tools never share one (phase 30). */
export const callKey = (tool: string, callId: string) => `${tool}\u0000${callId}`;
/** The plan fixes 10 minutes; `APPROVAL_TIMEOUT_MS` shortens it in tests. */
const TIMEOUT_MS = 10 * 60_000;

type ApprovalRequest = Extract<ServerMessage, { type: 'approval.request' }>;
export type AskInput = Pick<
  ApprovalRequest,
  'chatId' | 'callId' | 'tool' | 'args' | 'reason' | 'expiresAt' | 'view' | 'tainted'
>;
/** Resolves with the user's answer, or `false` (request dropped) when `signal` aborts. */
export type Ask = (req: AskInput, signal: AbortSignal) => Promise<boolean>;

/** `unattended` (see `approvals`): chats with no one to ask; `autoApprove`: chats whose toggle is on. */
type GateAsk = Ask & { unattended?: Map<string, string[]>; autoApprove?: Set<string> };

/**
 * The card a gated call shows (phase-25 decision 3), from the call's real arguments. An `error`
 * blocks the call without a card; it is fixed text (decision 4).
 */
export type View = (
  input: Record<string, unknown>,
  callId: string,
) => Promise<{ view: ApprovalView } | { error: string }>;

/**
 * "Hyväksy automaattisesti" is on in the chat and lets `tool` run (phase-21 decision 7). Never a
 * harness tool (phase-25 decision 2).
 */
const autoApproved = (
  ask: GateAsk,
  chatId: string,
  autoTools: string[] | undefined,
  tool: string,
) => !isHarnessTool(tool) && !!ask.autoApprove?.has(chatId) && !!autoTools?.includes(tool);

/**
 * The `ask` of a chat's subagent children (phase-22 decision 7): a child's tool that the parent
 * chat's toggle lets run passes without a card. In an unattended chat no one sees a card: only the
 * listed tools pass, the others are denied at once.
 */
export const childAsk =
  (ask: GateAsk, chatId: string, autoTools: string[]): Ask =>
  (req, signal) => {
    const unattended = ask.unattended?.get(chatId);
    if (unattended)
      return Promise.resolve(!isHarnessTool(req.tool) && unattended.includes(req.tool));
    return autoApproved(ask, chatId, autoTools, req.tool)
      ? Promise.resolve(true)
      : ask(req, signal);
  };

/**
 * Inline extension on `tool_call`. Tools in `policy.always` wait for the user; tools in
 * `policy.never` and all others pass. A harness tool always waits, whatever the profile, the
 * automation or the toggle says (phase-25 decision 2). Load it after `pseudoExtension`, so `args`
 * are real values.
 */
export const approvalGate =
  ({
    chatId,
    policy,
    ask,
    timeoutMs,
    approved,
    autoTools,
    views,
    tainted,
  }: {
    chatId: string;
    policy: AgentProfile['approval'];
    ask: GateAsk;
    /** The tools the toggle lets run (phase-21 decision 7), from the profile this gate was built with. */
    autoTools?: string[] | undefined;
    timeoutMs?: number | undefined;
    /** Calls the user already approved on an earlier card (the web search guard): no second card. */
    approved?: Set<string> | undefined;
    /** Phase 25: the card view per tool, awaited before the card. */
    views?: Record<string, View> | undefined;
    /** Phase 25: the session's turn taint; a harness card of a tainted turn says so. */
    tainted?: (() => boolean) | undefined;
  }): ExtensionFactory =>
  (pi) => {
    pi.on('tool_call', async (event, ctx) => {
      const tool = event.toolName;
      const harness = isHarnessTool(tool);
      if (!harness && (policy.never.includes(tool) || !policy.always.includes(tool))) return;
      if (!harness && approved?.has(callKey(tool, event.toolCallId))) return;
      const auto = ask.unattended?.get(chatId);
      if (auto)
        return !harness && auto.includes(tool)
          ? undefined
          : { block: true, reason: UNATTENDED_REASON };
      if (autoApproved(ask, chatId, autoTools, tool)) return;
      const shown = await views?.[tool]?.(event.input, event.toolCallId);
      if (shown && 'error' in shown) return { block: true, reason: shown.error };
      return confirm(ask, {
        chatId,
        callId: event.toolCallId,
        tool,
        args: event.input,
        ...(shown ? { view: shown.view } : {}),
        ...(harness && tainted?.() ? { tainted: true } : {}),
        reason: `Työkalu ${tool} vaatii hyväksynnän.`,
        denied: DENIED_REASON,
        timeoutMs,
        signal: ctx.signal,
      });
    });
  };

/**
 * One approval card for a tool call: undefined when the user approves, else a block whose reason
 * is `denied` (or `TIMEOUT_REASON`). An aborted `signal` blocks at once.
 */
export async function confirm(
  ask: Ask,
  o: Omit<AskInput, 'expiresAt'> & {
    denied: string;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<{ block: true; reason: string } | undefined> {
  if (o.signal?.aborted) return { block: true, reason: o.denied };
  const ms = o.timeoutMs ?? TIMEOUT_MS;
  const timeout = AbortSignal.timeout(ms);
  const signal = o.signal ? AbortSignal.any([timeout, o.signal]) : timeout;
  const expiresAt = new Date(Date.now() + ms).toISOString();
  const { denied: _, timeoutMs: __, signal: ___, ...req } = o;
  if (await ask({ ...req, expiresAt }, signal)) return;
  return { block: true, reason: timeout.aborted ? TIMEOUT_REASON : o.denied };
}

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
  /**
   * chatId to the tools that run without asking while "Hyväksy automaattisesti" is on (phase-21
   * decision 7). Other gated tools still ask. In memory: a restart turns it off.
   */
  const autoApprove = new Set<string>();
  const ask = Object.assign(
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
    { unattended, autoApprove },
  );
  return {
    ask,
    unattended,
    autoApprove,
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
