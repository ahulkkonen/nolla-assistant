import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { chats, type Db } from '@pa/db';
import { toolText as text } from '@pa/pi-ext-memory';
import type { PseudoClient } from '@pa/pi-ext-pseudo';
import { type AgentDoc, type ApprovalView, type ModeDoc, ModeId } from '@pa/protocol';
import { createTwoFilesPatch } from 'diff';
import { and, desc, eq, ne } from 'drizzle-orm';
import { Type } from 'typebox';
import { parse } from 'yaml';
import { type Answer, type adminWriters, badPath } from './admin.ts';
import { callKey, type View } from './approval.ts';
import { AutomationFile, nextRuns } from './automations.ts';
import { chatRow } from './chats.ts';
import { modesDir } from './modes.ts';
import type { SessionRegistry } from './pi/registry.ts';
import { restorer } from './restore.ts';
import { untrusted } from './search-tool.ts';
import { cutText, transcript } from './session-text.ts';

/**
 * Phase 25 (docs/decisions/phase-25-harness-tools.md, decisions 1 to 18): `profile_edit`,
 * `automation_edit` and `chat_read`. The gate always shows their card (`views`); each write goes
 * through the editors' writers and one git commit. Every block reason and error is fixed text
 * (decision 4): a block reason reaches the session unmasked.
 */

export const STALE = 'Tiedosto muuttui hyväksynnän jälkeen. Lue se ja yritä uudelleen.';
export const NO_PII = 'Profiiliin ei kirjoiteta henkilötietoja; ne kuuluvat muistiin (USER.md).';
export const SAVED = 'Tallennettu. Muutos tulee voimaan seuraavassa vastauksessa.';
export const NOT_FOUND = 'Kohdetta ei löydy.';
const EXISTS = 'Tunnus on jo käytössä.';
const SAME = 'Sisältö on jo sama.';
const FAILED = 'Muutosta ei voitu käsitellä.';
const ONE_OF = 'Anna joko chatId tai title, ei molempia.';
const NO_CHAT = 'Keskustelua ei löydy.';
const SELF = 'Tämä keskustelu on jo näkyvissäsi. Anna toisen keskustelun tunnus.';
const NO_HITS = 'Ei osumia.';
const READ_FAILED = 'Keskustelua ei voitu lukea nyt.';
export const AGENT_FIXED = 'Agenttia ei voi vaihtaa työkalulla.';
export const PSEUDO_DOWN = 'Tietosuojapalvelu ei vastaa; profiilia ei voi muuttaa nyt.';
export const badField = (path: string) =>
  path ? `Muutos ei kelpaa: ${path}` : 'Muutos ei kelpaa.';

const DIFF_MAX = 200_000;
/** `chat_read` text (decision 17). */
export const CHAT_MAX = 20_000;
const HITS_MAX = 5;

export type HarnessDeps = {
  writers: Pick<ReturnType<typeof adminWriters>, 'saveAgent' | 'saveAutomation' | 'saveMode'>;
  db: Db;
  userId: string;
  reader: SessionRegistry['reader'];
  pseudo?: PseudoClient | undefined;
  agentsDir: string;
  automationsDir: string;
  chatId: string;
  /** The chat's agent: `profile_edit` changes its prompt file. */
  agentId: string;
  /** Call id to the argument as the model wrote it (`maskedArgs`, decision 22). */
  masked: Map<string, unknown>;
  /** The profile's `tools.allow`: only these harness tools are registered. */
  allow: string[];
  log: (msg: string, data: object) => void;
};

const sha = (path: string) =>
  createHash('sha256')
    .update(existsSync(path) ? readFileSync(path) : '')
    .digest('hex');
/** The writers end a text file with a newline; the diff shows what lands. */
const asWritten = (s: string) => (s.endsWith('\n') ? s : `${s}\n`);

/** The unified diff without its header lines, 3 lines of context, at most 200 KB. */
export function unified(file: string, before: string, after: string) {
  const patch = createTwoFilesPatch(file, file, before, after, '', '', { context: 3 });
  const at = patch.indexOf('\n@@');
  const body = at < 0 ? '' : patch.slice(at + 1);
  return body.length > DIFF_MAX ? `${cutText(body, DIFF_MAX - 2)}\n` : body;
}

type Run<T> = { body: T } | { error: string };
/** A writer's answer, or a fixed reason: the field path of a failed check, never its message. */
function run<T>(fn: () => Answer, log: HarnessDeps['log']): Run<T> {
  try {
    const r = fn();
    if (r.status === 404) return { error: NOT_FOUND };
    if (r.status >= 400) return { error: EXISTS };
    return { body: r.body as T };
  } catch (err) {
    const path = badPath(err);
    if (path !== undefined) return { error: badField(path) };
    log('harness check failed', { error: err instanceof Error ? err.name : 'unknown' });
    return { error: FAILED };
  }
}

export function harness(deps: HarnessDeps): {
  tools: ExtensionFactory;
  views: Record<string, View>;
} {
  const { writers, db, userId, chatId, agentsDir, log } = deps;
  /** Call id to the target file and its hash when the card was shown (decision 6). */
  const stamps = new Map<string, { file: string; path: string; hash: string }>();

  // --- profile_edit (decisions 10, 11) ---------------------------------------------------------
  type ProfileArgs = { file: 'prompt' | 'mode'; id?: string | undefined; content: string };
  const modeExists = (id: string | undefined): id is string =>
    !!id && ModeId.safeParse(id).success && existsSync(join(modesDir(agentsDir), `${id}.md`));
  /**
   * The profile's YAML as it is, so the writer keeps it byte-equal (the merge of `profile: {}`
   * would format it again); a missing file answers 404.
   */
  const agentYaml = () => {
    const path = join(agentsDir, `${deps.agentId}.yaml`);
    return existsSync(path) ? { yaml: readFileSync(path, 'utf8') } : { profile: {} };
  };
  const profileWrite = (p: ProfileArgs, dry: boolean, n?: string) =>
    p.file === 'prompt'
      ? writers.saveAgent(deps.agentId, { ...agentYaml(), prompt: p.content }, dry, n)
      : writers.saveMode(modeExists(p.id) ? p.id : undefined, { raw: p.content }, dry, n);
  /** The file the change lands in, relative to the agents folder. */
  const profileFile = (p: ProfileArgs, body: unknown) =>
    p.file === 'prompt'
      ? ((body as AgentDoc).profile?.prompt ?? '')
      : `modes/${(body as ModeDoc).id}.md`;

  const profileView: View = async (input, callId) => {
    const p = input as ProfileArgs;
    const masked = deps.masked.get(callKey('profile_edit', callId));
    if (masked !== undefined && masked !== p.content) return { error: NO_PII };
    // A real name the model wrote itself is not in the masked argument: probe it with the
    // sidecar. Down: refuse rather than skip. No sidecar at all: no vault, nothing to find.
    if (deps.pseudo) {
      try {
        if ((await deps.pseudo.mask(chatId, p.content)).spans.length) return { error: NO_PII };
      } catch {
        return { error: PSEUDO_DOWN };
      }
    }
    const r = run<unknown>(() => profileWrite(p, true), log);
    if ('error' in r) return r;
    const file = profileFile(p, r.body);
    const path = join(agentsDir, file);
    const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const after = asWritten(p.content);
    if (before === after) return { error: SAME };
    stamps.set(callKey('profile_edit', callId), { file, path, hash: sha(path) });
    const view: ApprovalView = {
      kind: 'diff',
      file,
      created: !existsSync(path),
      diff: unified(file, before, after),
    };
    return { view };
  };

  // --- automation_edit (decisions 12 to 15) ----------------------------------------------------
  const AUTOMATION_KEYS = ['name', 'cron', 'prompt', 'deliver', 'enabled', 'agentId'] as const;
  /** The fields the tool may set; never `autoApprove` (decision 15). A new one gets `[]`. */
  const automationBody = (p: Record<string, unknown>) => ({
    ...Object.fromEntries(AUTOMATION_KEYS.flatMap((k) => (p[k] === undefined ? [] : [[k, p[k]]]))),
    ...(p.id === undefined ? { autoApprove: [] } : {}),
  });
  const automationId = (p: Record<string, unknown>) =>
    typeof p.id === 'string' ? p.id : undefined;
  type Dry = { id: string; yaml: string; created: boolean };

  /** The file an update changes, parsed; undefined for a create or an unknown id. */
  const automationNow = (id: string | undefined) => {
    if (id === undefined || !AutomationFile.shape.id.safeParse(id).success) return undefined;
    const path = join(deps.automationsDir, `${id}.yaml`);
    if (!existsSync(path)) return undefined;
    const r = AutomationFile.safeParse(parse(readFileSync(path, 'utf8')));
    return r.success ? r.data : undefined;
  };

  const automationView: View = async (input, callId) => {
    let old: ReturnType<typeof automationNow>;
    try {
      old = automationNow(automationId(input));
    } catch {
      return { error: FAILED };
    }
    // An update keeps its agent (and its `autoApprove` list, which the body never holds).
    if (old && input.agentId !== undefined && input.agentId !== old.agentId)
      return { error: AGENT_FIXED };
    const r = run<Dry>(
      () => writers.saveAutomation(automationId(input), automationBody(input), true),
      log,
    );
    if ('error' in r) return r;
    const { id, yaml, created } = r.body;
    const a = AutomationFile.parse(parse(yaml));
    const file = `automations/${id}.yaml`;
    const path = join(deps.automationsDir, `${id}.yaml`);
    stamps.set(callKey('automation_edit', callId), { file, path, hash: sha(path) });
    const view: ApprovalView = {
      kind: 'yaml',
      file,
      created,
      yaml,
      nextRuns: a.enabled ? nextRuns(a.cron, a.timezone) : [],
      ...(old && !created && old.enabled !== a.enabled
        ? { enabled: { from: old.enabled, to: a.enabled } }
        : {}),
    };
    return { view };
  };

  /** The stale check (decision 6), then the write and its log line. */
  const commit = (tool: string, callId: string, write: (n: string) => Answer) => {
    const stamp = stamps.get(callKey(tool, callId));
    stamps.delete(callKey(tool, callId));
    if (!stamp || sha(stamp.path) !== stamp.hash) return text(STALE, true);
    const r = run(() => write(`${tool} ${stamp.file} (chat ${chatId.slice(0, 8)})`), log);
    if ('error' in r) return text(r.error, true);
    log('harness write', { chatId, tool, file: stamp.file });
    return text(SAVED);
  };

  // --- chat_read (decisions 16 to 18) ----------------------------------------------------------
  type ChatArgs = { chatId?: string | undefined; title?: string | undefined };
  const oneOf = (p: ChatArgs) => (p.chatId === undefined) !== (p.title === undefined);
  const ownChat = (id: string) => (id === chatId ? SELF : chatRow(db, userId, id) ? null : NO_CHAT);

  const chatView: View = async (input) => {
    const p = input as ChatArgs;
    if (!oneOf(p)) return { error: ONE_OF };
    const view: ApprovalView = {
      kind: 'chat',
      chatId: null,
      title: null,
      createdAt: null,
      messages: null,
      query: null,
    };
    if (p.title !== undefined) return { view: { ...view, query: p.title } };
    const id = p.chatId as string;
    const bad = ownChat(id);
    if (bad) return { error: bad };
    const row = chatRow(db, userId, id);
    let messages: number;
    try {
      messages = transcript(deps.reader(id)).length;
    } catch {
      return { error: READ_FAILED };
    }
    return {
      view: {
        ...view,
        chatId: id,
        title: row?.title ?? null,
        createdAt: row?.createdAt ?? null,
        messages,
      },
    };
  };

  /** The newest messages that fit, restored, so `tool_result` masks them once here (H5). */
  const read = async (row: NonNullable<ReturnType<typeof chatRow>>) => {
    let lines: string[];
    try {
      lines = transcript(deps.reader(row.id)).map(
        (m) => `${m.role === 'user' ? 'Käyttäjä' : 'Avustaja'}: ${m.text}`,
      );
    } catch {
      // Fixed text: an error message may hold a path or a value.
      return text(READ_FAILED, true);
    }
    const kept: string[] = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] as string;
      if (size + line.length > CHAT_MAX) {
        if (!kept.length) kept.push(cutText(line, CHAT_MAX));
        break;
      }
      kept.unshift(line);
      size += line.length + 2;
    }
    let down = false;
    const restored = await restorer(deps.pseudo, () => {
      down = true;
    })(kept.join('\n\n'));
    // Masked text would be masked a second time: refuse instead.
    if (down) return text(READ_FAILED, true);
    const head = `Keskustelu "${row.title ?? 'Nimetön'}" (${row.createdAt.slice(0, 10)}), ${lines.length} viestiä, ${lines.length - kept.length} jätetty pois.`;
    // A restored name can be longer than its surrogate: cap after the restore.
    return text(`${head}\n${untrusted('keskustelu', cutText(restored.text, CHAT_MAX))}`);
  };

  const chatRead = async (p: ChatArgs) => {
    if (!oneOf(p)) return text(ONE_OF, true);
    if (p.chatId !== undefined) {
      const bad = ownChat(p.chatId);
      const row = chatRow(db, userId, p.chatId);
      return bad || !row ? text(bad ?? NO_CHAT, true) : read(row);
    }
    // ponytail: a full scan of the titles; an index when there are many thousands of chats.
    const q = (p.title as string).toLocaleLowerCase('fi');
    const hits = db
      .select()
      .from(chats)
      .where(and(eq(chats.userId, userId), ne(chats.id, chatId)))
      .orderBy(desc(chats.createdAt))
      .all()
      .filter((c) => c.title?.toLocaleLowerCase('fi').includes(q));
    const [first] = hits;
    if (!first) return text(NO_HITS);
    if (hits.length === 1) return read(first);
    // The list leaves through `execute`, so `tool_result` masks it (decision 16).
    const list = hits
      .slice(0, HITS_MAX)
      .map((c) => `- ${c.id} "${c.title}" (${c.createdAt.slice(0, 10)})`);
    return text(
      `${hits.length} osumaa. Kutsu uudelleen yhden tunnuksella (chatId):\n${list.join('\n')}`,
    );
  };

  const allowed = new Set(deps.allow);
  const tools: ExtensionFactory = (pi) => {
    // Every end (run, denied, expired, failed) drops the call's stamp.
    pi.on('tool_execution_end', (e) => void stamps.delete(callKey(e.toolName, e.toolCallId)));
    const registerTool: typeof pi.registerTool = (t) => {
      if (allowed.has(t.name)) pi.registerTool(t);
    };
    registerTool({
      name: 'profile_edit',
      label: 'profile_edit',
      description:
        'Muuttaa avustajan ohjetta (file "prompt") tai tilaa (file "mode", id; uusi id luo tilan). content on koko uusi tiedosto. Käyttäjä hyväksyy muutoksen. Älä kirjoita henkilötietoja.',
      parameters: Type.Object({
        file: Type.Union([Type.Literal('prompt'), Type.Literal('mode')]),
        id: Type.Optional(Type.String({ maxLength: 32 })),
        content: Type.String({ minLength: 1, maxLength: 100_000 }),
      }),
      execute: async (callId, p) =>
        commit('profile_edit', callId, (n) => profileWrite(p, false, n)),
    });
    registerTool({
      name: 'automation_edit',
      label: 'automation_edit',
      description:
        'Luo automaation (ilman id:tä) tai muuttaa sitä (id). cron on viisi kenttää, vähintään 5 minuuttia ajojen välillä. Käyttäjä hyväksyy muutoksen.',
      parameters: Type.Object({
        id: Type.Optional(Type.String({ maxLength: 64 })),
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        cron: Type.Optional(Type.String({ maxLength: 200 })),
        prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
        deliver: Type.Optional(
          Type.Union([Type.Literal('chat'), Type.Literal('push'), Type.Literal('both')]),
        ),
        enabled: Type.Optional(Type.Boolean()),
        agentId: Type.Optional(Type.String({ maxLength: 64 })),
      }),
      execute: async (callId, p) =>
        commit('automation_edit', callId, (n) =>
          writers.saveAutomation(automationId(p), automationBody(p), false, n),
        ),
    });
    registerTool({
      name: 'chat_read',
      label: 'chat_read',
      description:
        'Lukee yhden aiemman keskustelun tunnuksella (chatId) tai otsikon osalla (title). Useasta osumasta palautuu lista tunnuksineen.',
      parameters: Type.Object({
        chatId: Type.Optional(Type.String({ maxLength: 64 })),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      }),
      execute: async (_id, p) => chatRead(p),
    });
  };

  return {
    tools,
    views: { profile_edit: profileView, automation_edit: automationView, chat_read: chatView },
  };
}
