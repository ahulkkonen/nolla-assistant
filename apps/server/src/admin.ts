import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { automationRuns, chats, type Db } from '@pa/db';
import {
  type AgentDoc,
  AgentFile,
  type AgentList,
  AgentSave,
  AutomationSave,
  CronPreview,
  DEFAULT_AGENT_ID,
  type ServerMessage,
} from '@pa/protocol';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import { type Document, isMap, parseDocument, visit } from 'yaml';
import { ZodError } from 'zod';
import { type Agents, unruled } from './agents.ts';
import { AutomationFile, type Automations, loadAutomations, nextRuns } from './automations.ts';
import { slug } from './export.ts';
import { gitCommitter, writeAtomic } from './git.ts';
import type { Catalog } from './pi/models.ts';
import { PROFILE_TOOLS, type SessionRegistry } from './pi/registry.ts';
import { alias, aliasList } from './usage.ts';

// Agent and automation editors (docs/decisions/phase-15-admin.md, decisions 1 to 10).

const AGENT_ID = /^[a-z0-9-]{1,64}$/;
const AUTOMATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The editor's shortest gap between two automation runs (decision 9). */
const MIN_GAP_MS = 5 * 60_000;

export type AdminDeps = {
  db: Db;
  dataDir: string;
  agentsDir: string;
  automationsDir: string;
  skillsDir: string;
  /** The servers of `infra/mcp.yaml`. */
  mcpNames: string[];
  catalog: Pick<Catalog, 'get'>;
  registry: Pick<SessionRegistry, 'running'>;
  agents: () => Agents;
  /** The watcher's reload: new profiles in, `agents.state` to every socket. */
  reloadAgents: () => void;
  automations: () => Automations | undefined;
  sendAll: (msg: ServerMessage) => void;
  warn: (msg: string, data?: object) => void;
};

/** A failed check: HTTP 400 `{ error: 'bad_message', path, message }` (decision 2). */
class Bad extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}
const fromZod = (err: ZodError) => {
  const issue = err.issues[0];
  return new Bad(issue?.path.join('.') ?? '', issue?.message ?? 'invalid');
};
/** `fn` with a zod error or a `Bad` as a 400 answer. */
async function checked(reply: FastifyReply, fn: () => Promise<unknown> | unknown) {
  try {
    return await fn();
  } catch (err) {
    const e = err instanceof ZodError ? fromZod(err) : err;
    if (!(e instanceof Bad)) throw err;
    return reply.code(400).send({ error: 'bad_message', path: e.path, message: e.message });
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const readIf = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
/** A text file ends with a newline. */
const writeText = (path: string, text: string) =>
  writeAtomic(path, text.endsWith('\n') ? text : `${text}\n`);

function yamlOf(text: string): Document {
  const doc = parseDocument(text);
  const err = doc.errors[0];
  if (err) throw new Bad('', err.message);
  return doc;
}

/** The document as plain data; an alias bomb (yaml's alias count limit) is a 400, not a 500. */
function js(doc: Document): unknown {
  try {
    return doc.toJS();
  } catch (err) {
    throw new Bad('', err instanceof Error ? err.message : 'invalid YAML');
  }
}

/**
 * The editor's cron rules (decision 9): five fields (no seconds) and at least 5 minutes between
 * runs, checked over the next 20 runs. Hand-written files may still use other forms.
 */
function editorCron(expression: string, timezone: string) {
  if (expression.trim().split(/\s+/).length !== 5)
    throw new Bad('cron', 'use five fields: minute hour day month weekday');
  const runs = nextRuns(expression, timezone, 20).map((r) => Date.parse(r));
  if (runs.some((t, i) => i > 0 && t - (runs[i - 1] ?? 0) < MIN_GAP_MS))
    throw new Bad('cron', 'runs must be at least 5 minutes apart');
}

/** Sets `value` at `path` with lists in flow style, as the shipped files write them. */
function setIn(doc: Document, path: string[], value: unknown) {
  const node = doc.createNode(value);
  visit(node, {
    Seq(_, seq) {
      seq.flow = true;
    },
  });
  if (path.length) doc.setIn(path, node);
  else doc.contents = node as Document['contents'];
}

/**
 * Writes `next` into `doc` key by key (decision 6): a key the form sends changes, a key sent as
 * null goes, and every other key (skills, timezone, a comment) stays as it is.
 */
function merge(doc: Document, path: string[], cur: unknown, next: unknown) {
  if (!isObj(next)) {
    if (!isDeepStrictEqual(cur, next)) setIn(doc, path, next);
    return;
  }
  const here = path.length ? doc.getIn(path, true) : doc.contents;
  const old = isObj(cur) && isMap(here) ? cur : {};
  if (old !== cur) setIn(doc, path, {});
  for (const [k, v] of Object.entries(next))
    if (v === null) doc.deleteIn([...path, k]);
    else merge(doc, [...path, k], old[k], v);
}

/** The existing file with the form's fields merged in; a broken file starts over. */
function mergedDoc(existing: string | undefined, fields: Record<string, unknown>): Document {
  const old = parseDocument(existing ?? '');
  const doc = old.errors.length ? parseDocument('') : old;
  try {
    merge(doc, [], js(doc), fields);
  } catch (err) {
    if (err instanceof Bad) throw err;
    throw new Bad('', err instanceof Error ? err.message : 'invalid fields');
  }
  return doc;
}

/** An id from `name` that `taken` does not hold: ASCII words joined by `-`, then `-2`, `-3` … */
export function freeId(name: unknown, taken: (id: string) => boolean, fallback: string) {
  const base = slug(typeof name === 'string' ? name : '', 56) || fallback;
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

export function adminRoutes(app: FastifyInstance, auth: preHandlerHookHandler, deps: AdminDeps) {
  const { db, dataDir, agentsDir, automationsDir, registry, catalog, sendAll } = deps;
  // Git only for folders under DATA_DIR; in development the repository tracks `agents/` (decision 4).
  const committer = (dir: string, what: string) =>
    resolve(dir).startsWith(resolve(dataDir) + sep) ? gitCommitter(dir, deps.warn, what) : () => {};
  const commitAgents = committer(agentsDir, 'agent profiles');
  const commitAutomations = committer(automationsDir, 'automations');
  const agentFile = (id: string) => join(agentsDir, `${id}.yaml`);
  const autoFile = (id: string) => join(automationsDir, `${id}.yaml`);
  const yamlIds = (dir: string) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.yaml'))
          .sort()
          .map((f) => basename(f, '.yaml'))
      : [];

  /**
   * The current text (undefined for a create) and the id of a save; null when `id` has no file.
   * A create without an id gets one from the name (decision 5).
   */
  const saveTarget = (
    file: (id: string) => string,
    id: string | undefined,
    fields: Record<string, unknown>,
    fallback: string,
    alsoTaken: (id: string) => boolean = () => false,
  ) => {
    const existing = id === undefined ? undefined : readIf(file(id));
    if (id !== undefined && existing === undefined) return null;
    if (id !== undefined && fields.id !== undefined && fields.id !== id)
      throw new Bad('id', 'the id cannot change');
    const to =
      id ??
      (typeof fields.id === 'string'
        ? fields.id
        : freeId(fields.name, (x) => existsSync(file(x)) || alsoTaken(x), fallback));
    return { existing, to };
  };

  /** The prompt file of `rel`: a `.md` under `prompts/`, also after symlinks. */
  const promptPath = (rel: string) => {
    const abs = resolve(agentsDir, rel);
    const base = realpathSync(resolve(agentsDir, 'prompts')) + sep;
    const real = existsSync(abs)
      ? realpathSync(abs)
      : join(realpathSync(dirname(abs)), basename(abs));
    if (!real.startsWith(base) || !real.endsWith('.md'))
      throw new Bad('prompt', 'prompt must be a .md file under prompts/');
    return abs;
  };
  /** The `prompt` path a file names; '' when it names none or does not parse. */
  const promptOf = (text: string | undefined) => {
    try {
      const v = js(parseDocument(text ?? ''));
      return isObj(v) && typeof v.prompt === 'string' ? v.prompt : '';
    } catch {
      return '';
    }
  };
  /** Another profile than `except` names the prompt file `rel`. */
  const promptUsed = (rel: string, except?: string) =>
    yamlIds(agentsDir).some((o) => o !== except && promptOf(readIf(agentFile(o))) === rel);

  const agentDoc = (id: string): AgentDoc => {
    const yaml = readFileSync(agentFile(id), 'utf8');
    try {
      const profile = AgentFile.parse(js(yamlOf(yaml)));
      if (profile.id !== id) throw new Bad('id', `id ${profile.id} does not match the file name`);
      return {
        id,
        profile,
        yaml,
        prompt: readFileSync(promptPath(profile.prompt), 'utf8'),
        error: null,
      };
    } catch (err) {
      const e = err instanceof ZodError ? fromZod(err) : err;
      const where = e instanceof Bad && e.path ? `${e.path}: ` : '';
      return { id, profile: null, yaml, prompt: '', error: `${where}${(e as Error).message}` };
    }
  };

  /** The model is an alias of `infra/models.json` or a ZDR catalog model (decision 3). */
  const knownModel = (model: string) => {
    const id = model.slice('zdr/'.length);
    return id.includes('/') ? !!catalog.get(id)?.zdr : !!alias(model);
  };

  app.get('/api/agents', { preHandler: auth }, async (): Promise<AgentList> => {
    const skills = existsSync(deps.skillsDir)
      ? readdirSync(deps.skillsDir)
          .filter((d) => existsSync(join(deps.skillsDir, d, 'SKILL.md')))
          .sort()
      : [];
    return {
      defaultId: DEFAULT_AGENT_ID,
      agents: yamlIds(agentsDir).map(agentDoc),
      options: {
        tools: PROFILE_TOOLS,
        mcp: deps.mcpNames,
        skills,
        aliases: aliasList().map(({ id, name }) => ({ id, name })),
      },
    };
  });

  /** Create (`id` undefined) or update; `?dry=1` checks and answers without a write (decision 6). */
  const saveAgent = async (
    reply: FastifyReply,
    id: string | undefined,
    rawBody: unknown,
    dry: boolean,
  ) => {
    const body = AgentSave.parse(rawBody);
    const input = 'yaml' in body ? yamlOf(body.yaml) : undefined;
    const fields: unknown = input ? js(input) : 'profile' in body ? body.profile : undefined;
    if (!isObj(fields)) throw new Bad('', 'expected a mapping');
    // A derived id never takes a prompt file that another profile uses (decision 5).
    const at = saveTarget(agentFile, id, fields, 'agentti', (x) => promptUsed(`prompts/${x}.md`));
    if (!at) return reply.code(404).send({ error: 'not_found' });
    const { existing, to: target } = at;
    // The server fixes the prompt path (decision 4).
    const path =
      existing === undefined
        ? `prompts/${target}.md`
        : promptOf(existing) || `prompts/${target}.md`;
    if (existing !== undefined && fields.prompt !== undefined && fields.prompt !== path)
      throw new Bad('prompt', `the prompt file is ${path}`);
    let doc: Document;
    // The YAML tab's text is written as sent unless the server fixed the id or the prompt path.
    let asSent = !!input;
    if (input) {
      doc = input;
      for (const [k, v] of [
        ['id', target],
        ['prompt', path],
      ])
        if (doc.get(k) !== v) {
          doc.set(k, v);
          asSent = false;
        }
    } else doc = mergedDoc(existing, { id: target, ...fields, prompt: path });
    const profile = AgentFile.parse(js(doc));
    if (!AGENT_ID.test(target)) throw new Bad('id', 'invalid id');
    const unknown = profile.tools.allow.findIndex((t) => !PROFILE_TOOLS.includes(t));
    if (unknown >= 0)
      throw new Bad(`tools.allow.${unknown}`, `unknown tool ${profile.tools.allow[unknown]}`);
    if (!knownModel(profile.model)) throw new Bad('model', `unknown model ${profile.model}`);
    const missing = unruled(profile);
    if (missing.length) throw new Bad('approval', `tool ${missing[0]} has no approval rule`);
    const promptFile = promptPath(path);
    if (
      id === undefined &&
      (existsSync(agentFile(target)) || (existsSync(promptFile) && promptUsed(path)))
    )
      return reply.code(409).send({ error: 'exists' });
    const yaml = asSent && 'yaml' in body ? body.yaml : String(doc);
    if (!dry) {
      // Prompt first: a profile never names a prompt file that is not there yet.
      writeText(promptFile, body.prompt);
      writeText(agentFile(target), yaml);
      deps.reloadAgents();
      commitAgents(`agent ${target} saved`);
    }
    const doc_: AgentDoc = { id: target, profile, yaml, prompt: body.prompt, error: null };
    return reply.code(id === undefined && !dry ? 201 : 200).send(doc_);
  };

  app.post<{ Querystring: { dry?: string } }>(
    '/api/agents',
    { preHandler: auth },
    async (req, reply) =>
      checked(reply, () => saveAgent(reply, undefined, req.body, req.query.dry === '1')),
  );
  app.put<{ Params: { id: string }; Querystring: { dry?: string } }>(
    '/api/agents/:id',
    { preHandler: auth },
    async (req, reply) => {
      if (!AGENT_ID.test(req.params.id)) return reply.code(404).send({ error: 'not_found' });
      return checked(reply, () => saveAgent(reply, req.params.id, req.body, req.query.dry === '1'));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/agents/:id',
    { preHandler: auth },
    async (req, reply) => {
      const { id } = req.params;
      if (!AGENT_ID.test(id) || !existsSync(agentFile(id)))
        return reply.code(404).send({ error: 'not_found' });
      if (id === DEFAULT_AGENT_ID) return reply.code(409).send({ error: 'default_agent' });
      const own = and(eq(chats.userId, req.userId), eq(chats.agentId, id));
      const running = db
        .select({ id: chats.id })
        .from(chats)
        .where(own)
        .all()
        .filter((c) => registry.running(c.id)).length;
      if (running) return reply.code(409).send({ error: 'in_use', chats: running });
      const automations = loadAutomations(automationsDir)
        .filter((a) => a.agentId === id)
        .map((a) => a.id);
      if (automations.length) return reply.code(409).send({ error: 'in_use', automations });
      const rel = promptOf(readFileSync(agentFile(id), 'utf8'));
      rmSync(agentFile(id));
      if (rel && !promptUsed(rel)) {
        try {
          rmSync(promptPath(rel), { force: true });
        } catch {
          // A path outside prompts/ is never deleted.
        }
      }
      // Its chats stay readable with the default agent (decision 5).
      db.update(chats).set({ agentId: DEFAULT_AGENT_ID }).where(own).run();
      deps.reloadAgents();
      commitAgents(`agent ${id} deleted`);
      return reply.code(204).send();
    },
  );

  const automationsChanged = (note: string) => {
    deps.automations()?.reload();
    commitAutomations(note);
    const state = deps.automations()?.state();
    if (state) sendAll(state);
  };

  const saveAutomation = (reply: FastifyReply, id: string | undefined, rawBody: unknown) => {
    const fields = AutomationSave.parse(rawBody);
    const at = saveTarget(autoFile, id, fields, 'automaatio');
    if (!at) return reply.code(404).send({ error: 'not_found' });
    // Only the file's own keys: a client may send a whole `automations.state` item back.
    const own = Object.entries(fields).filter(([k]) => k in AutomationFile.shape);
    const doc = mergedDoc(at.existing, { id: at.to, ...Object.fromEntries(own) });
    const a = AutomationFile.parse(js(doc));
    // A hand-written file keeps its cron until the form changes it.
    const before = at.existing === undefined ? undefined : js(parseDocument(at.existing));
    if (!isObj(before) || before.cron !== a.cron) editorCron(a.cron, a.timezone);
    if (!deps.agents().has(a.agentId)) throw new Bad('agentId', `unknown agent ${a.agentId}`);
    if (id === undefined && existsSync(autoFile(a.id)))
      return reply.code(409).send({ error: 'exists' });
    writeText(autoFile(a.id), String(doc));
    automationsChanged(`automation ${a.id} saved`);
    return reply.code(id === undefined ? 201 : 200).send({ id: a.id });
  };

  app.post('/api/automations', { preHandler: auth }, async (req, reply) =>
    checked(reply, () => saveAutomation(reply, undefined, req.body)),
  );
  app.put<{ Params: { id: string } }>(
    '/api/automations/:id',
    { preHandler: auth },
    async (req, reply) => {
      if (!AUTOMATION_ID.test(req.params.id)) return reply.code(404).send({ error: 'not_found' });
      return checked(reply, () => saveAutomation(reply, req.params.id, req.body));
    },
  );
  app.delete<{ Params: { id: string } }>(
    '/api/automations/:id',
    { preHandler: auth },
    async (req, reply) => {
      const { id } = req.params;
      if (!AUTOMATION_ID.test(id) || !existsSync(autoFile(id)))
        return reply.code(404).send({ error: 'not_found' });
      rmSync(autoFile(id));
      db.delete(automationRuns)
        .where(and(eq(automationRuns.id, id), eq(automationRuns.userId, req.userId)))
        .run();
      automationsChanged(`automation ${id} deleted`);
      return reply.code(204).send();
    },
  );

  // Next runs from node-cron itself (decision 9).
  app.post('/api/automations/preview', { preHandler: auth }, async (req, reply) =>
    checked(reply, () => {
      const q = CronPreview.parse(req.body);
      const { cron, timezone } = AutomationFile.pick({ cron: true, timezone: true }).parse(q);
      editorCron(cron, timezone);
      return { runs: nextRuns(cron, timezone) };
    }),
  );
}
