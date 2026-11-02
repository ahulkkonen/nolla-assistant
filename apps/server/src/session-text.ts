/**
 * The text of Pi session messages: plain text, thinking, a safe cut, and the masked transcript of
 * a branch. Pure functions over Pi message shapes.
 *
 * Owns no state and calls no service. It must not restore surrogates (restore.ts does) and must
 * not import server modules: the bridge, tools and jobs all read it.
 */
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { stripConfidence } from '@nolla/protocol';

export type AgentMessage = AgentSession['messages'][number];

/**
 * Masked user and assistant texts of the session branch, in order, without confidence markers:
 * the search index, the title job and the claims sweep read them.
 */
export const transcript = (session: Pick<AgentSession, 'sessionManager'>) =>
  session.sessionManager
    .getBranch()
    .flatMap((e) =>
      e.type === 'message' && (e.message.role === 'user' || e.message.role === 'assistant')
        ? [{ id: e.id, role: e.message.role, text: stripConfidence(textOf(e.message)) }]
        : [],
    );

export function textOf(m: AgentMessage): string {
  if (!('content' in m)) return '';
  if (typeof m.content === 'string') return m.content;
  return m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

/** An assistant message's thinking: its non-redacted thinking blocks (phase-13 decision 10). */
export function thinkingOf(m: AgentMessage): string {
  if (m.role !== 'assistant') return '';
  return m.content
    .flatMap((b) => (b.type === 'thinking' && !b.redacted && b.thinking.trim() ? [b.thinking] : []))
    .join('\n\n')
    .trim();
}

/**
 * At most `max` UTF-16 units of `s`: cut at a paragraph break, else at a space or line break, when
 * one is in the last 2,000 units; never inside a surrogate pair. "…" marks a cut.
 */
export function cutText(s: string, max: number): string {
  if (s.length <= max) return s;
  const floor = Math.max(0, max - 2000);
  let at = s.lastIndexOf('\n\n', max);
  if (at <= floor) at = Math.max(s.lastIndexOf(' ', max), s.lastIndexOf('\n', max));
  if (at <= floor) at = max;
  if (isHigh(s.charCodeAt(at - 1))) at--;
  return `${s.slice(0, at)}…`;
}

export const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
export const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
