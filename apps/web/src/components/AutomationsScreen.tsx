import { CalendarClock, Play } from 'lucide-react';
import { useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cronText } from '../cron.ts';
import { type Automation, useStore } from '../store.ts';
import { send } from '../ws.ts';
import { ActionMenu } from './Actions.tsx';
import { IconButton, Tip } from './IconButton.tsx';
import { EmptyState, ListSkeleton, Page } from './Page.tsx';

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
const DELIVER = { chat: 'keskustelu', push: 'ilmoitus', both: 'molemmat' } as const;
const deliver = (a: Automation) => (a.deliver ? DELIVER[a.deliver] : '–');

/** Finnish schedule; the raw expression in the tooltip. */
function Cron({ cron }: { cron: string }) {
  return (
    <Tip label={cron}>
      <span
        // Focus shows the raw expression too.
        tabIndex={0}
        className="underline decoration-input decoration-dotted underline-offset-3"
      >
        {cronText(cron)}
      </span>
    </Tip>
  );
}

const run = (a: Automation) => () => send({ type: 'automations.run', id: a.id });

export function AutomationsScreen() {
  const automations = useStore((s) => s.automations);
  const agents = useStore((s) => s.agents);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  useEffect(() => send({ type: 'automations.list' }), []);

  return (
    <Page title={AUTOMATIONS_TITLE} wide>
      {!automations ? (
        <ListSkeleton loading />
      ) : !automations.length ? (
        <EmptyState
          Icon={CalendarClock}
          title="Ei automaatioita"
          line="Lisää automaatio tiedostona kansioon automations/."
        />
      ) : (
        <>
          <div className="max-md:hidden">
            <Table label="Automaatiot" className="[&_td:first-child]:pl-0 [&_th:first-child]:pl-0">
              <TableHeader>
                <TableRow>
                  <TableHead>Nimi</TableHead>
                  <TableHead>Ajastus</TableHead>
                  <TableHead>Agentti</TableHead>
                  <TableHead>Toimitus</TableHead>
                  <TableHead>Tila</TableHead>
                  <TableHead>Viimeksi</TableHead>
                  <TableHead>Tulos</TableHead>
                  <TableHead>
                    <span className="sr-only">Toiminnot</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {automations.map((a) => (
                  <TableRow key={a.id} className="group/row">
                    <TableCell className="font-mono text-ui">{a.id}</TableCell>
                    <TableCell>
                      <Cron cron={a.cron} />
                    </TableCell>
                    <TableCell>{agentName(a.agentId)}</TableCell>
                    <TableCell className="text-muted-foreground">{deliver(a)}</TableCell>
                    <TableCell>
                      <Badge variant={a.enabled ? 'success' : 'secondary'}>
                        {a.enabled ? 'käytössä' : 'ei käytössä'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{ago(a.lastRunAt)}</TableCell>
                    <TableCell>
                      <Result a={a} />
                    </TableCell>
                    <TableCell className="w-0 pr-0">
                      {/* Row actions show on hover or focus (brief 7.5). */}
                      <div className="flex justify-end opacity-0 transition-opacity duration-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100">
                        <IconButton
                          label={`Suorita nyt: ${a.id}`}
                          className="size-7"
                          onClick={run(a)}
                        >
                          <Play size={16} />
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
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono font-medium">{a.id}</span>
                    {a.lastStatus && <Result a={a} />}
                  </div>
                  <div className="text-meta text-muted-foreground">
                    <Cron cron={a.cron} /> · {agentName(a.agentId)} · {deliver(a)} ·{' '}
                    {a.enabled ? 'käytössä' : 'ei käytössä'} · {ago(a.lastRunAt)}
                  </div>
                </div>
                <ActionMenu
                  label={`Toiminnot: ${a.id}`}
                  actions={[{ label: `Suorita nyt: ${a.id}`, Icon: Play, run: run(a) }]}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </Page>
  );
}
