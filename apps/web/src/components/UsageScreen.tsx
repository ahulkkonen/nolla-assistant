import { formatCost, formatTokens } from '@nolla/protocol';
import { ChartColumn } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useStore } from '../store.ts';
import { cacheRate, count, withRate } from '../thread.ts';
import { openRoute } from '../useModel.ts';
import { send } from '../ws.ts';
import { EmptyState, ListSkeleton, Page } from './Page.tsx';

export const USAGE_TITLE = 'Käyttö';

const monthName = new Intl.DateTimeFormat('fi', { month: 'long', year: 'numeric' });
const rateDate = new Intl.DateTimeFormat('fi', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
});
const rateValue = new Intl.NumberFormat('fi', { maximumFractionDigits: 4 });

/** "2026-10" → "lokakuu 2026". */
const monthLabel = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return monthName.format(new Date(y ?? 1970, (mo ?? 1) - 1, 1));
};
/** This month in the browser's time zone, as `usage.get` takes it. */
const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const callCount = (n: number) => `${count.format(n)} ${n === 1 ? 'kutsu' : 'kutsua'}`;

type BreakdownRow = {
  key: string;
  name: string;
  badge?: ReactNode;
  calls: number;
  tokens: number;
  costUsd: number;
  estimated: boolean;
  /** The month's token split (phase 16): model rows have it, agent rows do not. */
  input?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
};

/** One grouping of the month: a table at 768 and up, cards below (brief 7.10 4a). */
function Breakdown({
  label,
  head,
  rows,
  cost,
  cacheColumn = false,
}: {
  label: string;
  head: string;
  rows: BreakdownRow[];
  cost: (usd: number, estimated: boolean) => string;
  /**
   * Model rows carry the token split; agent rows do not, so their "Välimuisti" column stays empty.
   * Both tables keep the column, so they share one grid.
   */
  cacheColumn?: boolean;
}) {
  return (
    <>
      <div className="max-md:hidden">
        <Table
          label={label}
          className="table-fixed [&_td:first-child]:pl-0 [&_td:last-child]:pr-0 [&_th:first-child]:pl-0 [&_th:last-child]:pr-0"
        >
          <TableHeader>
            <TableRow>
              <TableHead>{head}</TableHead>
              {/* Fixed numeric widths: the model and agent tables line up. */}
              <TableHead className="w-20 text-right">Kutsut</TableHead>
              <TableHead className="w-24 text-right">Tokenit</TableHead>
              <TableHead className="w-24 text-right">
                {cacheColumn ? 'Välimuisti' : <span className="sr-only">Välimuisti</span>}
              </TableHead>
              <TableHead className="w-24 text-right">Kustannus</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="w-full max-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{r.name}</span>
                    {r.badge}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{count.format(r.calls)}</TableCell>
                <TableCell className="text-right tabular-nums">{count.format(r.tokens)}</TableCell>
                <TableCell
                  className={cn(
                    'text-right tabular-nums',
                    !cacheRate(r) && 'text-muted-foreground',
                  )}
                >
                  {cacheColumn ? (cacheRate(r) ?? '–') : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {cost(r.costUsd, r.estimated)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col gap-2 md:hidden" aria-label={label}>
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{r.name}</span>
                {r.badge}
              </div>
              <p className="text-meta text-muted-foreground tabular-nums">
                {withRate(`${callCount(r.calls)} · ${formatTokens(r.tokens)}`, r)}
              </p>
            </div>
            <span className="shrink-0 tabular-nums">{cost(r.costUsd, r.estimated)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Käyttö (phase-13 UI): the month's model calls grouped by model, the costliest first, in euros
 * at the newest ECB rate (dollars without one).
 */
export function UsageScreen() {
  const usage = useStore((s) => s.usage);
  const fx = useStore((s) => s.fx);
  const agents = useStore((s) => s.agents);
  const [month, setMonth] = useState(thisMonth);
  useEffect(() => send({ type: 'usage.get', month }), [month]);
  // Back in the window: the month may have new calls.
  useEffect(() => {
    const again = () => send({ type: 'usage.get', month });
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [month]);

  const data = usage?.month === month ? usage : null;
  const rows = [...(data?.rows ?? [])].sort((a, b) => b.costUsd - a.costUsd);
  const total = rows.reduce((n, r) => n + r.costUsd, 0);
  const tokens = rows.reduce((n, r) => n + r.tokens, 0);
  const calls = rows.reduce((n, r) => n + r.calls, 0);
  const estimated = rows.some((r) => r.estimated);
  // This month is always there, also before its first call.
  const now = thisMonth();
  const months = [...new Set([now, month, ...(usage?.months ?? [])])].sort().reverse();
  // One rounding rule with the thread: three decimals below 0,10 €.
  const cost = (usd: number, est: boolean) => formatCost(usd, fx, { reply: true, estimated: est });
  const zdrOff = (model: string) => openRoute(model) && <Badge variant="warning">Ei ZDR</Badge>;
  // A null id is a task without a chat; a deleted agent keeps its id (phase-15 decision 19).
  const agentRows = (data?.agents ?? []).map((r) => ({
    ...r,
    key: r.agentId ?? '',
    name:
      r.agentId === null
        ? 'Tehtävät ilman keskustelua'
        : (agents.find((a) => a.id === r.agentId)?.name ?? r.agentId),
  }));

  return (
    <Page
      title={USAGE_TITLE}
      wide
      action={
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger aria-label="Kuukausi" className="w-40 max-md:w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            {months.map((m) => (
              <SelectItem key={m} value={m}>
                {monthLabel(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {!data ? (
        <ListSkeleton loading />
      ) : !rows.length ? (
        <EmptyState
          Icon={ChartColumn}
          title="Ei käyttöä tässä kuussa"
          line="Kustannukset näkyvät, kun malli on vastannut."
        />
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-title tabular-nums">{cost(total, estimated)}</p>
            <p className="text-meta text-muted-foreground tabular-nums">
              {formatTokens(tokens)} · {callCount(calls)}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-heading">Malleittain</h2>
            <Breakdown
              label="Mallit"
              head="Malli"
              cost={cost}
              cacheColumn
              rows={rows.map((r) => ({
                ...r,
                key: r.model,
                badge: zdrOff(r.model),
              }))}
            />
          </div>
          {agentRows.length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="text-heading">Agenteittain</h2>
              <Breakdown label="Agenteittain" head="Agentti" cost={cost} rows={agentRows} />
            </div>
          )}
        </>
      )}
      {rows.length > 0 && (
        // One footer group, 32 px under the last table (the page gap), lines 8 px apart.
        <div className="flex flex-col gap-2 text-meta text-muted-foreground">
          {data?.searches !== undefined && (
            <p className="tabular-nums">Verkkohaut: {count.format(data.searches)}</p>
          )}
          <p>
            {fx
              ? `Kurssi: EKP ${rateDate.format(new Date(fx.date))}, 1 € = ${rateValue.format(fx.usdPerEur)} $.`
              : 'Euromuunnos ei ole saatavilla. Summat ovat dollareina.'}
          </p>
          {estimated && <p>~ = arvio hinnaston mukaan.</p>}
        </div>
      )}
    </Page>
  );
}
