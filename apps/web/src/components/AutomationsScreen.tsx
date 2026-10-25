import { Play } from 'lucide-react';
import { useEffect } from 'react';
import { cronText } from '../cron.ts';
import { type Automation, useStore } from '../store.ts';
import { send } from '../ws.ts';
import { IconButton, Tip } from './IconButton.tsx';

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

const STATUS: Record<string, string> = { ok: 'onnistui', error: 'virhe', running: 'käynnissä' };
const status = (s: string | null) => (s ? (STATUS[s] ?? s) : '–');
const DELIVER = { chat: 'keskustelu', push: 'ilmoitus', both: 'molemmat' } as const;
const deliver = (a: Automation) => (a.deliver ? DELIVER[a.deliver] : '–');

/** Finnish schedule; the raw expression in the tooltip. */
function Cron({ cron }: { cron: string }) {
  return (
    <Tip label={cron}>
      <span
        tabIndex={0}
        className="underline decoration-border decoration-dotted underline-offset-2"
      >
        {cronText(cron)}
      </span>
    </Tip>
  );
}

function RunButton({ a }: { a: Automation }) {
  return (
    <IconButton
      label={`Suorita nyt: ${a.id}`}
      onClick={() => send({ type: 'automations.run', id: a.id })}
    >
      <Play size={16} />
    </IconButton>
  );
}

export function AutomationsScreen() {
  const automations = useStore((s) => s.automations);
  const agents = useStore((s) => s.agents);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  useEffect(() => send({ type: 'automations.list' }), []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-6">
        <h1 className="font-semibold max-md:hidden">{AUTOMATIONS_TITLE}</h1>
        {!automations ? (
          <p className="text-fg-muted">Ladataan…</p>
        ) : !automations.length ? (
          <p className="text-fg-muted">Ei automaatioita.</p>
        ) : (
          <>
            <div className="overflow-x-auto max-md:hidden">
              <table className="w-full text-left">
                <thead className="text-secondary text-fg-muted">
                  <tr>
                    <th className="py-2 pr-4 font-normal">Nimi</th>
                    <th className="py-2 pr-4 font-normal">Ajastus</th>
                    <th className="py-2 pr-4 font-normal">Agentti</th>
                    <th className="py-2 pr-4 font-normal">Toimitus</th>
                    <th className="py-2 pr-4 font-normal">Käytössä</th>
                    <th className="py-2 pr-4 font-normal">Viimeksi</th>
                    <th className="py-2 pr-4 font-normal">Tulos</th>
                    <th className="py-2">
                      <span className="sr-only">Toiminnot</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {automations.map((a) => (
                    <tr key={a.id} className="border-t border-border">
                      <td className="py-1 pr-4 font-mono">{a.id}</td>
                      <td className="py-1 pr-4 text-fg-muted">
                        <Cron cron={a.cron} />
                      </td>
                      <td className="py-1 pr-4">{agentName(a.agentId)}</td>
                      <td className="py-1 pr-4 text-fg-muted">{deliver(a)}</td>
                      <td className="py-1 pr-4 text-fg-muted">{a.enabled ? 'kyllä' : 'ei'}</td>
                      <td className="py-1 pr-4 text-fg-muted">{ago(a.lastRunAt)}</td>
                      <td className="py-1 pr-4 text-fg-muted">{status(a.lastStatus)}</td>
                      <td className="py-1">
                        <RunButton a={a} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="flex flex-col gap-2 md:hidden" aria-label="Automaatiot">
              {automations.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-3 rounded-lg border border-border py-2 pr-1 pl-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono">{a.id}</div>
                    <div className="text-secondary text-fg-muted">
                      <Cron cron={a.cron} /> · {agentName(a.agentId)} · {deliver(a)} ·{' '}
                      {a.enabled ? 'käytössä' : 'ei käytössä'} · {ago(a.lastRunAt)} ·{' '}
                      {status(a.lastStatus)}
                    </div>
                  </div>
                  <RunButton a={a} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
