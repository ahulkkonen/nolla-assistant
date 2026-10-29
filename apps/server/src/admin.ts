import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { automationRuns, chats, type Db } from '@pa/db';
import {
  type AgentDoc,
  AgentFile,
  type AgentList,
  AgentSave,
  AutomationSave,
  CronPreview,
  DEFAULT_AGENT_ID,
  ModeBody,
  type ModeDoc,
  ModeFile,
  ModeId,
  ModeSave,
  type ServerMessage,
} from '@pa/protocol';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import { type Document, isMap, parseDocument, stringify, visit } from 'yaml';
import { ZodError } from 'zod';
import { type Agents, unruled } from './agents.ts';
import { AutomationFile, type Automations, loadAutomations, nextRuns } from './automations.ts';
import { slug } from './export.ts';
import { gitCommitter, writeAtomic } from './git.ts';
import { type Modes, modesDir, parseMode } from './modes.ts';
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
  /** Loaded output modes (phase 23): `modes.default` may name only these. */
  modes: () => Modes;
  /** The watcher's reload: new profiles and modes in, `agents.state` to every socket. */
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
/** A YAML error in a raw mode file is the client's (`raw`), not a 500. */
const rawMode = (raw: string) => {
  try {
    return parseFrontmatter(raw);
  } catch (err) {
    throw new Bad('raw', err instanceof Error ? err.message : String(err));
  }
};

const fromZod = (err: ZodError) => {
  const issue = err.issues[0];
  return new Bad(issue?.path.join('.') ?? '', issue?.message ?? 'invalid');
};
/** A file's check failure as one line: `path: message`. */
const errorText = (err: unknown) => {
  const e = err instanceof ZodError ? fromZod(err) : err;
  const where = e instanceof Bad && e.path ? `${e.path}: ` : '';
  return `${where}${e instanceof Error ? e.message : String(e)}`;
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
export function freeId(name: unknown, taken: (id: string) => boolean, fallback: string, max = 56) {
  const base = slug(typeof name === 'string' ? name : '', max) || fallback;
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

/** Writes the editors and phase 25 share; each check failure throws `Bad` (a zod error too). */
type Answer = { status: number; body?: unknown };
const notFound: Answer = { status: 404, body: { error: 'not_found' } };

const yamlIds = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.yaml'))
        .sort()
        .map((f) => basename(f, '.yaml'))
    : [];
/** The `prompt` path a file names; '' when it names none or does not parse. */
const promptOf = (text: string | undefined) => {
  try {
    const v = js(parseDocument(text ?? ''));
    return isObj(v) && typeof v.prompt === 'string' ? v.prompt : '';
  } catch {
    return '';
  }
};
/** The prompt file of `rel`: a `.md` under `prompts/`, also after symlinks. */
const promptPath = (agentsDir: string, rel: string) => {
  const abs = resolve(agentsDir, rel);
  const base = realpathSync(resolve(agentsDir, 'prompts')) + sep;
  const real = existsSync(abs)
    ? realpathSync(abs)
    : join(realpathSync(dirname(abs)), basename(abs));
  if (!real.startsWith(base) || !real.endsWith('.md'))
    throw new Bad('prompt', 'prompt must be a .md file under prompts/');
  return abs;
};
/** A mode file as the form writes it: the frontmatter, a blank line, the paragraph. */
const modeText = (file: ModeFile, body: string) => `---\n${stringify(file)}---\n\n${body}\n`;

/**
 * The editors' writes (phase-23 decision 12): the routes below and the phase-25 tools call these,
 * so every check and write exists once. Each returns the HTTP status and body or throws `Bad`.
 */
export function adminWriters(deps: AdminDeps) {
  const { db, dataDir, agentsDir, automationsDir, registry, catalog, sendAll } = deps;
  // Git only for folders under DATA_DIR; in development the repository tracks `agents/` (decision 4).
  const committer = (dir: string, what: string) =>
    resolve(dir).startsWith(resolve(dataDir) + sep) ? gitCommitter(dir, deps.warn, what) : () => {};
  // Mode files are under `agentsDir`: this commit versions them too.
  const commitAgents = committer(agentsDir, 'agent profiles');
  const commitAutomations = committer(automationsDir, 'automations');
  const agentFile = (id: string) => join(agentsDir, `${id}.yaml`);
  const autoFile = (id: string) => join(automationsDir, `${id}.yaml`);
  const modeFile = (id: string) => join(modesDir(agentsDir), `${id}.md`);

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

  /** Another profile than `except` names the prompt file `rel`. */
  const promptUsed = (rel: string, except?: string) =>
    yamlIds(agentsDir).some((o) => o !== except && promptOf(readIf(agentFile(o))) === rel);

  /** The model is an alias of `infra/models.json` or a ZDR catalog model (decision 3). */
  const knownModel = (model: string) => {
    const id = model.slice('zdr/'.length);
    return id.includes('/') ? !!catalog.get(id)?.zdr : !!alias(model);
  };

  /** Create (`id` undefined) or update; `dry` checks and answers without a write (decision 6). */
  const saveAgent = (id: string | undefined, rawBody: unknown, dry: boolean): Answer => {
    const body = AgentSave.parse(rawBody);
    const input = 'yaml' in body ? yamlOf(body.yaml) : undefined;
    const fields: unknown = input ? js(input) : 'profile' in body ? body.profile : undefined;
    if (!isObj(fields)) throw new Bad('', 'expected a mapping');
    // A derived id never takes a prompt file that another profile uses (decision 5).
    const at = saveTarget(agentFile, id, fields, 'agentti', (x) => promptUsed(`prompts/${x}.md`));
    if (!at) return notFound;
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
    // Phase-23 decision 3: the editor refuses an unknown mode; the loader only warns.
    const mode = profile.modes.default.findIndex((m) => !deps.modes().has(m));
    if (mode >= 0)
      throw new Bad(`modes.default.${mode}`, `unknown mode ${profile.modes.default[mode]}`);
    const promptFile = promptPath(agentsDir, path);
    if (
      id === undefined &&
      (existsSync(agentFile(target)) || (existsSync(promptFile) && promptUsed(path)))
    )
      return { status: 409, body: { error: 'exists' } };
    const yaml = asSent && 'yaml' in body ? body.yaml : String(doc);
    if (!dry) {
      // Prompt first: a profile never names a prompt file that is not there yet.
      writeText(promptFile, body.prompt);
      writeText(agentFile(target), yaml);
      deps.reloadAgents();
      commitAgents(`agent ${target} saved`);
    }
    const doc_: AgentDoc = { id: target, profile, yaml, prompt: body.prompt, error: null };
    return { status: id === undefined && !dry ? 201 : 200, body: doc_ };
  };

  const deleteAgent = (id: string, userId: string): Answer => {
    if (!AGENT_ID.test(id) || !existsSync(agentFile(id))) return notFound;
    if (id === DEFAULT_AGENT_ID) return { status: 409, body: { error: 'default_agent' } };
    const own = and(eq(chats.userId, userId), eq(chats.agentId, id));
    const running = db
      .select({ id: chats.id })
      .from(chats)
      .where(own)
      .all()
      .filter((c) => registry.running(c.id)).length;
    if (running) return { status: 409, body: { error: 'in_use', chats: running } };
    const automations = loadAutomations(automationsDir)
      .filter((a) => a.agentId === id)
      .map((a) => a.id);
    if (automations.length) return { status: 409, body: { error: 'in_use', automations } };
    const rel = promptOf(readFileSync(agentFile(id), 'utf8'));
    rmSync(agentFile(id));
    if (rel && !promptUsed(rel)) {
      try {
        rmSync(promptPath(agentsDir, rel), { force: true });
      } catch {
        // A path outside prompts/ is never deleted.
      }
    }
    // Its chats stay readable with the default agent (decision 5).
    db.update(chats).set({ agentId: DEFAULT_AGENT_ID }).where(own).run();
    deps.reloadAgents();
    commitAgents(`agent ${id} deleted`);
    return { status: 204 };
  };

  const automationsChanged = (note: string) => {
    deps.automations()?.reload();
    commitAutomations(note);
    const state = deps.automations()?.state();
    if (state) sendAll(state);
  };

  const saveAutomation = (id: string | undefined, rawBody: unknown): Answer => {
    const fields = AutomationSave.parse(rawBody);
    const at = saveTarget(autoFile, id, fields, 'automaatio');
    if (!at) return notFound;
    // Only the file's own keys: a client may send a whole `automations.state` item back.
    const own = Object.entries(fields).filter(([k]) => k in AutomationFile.shape);
    const doc = mergedDoc(at.existing, { id: at.to, ...Object.fromEntries(own) });
    const a = AutomationFile.parse(js(doc));
    // A hand-written file keeps its cron until the form changes it.
    const before = at.existing === undefined ? undefined : js(parseDocument(at.existing));
    if (!isObj(before) || before.cron !== a.cron) editorCron(a.cron, a.timezone);
    if (!deps.agents().has(a.agentId)) throw new Bad('agentId', `unknown agent ${a.agentId}`);
    if (id === undefined && existsSync(autoFile(a.id)))
      return { status: 409, body: { error: 'exists' } };
    writeText(autoFile(a.id), String(doc));
    automationsChanged(`automation ${a.id} saved`);
    return { status: id === undefined ? 201 : 200, body: { id: a.id } };
  };

  const deleteAutomation = (id: string, userId: string): Answer => {
    if (!AUTOMATION_ID.test(id) || !existsSync(autoFile(id))) return notFound;
    rmSync(autoFile(id));
    db.delete(automationRuns)
      .where(and(eq(automationRuns.id, id), eq(automationRuns.userId, userId)))
      .run();
    automationsChanged(`automation ${id} deleted`);
    return { status: 204 };
  };

  /**
   * Create (`id` undefined, the id from the name) or update a mode file (phase-23 decision 13).
   * The raw text is written as sent; the form's fields are written as frontmatter and paragraph.
   */
  const saveMode = (id: string | undefined, rawBody: unknown, dry: boolean): Answer => {
    const body = ModeSave.parse(rawBody);
    if (id !== undefined && (!ModeId.safeParse(id).success || !existsSync(modeFile(id))))
      return notFound;
    const parsed = 'raw' in body ? rawMode(body.raw) : { frontmatter: body.file, body: body.body };
    const file = ModeFile.parse(parsed.frontmatter);
    const text = ModeBody.safeParse(parsed.body);
    if (!text.success) throw new Bad('body', 'the instruction must be 1 to 4000 characters');
    const target = id ?? freeId(file.name, (x) => existsSync(modeFile(x)), 'tila', 29);
    const raw = 'raw' in body ? body.raw : modeText(file, text.data);
    if (!dry) {
      mkdirSync(modesDir(agentsDir), { recursive: true });
      writeText(modeFile(target), raw);
      deps.reloadAgents();
      commitAgents(`mode ${target} saved`);
    }
    const doc: ModeDoc = { id: target, file, body: text.data, raw, error: null };
    return { status: id === undefined && !dry ? 201 : 200, body: doc };
  };

  /** A mode that a profile names in `modes.default` stays (`in_use`). */
  const deleteMode = (id: string): Answer => {
    if (!ModeId.safeParse(id).success || !existsSync(modeFile(id))) return notFound;
    const agents = [...deps.agents().values()]
      .filter((a) => a.modes.default.includes(id))
      .map((a) => a.id);
    if (agents.length) return { status: 409, body: { error: 'in_use', agents } };
    rmSync(modeFile(id));
    deps.reloadAgents();
    commitAgents(`mode ${id} deleted`);
    return { status: 204 };
  };

  return { saveAgent, deleteAgent, saveAutomation, deleteAutomation, saveMode, deleteMode };
}

export function adminRoutes(app: FastifyInstance, auth: preHandlerHookHandler, deps: AdminDeps) {
  const { agentsDir } = deps;
  const w = adminWriters(deps);
  /** Sends a writer's answer; a check failure is a 400 (`checked`). */
  const send = (reply: FastifyReply, fn: () => Answer) =>
    checked(reply, () => {
      const r = fn();
      return reply.code(r.status).send(r.body);
    });

  const agentDoc = (id: string): AgentDoc => {
    const yaml = readFileSync(join(agentsDir, `${id}.yaml`), 'utf8');
    try {
      const profile = AgentFile.parse(js(yamlOf(yaml)));
      if (profile.id !== id) throw new Bad('id', `id ${profile.id} does not match the file name`);
      return {
        id,
        profile,
        yaml,
        prompt: readFileSync(promptPath(agentsDir, profile.prompt), 'utf8'),
        error: null,
      };
    } catch (err) {
      return { id, profile: null, yaml, prompt: '', error: errorText(err) };
    }
  };

  const modeDocs = (): ModeDoc[] => {
    const dir = modesDir(agentsDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .flatMap((f): ModeDoc[] => {
        const id = basename(f, '.md');
        if (!ModeId.safeParse(id).success) return [];
        const raw = readFileSync(join(dir, f), 'utf8');
        try {
          const { id: _, body, ...file } = parseMode(id, raw);
          return [{ id, file, body, raw, error: null }];
        } catch (err) {
          return [{ id, file: null, body: '', raw, error: errorText(err) }];
        }
      });
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
      modes: modeDocs(),
      options: {
        modes: [...deps.modes().keys()],
        tools: PROFILE_TOOLS,
        mcp: deps.mcpNames,
        skills,
        aliases: aliasList().map(({ id, name }) => ({ id, name })),
      },
    };
  });

  app.post<{ Querystring: { dry?: string } }>(
    '/api/agents',
    { preHandler: auth },
    async (req, reply) =>
      send(reply, () => w.saveAgent(undefined, req.body, req.query.dry === '1')),
  );
  app.put<{ Params: { id: string }; Querystring: { dry?: string } }>(
    '/api/agents/:id',
    { preHandler: auth },
    async (req, reply) => {
      if (!AGENT_ID.test(req.params.id)) return reply.code(404).send({ error: 'not_found' });
      return send(reply, () => w.saveAgent(req.params.id, req.body, req.query.dry === '1'));
    },
  );
  app.delete<{ Params: { id: string } }>(
    '/api/agents/:id',
    { preHandler: auth },
    async (req, reply) => send(reply, () => w.deleteAgent(req.params.id, req.userId)),
  );

  app.post('/api/automations', { preHandler: auth }, async (req, reply) =>
    send(reply, () => w.saveAutomation(undefined, req.body)),
  );
  app.put<{ Params: { id: string } }>(
    '/api/automations/:id',
    { preHandler: auth },
    async (req, reply) => {
      if (!AUTOMATION_ID.test(req.params.id)) return reply.code(404).send({ error: 'not_found' });
      return send(reply, () => w.saveAutomation(req.params.id, req.body));
    },
  );
  app.delete<{ Params: { id: string } }>(
    '/api/automations/:id',
    { preHandler: auth },
    async (req, reply) => send(reply, () => w.deleteAutomation(req.params.id, req.userId)),
  );

  // Phase-23 decision 13: the mode files.
  app.post<{ Querystring: { dry?: string } }>(
    '/api/modes',
    { preHandler: auth },
    async (req, reply) => send(reply, () => w.saveMode(undefined, req.body, req.query.dry === '1')),
  );
  app.put<{ Params: { id: string }; Querystring: { dry?: string } }>(
    '/api/modes/:id',
    { preHandler: auth },
    async (req, reply) =>
      send(reply, () => w.saveMode(req.params.id, req.body, req.query.dry === '1')),
  );
  app.delete<{ Params: { id: string } }>(
    '/api/modes/:id',
    { preHandler: auth },
    async (req, reply) => send(reply, () => w.deleteMode(req.params.id)),
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
