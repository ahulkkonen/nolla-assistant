import { TOOL_STATUS_WORD, WEB_SEARCH_TOOL } from '@pa/protocol';
import { AlertCircle, ArrowDown, GitFork, MessageSquare, ShieldAlert } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { announce } from '../announce.ts';
import { useMobile } from '../media.ts';
import { failedText, serverIdOf, type UiMessage, useStore } from '../store.ts';
import { Follow, replyTiming, replyUsage, threadKey } from '../thread.ts';
import { useModel } from '../useModel.ts';
import {
  editMessage,
  forkChat,
  openChat,
  retryTurn,
  send,
  sendUserMessage,
  setDataPolicy,
  switchVersion,
} from '../ws.ts';
import { ApprovalCard } from './ApprovalCard.tsx';
import { FindBar } from './FindBar.tsx';
import { ClaimChipRow, MemoryChipRow } from './MemoryChipRow.tsx';
import { MessageView, VersionSwitcher } from './MessageView.tsx';
import { UNTITLED } from './Sidebar.tsx';
import { SubagentRow } from './SubagentRow.tsx';
import { ThinkingRow, ThoughtRow } from './ThinkingRow.tsx';
import { LiveWait, Receipt, WaitStatus } from './WaitingLine.tsx';

const EMPTY: never[] = [];

/** At the top of a forked chat (phase-13 UI): where it came from, a link while the source exists. */
function ForkRow({ chatId }: { chatId: string }) {
  const from = useStore((s) => s.forkedFrom[chatId]);
  if (!from) return null;
  return (
    <div className="flex min-h-8 items-center gap-2 text-meta text-muted-foreground [@media(pointer:coarse)]:min-h-11">
      {/* The sidebar's fork mark (phase-22 decision 3): one glyph for a fork. */}
      <GitFork size={16} className="shrink-0" />
      {from.deleted ? (
        <span>Haarautettu keskustelusta, joka on poistettu.</span>
      ) : (
        <Button
          variant="link"
          onClick={() => openChat(from.chatId, from.messageId)}
          className="min-w-0 justify-start text-meta font-normal whitespace-normal"
        >
          {from.title
            ? `Haarautettu keskustelusta ”${from.title}”`
            : 'Haarautettu toisesta keskustelusta'}
        </Button>
      )}
    </div>
  );
}

/** The user message before `i`, for "retry". */
const previousUser = (messages: UiMessage[], i: number) =>
  messages.slice(0, i).findLast((m) => m.role === 'user' && m.text);

/** Stream start and end, tool status changes and approvals, never per token. */
function useAnnouncements(chatId: string | null) {
  const running = useStore((s) => (chatId ? s.agentStatus[chatId] === 'running' : false));
  const tools = useStore((s) => (chatId ? s.streaming[chatId]?.tools : undefined)) ?? EMPTY;
  const approvals = useStore((s) => s.approvals);
  const was = useRef({ running, tools: new Map<string, string>(), approvals: new Set<string>() });
  useEffect(() => {
    if (running !== was.current.running) announce(running ? 'Avustaja vastaa' : 'Vastaus valmis');
    was.current.running = running;
  }, [running]);
  useEffect(() => {
    for (const t of tools) {
      const before = was.current.tools.get(t.callId);
      if (before && before !== t.status)
        announce(`Työkalu ${t.name} ${TOOL_STATUS_WORD[t.status]}`);
      was.current.tools.set(t.callId, t.status);
    }
  }, [tools]);
  useEffect(() => {
    for (const a of approvals) {
      if (a.expired || was.current.approvals.has(a.requestId)) continue;
      was.current.approvals.add(a.requestId);
      announce(
        a.tool === WEB_SEARCH_TOOL ? 'Haku odottaa hyväksyntää' : `Hyväksyntä odottaa: ${a.tool}`,
        true,
      );
    }
  }, [approvals]);
}

export function Thread() {
  const chatId = useStore((s) => s.activeChatId);
  const messages = useStore((s) => (chatId ? (s.messages[chatId] ?? EMPTY) : EMPTY));
  // Phase 27: not the streamed text; the live reply reads it itself (MessageView `live`).
  const streaming = useStore((s) => (chatId ? !!s.streaming[chatId] : false));
  const streamTools = useStore((s) => (chatId ? s.streaming[chatId]?.tools : undefined)) ?? EMPTY;
  const running = useStore((s) => (chatId ? s.agentStatus[chatId] === 'running' : false));
  const related = useStore((s) => (chatId ? s.related[chatId] : undefined)) ?? EMPTY;
  const scrollTo = useStore((s) => s.scrollTo);
  const memoryChip = useStore((s) => (chatId ? s.memoryChip[chatId] : undefined));
  const claimChips = useStore((s) => (chatId ? s.claimChips[chatId] : undefined)) ?? EMPTY;
  const subagents = useStore((s) => (chatId ? s.subagents[chatId] : undefined)) ?? EMPTY;
  const failed = useStore((s) => (chatId ? s.failed[chatId] : undefined));
  const held = useStore((s) => (chatId ? s.held[chatId] !== undefined : false));
  const showThinking = useStore((s) => s.showThinking);
  const thinkingLive = useStore((s) => (chatId ? s.thinkingLive[chatId] : undefined));
  // Phase 26: a final without tool calls ends the rounds; the live turn goes before the idle.
  const ended = useStore((s) => (chatId ? s.waits[chatId]?.ended : false));
  const live = streaming || (running && !ended);
  const forking = useStore((s) => s.pendingFork);
  const editPending = useStore((s) => !!chatId && s.pendingEdit?.chatId === chatId);
  const switching = useStore((s) =>
    s.pendingVersion?.chatId === chatId ? s.pendingVersion : null,
  );
  const refusal = useStore((s) => (chatId ? s.zdrRefused[chatId] : undefined));
  const { name: modelName, policy } = useModel();
  const mobile = useMobile();
  // Only while the chat keeps the refused model: the name in the alert is that model's.
  const refused = refusal?.modelId === policy.modelId;
  // Filtered here, not in the selector: a new array per call would re-render forever.
  const allApprovals = useStore((s) => s.approvals);
  // Open requests only: a decided one is shown by its tool row.
  const approvals = allApprovals.filter((a) => a.chatId === chatId && !a.expired && !a.denied);
  const scroller = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(new Follow()).current;
  // Reply turns of this chat that began live here: no fade-in when their final message takes the
  // place. Per chat, reset in the render that shows another chat, so a chat opened mid-stream keeps
  // the live key its first render adds (another chat's turns fade in again when it opens).
  const born = useRef({ chatId, keys: new Set<string>() }).current;
  if (born.chatId !== chatId) [born.chatId, born.keys] = [chatId, new Set()];
  const bornLive = born.keys;
  const touchY = useRef(0);
  const [away, setAway] = useState(false);
  // Messages the reader has seen at the bottom; the rest count as new on the pill.
  const seen = useRef(messages.length);
  useAnnouncements(chatId);
  const lastUserId = messages.findLast((m) => m.role === 'user')?.id;
  // Phase-24 decision 10: a version switch keeps the switched message (its place in the thread)
  // where it was on screen; the last user message it brings does not pin the follow. The message
  // remounts (another entry): a focused switcher button gets the focus back.
  const keep = useRef<{ index: number; top: number; focus: string | null } | null>(null);
  const kept = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!away) seen.current = messages.length;
  }, [away, messages.length]);

  useLayoutEffect(() => {
    const k = keep.current;
    const el = scroller.current;
    if (!k || !el || switching) return;
    keep.current = null;
    const id = messages[k.index]?.id;
    const node = id && el.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    if (node) el.scrollTop += node.getBoundingClientRect().top - k.top;
    if (node && k.focus)
      node.querySelector<HTMLElement>(`[aria-label="${k.focus}"]`)?.focus({ preventScroll: true });
    kept.current = lastUserId;
    setAway(follow.sync(el));
  }, [messages, switching]);

  // Another chat starts at its bottom, with no pill and nothing unread. The follow runs now: a
  // cached chat of the same height gives no resize.
  useEffect(() => {
    follow.reset();
    setAway(false);
    seen.current = useStore.getState().messages[chatId ?? '']?.length ?? 0;
    if (scroller.current) follow.follow(scroller.current);
  }, [chatId]);

  // A sent message follows the bottom again, at once.
  useEffect(() => {
    if (kept.current === lastUserId) return;
    follow.pinned = true;
    if (scroller.current) follow.follow(scroller.current);
  }, [lastUserId]);

  // Phase 26: the thread's own height changes (an Android keyboard, the composer growing): the
  // bottom stays while pinned, else the reader's distance to it. Phase 27: the content's height
  // too (a delta, a tool row): the follow runs after layout, once per frame, with no forced
  // layout (a jump, not a smooth scroll); the pill shows once the growth leaves the reader away.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let height = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const delta = height - el.clientHeight;
      height = el.clientHeight;
      setAway(follow.resized(el, delta));
    });
    ro.observe(el);
    if (content.current) ro.observe(content.current);
    return () => ro.disconnect();
  }, []);

  // A search hit opens at its message once the chat's messages are in.
  useEffect(() => {
    if (!scrollTo) return;
    const el = scroller.current?.querySelector(`[data-message-id="${CSS.escape(scrollTo)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    if (scroller.current) setAway(follow.sync(scroller.current));
    useStore.getState().setScrollTo(null);
  }, [messages, scrollTo]);

  const lastUser = messages.findLastIndex((m) => m.role === 'user');
  // Each reply's cost and tokens, its tool rounds included (decision 15); once per thread change.
  const usageOf = useMemo(
    () => replyUsage(messages, streaming || running),
    [messages, streaming, running],
  );
  // Phase 26: each reply's receipt, from the stored phase times.
  const timingOf = useMemo(
    () => replyTiming(messages, streaming || running),
    [messages, streaming, running],
  );
  // Phase 12: the toast goes after 8 s, so the held bubble says what it waits for.
  const heldNote = (
    <p className="text-meta text-muted-foreground">
      Odottaa Nimisuojaa ·{' '}
      <button
        type="button"
        // Unique beside the toast's own "Avaa Nimisuoja" action.
        aria-label="Avaa Nimisuoja ja vastaa"
        onClick={() => useStore.getState().setScreen('vault')}
        className="text-link underline-offset-4 hover:underline"
      >
        Avaa Nimisuoja
      </button>
    </p>
  );
  // The memory chip belongs to the turn that wrote memory: the live one, else the last reply.
  const chip = (memoryChip || claimChips.length > 0) && chatId && (
    <>
      {memoryChip && <MemoryChipRow chip={memoryChip} />}
      {claimChips.length > 0 && <ClaimChipRow chatId={chatId} claims={claimChips} />}
    </>
  );
  const chipAt = live ? -1 : messages.findLastIndex((m) => m.role === 'assistant');
  const lastAssistant = live ? -1 : messages.findLastIndex((m) => m.role === 'assistant');
  // A tool-only assistant message and the reply after it are one turn (8 px in-turn gap). Phase
  // 27: a reply turn's key is its user turn's id and its place after it, so the live reply and
  // its final message are one article (the final's id is not known before it comes).
  const turns: {
    key: string;
    role: UiMessage['role'];
    items: { m: UiMessage; i: number }[];
    live?: boolean;
  }[] = [];
  let asked = '';
  let replies = 0;
  messages.forEach((m, i) => {
    const turn = turns.at(-1);
    const prev = turn?.items.at(-1)?.m;
    if (turn && m.role === 'assistant' && turn.role === 'assistant' && prev && !prev.text)
      return void turn.items.push({ m, i });
    if (m.role === 'user') [asked, replies] = [m.id, 0];
    const key = m.role === 'user' ? m.id : `${asked}:${replies++}`;
    turns.push({ key, role: m.role, items: [{ m, i }] });
  });
  const lastTurn = turns.at(-1);
  const joinLive = live && lastTurn?.role === 'assistant' && !lastTurn.items.at(-1)?.m.text;
  if (live && joinLive && lastTurn) lastTurn.live = true;
  else if (live) {
    const key = `${asked}:${replies}`;
    bornLive.add(key);
    turns.push({ key, role: 'assistant', items: [], live: true });
  }
  const cards = approvals.map((a) => <ApprovalCard key={a.requestId} a={a} />);
  // Phase 26: the waiting line shows the thinking while it lasts; once it stopped, "Ajatteli 12 s"
  // until the final message that owns it arrives (`message.final` clears it).
  const liveThought =
    showThinking && thinkingLive?.endedAt ? (
      <ThoughtRow ms={thinkingLive.endedAt - thinkingLive.startedAt} />
    ) : undefined;
  const liveView = live && chatId && (
    <MessageView
      role="assistant"
      text=""
      tools={streamTools}
      thinking={liveThought}
      subagents={subagents}
      live={chatId}
      // The latest reply: its row (the live line) shows without hover, also on touch.
      latest
      // Phase 26: the 28 px first line before the first token, then the action row's end. An
      // open approval card says what the turn waits for; no line between it and its tool row.
      waiting={approvals.length ? undefined : <LiveWait chatId={chatId} />}
      receipt={<LiveWait chatId={chatId} row />}
      // A pending approval card follows in the same turn; no reserved row in between.
      reserve={!approvals.length}
      footer={chip}
    />
  );
  // Normally the `subagent` tool row carries it; standalone only before that row exists.
  const standalone = subagents.length > 0 && !streamTools.some((t) => t.name === 'subagent') && (
    <SubagentRow items={subagents} />
  );

  useEffect(() => {
    if (refused) announce('Malli ei tue ZDR:ää', true);
  }, [refused]);

  /** "Uusimpaan" and End: to the bottom (smooth unless reduced motion), and the follow resumes. */
  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    // Focus stays in the thread when the pill unmounts (not lost to <body>).
    el.focus({ preventScroll: true });
    follow.jump(el, !matchMedia('(prefers-reduced-motion: reduce)').matches);
    setAway(false);
  };
  const unread = away ? messages.length - seen.current : 0;
  /** Inside a region that scrolls by itself (tool output, a tall code block): not the thread's. */
  const inner = (t: EventTarget | null) => {
    const r = (t as HTMLElement | null)?.closest?.('[role="region"]');
    // Vertical scrollers have a max height (tool output, thinking); a code block scrolls sideways
    // only, and its horizontal scrollbar makes it look taller than its box.
    return !!r && getComputedStyle(r).maxHeight !== 'none' && r.scrollHeight > r.clientHeight + 1;
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <section
        ref={scroller}
        aria-label="Keskustelu"
        // Focus target of the pill; not a tab stop.
        tabIndex={-1}
        onScroll={(e) => {
          const away = follow.scrolled(e.currentTarget);
          if (away !== undefined) setAway(away);
        }}
        // The reader scrolls up: the follow stops at once, before a delta can pull the thread
        // back down; `onScroll` then sets it from the real position. It also ends a smooth jump.
        // Not inside a region that scrolls by itself (tool output, code): that scroll is not ours.
        onWheel={(e) => {
          if (e.deltaY < 0 && !inner(e.target)) follow.up(e.currentTarget);
          else follow.jumping = false;
        }}
        onTouchStart={(e) => {
          touchY.current = e.touches[0]?.clientY ?? 0;
        }}
        // Phase 27: only a finger that moves down scrolls the thread up; one that pushes past the
        // bottom does not stop the follow.
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current && !inner(e.target)) follow.up(e.currentTarget);
          touchY.current = y;
        }}
        onKeyDown={(e) => {
          const key = threadKey(e);
          if (key === 'up' && !inner(e.target)) follow.up(e.currentTarget);
          if (key !== 'end') return;
          e.preventDefault();
          jump();
        }}
        // No scroll anchoring: it moved the thread 40 px on a keyboard open and unpinned the
        // follow; `Follow.resized` keeps the place in every engine (Safari has no anchoring).
        className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 outline-none [overflow-anchor:none]"
      >
        {/* Bottom 64: at the end the latest action row sits above the composer's fade. */}
        {/* `col`: a reply's action row reads the column's width (the receipt's own line). */}
        <div
          ref={content}
          className="@container/col mx-auto flex w-full max-w-(--thread-max) flex-col gap-6 pt-6 pb-16"
        >
          <FindBar scroller={scroller} />
          {chatId && <ForkRow chatId={chatId} />}
          {turns.map((t, n) => {
            const last = n === turns.length - 1;
            return (
              <Fragment key={t.key}>
                {t.live && !joinLive && standalone}
                <article
                  // After a user turn and an older reply 40 px (48 on phones): the action row sits
                  // in the gap. Touch shows the row only under the latest turns, but every turn
                  // keeps its room, so the gaps match (UI review 3). The latest user turn shows its
                  // 44 px row on touch, so 24 px stay below the row.
                  className={cn(
                    'flex flex-col gap-2',
                    // Messages from elsewhere (a reload, another device) fade in; a reply that
                    // streamed here stays as it is when its final message takes its place.
                    !bornLive.has(t.key) && 'animate-fade-in',
                    (t.role === 'user' || !last) && 'mb-4 max-md:mb-6',
                    // Under 620 px its receipt line (4 + 18 px) needs a wider gap.
                    t.role === 'assistant' &&
                      !last &&
                      t.items.some(({ m }) => timingOf.has(m.id)) &&
                      'md:@max-[620px]/col:[@media(hover:hover)]:mb-9',
                    t.role === 'user' && t.items.some(({ i }) => i === lastUser) && 'max-md:mb-12',
                    // Editing: the action row is gone, so is the room kept for it.
                    t.role === 'user' && 'has-[textarea]:mb-0',
                  )}
                >
                  <h2 className="sr-only">
                    {t.role === 'user' ? 'Sinä sanoit' : 'Avustaja sanoi'}
                  </h2>
                  {/* Keyed by place: the live reply's element stays for its final message. */}
                  {[...t.items, ...(t.live ? [undefined] : [])].map((item, j) => {
                    if (!item) return <div key={j}>{liveView}</div>;
                    const { m, i } = item;
                    const prev = m.role === 'assistant' ? previousUser(messages, i) : undefined;
                    const serverId = serverIdOf(m);
                    return (
                      <div key={j} data-message-id={m.id}>
                        <MessageView
                          id={m.id}
                          role={m.role}
                          text={m.text}
                          annotations={m.annotations}
                          attachments={m.attachments}
                          tools={m.tools}
                          latest={i === lastUser || i === lastAssistant}
                          meta={{ createdAt: m.createdAt, usage: usageOf.get(m.id) }}
                          {...(timingOf.has(m.id)
                            ? { receipt: <Receipt timing={timingOf.get(m.id) ?? {}} /> }
                            : {})}
                          {...(showThinking && m.thinking && chatId
                            ? {
                                thinking: (
                                  <ThinkingRow
                                    chatId={chatId}
                                    messageId={m.id}
                                    ms={m.thinking.ms}
                                    createdAt={m.createdAt}
                                  />
                                ),
                              }
                            : {})}
                          {...(i === chipAt ? { footer: chip } : {})}
                          {...(held && i === lastUser ? { footer: heldNote } : {})}
                          // "Muokkaa" edits in place or forks (phases 24, 13); not while a reply
                          // streams.
                          {...(m.role === 'user' && chatId && !streaming && !running
                            ? {
                                // Without its entry id (sent before `message.accepted` existed,
                                // or the answer never came) the edit box asks for a reopen.
                                onEdit: (text: string) =>
                                  serverId && editMessage(chatId, serverId, text),
                                onFork: (text: string) =>
                                  serverId && forkChat(chatId, serverId, text),
                                canSend: !!serverId,
                                busy: !!forking || editPending,
                                onNeedIds: () => send({ type: 'chat.open', chatId }),
                              }
                            : {})}
                          {...(m.role === 'user' && m.versions && chatId
                            ? {
                                switcher: (
                                  <VersionSwitcher
                                    versions={m.versions}
                                    wait={streaming || running || !serverId}
                                    busy={!!serverId && switching?.messageId === serverId}
                                    onPick={(index) => {
                                      if (!serverId) return;
                                      const at = scroller.current?.querySelector(
                                        `[data-message-id="${CSS.escape(m.id)}"]`,
                                      );
                                      const active = document.activeElement;
                                      keep.current = {
                                        index: i,
                                        top: at?.getBoundingClientRect().top ?? 0,
                                        focus: at?.contains(active)
                                          ? (active?.getAttribute('aria-label') ?? null)
                                          : null,
                                      };
                                      switchVersion(chatId, serverId, index);
                                    }}
                                  />
                                ),
                              }
                            : {})}
                          {...(prev
                            ? {
                                // A reply that came is asked again as a new message. Only a failed
                                // turn runs again in place (the alert below, `user.retry`).
                                onRetry: () => void sendUserMessage(prev.text, prev.attachments),
                              }
                            : {})}
                        />
                      </div>
                    );
                  })}
                  {t.live && (
                    <>
                      {/* The approval card: in the turn of its tool row (8 px gap), no modal. */}
                      {cards}
                      {chatId && <WaitStatus chatId={chatId} />}
                    </>
                  )}
                </article>
              </Fragment>
            );
          })}
          {/* No reply to hold it (the turn failed before any text): on its own. */}
          {!live && chipAt < 0 && chip}
          {!streaming && !running && related.length > 0 && (
            <nav aria-label="Liittyvät keskustelut" className="flex flex-col gap-2">
              <h2 className="text-micro text-muted-foreground">Liittyvät keskustelut</h2>
              {/* Not a list: the sidebar owns `nav li > button` (e2e counts chat rows by it). */}
              <div className="flex flex-wrap gap-2">
                {related.slice(0, 3).map((r) => (
                  <Button
                    key={r.chatId}
                    variant="outline"
                    size="sm"
                    onClick={() => openChat(r.chatId)}
                    className="max-w-60 justify-start font-normal"
                  >
                    <MessageSquare size={16} className="text-muted-foreground" />
                    <span className="truncate">{r.title || UNTITLED}</span>
                  </Button>
                ))}
              </div>
            </nav>
          )}
          {(!live || joinLive) && standalone}
          {failed && !streaming && !running && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive-subtle px-4 py-3 text-body text-foreground max-md:gap-y-2"
            >
              <AlertCircle size={16} className="shrink-0 text-destructive" />
              <span className="min-w-0 flex-1">{failedText(failed)}</span>
              {/* Phones: two 44 px outline buttons in one row, 50 % each, as the approval card. */}
              <div className="flex items-center gap-3 max-md:grid max-md:basis-full max-md:grid-cols-2 max-md:gap-2">
                {failed.detail && (
                  <Button
                    variant={mobile ? 'outline' : 'link'}
                    onClick={() => useStore.setState({ errorDetail: failed })}
                  >
                    Näytä tiedot
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="max-md:col-start-2"
                  onClick={() => chatId && retryTurn(chatId)}
                >
                  Yritä uudelleen
                </Button>
              </div>
            </div>
          )}
          {refused && !streaming && !running && (
            // A ZDR refusal asks for a decision (phase-10 UI): warning tint, the risk before consent.
            <div
              role="alert"
              className="flex flex-col gap-3 rounded-md bg-warning-subtle px-4 py-3 text-foreground"
            >
              <div className="flex gap-3">
                <ShieldAlert size={16} className="mt-1 shrink-0 text-warning" />
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-body">
                    Mallilla {modelName} ei ole ZDR-reittiä, joten OpenRouter hylkäsi pyynnön.
                  </p>
                  <p className="text-meta text-pretty text-muted-foreground">
                    Ilman ZDR:ää palveluntarjoaja voi säilyttää viestit omien ehtojensa mukaan.
                    Nimet ja tunnisteet korvataan silti peitenimillä.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pl-7 max-md:flex-col max-md:pl-0">
                <Button variant="outline" onClick={() => chatId && setDataPolicy(chatId, 'open')}>
                  Salli ilman ZDR:ää tässä keskustelussa
                </Button>
                <Button variant="ghost" onClick={() => useStore.setState({ modelMenuOpen: true })}>
                  Vaihda malli
                </Button>
              </div>
            </div>
          )}
          {!live && cards}
        </div>
      </section>
      {/* Prose fades out above the composer instead of ending on a hard cut. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-15 bg-linear-to-t from-background"
      />
      {away && (
        // Brief 7.5: 12 px above the composer, centred on the thread column. Dark has no
        // shadow-sm; floating elements take the dark floating shadow there (7.4).
        <Button
          variant="outline"
          onClick={jump}
          // Above the fade; 36 px, 44 below 768; 12 px over the composer.
          className="absolute bottom-3 left-1/2 z-10 h-9 -translate-x-1/2 rounded-full bg-card px-4 text-foreground shadow-sm hover:bg-accent max-md:h-11 dark:shadow-md"
        >
          <ArrowDown />
          Uusimpaan
          {unread > 1 && (
            <span className="font-normal text-muted-foreground">· {unread} uutta</span>
          )}
        </Button>
      )}
    </div>
  );
}
