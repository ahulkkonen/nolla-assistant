import type { AgentList, ModeDoc, ModeFile } from '@pa/protocol';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TabsContent } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { HttpError, modeDelete, modeSave } from '../api.ts';
import { useStore } from '../store.ts';
import { ActionMenu } from './Actions.tsx';
import { DeleteDialog } from './ConfirmDialog.tsx';
import {
  CHECK_FIELD,
  Field,
  type FieldError,
  invalid,
  type SaveFields,
  saveFailure,
  useEditor,
} from './Field.tsx';
import { EditorPage } from './Page.tsx';
import { Row } from './SettingsDialog.tsx';

/** The form's fields (phase-23 decision 14); `renderer` is kept, not edited. */
type Form = ModeFile & { body: string };
const formOf = (file: ModeFile | null, body: string): Form => ({
  name: '',
  description: '',
  ...file,
  body,
});

/** Where a refused save goes; `renderer` is only in the file, so the Markdown tab has it. */
const FIELDS: SaveFields = {
  file: 'mode-file',
  tab: 'Markdown',
  name: 'mode-name',
  fields: [
    ['name', 'mode-name'],
    ['description', 'mode-description'],
    ['body', 'mode-body'],
  ],
};

/** The mode editor (phase-23 decision 14): "Lomake" and "Markdown", a dry run on each switch. */
export function ModeEditor({ doc, onDone }: { doc: ModeDoc | null; onDone: () => void }) {
  const [raw, setRaw] = useState(doc?.raw ?? '');
  const ed = useEditor({
    form: formOf(doc?.file ?? null, doc?.body ?? ''),
    // A file that fails its check opens in Markdown, with its error.
    tab: doc && !doc.file ? 'file' : ('form' as 'form' | 'file'),
    error: doc?.error ? { field: 'mode-file', message: doc.error } : null,
    leave: 'Tilaan tehdyt muokkaukset menetetään.',
    call: async ({ body, ...file }, tab, dry) => {
      // The server's union check would only say "invalid" for an empty instruction.
      if (tab === 'form' && !body.trim())
        throw { field: 'mode-body', message: CHECK_FIELD } satisfies FieldError;
      const fields = { ...file, name: file.name.trim(), description: file.description.trim() };
      try {
        return await modeSave(
          doc?.id,
          tab === 'form' ? { file: fields, body: body.trim() } : { raw },
          dry,
        );
      } catch (err) {
        throw saveFailure(err, tab === 'file', FIELDS);
      }
    },
    take: (checked, next, replace) => {
      if (next === 'file') setRaw(checked.raw);
      else if (checked.file) replace(formOf(checked.file, checked.body));
    },
    onDone,
  });
  const { form, set, at } = ed;

  const text = (id: string, key: 'name' | 'description') => (
    <Input
      id={id}
      value={form[key]}
      autoComplete="off"
      {...invalid(id, at(id))}
      onChange={(e) => set({ [key]: e.target.value })}
    />
  );

  return (
    <EditorPage
      title="Agentit"
      heading={doc ? (doc.file?.name ?? doc.id) : 'Uusi tila'}
      id={doc?.id}
      tabs={[
        ['form', 'Lomake'],
        ['file', 'Markdown'],
      ]}
      {...ed.page}
    >
      <TabsContent value="form" className="flex flex-col divide-y divide-border pt-2">
        <Field id="mode-name" label="Nimi" error={at('mode-name')}>
          {text('mode-name', 'name')}
        </Field>
        <Field
          id="mode-description"
          label="Kuvaus"
          helper="Näkyy Tila-valikossa nimen alla."
          error={at('mode-description')}
        >
          {text('mode-description', 'description')}
        </Field>
        <Field
          id="mode-body"
          label="Ohje"
          helper="Lisätään mallin ohjeeseen, kun tila on päällä."
          error={at('mode-body')}
        >
          <Textarea
            id="mode-body"
            value={form.body}
            rows={6}
            className="max-h-80 min-h-32"
            {...invalid('mode-body', at('mode-body'))}
            onChange={(e) => set({ body: e.target.value })}
          />
        </Field>
        {form.renderer && (
          <Row label="Esitystapa" helper="Vaihdettavissa välilehdellä Markdown.">
            <span className="font-mono text-[13px]">{form.renderer}</span>
          </Row>
        )}
      </TabsContent>
      <TabsContent value="file" className="flex flex-col pt-2">
        <Field id="mode-file" label="Tiedosto" error={at('mode-file')}>
          <Textarea
            id="mode-file"
            value={raw}
            rows={14}
            spellCheck={false}
            className="max-h-[60dvh] min-h-64 font-mono text-[13px] leading-5"
            {...invalid('mode-file', at('mode-file'))}
            onChange={(e) => {
              ed.touch();
              setRaw(e.target.value);
            }}
          />
        </Field>
      </TabsContent>
      {ed.guard}
    </EditorPage>
  );
}

/** Why a delete was refused: a profile names the mode in `modes.default`. */
function deleteError(err: unknown, list: AgentList) {
  if (!(err instanceof HttpError) || err.code !== 'in_use')
    return 'Poisto epäonnistui. Yritä uudelleen.';
  const names = (err.detail.agents ?? []).map(
    (id) => list.agents.find((a) => a.id === id)?.profile?.name ?? id,
  );
  return names.length > 1
    ? `Agentit ${names.join(', ')} käyttävät tilaa oletuksena. Poista se ensin niiden oletustiloista.`
    : `Agentti ${names[0] ?? ''} käyttää tilaa oletuksena. Poista se ensin sen oletustiloista.`;
}

/**
 * "Tilat" in Agentit (phase-23 decision 14): one 56 px row per mode file, "Oletus" when a profile
 * names it, "Uusi tila", and the delete with its confirmation.
 */
export function ModesSection({
  list,
  onEdit,
  onChange,
}: {
  list: AgentList;
  onEdit: (doc: ModeDoc | 'new') => void;
  onChange: () => void;
}) {
  const [remove, setRemove] = useState<ModeDoc | null>(null);
  const nameOf = (d: ModeDoc) => d.file?.name ?? d.id;
  const drop = (d: ModeDoc) => {
    setRemove(null);
    void modeDelete(d.id).then(onChange, (err) =>
      useStore.getState().pushError(deleteError(err, list)),
    );
  };
  return (
    <section aria-labelledby="modes-title" className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <h2 id="modes-title" className="min-w-0 flex-1 text-heading">
          Tilat
        </h2>
        <Button variant="outline" size="sm" onClick={() => onEdit('new')}>
          <Plus size={16} />
          Uusi tila
        </Button>
      </div>
      {list.modes.length ? (
        <ul className="flex flex-col divide-y divide-border border-y">
          {list.modes.map((d) => (
            <li key={d.id} className="flex min-h-14 items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{nameOf(d)}</div>
                <div className="truncate text-meta text-muted-foreground">
                  {d.file ? d.file.description || d.id : d.error}
                </div>
              </div>
              {!d.file ? (
                <Badge variant="destructive">virheellinen</Badge>
              ) : (
                list.agents.some((a) => a.profile?.modes.default.includes(d.id)) && (
                  <Badge variant="secondary">Oletus</Badge>
                )
              )}
              <ActionMenu
                label={`Toiminnot: ${nameOf(d)}`}
                small
                actions={[
                  { label: 'Muokkaa', Icon: Pencil, run: () => onEdit(d) },
                  { label: 'Poista', Icon: Trash2, run: () => setRemove(d) },
                ]}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-meta text-muted-foreground">Ei tiloja.</p>
      )}
      <DeleteDialog
        kind="tila"
        name={remove && nameOf(remove)}
        onDelete={() => remove && drop(remove)}
        onClose={() => setRemove(null)}
      >
        Keskustelut, joissa tila on päällä, jatkavat ilman sitä.
      </DeleteDialog>
    </section>
  );
}
