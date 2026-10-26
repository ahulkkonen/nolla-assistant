import { readdirSync, readFileSync, realpathSync, watch } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AgentFile, DEFAULT_AGENT_ID } from '@pa/protocol';
import { parse } from 'yaml';
import type { z } from 'zod';

/** Tools that change state or spend money; each should have an explicit approval rule. */
const RISKY = ['write', 'edit', 'bash', 'subagent'];
/** The allowed risky tools that are in neither approval list (the loader warns, the editor refuses). */
export const unruled = (p: z.infer<typeof AgentFile>) =>
  (p.subagents ? [...p.tools.allow, 'subagent'] : p.tools.allow).filter(
    (t) => RISKY.includes(t) && !p.approval.always.includes(t) && !p.approval.never.includes(t),
  );
/** `prompt` holds the prompt text, not its path. */
export type AgentProfile = z.infer<typeof AgentFile>;
export type Agents = Map<string, AgentProfile>;
/** The agent that runs a chat: its own, or the default when its profile is gone (phase-16 decision 3). */
export const liveAgentId = (agents: Agents, id: string) => (agents.has(id) ? id : DEFAULT_AGENT_ID);

/**
 * Reads every `*.yaml` in `dir`. A bad file goes to `onError` and keeps its `prev` version (if
 * any); warnings go to `onError` with `level: 'warn'`. `assistant` is required.
 */
export function loadAgents(
  dir: string,
  onError: (file: string, err: unknown, level: 'error' | 'warn') => void = () => {},
  prev?: Agents,
): Agents {
  const prompts = realpathSync(resolve(dir, 'prompts')) + sep;
  const agents: Agents = new Map();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()) {
    try {
      const p = AgentFile.parse(parse(readFileSync(join(dir, file), 'utf8')));
      if (p.id !== basename(file, '.yaml')) throw new Error(`id ${p.id} does not match file name`);
      const path = realpathSync(resolve(dir, p.prompt));
      if (!path.startsWith(prompts)) throw new Error('prompt must be under prompts/');
      for (const t of unruled(p)) onError(file, `tool ${t} has no approval rule`, 'warn');
      const next = { ...p, prompt: readFileSync(path, 'utf8') };
      // An unchanged profile keeps its object: the registry rebuilds only sessions of changed ones.
      const old = prev?.get(p.id);
      agents.set(p.id, old && isDeepStrictEqual(old, next) ? old : next);
    } catch (err) {
      onError(file, err, 'error');
      const old = prev?.get(basename(file, '.yaml'));
      if (old) agents.set(old.id, old);
    }
  }
  if (!agents.has('assistant')) throw new Error(`agent profile "assistant" missing in ${dir}`);
  return agents;
}

/** A watcher event of the server's own temp files or git repository (phase-15 decision 4). */
export const ownChange = (filename: string | null) =>
  !!filename && (/(^|[\\/])\.git([\\/]|$)/.test(filename) || filename.endsWith('.tmp'));

/** Calls `onChange` 1 s after the last change in `dir` (also `prompts/`). Returns a stop function. */
export function watchAgents(
  dir: string,
  onChange: () => void,
  onError: (err: Error) => void,
): () => void {
  let timer: NodeJS.Timeout | undefined;
  const w = watch(dir, { recursive: true }, (_event, filename) => {
    if (ownChange(filename)) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, 1000);
  });
  w.on('error', onError);
  return () => {
    clearTimeout(timer);
    w.close();
  };
}
