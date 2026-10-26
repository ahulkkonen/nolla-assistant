import { type AgentList, cronToSchedule, type Schedule, scheduleToCron } from '@pa/protocol';
import { CalendarClock, Pencil, Play, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { agentsList, automationDelete, automationSave, cronPreview, HttpError } from '../api.ts';
import { runText, scheduleText } from '../cron.ts';
import { type Automation, useStore } from '../store.ts';
import { send } from '../ws.ts';
import { ActionMenu } from './Actions.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { CHECK_FIELD, Checks, Field, invalid, useFieldError } from './Field.tsx';
import { IconButton, Tip } from './IconButton.tsx';
import { EmptyState, ListSkeleton, Page } from './Page.tsx';
import { Segmented } from './Segmented.tsx';
import { Row } from './SettingsDialog.tsx';

export const AUTOMATIONS_TITLE = 'Automaatiot';

const rtf = new Intl.RelativeTimeFormat('fi', { numeric: 'auto' });
/** "5 minuuttia sitten", "eilen"; "ei vielä ajettu" for never. */
export function ago(iso: string | null, now = Date.now()) {
  if (!iso) return 'ei vielä ajettu';
  const s = (Date.parse(iso) - now) / 1000;
  for (const [unit, size] of [
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ] as const)
    if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return rtf.format(Math.round(s), 'second');
}

type Variant = 'success' | 'destructive' | 'info' | 'secondary';
const STATUS: Record<string, [string, Variant]> = {
  ok: ['onnistui', 'success'],
  error: ['virhe', 'destructive'],
  running: ['käynnissä', 'info'],
};
/** The last result as a badge (brief 7.5); none before the first run. */
function Result({ a }: { a: Automation }) {
  if (!a.lastStatus) return <span className="text-muted-foreground">–</span>;
  const [text, variant] = STATUS[a.lastStatus] ?? [a.lastStatus, 'secondary'];
  return <Badge variant={variant}>{text}</Badge>;
}

/** The schedule in words; the raw expression in the tooltip. */
function Cron({ cron }: { cron: string }) {
  return (
    <Tip label={cron}>
      <span
        // Focus shows the raw expression too.
        tabIndex={0}
        className="underline decoration-input decoration-dotted underline-offset-3"
      >
        {scheduleText(cron)}
      </span>
    </Tip>
  );
}

const TZ = 'Europe/Helsinki';
const DELIVER = [
  { value: 'chat', label: 'Keskusteluun' },
  { value: 'push', label: 'Ilmoituksena' },
  { value: 'both', label: 'Molemmat' },
] as const;
type Deliver = (typeof DELIVER)[number]['value'];
const KINDS = [
  { value: 'daily', label: 'Päivittäin' },
  { value: 'weekdays', label: 'Arkisin' },
  { value: 'weekly', label: 'Viikoittain' },
  { value: 'custom', label: 'Oma' },
] as const;
const WEEKDAYS = [
  'maanantai',
  'tiistai',
  'keskiviikko',
  'torstai',
  'perjantai',
  'lauantai',
  'sunnuntai',
];

type Draft = {
  name: string;
  agentId: string;
  prompt: string;
  deliver: Deliver;
  kind: Schedule['kind'];
  /** "07:30", the time input's value. */
  time: string;
  /** 0 Sunday … 6 Saturday. */
  day: number;
  cron: string;
  enabled: boolean;
  autoApprove: string[];
};
const pad = (n: number) => String(n).padStart(2, '0');
function draftOf(a: Automation | null, agentId: string): Draft {
  const cron = a?.cron ?? '0 8 * * *';
  const s = cronToSchedule(cron);
  const preset = s.kind === 'custom' ? null : s;
  return {
    name: a?.name ?? '',
    agentId: a?.agentId ?? agentId,
    prompt: a?.prompt ?? '',
    deliver: a?.deliver ?? 'chat',
    kind: s.kind,
    time: preset ? `${pad(preset.hour)}:${pad(preset.minute)}` : '07:30',
    day: preset?.kind === 'weekly' ? preset.day : 1,
    cron,
    enabled: a?.enabled ?? true,
    autoApprove: a?.autoApprove ?? [],
  };
}
const cronOf = (d: Draft) => {
  if (d.kind === 'custom') return d.cron.trim();
  const [hour = 0, minute = 0] = d.time.split(':').map(Number);
  return scheduleToCron(
    d.kind === 'weekly'
      ? { kind: d.kind, day: d.day, hour, minute }
      : { kind: d.kind, hour, minute },
  );
};

/** The form field of a server `path` (phase-15 decision 2). */
const fieldOf = (path: string | undefined, custom: boolean) =>
  ({
    name: 'auto-name',
    id: 'auto-name',
    agentId: 'auto-agent',
    prompt: 'auto-prompt',
    cron: custom ? 'auto-cron' : 'auto-time',
    autoApprove: 'auto-approve',
  })[path?.split('.')[0] ?? ''];

/** The editor (phase-15 UI): fields, the schedule presets and the next five runs. */
function AutomationEditor({ item, onDone }: { item: Automation | null; onDone: () => void }) {
  const agents = useStore((s) => s.agents);
  const [d, setD] = useState(() => draftOf(item, agents[0]?.id ?? 'assistant'));
  const [list, setList] = useState<AgentList | null>(null);
  const [runs, setRuns] = useState<string[] | null>(null);
  const { error, setError, at: errorAt } = useFieldError();
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState(false);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const cron = cronOf(d);

  useEffect(() => void agentsList().then(setList, () => {}), []);
  // The next runs from the server's own scheduler, 300 ms after the last change (decision 9).
  const [previewError, setPreviewError] = useState(false);
  useEffect(() => {
    const t = setTimeout(
      () =>
        void cronPreview(cron, item?.timezone ?? TZ).then(
          (r) => {
            setRuns(r.runs);
            setPreviewError(false);
          },
          () => {
            setRuns(null);
            setPreviewError(true);
          },
        ),
      300,
    );
    return () => clearTimeout(t);
  }, [cron, item?.timezone]);

  const always = list?.agents.find((a) => a.id === d.agentId)?.profile?.approval.always ?? null;
  const save = async () => {
    setBusy(true);
    try {
      await automationSave(item?.id, {
        name: d.name.trim() || null,
        agentId: d.agentId,
        prompt: d.prompt,
        deliver: d.deliver,
        cron,
        timezone: item?.timezone ?? TZ,
        enabled: d.enabled,
        autoApprove: always ? d.autoApprove.filter((t) => always.includes(t)) : d.autoApprove,
      });
      useStore.getState().notify('Tallennettu');
      onDone();
    } catch (err) {
      const bad = err instanceof HttpError && err.code === 'bad_message';
      const field = bad ? fieldOf(err.detail.path, d.kind === 'custom') : undefined;
      setError(
        field
          ? { field, message: CHECK_FIELD }
          : err instanceof HttpError && err.code === 'exists'
            ? { field: 'auto-name', message: 'Tunniste on jo käytössä.' }
            : { field: undefined, message: 'Tallennus epäonnistui. Yritä uudelleen.' },
      );
    } finally {
      setBusy(false);
    }
  };
  const drop = () => {
    setRemove(false);
    if (item)
      void automationDelete(item.id).then(onDone, () =>
        useStore.getState().pushError('Poisto epäonnistui. Yritä uudelleen.'),
      );
  };
  const title = item ? (item.name ?? item.id) : 'Uusi automaatio';

  return (
    <section aria-labelledby="auto-editor-title" className="flex flex-col gap-4">
      <h2 id="auto-editor-title" className="truncate text-heading">
        {title}
      </h2>
      <div className="flex flex-col divide-y divide-border">
        {error && !error.field && (
          <p role="alert" className="py-3 text-meta text-destructive">
            {error.message}
          </p>
        )}
        <Field id="auto-name" label="Nimi" error={errorAt('auto-name')}>
          <Input
            id="auto-name"
            value={d.name}
            autoComplete="off"
            {...invalid('auto-name', errorAt('auto-name'))}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field id="auto-agent" label="Agentti" error={errorAt('auto-agent')}>
          <Select value={d.agentId} onValueChange={(agentId) => set({ agentId })}>
            <SelectTrigger
              id="auto-agent"
              className="w-full"
              {...invalid('auto-agent', errorAt('auto-agent'))}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
              {!agents.some((a) => a.id === d.agentId) && (
                <SelectItem value={d.agentId}>{d.agentId}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </Field>
        <Field id="auto-prompt" label="Ohje" error={errorAt('auto-prompt')}>
          <Textarea
            id="auto-prompt"
            value={d.prompt}
            rows={4}
            className="max-h-[40dvh] min-h-24"
            {...invalid('auto-prompt', errorAt('auto-prompt'))}
            onChange={(e) => set({ prompt: e.target.value })}
          />
        </Field>
        {/* The segmented controls carry their names; the visible captions are for the eye. */}
        <div className="flex flex-col gap-1.5 py-3">
          <span aria-hidden="true" className="text-ui font-medium">
            Toimitus
          </span>
          <Segmented
            label="Toimitus"
            options={DELIVER}
            value={d.deliver}
            onChange={(deliver) => set({ deliver })}
          />
        </div>
        <div className="flex flex-col gap-1.5 py-3">
          <span aria-hidden="true" className="text-ui font-medium">
            Aikataulu
          </span>
          <Segmented
            label="Aikataulu"
            options={KINDS}
            value={d.kind}
            // Oma starts from the expression of the preset on screen.
            onChange={(kind) => set(kind === 'custom' ? { kind, cron } : { kind })}
          />
        </div>
        {d.kind === 'custom' ? (
          <Field
            id="auto-cron"
            label="Cron-lauseke"
            helper="Minuutti, tunti, päivä, kuukausi, viikonpäivä. Ajojen väli vähintään 5 minuuttia."
            error={errorAt('auto-cron') ?? (previewError ? CHECK_FIELD : null)}
          >
            <Input
              id="auto-cron"
              value={d.cron}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              {...invalid('auto-cron', errorAt('auto-cron') ?? (previewError ? CHECK_FIELD : null))}
              onChange={(e) => set({ cron: e.target.value })}
            />
          </Field>
        ) : (
          <div className="flex gap-4">
            <Field id="auto-time" label="Kellonaika" error={errorAt('auto-time')} className="w-36">
              <Input
                id="auto-time"
                type="time"
                value={d.time}
                required
                {...invalid('auto-time', errorAt('auto-time'))}
                onChange={(e) => e.target.value && set({ time: e.target.value })}
              />
            </Field>
            {d.kind === 'weekly' && (
              <Field id="auto-day" label="Viikonpäivä" className="min-w-0 flex-1">
                <Select value={String(d.day)} onValueChange={(v) => set({ day: Number(v) })}>
                  <SelectTrigger id="auto-day" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {WEEKDAYS.map((name, i) => (
                      <SelectItem key={name} value={String((i + 1) % 7)}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>
        )}
        <div className="flex flex-col gap-1.5 py-3">
          <h3 id="auto-runs" className="text-ui font-medium">
            Seuraavat ajot
          </h3>
          {runs ? (
            <ol aria-labelledby="auto-runs" className="flex flex-col text-ui tabular-nums">
              {runs.map((r) => (
                <li key={r} className="flex min-h-7 items-center">
                  {runText(r)}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-meta text-muted-foreground">
              {previewError ? 'Aikataulusta ei saatu ajoja.' : 'Haetaan…'}
            </p>
          )}
        </div>
        <Field id="auto-approve" label="Saa ajaa kysymättä" group error={errorAt('auto-approve')}>
          {always?.length ? (
            <Checks
              options={always}
              value={d.autoApprove}
              onChange={(autoApprove) => set({ autoApprove })}
            />
          ) : (
            <p className="text-meta text-muted-foreground">
              {always ? 'Agentin työkalut eivät kysy hyväksyntää.' : 'Haetaan…'}
            </p>
          )}
        </Field>
        <Row label="Käytössä" htmlFor="auto-enabled" helper="Pois päältä automaatio ei aja itse.">
          <Switch
            id="auto-enabled"
            checked={d.enabled}
            aria-describedby="auto-enabled-help"
            onCheckedChange={(enabled) => set({ enabled })}
          />
        </Row>
      </div>
      <div className="flex flex-wrap gap-2 max-sm:grid max-sm:grid-cols-2">
        {item && (
          <Button variant="outline" className="max-sm:col-span-2" onClick={() => setRemove(true)}>
            Poista
          </Button>
        )}
        <Button variant="outline" className="sm:ml-auto" onClick={onDone}>
          Peruuta
        </Button>
        <Button disabled={busy || !d.prompt.trim()} onClick={() => void save()}>
          Tallenna
        </Button>
      </div>
      <ConfirmDialog
        open={remove}
        title={`Poistetaanko automaatio ”${title}”?`}
        action="Poista"
        destructive
        onConfirm={drop}
        onClose={() => setRemove(false)}
      >
        Automaatio ei enää aja. Sen keskustelut jäävät.
      </ConfirmDialog>
    </section>
  );
}

const run = (a: Automation) => () => send({ type: 'automations.run', id: a.id });
const nameOf = (a: Automation) => a.name ?? a.id;
const toggle = (a: Automation, enabled: boolean) =>
  void automationSave(a.id, { enabled }).catch(() =>
    useStore.getState().pushError('Muutos epäonnistui. Yritä uudelleen.'),
  );

export function AutomationsScreen() {
  const automations = useStore((s) => s.automations);
  const agents = useStore((s) => s.agents);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const [editing, setEditing] = useState<Automation | 'new' | null>(null);

  useEffect(() => send({ type: 'automations.list' }), []);

  if (editing)
    return (
      <Page title={AUTOMATIONS_TITLE}>
        <AutomationEditor
          item={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      </Page>
    );

  const enabled = (a: Automation) => (
    <Switch
      aria-label={`Käytössä: ${nameOf(a)}`}
      checked={a.enabled}
      onCheckedChange={(on) => toggle(a, on)}
    />
  );
  const next = (a: Automation) => (a.nextRunAt ? runText(a.nextRunAt) : '–');

  return (
    <Page
      title={AUTOMATIONS_TITLE}
      wide
      action={
        <Button variant="outline" onClick={() => setEditing('new')}>
          <Plus size={16} />
          Uusi automaatio
        </Button>
      }
    >
      {!automations ? (
        <ListSkeleton loading />
      ) : !automations.length ? (
        <EmptyState
          Icon={CalendarClock}
          title="Ei automaatioita"
          line="Automaatio ajaa agentin ohjeen aikataulun mukaan."
        />
      ) : (
        <>
          <div className="max-md:hidden">
            <Table label="Automaatiot" className="[&_td:first-child]:pl-0 [&_th:first-child]:pl-0">
              <TableHeader>
                <TableRow>
                  <TableHead>Nimi</TableHead>
                  <TableHead>Aikataulu</TableHead>
                  <TableHead>Agentti</TableHead>
                  <TableHead>Seuraava</TableHead>
                  <TableHead>Viimeksi</TableHead>
                  <TableHead>Tulos</TableHead>
                  <TableHead>Käytössä</TableHead>
                  <TableHead>
                    <span className="sr-only">Toiminnot</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {automations.map((a) => (
                  <TableRow key={a.id} className="group/row">
                    <TableCell className="font-medium">{nameOf(a)}</TableCell>
                    <TableCell>
                      <Cron cron={a.cron} />
                    </TableCell>
                    <TableCell>{agentName(a.agentId)}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">{next(a)}</TableCell>
                    <TableCell className="text-muted-foreground">{ago(a.lastRunAt)}</TableCell>
                    <TableCell>
                      <Result a={a} />
                    </TableCell>
                    <TableCell>{enabled(a)}</TableCell>
                    <TableCell className="w-0 pr-0">
                      {/* Row actions show on hover or focus (brief 7.5). */}
                      <div className="flex justify-end opacity-0 transition-opacity duration-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100">
                        <IconButton
                          label={`Aja nyt: ${nameOf(a)}`}
                          className="size-7"
                          onClick={run(a)}
                        >
                          <Play size={16} />
                        </IconButton>
                        <IconButton
                          label={`Muokkaa: ${nameOf(a)}`}
                          className="size-7"
                          onClick={() => setEditing(a)}
                        >
                          <Pencil size={16} />
                        </IconButton>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="flex flex-col gap-2 md:hidden" aria-label="Automaatiot">
            {automations.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-3 rounded-lg border bg-card py-3 pr-2 pl-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{nameOf(a)}</span>
                    {a.lastStatus && <Result a={a} />}
                  </div>
                  {/* The separator ends a segment: a wrapped line never starts with "·". */}
                  <div className="flex flex-wrap gap-x-1 text-meta text-muted-foreground">
                    <span className="whitespace-nowrap">
                      <Cron cron={a.cron} /> ·
                    </span>
                    <span className="whitespace-nowrap">{agentName(a.agentId)}</span>
                  </div>
                  <div className="text-meta text-muted-foreground tabular-nums">
                    Seuraava: {next(a)}
                  </div>
                </div>
                {enabled(a)}
                <ActionMenu
                  label={`Toiminnot: ${nameOf(a)}`}
                  actions={[
                    { label: `Aja nyt: ${nameOf(a)}`, Icon: Play, run: run(a) },
                    { label: `Muokkaa: ${nameOf(a)}`, Icon: Pencil, run: () => setEditing(a) },
                  ]}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </Page>
  );
}
