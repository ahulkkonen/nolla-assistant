import { formatCost, formatTokens } from '@pa/protocol';
import { ChartColumn } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { useStore } from '../store.ts';
import { send } from '../ws.ts';
import { EmptyState, ListSkeleton, Page } from './Page.tsx';

export const USAGE_TITLE = 'Käyttö';

const num = new Intl.NumberFormat('fi');
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
const kunta = (n: number) => `${num.format(n)} ${n === 1 ? 'kutsu' : 'kutsua'}`;

/**
 * Käyttö (phase-13 UI): the month's model calls grouped by model, the costliest first, in euros
 * at the newest ECB rate (dollars without one).
 */
export function UsageScreen() {
  const usage = useStore((s) => s.usage);
  const fx = useStore((s) => s.fx);
  const [month, setMonth] = useState(thisMonth);
  useEffect(() => send({ type: 'usage.get', month }), [month]);

  const data = usage?.month === month ? usage : null;
  const rows = [...(data?.rows ?? [])].sort((a, b) => b.costUsd - a.costUsd);
  const total = rows.reduce((n, r) => n + r.costUsd, 0);
  const tokens = rows.reduce((n, r) => n + r.tokens, 0);
  const calls = rows.reduce((n, r) => n + r.calls, 0);
  const estimated = rows.some((r) => r.estimated);
  const months = usage?.months.length ? usage.months : [month];
  const cost = (usd: number, est: boolean) => formatCost(usd, fx, { estimated: est });
  const zdrOff = (model: string) =>
    model.startsWith('open/') && <Badge variant="warning">Ei ZDR</Badge>;

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
              {formatTokens(tokens)} · {kunta(calls)}
            </p>
          </div>
          <div className="max-md:hidden">
            <Table label="Mallit" className="[&_td:first-child]:pl-0 [&_th:first-child]:pl-0">
              <TableHeader>
                <TableRow>
                  <TableHead>Malli</TableHead>
                  <TableHead className="text-right">Kutsut</TableHead>
                  <TableHead className="text-right">Tokenit</TableHead>
                  <TableHead className="text-right">Kustannus</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.model}>
                    <TableCell className="w-full max-w-0">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{r.name}</span>
                        {zdrOff(r.model)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{num.format(r.calls)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num.format(r.tokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {cost(r.costUsd, r.estimated)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="flex flex-col gap-2 md:hidden" aria-label="Mallit">
            {rows.map((r) => (
              <li
                key={r.model}
                className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{r.name}</span>
                    {zdrOff(r.model)}
                  </div>
                  <p className="text-meta text-muted-foreground tabular-nums">
                    {kunta(r.calls)} · {formatTokens(r.tokens)}
                  </p>
                </div>
                <span className="shrink-0 tabular-nums">{cost(r.costUsd, r.estimated)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {rows.length > 0 && (
        <div className="flex flex-col gap-1 text-meta text-muted-foreground">
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
