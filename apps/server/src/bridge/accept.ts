/**
 * Maps each prompt to the session entry Pi stores for it, so `message.accepted` can tell the
 * sending socket the entry id of its local message. One queue per Pi session, shared by sockets.
 *
 * It only listens to session events and reads the session; it must not prompt, store entries or
 * send frames (the caller's `notify` does). It depends on Pi's prompt order, see below.
 */
import type {
  AgentSession,
  AgentSessionEvent,
  PromptOptions,
} from '@earendil-works/pi-coding-agent';
import { type AgentMessage, textOf } from '../session-text.ts';

/**
 * `message.accepted` (phase 13): the prompts of a session whose user entry is not stored yet, in
 * call order. One queue per session, shared by every socket; each prompt keeps its own `notify`.
 *
 * Pi 1.3.0 `AgentSession.prompt` (dist/core/agent-session.js) runs the input hooks first (masking),
 * then reports through `preflightResult`:
 * - `started` (idle): the run starts and stores this prompt as its first user message. `prompt`
 *   resolves only when the run ends.
 * - `queued` (a run is active, `steer`): the masked text joins the steering queue
 *   (`getSteeringMessages()`) and `prompt` resolves at once. Pi stores the message later, after the
 *   current turn, so the prompt's promise says nothing about the entry.
 * - `handled` (an input hook dropped it: sidecar down, a dropped collision): nothing is stored.
 *
 * Pi stores a message right after the public `message_end` listeners return, so the entry is read
 * in a microtask. A queued prompt matches by its masked text; the started one is the run's first
 * user message.
 */
type Accepting = {
  state: 'input' | 'started' | 'queued';
  /** The masked text of a queued prompt. */
  text?: string | undefined;
  notify: ((entryId: string) => void) | undefined;
};
const accepting = new WeakMap<AgentSession, Accepting[]>();
const unsubscribe = new WeakMap<AgentSession, () => void>();

/** Stops listening once no prompt of the session waits. */
function pruneAccepting(session: AgentSession) {
  if (accepting.get(session)?.length) return;
  unsubscribe.get(session)?.();
  unsubscribe.delete(session);
  accepting.delete(session);
}

/**
 * The entry id of the stored user message `m`: the leaf, or the nearest entry above it that holds
 * `m` (an extension may append a custom entry right after it).
 */
function storedId(sm: AgentSession['sessionManager'], m: AgentMessage) {
  let id = sm.getLeafId();
  for (let hops = 0; id && hops < 8; hops++) {
    const e = sm.getEntry(id);
    if (!e) return undefined;
    if (
      e.type === 'message' &&
      e.message.role === 'user' &&
      (e.message === m || (e.message.timestamp === m.timestamp && textOf(e.message) === textOf(m)))
    )
      return e.id;
    id = e.parentId;
  }
  return undefined;
}

function acceptEvent(session: AgentSession, e: AgentSessionEvent) {
  const items = accepting.get(session);
  if (!items) return;
  // The run is over: a started or queued prompt that got no entry never will.
  if (e.type === 'agent_settled') {
    for (let i = items.length - 1; i >= 0; i--) if (items[i]?.state !== 'input') items.splice(i, 1);
    return pruneAccepting(session);
  }
  if (e.type !== 'message_end' || e.message.role !== 'user') return;
  const m = e.message;
  const text = textOf(m);
  const started = items.findIndex((x) => x.state === 'started');
  const i =
    started >= 0 ? started : items.findIndex((x) => x.state === 'queued' && x.text === text);
  const item = items[i];
  if (!item) return;
  items.splice(i, 1);
  queueMicrotask(() => {
    const id = storedId(session.sessionManager, m);
    if (id) item.notify?.(id);
    pruneAccepting(session);
  });
}

/**
 * Tracks one prompt until its user entry is stored, then calls `notify` with the entry id. Every
 * prompt is tracked, with or without `notify`, so queued texts stay matched in order. Pass
 * `preflightResult` in the prompt's options and call `failed` when the prompt rejects.
 */
export function trackAccept(session: AgentSession, notify?: (entryId: string) => void) {
  let items = accepting.get(session);
  if (!items) {
    items = [];
    accepting.set(session, items);
    unsubscribe.set(
      session,
      session.subscribe((e) => acceptEvent(session, e)),
    );
  }
  const list = items;
  const item: Accepting = { state: 'input', notify };
  list.push(item);
  const drop = () => {
    const i = list.indexOf(item);
    if (i >= 0) list.splice(i, 1);
    pruneAccepting(session);
  };
  const preflightResult: NonNullable<PromptOptions['preflightResult']> = (d) => {
    if (d === 'handled') return drop();
    if (d === 'started') {
      item.state = 'started';
      return;
    }
    // This prompt's text: the first one in the steering queue that no other queued prompt holds.
    const held = list.filter((x) => x !== item && x.state === 'queued').map((x) => x.text);
    item.text = session.getSteeringMessages().find((t) => {
      const k = held.indexOf(t);
      if (k < 0) return true;
      held.splice(k, 1);
      return false;
    });
    item.state = 'queued';
  };
  return { preflightResult, failed: drop };
}
