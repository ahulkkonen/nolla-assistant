import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { toolText as text } from '@pa/pi-ext-memory';
import { FETCH_URL_TOOL } from '@pa/protocol';
import { isPrivate, publicLookup } from '@pa/sandbox-broker/net';
import { Type } from 'typebox';
import { type Ask, callKey, DENIED_REASON, UNATTENDED_REASON } from './approval.ts';
import { capped } from './fx.ts';
import { guardConfirm, type maskedArgs, toolGuard, untrusted } from './search-tool.ts';
import { cutText, textOf } from './session-text.ts';

/**
 * `fetch_url` (docs/decisions/phase-25-harness-tools.md, decisions 20 to 23): one GET of a public
 * http(s) page, no body, no cookie, no file, no shell. Every error is fixed text.
 */

const MAX_URL = 2048;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
const TEXT_MAX = 20_000;
const TEXT_TYPES = /^(text\/[\w.+-]+|application\/json|application\/xhtml\+xml)$/;

export const BAD_URL = 'Osoite ei kelpaa: vain http- tai https-osoite porttiin 80 tai 443.';
export const NOT_PUBLIC = 'Osoite ei ole julkinen.';
export const TOO_MANY_REDIRECTS = 'Liian monta uudelleenohjausta.';
export const TOO_LARGE = 'Sivu on liian suuri (yli 2 Mt).';
export const NOT_TEXT = 'Sivu ei ole tekstiä.';
const TIMED_OUT = 'Sivun haku aikakatkaistiin.';
const FAILED = 'Sivun haku epäonnistui.';
/** Approval card reasons of the guard (decision 22). */
export const FETCH_ENTITY_REASON = 'Osoite sisältää henkilötiedon';
export const FETCH_UNLISTED_REASON = 'Osoite ei ole viestissäsi';
/** Holds `DENIED_REASON`, so the tool row says "estetty". */
export const FETCH_DENIED = `${DENIED_REASON}. Älä hae samaa osoitetta uudelleen; vastaa ilman sivua.`;

/** The URL, or a fixed error: http(s), ports 80 and 443, no user info, an IP literal checked. */
function checked(raw: string): URL | string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return BAD_URL;
  }
  if (
    raw.length > MAX_URL ||
    (u.protocol !== 'http:' && u.protocol !== 'https:') ||
    (u.port !== '' && u.port !== '80' && u.port !== '443') ||
    u.username ||
    u.password
  )
    return BAD_URL;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // A name goes through `publicLookup`; Node never looks up an IP literal.
  return /^[\d.]+$|:/.test(host) && isPrivate(host) ? NOT_PUBLIC : u;
}

export type FetchOptions = {
  signal?: AbortSignal | undefined;
  /** Test seams: the resolver and the TCP port actually connected. */
  lookup?: LookupFunction;
  connectPort?: number;
};

function get(u: URL, o: FetchOptions, signal: AbortSignal) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request(
      {
        protocol: u.protocol,
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: o.connectPort ?? (u.port || (u.protocol === 'https:' ? 443 : 80)),
        path: u.pathname + u.search,
        method: 'GET',
        headers: { host: u.host, 'user-agent': 'pa-server', accept: 'text/html,text/plain,*/*' },
        lookup: o.lookup ?? publicLookup,
        agent: false,
        signal,
      },
      resolve,
    );
    req.on('error', reject);
    req.end();
  });
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
const RAW = /(script|style|noscript|template|svg)\b/iy;
const BLOCK = /\/?(br|p|div|li|tr|h[1-6]|section|article|header|footer|ul|ol|table)\b/iy;
const at = (re: RegExp, s: string, i: number) => {
  re.lastIndex = i;
  return re.exec(s);
};

/**
 * Tags, comments and raw-text elements out, in one pass with an index (no backtracking regex:
 * a hostile page of `<` or unterminated `<script` stays linear). An unterminated comment or
 * raw-text element drops the rest; a `<` with no `>` after it stays text.
 */
function stripTags(html: string) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    out += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) return out;
      out += ' ';
      i = end + 3;
      continue;
    }
    const raw = at(RAW, html, lt + 1);
    if (raw) {
      const close = new RegExp(`</${raw[1]}\\s*>`, 'gi');
      close.lastIndex = lt + 1;
      if (!close.exec(html)) return `${out} `;
      out += ' ';
      i = close.lastIndex;
      continue;
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) return out + html.slice(lt);
    out += at(BLOCK, html, lt + 1) ? '\n' : ' ';
    i = gt + 1;
  }
  return out + html.slice(i);
}

/**
 * HTML as text: scripts, styles and tags out, entities decoded, white space collapsed. The input
 * is cut to the body cap first. ponytail: no article extraction; pages that build their text in
 * scripts give little text.
 */
export const htmlText = (html: string) =>
  stripTags(html.slice(0, FETCH_MAX_BYTES))
    .replace(/&(#x[\da-f]{1,8}|#\d{1,8}|[a-z]{1,32});/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const n = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n\s*/g, '\n')
    .trim();

/** One page as text, or a fixed error. Each redirect is checked again; at most 3. */
export async function fetchPage(
  raw: string,
  o: FetchOptions = {},
): Promise<{ text: string } | { error: string }> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = o.signal ? AbortSignal.any([timeout, o.signal]) : timeout;
  let url = raw;
  for (let hop = 0; ; hop++) {
    const u = checked(url);
    if (typeof u === 'string') return { error: u };
    let res: IncomingMessage;
    try {
      res = await get(u, o, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') return { error: NOT_PUBLIC };
      return { error: timeout.aborted ? TIMED_OUT : FAILED };
    }
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.destroy();
      if (hop >= MAX_REDIRECTS) return { error: TOO_MANY_REDIRECTS };
      try {
        url = new URL(location, u).href;
      } catch {
        return { error: BAD_URL };
      }
      continue;
    }
    if (status < 200 || status >= 300) {
      res.destroy();
      return { error: `Sivu vastasi tilakoodilla ${status}.` };
    }
    const type = String(res.headers['content-type'] ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase();
    if (!type || !TEXT_TYPES.test(type)) {
      res.destroy();
      return { error: NOT_TEXT };
    }
    let body: string;
    try {
      body = await capped(new Response(Readable.toWeb(res) as ReadableStream), FETCH_MAX_BYTES);
    } catch (err) {
      res.destroy();
      if (err instanceof Error && err.name === 'ResponseTooLarge') return { error: TOO_LARGE };
      return { error: timeout.aborted ? TIMED_OUT : FAILED };
    }
    return { text: /html/.test(type) ? htmlText(body) : body.trim() };
  }
}

/**
 * True when `url` is a whole white-space token of `t`, with
 * trailing `.,;:)]` and one trailing slash cut from both: a prefix of a URL the user wrote does not count.
 */
export const saidIn = (t: string, url: string) => {
  const bare = url.replace(/\/$/, '');
  return t.split(/\s+/).some((w) => w.replace(/[.,;:)\]]+$/, '').replace(/\/$/, '') === bare);
};

/**
 * `fetch_url` and its guard (decision 22). Load `tool` anywhere and `guard` after
 * `pseudoExtension`: a restored URL that differs from the masked one names a vault entity, and a
 * URL that no user message of the branch holds came from a page or a result. Both ask; an
 * unattended chat blocks both. The chat's auto-approve toggle never covers this card, as for the
 * `web_search` entity card.
 */
export function fetchExtensions(o: {
  chatId: string;
  ask: Ask & { unattended?: Map<string, string[]> };
  masked: ReturnType<typeof maskedArgs>;
  timeoutMs?: number | undefined;
  /** Call ids this guard approved; `approvalGate` skips them. */
  approved?: Set<string> | undefined;
  fetch?: typeof fetchPage;
}): [tool: ExtensionFactory, guard: ExtensionFactory] {
  const fetch = o.fetch ?? fetchPage;
  const tool: ExtensionFactory = (pi) => {
    pi.on('tool_execution_end', (e) => void o.approved?.delete(callKey(e.toolName, e.toolCallId)));
    pi.registerTool({
      name: FETCH_URL_TOOL,
      label: FETCH_URL_TOOL,
      description:
        'Hakee yhden julkisen verkkosivun (http tai https) tekstinä, enintään 20 000 merkkiä. Hae vain osoite, jonka käyttäjä antoi.',
      parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: MAX_URL }) }),
      async execute(_id, p, signal) {
        const r = await fetch(p.url, { signal });
        if ('error' in r) return text(r.error, true);
        return text(untrusted('sivu', cutText(r.text, TEXT_MAX) || '(tyhjä sivu)'));
      },
    });
  };
  const guard = toolGuard(FETCH_URL_TOOL, async (event, ctx) => {
    const url = String(event.input.url ?? '');
    const masked = o.masked.sent.get(callKey(FETCH_URL_TOOL, event.toolCallId)) ?? url;
    const said = (t: string) => typeof masked === 'string' && saidIn(t, masked);
    const fromUser = ctx.sessionManager
      .getBranch()
      .some((e) => e.type === 'message' && e.message.role === 'user' && said(textOf(e.message)));
    const reason =
      masked !== url ? FETCH_ENTITY_REASON : fromUser ? undefined : FETCH_UNLISTED_REASON;
    if (!reason) return;
    if (o.ask.unattended?.has(o.chatId)) return { block: true, reason: UNATTENDED_REASON };
    return guardConfirm(o, event.toolCallId, ctx.signal, {
      tool: FETCH_URL_TOOL,
      args: { url },
      reason,
      ...(url.length <= MAX_URL && /^https?:\/\//i.test(url)
        ? { view: { kind: 'fetch' as const, url } }
        : {}),
      denied: FETCH_DENIED,
    });
  });
  return [tool, guard];
}
