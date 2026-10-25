import { readdirSync, readFileSync, watch } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const names = z.array(z.string().min(1).max(64));

/** `agents/<id>.yaml`, decision 1 of docs/decisions/phase-5.md. */
const ProfileFile = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  name: z.string().min(1).max(80),
  model: z.string().regex(/^zdr\/[A-Za-z0-9._-]+$/),
  prompt: z.string().min(1),
  skills: names.default([]),
  tools: z.object({ allow: names, mcp: names.optional() }),
  approval: z
    .object({ always: names.default([]), never: names.default([]) })
    .default({ always: [], never: [] }),
  subagents: z.boolean().default(false),
});
/** `prompt` holds the prompt text, not its path. */
export type AgentProfile = z.infer<typeof ProfileFile>;
export type Agents = Map<string, AgentProfile>;

/** Reads every `*.yaml` in `dir`. A bad file goes to `onError` and is skipped; `assistant` is required. */
export function loadAgents(
  dir: string,
  onError: (file: string, err: unknown) => void = () => {},
): Agents {
  const prompts = resolve(dir, 'prompts') + sep;
  const agents: Agents = new Map();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()) {
    try {
      const p = ProfileFile.parse(parse(readFileSync(join(dir, file), 'utf8')));
      if (p.id !== basename(file, '.yaml')) throw new Error(`id ${p.id} does not match file name`);
      const path = resolve(dir, p.prompt);
      if (!path.startsWith(prompts)) throw new Error('prompt must be under prompts/');
      agents.set(p.id, { ...p, prompt: readFileSync(path, 'utf8') });
    } catch (err) {
      onError(file, err);
    }
  }
  if (!agents.has('assistant')) throw new Error(`agent profile "assistant" missing in ${dir}`);
  return agents;
}

/** Calls `onChange` 1 s after the last change in `dir` (also `prompts/`). Returns a stop function. */
export function watchAgents(dir: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const w = watch(dir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 1000);
  });
  return () => {
    clearTimeout(timer);
    w.close();
  };
}
