import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { ModeBody, ModeFile, ModeId, type ModeInfo } from '@nolla/protocol';

/** A loaded `agents/modes/<id>.md` (phase-23 decision 1); `body` is the prompt paragraph. */
export type Mode = ModeInfo & { body: string };
export type Modes = Map<string, Mode>;

/** The mode files live under the agents folder, so the editor's git commit covers them. */
export const modesDir = (agentsDir: string) => join(agentsDir, 'modes');

/** Parses one mode file; throws on a bad id, frontmatter or body. */
export function parseMode(id: string, raw: string): Mode {
  const { frontmatter, body } = parseFrontmatter(raw);
  return { id: ModeId.parse(id), ...ModeFile.parse(frontmatter), body: ModeBody.parse(body) };
}

/**
 * Reads every `*.md` in `dir`, as `loadAgents` does: a bad file goes to `onError` and keeps its
 * `prev` version (if any); an unchanged mode keeps its object. A missing `dir` has no modes.
 */
export function loadModes(
  dir: string,
  onError: (file: string, err: unknown) => void = () => {},
  prev?: Modes,
): Modes {
  const modes: Modes = new Map();
  if (!existsSync(dir)) return modes;
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()) {
    const id = basename(file, '.md');
    const old = prev?.get(id);
    try {
      const next = parseMode(id, readFileSync(join(dir, file), 'utf8'));
      modes.set(id, old && isDeepStrictEqual(old, next) ? old : next);
    } catch (err) {
      onError(file, err);
      if (old) modes.set(id, old);
    }
  }
  return modes;
}

/** The mode list without bodies, for `agents.state`. */
export const modeInfos = (modes: Modes): ModeInfo[] =>
  [...modes.values()].map(({ body: _, ...m }) => m);

/**
 * The profile prompt and the bodies of the active modes in id order, joined by blank lines
 * (phase-23 decision 5). Id order keeps the bytes stable for the provider cache; an unknown id
 * (a deleted mode) is skipped.
 */
export const systemPrompt = (profile: string, ids: readonly string[], modes: Modes) =>
  [profile, ...[...new Set(ids)].sort().flatMap((id) => modes.get(id)?.body ?? [])].join('\n\n');
