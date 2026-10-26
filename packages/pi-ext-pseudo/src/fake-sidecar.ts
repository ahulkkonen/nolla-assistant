import { createServer } from 'node:http';
import { listenLocal } from '@pa/fake-llm';
import type { Collision, Json, VaultEntityRow, VaultPendingRow } from './client.ts';

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

/** Longest suffix of `s` that is a proper prefix of some surrogate (contract `hold`). */
function holdOf(s: string, surrogates: string[]) {
  let best = 0;
  for (const sur of surrogates)
    for (let k = Math.min(sur.length - 1, s.length); k > best; k--)
      if (s.endsWith(sur.slice(0, k))) {
        best = k;
        break;
      }
  return best;
}

const kindOf = (real: string) => (/\d/.test(real) ? 'hetu' : 'person');

type PendingSeed = Omit<VaultPendingRow, 'id' | 'session_id' | 'reason' | 'entity_id'>;

/**
 * Test double for `pseudo-svc` (contract in docs/decisions/phase-3.md). `dictionary` maps real
 * values to surrogates; entity ids are 1-based dictionary positions. Offsets are UTF-16 code units
 * (native JS string indexes), as the contract requires. `passthrough` makes `/mask`
 * return its input unchanged (for seeding a leak); `scanFail` makes `/scan` answer 404. Vault entities appear on their first mask (or
 * seed); `pending` fills the pending lane. `learn` adds every unknown email and `Name Surname`
 * pair seen by `/mask` to the dictionary with a generated surrogate (digits keep surrogates from
 * matching again). `collide` lists texts that `/mask` with `user_input` reports as collisions
 * (phase 12) until the pending row is answered: accept adds the text with a new surrogate, reject
 * leaves it as it is.
 */
export async function startFakeSidecar(
  dictionary: Record<string, string>,
  opts: { pending?: PendingSeed[]; learn?: boolean; collide?: string[] } = {},
) {
  const byLength = (a: Pair, b: Pair) => b.from.length - a.from.length;
  const entries = Object.entries(dictionary);
  const toFake = entries.map(([from, to], i) => ({ from, to, id: i + 1 })).sort(byLength);
  const toReal = entries.map(([to, from], i) => ({ from, to, id: i + 1 })).sort(byLength);
  const requests: { path: string; body: any }[] = [];
  const state = { passthrough: false, scanFail: false };

  // Vault: entities by id, merged ids → target id, ids never to detect again.
  const entities = new Map<number, VaultEntityRow>();
  const mergedInto = new Map<number, number>();
  const ignored = new Set<number>();
  let nextId = entries.length + 1;
  const pending: VaultPendingRow[] = (opts.pending ?? []).map((p, i) => ({
    ...p,
    id: i + 1,
    session_id: '',
    reason: 'uncertain',
    entity_id: null,
  }));
  let nextPending = pending.length + 1;
  /** Collision texts answered so far. */
  const answered = new Set<string>();
  const entity = (kind: string, canonical: string, surrogate: string, id = nextId++) => {
    const e: VaultEntityRow = {
      id,
      kind,
      canonical,
      surrogate,
      mode: 'realistic',
      pinned: false,
      allowlisted: false,
      seen_count: 0,
      last_seen: null,
    };
    entities.set(id, e);
    return e;
  };
  /** The live entity for a dictionary pair, created on first sight. */
  const seen = (pair: Pair) => {
    let id = pair.id;
    while (mergedInto.has(id)) id = mergedInto.get(id) as number;
    const e = entities.get(id) ?? entity(kindOf(pair.from), pair.from, pair.to, id);
    e.seen_count++;
    e.last_seen = new Date().toISOString();
    return e;
  };
  const vault = (path: string, body: any) => {
    const m = /^\/vault\/(entity|pending)\/(\d+)$/.exec(path);
    if (m?.[1] === 'entity') {
      const e = entities.get(Number(m[2]));
      if (!e) return;
      if (body.pinned !== undefined) e.pinned = body.pinned;
      if (body.allowlisted !== undefined) e.allowlisted = body.allowlisted;
      if (body.mode) e.mode = body.mode;
      if (body.regenerate) e.surrogate += ' 2';
      if (body.never_detect) {
        ignored.add(e.id);
        entities.delete(e.id);
      }
      return { entity: e };
    }
    if (m?.[1] === 'pending') {
      const i = pending.findIndex((p) => p.id === Number(m[2]));
      const [p] = i >= 0 ? pending.splice(i, 1) : [];
      if (!p) return;
      if (p.reason === 'collision') {
        answered.add(p.text);
        if (body.action === 'accept') {
          const id = nextId++;
          const to = `Uusi${id} Henkilö${id}`;
          entity(p.kind, p.text, to, id);
          dictionary[p.text] = to;
          toFake.push({ from: p.text, to, id });
          toReal.push({ from: to, to: p.text, id });
          toFake.sort(byLength);
          toReal.sort(byLength);
        }
        return { ok: true };
      }
      if (body.action !== 'dismiss') {
        const e = entity(p.kind, p.text, `[${p.kind} ${nextId}]`);
        e.allowlisted = body.action === 'allowlist';
      }
      return { ok: true };
    }
    switch (path) {
      case '/vault/merge': {
        const into = entities.get(body.into_id);
        if (!into) return;
        for (const id of body.from_ids as number[]) {
          const from = entities.get(id);
          if (!from) continue;
          into.seen_count += from.seen_count;
          entities.delete(id);
          mergedInto.set(id, into.id);
        }
        return { ok: true };
      }
      case '/vault/split': {
        const from = entities.get(body.entity_id);
        if (!from) return;
        return {
          ok: true,
          new_entity_id: entity(from.kind, from.canonical, `${from.surrogate} B`).id,
        };
      }
      case '/vault/seed': {
        const ids = (body.entities as { canonical: string; kind: string }[]).map(
          (s) => entity(s.kind, s.canonical, dictionary[s.canonical] ?? `[${s.kind} ${nextId}]`).id,
        );
        return { ok: true, ids };
      }
    }
  };

  const LEARN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b[A-ZÅÄÖ][a-zåäö]+ [A-ZÅÄÖ][a-zåäö]+\b/g;
  const learn = (v: Json) => {
    const known = new Set([...toFake.map((p) => p.from), ...toReal.map((p) => p.from)]);
    const strings = (x: Json): string[] =>
      typeof x === 'string'
        ? [x]
        : x && typeof x === 'object'
          ? Object.values(x).flatMap(strings)
          : [];
    for (const s of strings(v).flatMap((t) => t.match(LEARN) ?? [])) {
      if (known.has(s)) continue;
      const id = nextId++;
      const to = s.includes('@') ? `henkilo${id}@example.invalid` : `Testi${id} Henkilö${id}`;
      dictionary[s] = to;
      toFake.push({ from: s, to, id });
      toReal.push({ from: to, to: s, id });
      known.add(s).add(to);
    }
    toFake.sort(byLength);
    toReal.sort(byLength);
  };

  const handle = (path: string, body: any) => {
    const hits: Hit[] = [];
    if (path.startsWith('/vault/')) return vault(path, body);
    switch (path) {
      case '/mask': {
        const value: Json = 'text' in body ? body.text : body.json;
        if (body.user_input && typeof value === 'string') {
          const collisions: Collision[] = [];
          for (const text of opts.collide ?? []) {
            if (!value.includes(text) || answered.has(text)) continue;
            const owner = toReal.find((p) => p.from === text)?.id ?? 0;
            let row = pending.find((p) => p.reason === 'collision' && p.text === text);
            if (!row) {
              row = {
                id: nextPending++,
                kind: 'PERSON',
                text,
                detector: 'fake',
                score: 1,
                session_id: body.session_id,
                reason: 'collision',
                entity_id: owner,
              };
              pending.push(row);
            }
            collisions.push({ pending_id: row.id, entity_id: owner, kind: 'PERSON' });
          }
          if (collisions.length) return { masked: '', spans: [], collisions };
        }
        if (opts.learn && !state.passthrough) learn(value);
        const live = toFake.filter((p) => !ignored.has(p.id));
        const masked = state.passthrough ? value : deep(value, live, hits);
        const spans = hits.map(({ start, end, pair }) => ({
          start,
          end,
          entity_id: seen(pair).id,
          kind: kindOf(pair.from),
          surrogate: pair.to,
          real_form: pair.from,
          detector: 'fake',
          score: 1,
          pending: false,
        }));
        return { masked, spans, ...(body.user_input ? { collisions: [] } : {}) };
      }
      case '/unmask': {
        const restored = deep('text' in body ? body.text : body.json, toReal, hits);
        const hold =
          typeof body.text === 'string' ? holdOf(body.text, Object.values(dictionary)) : 0;
        const spans = hits.map(({ start, end, pair }) => ({
          start,
          end,
          entity_id: pair.id,
          surrogate_form: pair.from,
        }));
        return { restored, spans, unresolved: [], hold };
      }
      case '/scan': {
        if (state.scanFail) return;
        const leaked: object[] = [];
        const messages = body.messages.map((m: { role: string; content: Json }, i: number) => {
          const found: Hit[] = [];
          const content = deep(m.content, toFake, found);
          for (const h of found)
            leaked.push({
              message_index: i,
              start: h.start,
              end: h.end,
              kind: kindOf(h.pair.from),
              entity_id: h.pair.id,
            });
          return { ...m, content };
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
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/healthz') return json(200, { ok: true });
    if (req.method === 'GET' && path === '/vault/entities') {
      if (!url.searchParams.get('user_id')) return json(400, { error: 'bad request' });
      requests.push({ path, body: {} });
      return json(200, { entities: [...entities.values()], pending });
    }
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
