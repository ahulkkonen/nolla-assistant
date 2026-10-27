import { TOOL_STATUS_WORD, WEB_SEARCH_TOOL } from '@pa/protocol';
import { AlertCircle, ArrowDown, GitBranch, MessageSquare, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { announce } from '../announce.ts';
import { FAILED_TEXT, serverIdOf, type UiMessage, useStore } from '../store.ts';
import { Follow, replyUsage, threadKey } from '../thread.ts';
import { useModel } from '../useModel.ts';
import { forkChat, openChat, retryTurn, send, sendUserMessage, setDataPolicy } from '../ws.ts';
import { ApprovalCard } from './ApprovalCard.tsx';
import { FindBar } from './FindBar.tsx';
import { ClaimChipRow, MemoryChipRow } from './MemoryChipRow.tsx';
import { MessageView } from './MessageView.tsx';
import { UNTITLED } from './Sidebar.tsx';
import { SubagentRow } from './SubagentRow.tsx';
import { ThinkingLive, ThinkingRow } from './ThinkingRow.tsx';

const EMPTY: never[] = [];

/** At the top of a forked chat (phase-13 UI): where it came from, a link while the source exists. */
function ForkRow({ chatId }: { chatId: string }) {
  const from = useStore((s) => s.forkedFrom[chatId]);
  if (!from) return null;
  return (
    <div className="flex min-h-8 items-center gap-2 text-meta text-muted-foreground [@media(pointer:coarse)]:min-h-11">
      <GitBranch size={16} className="shrink-0" />
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
  const stream = useStore((s) => (chatId ? s.streaming[chatId] : undefined));
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
  const forking = useStore((s) => s.pendingFork);
  const refusal = useStore((s) => (chatId ? s.zdrRefused[chatId] : undefined));
  const { name: modelName, policy } = useModel();
  // Only while the chat keeps the refused model: the name in the alert is that model's.
  const refused = refusal?.modelId === policy.modelId;
  // Filtered here, not in the selector: a new array per call would re-render forever.
  const allApprovals = useStore((s) => s.approvals);
  // Open requests only: a decided one is shown by its tool row.
  const approvals = allApprovals.filter((a) => a.chatId === chatId && !a.expired && !a.denied);
  const scroller = useRef<HTMLElement>(null);
  const follow = useRef(new Follow()).current;
  const [away, setAway] = useState(false);
  // Messages the reader has seen at the bottom; the rest count as new on the pill.
  const seen = useRef(messages.length);
  useAnnouncements(chatId);
  const lastUserId = messages.findLast((m) => m.role === 'user')?.id;

  useEffect(() => {
    if (!away) seen.current = messages.length;
  }, [away, messages.length]);

  // Another chat starts at its bottom, with no pill and nothing unread.
  useEffect(() => {
    follow.reset();
    setAway(false);
    seen.current = useStore.getState().messages[chatId ?? '']?.length ?? 0;
  }, [chatId]);

  // A sent message follows the bottom again.
  useEffect(() => {
    follow.pinned = true;
  }, [lastUserId]);

  // Follow the bottom while the user has not scrolled up (a jump, not a smooth scroll).
  useEffect(() => {
    if (scroller.current) follow.follow(scroller.current);
  }, [messages, stream?.text, stream?.tools, running, allApprovals, subagents, failed]);

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
    () => replyUsage(messages, !!(stream || running)),
    [messages, stream, running],
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
  const chipAt = stream || running ? -1 : messages.findLastIndex((m) => m.role === 'assistant');
  const lastAssistant =
    stream || running ? -1 : messages.findLastIndex((m) => m.role === 'assistant');
  // A tool-only assistant message and the reply after it are one turn (8 px in-turn gap).
  const turns: { role: UiMessage['role']; items: { m: UiMessage; i: number }[] }[] = [];
  messages.forEach((m, i) => {
    const turn = turns.at(-1);
    const prev = turn?.items.at(-1)?.m;
    if (turn && m.role === 'assistant' && turn.role === 'assistant' && prev && !prev.text)
      turn.items.push({ m, i });
    else turns.push({ role: m.role, items: [{ m, i }] });
  });
  const lastTurn = turns.at(-1);
  const joinLive =
    !!(stream || running) && lastTurn?.role === 'assistant' && !lastTurn.items.at(-1)?.m.text;
  const cards = approvals.map((a) => <ApprovalCard key={a.requestId} a={a} />);
  // The live line stays until the final message that owns it arrives (`message.final` clears it),
  // also when a tool round has moved the stream on.
  const liveThinking =
    showThinking && thinkingLive ? (
      <ThinkingLive
        startedAt={thinkingLive.startedAt}
        {...(thinkingLive.endedAt ? { endedAt: thinkingLive.endedAt } : {})}
      />
    ) : undefined;
  const liveView = (stream || running) && (
    <>
      {stream?.text || stream?.tools.length || liveThinking ? (
        <MessageView
          role="assistant"
          text={stream?.text ?? ''}
          annotations={stream?.annotations ?? []}
          tools={stream?.tools ?? []}
          thinking={liveThinking}
          subagents={subagents}
          live
          // A pending approval card follows in the same turn; no reserved row in between.
          reserve={!approvals.length}
          footer={chip}
        />
      ) : (
        // Before the first token: three 6 px dots; the action row's 32 px is kept.
        <div className="flex flex-col gap-2">
          <span
            role="status"
            aria-label="Vastaus tulossa"
            className="flex h-7 items-center gap-1.5"
          >
            {[0, 150, 300].map((d) => (
              <span
                key={d}
                style={{ animationDelay: `${d}ms` }}
                className="size-1.5 animate-pulse rounded-full bg-muted-foreground"
              />
            ))}
          </span>
          <div className="h-8" />
        </div>
      )}
      {/* The approval card sits in the turn of its tool row (8 px gap), never as a modal. */}
      {cards}
    </>
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
          // Pixels, or lines and pages (deltaMode 1, 2) as "far".
          if (e.deltaY < 0 && !inner(e.target))
            follow.up(e.currentTarget, e.deltaMode ? Number.POSITIVE_INFINITY : -e.deltaY);
          else follow.jumping = false;
        }}
        onTouchMove={(e) => {
          if (!inner(e.target)) follow.up(e.currentTarget);
        }}
        onKeyDown={(e) => {
          const key = threadKey(e);
          if (key === 'up' && !inner(e.target))
            follow.up(e.currentTarget, e.key === 'ArrowUp' ? 40 : Number.POSITIVE_INFINITY);
          if (key !== 'end') return;
          e.preventDefault();
          jump();
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 outline-none"
      >
        <div className="mx-auto flex w-full max-w-(--thread-max) flex-col gap-6 py-6">
          <FindBar scroller={scroller} />
          {chatId && <ForkRow chatId={chatId} />}
          {turns.map((t, n) => {
            const last = n === turns.length - 1;
            return (
              <article
                key={t.items[0]?.m.id}
                // After a user turn 40 px (48 on phones): its action row sits in the gap. The
                // latest user turn shows its 44 px row on touch, so 24 px stay below the row.
                className={cn(
                  'flex flex-col gap-2 animate-fade-in',
                  t.role === 'user' && 'mb-4 max-md:mb-6',
                  // An older reply's action row sits in the gap below it, as a user turn's does.
                  t.role === 'assistant' && !last && '[@media(hover:hover)]:mb-4',
                  t.role === 'user' && t.items.some(({ i }) => i === lastUser) && 'max-md:mb-12',
                  // Editing: the action row is gone, so is the room kept for it.
                  t.role === 'user' && 'has-[textarea]:mb-0',
                )}
              >
                <h2 className="sr-only">{t.role === 'user' ? 'Sinä sanoit' : 'Avustaja sanoi'}</h2>
                {t.items.map(({ m, i }) => {
                  const prev = m.role === 'assistant' ? previousUser(messages, i) : undefined;
                  const serverId = serverIdOf(m);
                  return (
                    <div key={m.id} data-message-id={m.id}>
                      <MessageView
                        id={m.id}
                        role={m.role}
                        text={m.text}
                        annotations={m.annotations}
                        attachments={m.attachments}
                        tools={m.tools}
                        latest={i === lastUser || i === lastAssistant}
                        meta={{ createdAt: m.createdAt, usage: usageOf.get(m.id) }}
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
                        // "Muokkaa" forks (phase 13); not while a reply streams.
                        {...(m.role === 'user' && chatId && !stream && !running
                          ? {
                              // Without its entry id (sent before `message.accepted` existed,
                              // or the answer never came) the edit box asks for a reopen.
                              onEdit: (text: string) =>
                                serverId && forkChat(chatId, serverId, text),
                              canFork: !!serverId,
                              forking: !!forking,
                              onNeedIds: () => send({ type: 'chat.open', chatId }),
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
                {last && joinLive && liveView}
              </article>
            );
          })}
          {/* No reply to hold it (the turn failed before any text): on its own. */}
          {!(stream || running) && chipAt < 0 && chip}
          {!stream && !running && related.length > 0 && (
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
          {/* Normally the `subagent` tool row carries it; standalone only before that row exists. */}
          {subagents.length > 0 && !stream?.tools.some((t) => t.name === 'subagent') && (
            <SubagentRow items={subagents} />
          )}
          {(stream || running) && !joinLive && (
            <article className="flex flex-col gap-2">
              <h2 className="sr-only">Avustaja sanoi</h2>
              {liveView}
            </article>
          )}
          {failed && !stream && !running && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive-subtle px-4 py-3 text-body text-foreground"
            >
              <AlertCircle size={16} className="shrink-0 text-destructive" />
              <span className="min-w-0 flex-1">{FAILED_TEXT[failed]}</span>
              <Button variant="outline" size="sm" onClick={() => chatId && retryTurn(chatId)}>
                Yritä uudelleen
              </Button>
            </div>
          )}
          {refused && !stream && !running && (
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
          {!(stream || running) && cards}
        </div>
      </section>
      {/* Prose fades out above the composer instead of ending on a hard cut. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-t from-background"
      />
      {away && (
        // Brief 7.5: 12 px above the composer, centred on the thread column. Dark has no
        // shadow-sm; floating elements take the dark floating shadow there (7.4).
        <Button
          variant="outline"
          onClick={jump}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-card px-4 text-foreground shadow-sm hover:bg-accent dark:shadow-md"
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
