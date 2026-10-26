import { type AgentDoc, type AgentFile, type AgentList, DEFAULT_AGENT_ID } from '@pa/protocol';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { agentDelete, agentSave, agentsList, HttpError } from '../api.ts';
import { useStore } from '../store.ts';
import { ActionMenu } from './Actions.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { CHECK_FIELD, Checks, Field, type FieldError, invalid, useFieldError } from './Field.tsx';
import { EmptyState, ListSkeleton, Page } from './Page.tsx';
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
});
const blank = (list: AgentList): Form => ({
  name: '',
  model: list.options.aliases[0]?.id ?? 'zdr/strong',
  allow: [],
  mcp: [],
  rules: {},
  order: [],
  subagents: false,
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
  };
};

/** The form field of a server `path` (decision 2); the id comes from the name. */
const FIELDS: [string, string][] = [
  ['name', 'agent-name'],
  ['id', 'agent-name'],
  ['model', 'agent-model'],
  ['prompt', 'agent-prompt'],
  ['tools.allow', 'agent-tools'],
  ['tools.mcp', 'agent-mcp'],
  ['approval', 'agent-approval'],
  ['subagents', 'agent-subagents'],
];
const fieldOf = (path: string | undefined) =>
  FIELDS.find(([p]) => path === p || path?.startsWith(`${p}.`))?.[1];

/** A refused save as the field and its text: "Tarkista kenttä." on the form, the server's text on YAML. */
function failure(err: unknown, tab: 'form' | 'yaml'): FieldError {
  if (!(err instanceof HttpError)) return { field: undefined, message: 'Tallennus epäonnistui.' };
  if (err.code === 'exists') return { field: 'agent-name', message: 'Tunniste on jo käytössä.' };
  if (err.code !== 'bad_message') return { field: undefined, message: 'Tallennus epäonnistui.' };
  const { path, message = '' } = err.detail;
  if (tab === 'yaml')
    return { field: 'agent-yaml', message: path ? `${path}: ${message}` : message };
  const field = fieldOf(path);
  return field ? { field, message: CHECK_FIELD } : { field: undefined, message };
}

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
  const [form, setForm] = useState<Form>(doc?.profile ? formOf(doc.profile) : blank(list));
  const [prompt, setPrompt] = useState(doc?.prompt ?? '');
  const [yaml, setYaml] = useState(doc?.yaml ?? '');
  // A file that fails the schema opens in YAML, with its error.
  const [tab, setTab] = useState<'form' | 'yaml'>(doc && !doc.profile ? 'yaml' : 'form');
  const {
    error,
    setError,
    at: errorAt,
  } = useFieldError(doc?.error ? { field: 'agent-yaml', message: doc.error } : null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  /** A save or, `dry`, the check of the tab on screen. */
  const call = async (dry: boolean) => {
    if (!prompt.trim()) {
      setTab('form');
      throw { field: 'agent-prompt', message: CHECK_FIELD } satisfies FieldError;
    }
    try {
      const body = tab === 'form' ? { profile: fieldsOf(form) } : { yaml };
      return await agentSave(doc?.id, body, prompt, dry);
    } catch (err) {
      throw failure(err, tab);
    }
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
    } catch (err) {
      setError(err as FieldError);
    } finally {
      setBusy(false);
    }
  };
  const switchTab = (next: string) =>
    next !== tab &&
    void run(async () => {
      const checked = await call(true);
      if (next === 'yaml') setYaml(checked.yaml);
      else if (checked.profile) setForm(formOf(checked.profile));
      setTab(next as 'form' | 'yaml');
    });
  const save = () =>
    void run(async () => {
      await call(false);
      useStore.getState().notify('Tallennettu');
      onDone();
    });

  const models = [
    ...list.options.aliases,
    ...catalog.filter((m) => m.zdr).map((m) => ({ id: `zdr/${m.id}`, name: m.name })),
  ];
  const tools = [...new Set([...list.options.tools, ...form.allow])];
  const general = error && !error.field ? error.message : null;

  return (
    <section aria-labelledby="agent-editor-title" className="flex flex-col gap-4">
      <div className="min-w-0">
        <h2 id="agent-editor-title" className="truncate text-heading">
          {doc ? (doc.profile?.name ?? doc.id) : 'Uusi agentti'}
        </h2>
        <p className="text-meta text-muted-foreground">
          {doc ? (
            <>
              Tunniste <span className="font-mono">{doc.id}</span>
            </>
          ) : (
            'Tunniste tehdään nimestä.'
          )}
        </p>
      </div>
      <Tabs value={tab} onValueChange={switchTab} className="gap-0">
        <TabsList className="max-md:h-11! max-md:w-full">
          <TabsTrigger value="form">Lomake</TabsTrigger>
          <TabsTrigger value="yaml">YAML</TabsTrigger>
        </TabsList>
        <TabsContent value="form" className="flex flex-col divide-y divide-border pt-2">
          {general && (
            <p role="alert" className="py-3 text-meta text-destructive">
              {general}
            </p>
          )}
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
              onChange={(e) => setPrompt(e.target.value)}
            />
          </Field>
          <Field id="agent-tools" label="Työkalut" group error={errorAt('agent-tools')}>
            <Checks options={tools} value={form.allow} onChange={(allow) => set({ allow })} />
          </Field>
          <Field id="agent-mcp" label="MCP-palvelimet" group error={errorAt('agent-mcp')}>
            {list.options.mcp.length ? (
              <Checks
                options={list.options.mcp}
                value={form.mcp}
                onChange={(mcp) => set({ mcp })}
              />
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
        <TabsContent value="yaml" className="pt-4">
          <Field
            id="agent-yaml"
            label="Tiedosto"
            helper="Ohje on omassa kentässään välilehdellä Lomake."
            error={errorAt('agent-yaml')}
            className="pt-0"
          >
            <Textarea
              id="agent-yaml"
              value={yaml}
              rows={16}
              // YAML indentation must read as written: no soft wrap, the field scrolls instead.
              wrap="off"
              spellCheck={false}
              className="max-h-[60dvh] min-h-64 font-mono text-[13px] leading-5"
              {...invalid('agent-yaml', errorAt('agent-yaml'))}
              onChange={(e) => setYaml(e.target.value)}
            />
          </Field>
        </TabsContent>
      </Tabs>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
        <Button variant="outline" onClick={onDone}>
          Peruuta
        </Button>
        <Button disabled={busy} onClick={save}>
          Tallenna
        </Button>
      </div>
    </section>
  );
}

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

/** Agentit (phase-15 UI): the profiles of `agents/`, and their editor. Rows 56 h (brief 7.5). */
export function AgentsScreen() {
  const [list, setList] = useState<AgentList | null>(null);
  const [editing, setEditing] = useState<AgentDoc | 'new' | null>(null);
  const [remove, setRemove] = useState<AgentDoc | null>(null);
  const load = () =>
    void agentsList().then(setList, () =>
      useStore.getState().pushError('Agentteja ei voitu hakea.'),
    );
  useEffect(load, []);
  const nameOf = (d: AgentDoc) => d.profile?.name ?? d.id;

  const duplicate = (d: AgentDoc) => {
    if (!d.profile) return;
    const name = `${d.profile.name} (kopio)`;
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

  if (list && editing)
    return (
      <Page title={AGENTS_TITLE}>
        <AgentEditor
          doc={editing === 'new' ? null : editing}
          list={list}
          onDone={() => {
            setEditing(null);
            load();
          }}
        />
      </Page>
    );

  return (
    <Page
      title={AGENTS_TITLE}
      action={
        <Button variant="outline" disabled={!list} onClick={() => setEditing('new')}>
          <Plus size={16} />
          Uusi agentti
        </Button>
      }
    >
      <section aria-label="Agenttiprofiilit" className="flex flex-col">
        <ListSkeleton loading={!list} />
        {list && !list.agents.length && <EmptyState Icon={Bot} title="Ei agentteja" />}
        <ul className="flex flex-col divide-y divide-border border-y max-md:border-t-0 empty:hidden">
          {list?.agents.map((d) => (
            <li key={d.id} className="flex min-h-14 items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{nameOf(d)}</div>
                <div className="truncate font-mono text-meta text-muted-foreground">
                  {d.id}
                  {d.profile && ` · ${d.profile.model}`}
                </div>
              </div>
              {!d.profile ? (
                <Badge variant="destructive">virheellinen</Badge>
              ) : (
                <Badge variant={d.profile.subagents ? 'info' : 'secondary'}>
                  {d.profile.subagents ? 'aliagentit käytössä' : 'ei aliagentteja'}
                </Badge>
              )}
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
      <ConfirmDialog
        open={!!remove}
        title={`Poistetaanko agentti ”${remove ? nameOf(remove) : ''}”?`}
        action="Poista"
        destructive
        onConfirm={() => remove && drop(remove)}
        onClose={() => setRemove(null)}
      >
        Agentin keskustelut siirtyvät Avustajalle.
      </ConfirmDialog>
    </Page>
  );
}
