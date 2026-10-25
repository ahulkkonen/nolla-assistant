import { createServer } from 'node:http';
import { listenLocal } from '@pa/fake-llm';
import type { Json } from './client.ts';

type Pair = { from: string; to: string; id: number };
type Hit = { start: number; end: number; pair: Pair };

/** One pass, longest match first. Hit offsets are in the output string. */
function replace(s: string, pairs: Pair[]) {
  let out = '';
  const hits: Hit[] = [];
  for (let i = 0; i < s.length; ) {
    const pair = pairs.find((p) => s.startsWith(p.from, i));
    if (!pair) {
      out += s[i++];
      continue;
    }
    hits.push({ start: out.length, end: out.length + pair.to.length, pair });
    out += pair.to;
    i += pair.from.length;
  }
  return { out, hits };
}

/** Applies `replace` to every string in a JSON value; hits keep per-string offsets. */
function deep(v: Json, pairs: Pair[], hits: Hit[]): Json {
  if (typeof v === 'string') {
    const r = replace(v, pairs);
    hits.push(...r.hits);
    return r.out;
  }
  if (Array.isArray(v)) return v.map((x) => deep(x, pairs, hits));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, pairs, hits)]));
  return v;
}

const kindOf = (real: string) => (/\d/.test(real) ? 'hetu' : 'person');

/**
 * Test double for `pseudo-svc` (contract in docs/decisions/phase-3.md). `dictionary` maps real
 * values to surrogates; entity ids are 1-based dictionary positions. `passthrough` makes `/mask`
 * return its input unchanged (for seeding a leak).
 */
export async function startFakeSidecar(dictionary: Record<string, string>) {
  const byLength = (a: Pair, b: Pair) => b.from.length - a.from.length;
  const entries = Object.entries(dictionary);
  const toFake = entries.map(([from, to], i) => ({ from, to, id: i + 1 })).sort(byLength);
  const toReal = entries.map(([to, from], i) => ({ from, to, id: i + 1 })).sort(byLength);
  const requests: { path: string; body: any }[] = [];
  const state = { passthrough: false };

  const handle = (path: string, body: any) => {
    const hits: Hit[] = [];
    switch (path) {
      case '/mask': {
        const value: Json = 'text' in body ? body.text : body.json;
        const masked = state.passthrough ? value : deep(value, toFake, hits);
        const spans = hits.map(({ start, end, pair }) => ({
          start,
          end,
          entity_id: pair.id,
          kind: kindOf(pair.from),
          surrogate: pair.to,
          real_form: pair.from,
          detector: 'fake',
          score: 1,
          pending: false,
        }));
        return { masked, spans };
      }
      case '/unmask': {
        const restored = deep('text' in body ? body.text : body.json, toReal, hits);
        const spans = hits.map(({ start, end, pair }) => ({
          start,
          end,
          entity_id: pair.id,
          surrogate_form: pair.from,
        }));
        return { restored, spans, unresolved: [] };
      }
      case '/scan': {
        const leaked: object[] = [];
        const messages = body.messages.map((m: { role: string; content: string }, i: number) => {
          const r = replace(m.content, toFake);
          for (const h of r.hits)
            leaked.push({
              message_index: i,
              start: h.start,
              end: h.end,
              kind: kindOf(h.pair.from),
              entity_id: h.pair.id,
            });
          return { ...m, content: r.out };
        });
        return { messages, leaked };
      }
    }
  };

  const server = createServer((req, res) => {
    const json = (status: number, obj: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const path = req.url?.split('?')[0] ?? '';
    if (req.method === 'GET' && path === '/healthz') return json(200, { ok: true });
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path, body });
      if (req.method !== 'POST' || typeof body.user_id !== 'string')
        return json(400, { error: 'bad request' });
      const out = handle(path, body);
      return out ? json(200, out) : json(404, { error: 'not found' });
    });
  });

  const { origin, close } = await listenLocal(server);
  return { url: origin, requests, state, close };
}
