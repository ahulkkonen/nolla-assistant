import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import {
  SEARCH_ENTITY_REASON,
  SEARCH_MAX_RESULTS,
  type SearchCitation,
  type ToolSearch,
  WEB_SEARCH_TOOL,
} from '@pa/protocol';
import { Type } from 'typebox';
import { type Ask, confirm } from './approval.ts';
import { type RecordUsage, rawUsage } from './usage.ts';

/**
 * Web search (docs/decisions/phase-14-search.md). The server runs `web_search` as one non-streaming
 * call to the LiteLLM alias `zdr/search`, whose deployment fixes OpenRouter's web plugin, and
 * returns the plugin's `url_citation` annotations. A query that names a vault entity waits for an
 * approval card first.
 */

/** LiteLLM alias with the web plugin in its deployment (infra/litellm.yaml). */
export const SEARCH_MODEL = 'zdr/search';
/** Searches per chat in any 60 s (decision 12). */
export const SEARCH_PER_MINUTE = 5;
/** Tool errors the model reads (decisions 8, 9, 12). */
export const SEARCH_DENIED =
  'käyttäjä esti haun, koska kysely sisälsi henkilötietoja. Älä hae henkilöillä: hae uudelleen ilman nimiä, tunnisteita ja osoitteita, tai vastaa ilman hakua.';
export const SEARCH_UNATTENDED =
  'ajastettu ajo: kysely sisälsi henkilötietoja, eikä sitä voi hyväksyä ilman käyttäjää. Hae ilman nimiä, tunnisteita ja osoitteita, tai vastaa ilman hakua.';
export const SEARCH_LIMITED = `hakuraja täynnä: enintään ${SEARCH_PER_MINUTE} hakua minuutissa. Vastaa saamillasi tiedoilla.`;
export const SEARCH_FAILED =
  'haku epäonnistui. Vastaa ilman hakua ja kerro, ettei haku onnistunut.';

/** Asks only for the links; the plugin's annotations carry the results (decision 4). */
export const SEARCH_SYSTEM =
  'Listaa jokainen verkkohaun tulos omalle rivilleen muodossa [otsikko](url). Älä kirjoita mitään muuta.';
const SNIPPET_MAX = 600;
const TIMEOUT_MS = 30_000;

export type Citation = SearchCitation & { snippet: string };

const clean = (s: unknown, max: number) =>
  typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** The `url_citation` annotations of a chat completion: http(s) links only, one per URL, in order. */
export function citations(body: unknown): Citation[] {
  const anns = (body as { choices?: { message?: { annotations?: unknown } }[] } | null)
    ?.choices?.[0]?.message?.annotations;
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const a of Array.isArray(anns) ? anns : []) {
    const c = a?.type === 'url_citation' ? a.url_citation : undefined;
    const url = typeof c?.url === 'string' ? c.url.trim() : '';
    if (!/^https?:\/\//i.test(url) || url.length > 2048 || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: clean(c.title, 300) || url.slice(0, 300),
      url,
      snippet: clean(c.content, SNIPPET_MAX),
    });
  }
  return out;
}

/**
 * Runs one search through LiteLLM and writes its `search` usage row. Resolves `'limited'` past
 * `perMinute` searches of a chat in 60 s; throws on a failed call.
 */
export function searcher(o: {
  litellmUrl: string;
  litellmKey: string;
  onUsage?: RecordUsage | undefined;
  perMinute?: number;
  now?: () => number;
}) {
  const { perMinute = SEARCH_PER_MINUTE, now = Date.now } = o;
  // ponytail: in-memory window per process; a restart resets it. Fine for one user.
  const recent = new Map<string, number[]>();
  return async (
    chatId: string,
    agentId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<Citation[] | 'limited'> => {
    const t = now();
    const times = (recent.get(chatId) ?? []).filter((x) => t - x < 60_000);
    if (times.length >= perMinute) return 'limited';
    recent.set(chatId, [...times, t]);
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetch(`${o.litellmUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.litellmKey}` },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        stream: false,
        max_tokens: 600,
        messages: [
          { role: 'system', content: SEARCH_SYSTEM },
          { role: 'user', content: query },
        ],
      }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    // The status only: an error body may echo the query.
    if (!res.ok) throw new Error(`search call status ${res.status}`);
    const body = (await res.json()) as { usage?: unknown };
    o.onUsage?.(
      { kind: 'search', chatId, agentId },
      rawUsage(SEARCH_MODEL, body.usage, o.onUsage.warn),
    );
    return citations(body);
  };
}
export type Searcher = ReturnType<typeof searcher>;

const fail = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  details: undefined,
  isError: true,
});

/**
 * `web_search` and its entity guard (decisions 3 and 7) as two extensions. Load `tool` before
 * `pseudoExtension`: it records the query as the model wrote it (masked). Load `guard` after it:
 * when the restored query differs, the query names a vault entity, and the user decides on an
 * approval card. Automations are always denied (`ask.unattended`).
 */
export function webSearchExtensions(o: {
  chatId: string;
  agentId: string;
  search: Searcher;
  ask: Ask & { unattended?: Map<string, string[]> };
  timeoutMs?: number | undefined;
}): [tool: ExtensionFactory, guard: ExtensionFactory] {
  const sent = new Map<string, unknown>();
  const tool: ExtensionFactory = (pi) => {
    pi.on('tool_call', (event) => {
      if (event.toolName === WEB_SEARCH_TOOL) sent.set(event.toolCallId, event.input.query);
    });
    pi.registerTool({
      name: WEB_SEARCH_TOOL,
      label: WEB_SEARCH_TOOL,
      description:
        'Hakee verkosta ja palauttaa enintään 5 tulosta (otsikko, osoite, ote). Käytä vain asioihin, jotka muuttuvat ajan myötä, tai kun käyttäjä pyytää tarkistamaan. Älä koskaan laita kyselyyn nimiä, henkilötunnuksia, puhelinnumeroita, sähköposteja tai osoitteita. Mainitse vastauksessa käyttämiesi lähteiden osoitteet.',
      parameters: Type.Object({
        query: Type.String({
          minLength: 1,
          maxLength: 500,
          description: 'Hakulause ilman henkilötietoja',
        }),
        maxResults: Type.Optional(
          Type.Integer({ minimum: 1, maximum: SEARCH_MAX_RESULTS, description: 'Oletus 5' }),
        ),
      }),
      async execute(_id, p, signal) {
        // One line: the tool row restores query and titles in one sidecar call (bridge.ts).
        const query = p.query.replace(/\s+/g, ' ').trim();
        let found: Citation[] | 'limited';
        try {
          found = await o.search(o.chatId, o.agentId, query, signal);
        } catch {
          return fail(SEARCH_FAILED);
        }
        if (found === 'limited') return fail(SEARCH_LIMITED);
        const results = found.slice(0, p.maxResults ?? SEARCH_MAX_RESULTS);
        const details: ToolSearch = {
          query,
          results: results.map(({ title, url }) => ({ title, url })),
        };
        const text = results.length
          ? results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n')
          : 'Ei tuloksia.';
        return { content: [{ type: 'text', text }], details };
      },
    });
  };
  const guard: ExtensionFactory = (pi) => {
    pi.on('tool_call', async (event, ctx) => {
      if (event.toolName !== WEB_SEARCH_TOOL) return;
      const masked = sent.get(event.toolCallId);
      sent.delete(event.toolCallId);
      const query = event.input.query;
      if (masked === query) return;
      if (o.ask.unattended?.has(o.chatId)) return { block: true, reason: SEARCH_UNATTENDED };
      return confirm(o.ask, {
        chatId: o.chatId,
        callId: event.toolCallId,
        tool: WEB_SEARCH_TOOL,
        args: { query },
        reason: SEARCH_ENTITY_REASON,
        denied: SEARCH_DENIED,
        timeoutMs: o.timeoutMs,
        signal: ctx.signal,
      });
    });
  };
  return [tool, guard];
}
