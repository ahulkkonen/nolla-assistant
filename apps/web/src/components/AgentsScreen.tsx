import {
  type AgentDoc,
  type AgentFile,
  type AgentList,
  DEFAULT_AGENT_ID,
  type ModeDoc,
} from '@pa/protocol';
import { Bot, Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { TabsContent } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { agentDelete, agentSave, agentsList, HttpError } from '../api.ts';
import { useStore } from '../store.ts';
import { ActionMenu } from './Actions.tsx';
import { DeleteDialog } from './ConfirmDialog.tsx';
import {
  CHECK_FIELD,
  Checks,
  Field,
  type FieldError,
  invalid,
  type SaveFields,
  saveFailure,
  useEditor,
} from './Field.tsx';
import { ModeEditor, ModesSection } from './ModesEditor.tsx';
import { EditorPage, EmptyState, ListSkeleton, Page } from './Page.tsx';
import { Row } from './SettingsDialog.tsx';

export const AGENTS_TITLE = 'Agentit';

type Rule = 'always' | 'never' | 'default';
const RULES: { value: Rule; label: string }[] = [
  { value: 'always', label: 'Kysy aina' },
  { value: 'never', label: 'Älä kysy' },
  { value: 'default', label: 'Oletus' },
];
/** The form's fields (phase-15 decision 3); `skills` and comments stay in the file. */
type Form = {
  name: string;
  model: string;
  allow: string[];
  mcp: string[];
  rules: Record<string, Rule>;
  /** The tools of the file's approval lists first, so an unchanged list keeps its order. */
  order: string[];
  subagents: boolean;
  /** Phase-23 decision 14: "Oletustilat", the profile's `modes.default`. */
  modes: string[];
};

const formOf = (p: AgentFile): Form => ({
  name: p.name,
  model: p.model,
  allow: p.tools.allow,
  mcp: p.tools.mcp ?? [],
  rules: Object.fromEntries([
    ...p.approval.never.map((t) => [t, 'never'] as const),
    ...p.approval.always.map((t) => [t, 'always'] as const),
  ]),
  order: [...p.approval.always, ...p.approval.never],
  subagents: p.subagents,
  modes: p.modes.default,
});
const blank = (list: AgentList): Form => ({
  name: '',
  model: list.options.aliases[0]?.id ?? 'zdr/strong',
  allow: [],
  mcp: [],
  rules: {},
  order: [],
  subagents: false,
  modes: [],
});
/** The tools that get a "Hyväksyntä" row: the allowed ones, and `subagent` when it is on. */
const ruled = (f: Form) => (f.subagents ? [...f.allow, 'subagent'] : f.allow);
/** The body of a form save: the server merges it into the file key by key; null drops a key. */
const fieldsOf = (f: Form) => {
  const order = [...new Set([...f.order, ...ruled(f)])];
  return {
    name: f.name.trim(),
    model: f.model,
    tools: { allow: f.allow, mcp: f.mcp.length ? f.mcp : null },
    approval: {
      always: order.filter((t) => f.rules[t] === 'always'),
      never: order.filter((t) => f.rules[t] === 'never'),
    },
    subagents: f.subagents,
    // No key for no modes, as `tools.mcp`: a file without modes stays as it was.
    modes: f.modes.length ? { default: f.modes } : null,
  };
};

/**
 * Where a refused save goes (decision 2): the form field of a server `path`, the id from the
 * name; a key the form does not show (`skills`, a whole `tools`) points to the YAML tab.
 */
const FIELDS: SaveFields = {
  file: 'agent-yaml',
  tab: 'YAML',
  name: 'agent-name',
  fields: [
    ['name', 'agent-name'],
    ['id', 'agent-name'],
    ['model', 'agent-model'],
    ['prompt', 'agent-prompt'],
    ['tools.allow', 'agent-tools'],
    ['tools.mcp', 'agent-mcp'],
    ['approval', 'agent-approval'],
    ['subagents', 'agent-subagents'],
    ['modes', 'agent-modes'],
  ],
};

/** The editor (phase-15 UI): "Lomake" and "YAML", a dry run on each tab switch. */
function AgentEditor({
  doc,
  list,
  onDone,
}: {
  doc: AgentDoc | null;
  list: AgentList;
  onDone: () => void;
}) {
  const catalog = useStore((s) => s.models?.catalog ?? []);
  const [prompt, setPrompt] = useState(doc?.prompt ?? '');
  const [yaml, setYaml] = useState(doc?.yaml ?? '');
  const ed = useEditor({
    form: doc?.profile ? formOf(doc.profile) : blank(list),
    // A file that fails the schema opens in YAML, with its error.
    tab: doc && !doc.profile ? 'yaml' : ('form' as 'form' | 'yaml'),
    error: doc?.error ? { field: 'agent-yaml', message: doc.error } : null,
    leave: 'Agenttiin tehdyt muokkaukset menetetään.',
    // The YAML tab leaves the checks to the server.
    call: async (form, tab, dry) => {
      if (tab === 'form' && !prompt.trim())
        throw { field: 'agent-prompt', message: CHECK_FIELD } satisfies FieldError;
      try {
        const body = tab === 'form' ? { profile: fieldsOf(form) } : { yaml };
        return await agentSave(doc?.id, body, prompt, dry);
      } catch (err) {
        throw saveFailure(err, tab === 'yaml', FIELDS);
      }
    },
    take: (checked, next, replace) => {
      if (next === 'yaml') setYaml(checked.yaml);
      else if (checked.profile) replace(formOf(checked.profile));
    },
    onDone,
  });
  const { form, set, at: errorAt } = ed;

  const models = [
    ...list.options.aliases,
    ...catalog.filter((m) => m.zdr).map((m) => ({ id: `zdr/${m.id}`, name: m.name })),
  ];
  const tools = [...new Set([...list.options.tools, ...form.allow])];
  // A mode the profile names but the server lacks stays visible, so it can be turned off.
  const modes = [...new Set([...list.options.modes, ...form.modes])];

  const promptField = (
    <Field
      id="agent-prompt"
      label="Ohje"
      helper="Markdown. Tallentuu omaan tiedostoonsa."
      error={errorAt('agent-prompt')}
    >
      <Textarea
        id="agent-prompt"
        value={prompt}
        rows={8}
        className="max-h-80 min-h-40"
        {...invalid('agent-prompt', errorAt('agent-prompt'))}
        onChange={(e) => {
          ed.touch();
          setPrompt(e.target.value);
        }}
      />
    </Field>
  );

  return (
    <EditorPage
      title={AGENTS_TITLE}
      heading={doc ? (doc.profile?.name ?? doc.id) : 'Uusi agentti'}
      id={doc?.id}
      tabs={[
        ['form', 'Lomake'],
        ['yaml', 'YAML'],
      ]}
      {...ed.page}
    >
      <TabsContent value="form" className="flex flex-col divide-y divide-border pt-2">
        <Field id="agent-name" label="Nimi" error={errorAt('agent-name')}>
          <Input
            id="agent-name"
            value={form.name}
            autoComplete="off"
            {...invalid('agent-name', errorAt('agent-name'))}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field id="agent-model" label="Malli" error={errorAt('agent-model')}>
          <Select value={form.model} onValueChange={(model) => set({ model })}>
            <SelectTrigger
              id="agent-model"
              className="w-full"
              {...invalid('agent-model', errorAt('agent-model'))}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-80">
              {(
                [
                  ['Aliakset', list.options.aliases],
                  ['ZDR-mallit', models.slice(list.options.aliases.length)],
                ] as const
              ).map(([group, items]) => (
                <SelectGroup key={group}>
                  <SelectLabel>{group}</SelectLabel>
                  {items.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
              {/* A model the lists lack stays selectable as it is. */}
              {!models.some((m) => m.id === form.model) && (
                <SelectItem value={form.model}>{form.model}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </Field>
        {promptField}
        <Field
          id="agent-modes"
          label="Oletustilat"
          group
          helper="Päällä keskusteluissa, joiden tiloja et ole itse valinnut."
          error={errorAt('agent-modes')}
        >
          {modes.length ? (
            <Checks
              options={modes}
              value={form.modes}
              labelOf={(id) => list.modes.find((m) => m.id === id)?.file?.name ?? id}
              onChange={(modes) => set({ modes })}
            />
          ) : (
            <p className="text-meta text-muted-foreground">Ei tiloja.</p>
          )}
        </Field>
        <Field id="agent-tools" label="Työkalut" group error={errorAt('agent-tools')}>
          <Checks options={tools} value={form.allow} onChange={(allow) => set({ allow })} />
        </Field>
        <Field id="agent-mcp" label="MCP-palvelimet" group error={errorAt('agent-mcp')}>
          {list.options.mcp.length ? (
            <Checks options={list.options.mcp} value={form.mcp} onChange={(mcp) => set({ mcp })} />
          ) : (
            <p className="text-meta text-muted-foreground">Ei MCP-palvelimia.</p>
          )}
        </Field>
        <Field
          id="agent-approval"
          label="Hyväksyntä"
          group
          helper="Työkalut write, edit, bash ja subagent tarvitsevat valinnan."
          error={errorAt('agent-approval')}
        >
          {ruled(form).length ? (
            <ul className="flex flex-col">
              {ruled(form).map((t) => (
                <li key={t} className="flex min-h-12 items-center gap-4">
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{t}</span>
                  <Select
                    value={form.rules[t] ?? 'default'}
                    onValueChange={(v) => set({ rules: { ...form.rules, [t]: v as Rule } })}
                  >
                    <SelectTrigger aria-label={`Hyväksyntä: ${t}`} className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper" align="end">
                      {RULES.map((r) => (
                        <SelectItem key={r.value} value={r.value}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-meta text-muted-foreground">Ei sallittuja työkaluja.</p>
          )}
        </Field>
        <Row
          label="Aliagentit"
          htmlFor="agent-subagents"
          helper="Agentti voi antaa osatehtäviä omille aliagenteilleen."
        >
          <Switch
            id="agent-subagents"
            checked={form.subagents}
            aria-describedby="agent-subagents-help"
            onCheckedChange={(subagents) => set({ subagents })}
          />
        </Row>
      </TabsContent>
      <TabsContent value="yaml" className="flex flex-col divide-y divide-border pt-2">
        <Field id="agent-yaml" label="Tiedosto" error={errorAt('agent-yaml')}>
          <Textarea
            id="agent-yaml"
            value={yaml}
            rows={16}
            // YAML indentation must read as written: no soft wrap, the field scrolls instead.
            // Phones (16 px text, UI review 4): 24 px lines, and a long line wraps
            // (`pre-wrap` keeps the indentation).
            wrap="off"
            spellCheck={false}
            className="max-h-[60dvh] min-h-64 font-mono text-[13px] leading-5 max-md:leading-6 max-md:whitespace-pre-wrap"
            {...invalid('agent-yaml', errorAt('agent-yaml'))}
            onChange={(e) => {
              ed.touch();
              setYaml(e.target.value);
            }}
          />
        </Field>
        {/* The prompt is its own file: both tabs edit it (a broken file can get one here). */}
        {promptField}
      </TabsContent>
      {ed.guard}
    </EditorPage>
  );
}

const COPY = ' (kopio)';

/** Why a delete was refused (decision 5). */
function deleteError(err: unknown) {
  if (!(err instanceof HttpError)) return 'Poisto epäonnistui. Yritä uudelleen.';
  if (err.code === 'default_agent') return 'Oletusagenttia ei voi poistaa.';
  if (err.code !== 'in_use') return 'Poisto epäonnistui. Yritä uudelleen.';
  const autos = err.detail.automations ?? [];
  return autos.length
    ? `Agentti on käytössä. Odota, että keskustelu päättyy, tai poista ensin automaatiot: ${autos.join(', ')}.`
    : 'Agentti on käytössä. Odota, että keskustelu päättyy.';
}

/**
 * Agentit (phase-15 UI): the profiles of `agents/` and, under "Tilat", the mode files (phase-23
 * decision 14); each opens its editor in place of the list. Rows 56 h (brief 7.5).
 */
export function AgentsScreen() {
  const [list, setList] = useState<AgentList | null>(null);
  const [editing, setEditing] = useState<AgentDoc | 'new' | null>(null);
  const [mode, setMode] = useState<ModeDoc | 'new' | null>(null);
  const [remove, setRemove] = useState<AgentDoc | null>(null);
  const load = () =>
    void agentsList().then(setList, () =>
      useStore.getState().pushError('Agentteja ei voitu hakea.'),
    );
  useEffect(load, []);
  const nameOf = (d: AgentDoc) => d.profile?.name ?? d.id;

  const duplicate = (d: AgentDoc) => {
    if (!d.profile) return;
    // The name has at most 80 characters (AgentFile).
    const name = `${d.profile.name.slice(0, 80 - COPY.length)}${COPY}`;
    void agentSave(
      undefined,
      { profile: { ...fieldsOf(formOf(d.profile)), name, skills: d.profile.skills } },
      d.prompt,
    ).then(
      () => {
        useStore.getState().notify(`Monistettu: ${name}`);
        load();
      },
      () => useStore.getState().pushError('Monistus epäonnistui. Yritä uudelleen.'),
    );
  };
  const drop = (d: AgentDoc) => {
    setRemove(null);
    void agentDelete(d.id).then(load, (err) => useStore.getState().pushError(deleteError(err)));
  };

  if (list && mode)
    return (
      <ModeEditor
        doc={mode === 'new' ? null : mode}
        onDone={() => {
          setMode(null);
          load();
        }}
      />
    );
  if (list && editing)
    return (
      <AgentEditor
        doc={editing === 'new' ? null : editing}
        list={list}
        onDone={() => {
          setEditing(null);
          load();
        }}
      />
    );

  return (
    <Page
      title={AGENTS_TITLE}
      action={
        // `sm` as "Uusi tila" (32 px; 44 and full width on phones).
        <Button variant="outline" size="sm" disabled={!list} onClick={() => setEditing('new')}>
          <Plus size={16} />
          Uusi agentti
        </Button>
      }
    >
      <section aria-label="Agenttiprofiilit" className="flex flex-col">
        <ListSkeleton loading={!list} />
        {list && !list.agents.length && <EmptyState Icon={Bot} title="Ei agentteja" />}
        <ul className="flex flex-col divide-y divide-border border-y empty:hidden">
          {list?.agents.map((d) => (
            // Brief 7.5: 56 px rows. Phones: the badge under the meta line, so the model id
            // shows in full (UI review 3).
            <li key={d.id} className="flex min-h-14 items-center gap-3 py-1.5">
              <div className="flex min-w-0 flex-1 items-center gap-3 max-md:flex-col max-md:items-start max-md:gap-1">
                <div className="min-w-0 max-md:self-stretch md:flex-1">
                  <div className="truncate font-medium">{nameOf(d)}</div>
                  <div className="truncate font-mono text-meta text-muted-foreground">
                    {d.id}
                    {d.profile && ` · ${d.profile.model}`}
                  </div>
                </div>
                {!d.profile ? (
                  <Badge variant="destructive">Virheellinen</Badge>
                ) : (
                  <Badge variant={d.profile.subagents ? 'info' : 'secondary'}>
                    {d.profile.subagents ? 'Aliagentit käytössä' : 'Ei aliagentteja'}
                  </Badge>
                )}
              </div>
              <ActionMenu
                label={`Toiminnot: ${nameOf(d)}`}
                small
                actions={[
                  { label: 'Muokkaa', Icon: Pencil, run: () => setEditing(d) },
                  ...(d.profile ? [{ label: 'Monista', Icon: Copy, run: () => duplicate(d) }] : []),
                  ...(d.id === list.defaultId || d.id === DEFAULT_AGENT_ID
                    ? []
                    : [{ label: 'Poista', Icon: Trash2, run: () => setRemove(d) }]),
                ]}
              />
            </li>
          ))}
        </ul>
      </section>
      {list && <ModesSection list={list} onEdit={setMode} onChange={load} />}
      <DeleteDialog
        kind="agentti"
        name={remove && nameOf(remove)}
        onDelete={() => remove && drop(remove)}
        onClose={() => setRemove(null)}
      >
        Agentin keskustelut siirtyvät Avustajalle.
      </DeleteDialog>
    </Page>
  );
}
