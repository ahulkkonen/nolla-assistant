import type { VaultEntity, VaultPending } from '@pa/protocol';
import {
  Brackets,
  Check,
  EyeOff,
  MoreHorizontal,
  Pin,
  PinOff,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Split,
  UserRound,
  X,
} from 'lucide-react';
import { AlertDialog, DropdownMenu } from 'radix-ui';
import { useEffect, useState } from 'react';
import { useStore } from '../store.ts';
import { send } from '../ws.ts';
import { IconButton } from './IconButton.tsx';

export const VAULT_TITLE = 'Nimisuoja';

const KIND: Record<string, string> = {
  person: 'henkilö',
  hetu: 'henkilötunnus',
  iban: 'tilinumero',
  phone: 'puhelinnumero',
  address: 'osoite',
  email: 'sähköposti',
};
const kind = (k: string) => KIND[k] ?? k;
const MODE = { realistic: 'realistinen', placeholder: 'paikkamerkki' } as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fi-FI') : '–');

type Action = {
  label: string;
  Icon: typeof Pin;
  run?: () => void;
  pressed?: boolean;
};

/** One list for the desktop icon row and the mobile menu. No `run` means not available yet. */
function actionsOf(e: VaultEntity, askNeverDetect: (e: VaultEntity) => void): Action[] {
  const entityId = e.id;
  return [
    {
      label: e.pinned ? 'Poista kiinnitys' : 'Kiinnitä pseudonyymi',
      Icon: e.pinned ? PinOff : Pin,
      pressed: e.pinned,
      run: () => send({ type: 'vault.pin', entityId, pinned: !e.pinned }),
    },
    {
      label: 'Vaihda pseudonyymi',
      Icon: RefreshCw,
      run: () => send({ type: 'vault.regenerate', entityId }),
    },
    {
      label: e.mode === 'realistic' ? 'Käytä paikkamerkkiä' : 'Käytä realistista nimeä',
      Icon: e.mode === 'realistic' ? Brackets : UserRound,
      run: () =>
        send({
          type: 'vault.setMode',
          entityId,
          mode: e.mode === 'realistic' ? 'placeholder' : 'realistic',
        }),
    },
    {
      label: e.allowlisted ? 'Suojaa taas' : 'Lähetä sellaisenaan',
      Icon: e.allowlisted ? ShieldCheck : ShieldOff,
      pressed: e.allowlisted,
      run: () => send({ type: 'vault.allowlist', entityId, allowlisted: !e.allowlisted }),
    },
    { label: 'Älä tunnista enää', Icon: EyeOff, run: () => askNeverDetect(e) },
    // `vault.state` carries no span ids, so a split has nothing to select yet.
    { label: 'Jakaminen ei ole vielä käytettävissä', Icon: Split },
  ];
}

function ActionRow({ actions }: { actions: Action[] }) {
  return (
    <div className="flex">
      {actions.map(({ label, Icon, run, pressed }) => (
        <IconButton
          key={label}
          label={label}
          {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
          {...(run ? { onClick: run } : { 'aria-disabled': 'true' as const })}
        >
          <Icon size={16} />
        </IconButton>
      ))}
    </div>
  );
}

const menuItem =
  'flex h-11 cursor-default items-center gap-3 rounded-sm px-3 outline-none data-[disabled]:text-fg-muted data-[highlighted]:bg-bg-sunken';

function ActionMenu({ e, actions }: { e: VaultEntity; actions: Action[] }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton label={`Toiminnot: ${e.canonical}`}>
          <MoreHorizontal size={20} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 min-w-60 rounded-md border border-border bg-bg-raised p-1"
        >
          {actions.map(({ label, Icon, run }) => (
            <DropdownMenu.Item
              key={label}
              className={menuItem}
              {...(run ? { onSelect: run } : { disabled: true })}
            >
              <Icon size={16} />
              {label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const button = 'h-10 rounded-md px-4 font-medium';

function NeverDetectDialog({ e, onClose }: { e: VaultEntity | null; onClose: () => void }) {
  return (
    <AlertDialog.Root open={!!e} onOpenChange={(open) => !open && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-fg/30 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <AlertDialog.Content className="fixed inset-x-4 top-1/2 z-50 mx-auto max-w-sm -translate-y-1/2 rounded-lg border border-border bg-bg-raised p-6 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in">
          <AlertDialog.Title className="mb-2 font-semibold">
            Lopetetaanko tunnistus?
          </AlertDialog.Title>
          <AlertDialog.Description className="mb-6 text-fg-muted">
            Arvoa ”{e?.canonical}” ei enää tunnisteta eikä suojata.
          </AlertDialog.Description>
          <div className="flex justify-end gap-2">
            <AlertDialog.Cancel className={`${button} border border-border hover:bg-bg-sunken`}>
              Peruuta
            </AlertDialog.Cancel>
            <AlertDialog.Action
              className={`${button} bg-accent text-accent-fg`}
              onClick={() => e && send({ type: 'vault.neverDetect', entityId: e.id })}
            >
              Lopeta tunnistus
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function PendingLane({ pending }: { pending: VaultPending[] }) {
  return (
    <section aria-labelledby="pending-title" className="flex flex-col gap-2">
      <h2 id="pending-title" className="text-secondary text-fg-muted">
        Vahvistettavat
      </h2>
      <ul className="flex flex-col gap-2">
        {pending.map((p) => (
          <li
            key={p.id}
            className="flex items-center gap-3 rounded-lg border border-border bg-bg-raised py-1 pr-1 pl-4"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate">{p.text}</div>
              <div className="text-secondary text-fg-muted">
                {kind(p.kind)} · suojattu kunnes vahvistat · {Math.round(p.score * 100)} %
              </div>
            </div>
            <IconButton
              label="Vahvista"
              onClick={() =>
                send({ type: 'vault.pending.resolve', pendingId: p.id, action: 'confirm' })
              }
            >
              <Check size={16} />
            </IconButton>
            <IconButton
              label="Lähetä sellaisenaan"
              onClick={() =>
                send({ type: 'vault.pending.resolve', pendingId: p.id, action: 'allowlist' })
              }
            >
              <ShieldOff size={16} />
            </IconButton>
            <IconButton
              label="Hylkää"
              onClick={() =>
                send({ type: 'vault.pending.resolve', pendingId: p.id, action: 'dismiss' })
              }
            >
              <X size={16} />
            </IconButton>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function VaultScreen() {
  const vault = useStore((s) => s.vault);
  const showModelSaw = useStore((s) => s.showModelSaw);
  const setShowModelSaw = useStore((s) => s.setShowModelSaw);
  const [picked, setPicked] = useState<number[]>([]);
  const [into, setInto] = useState<number | null>(null);
  const [neverDetect, setNeverDetect] = useState<VaultEntity | null>(null);

  useEffect(() => send({ type: 'vault.list' }), []);

  const entities = vault?.entities ?? [];
  const selected = entities.filter((e) => picked.includes(e.id));
  const target = selected.find((e) => e.id === into) ?? selected[0];
  const toggle = (id: number) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const merge = () => {
    if (!target) return;
    const fromIds = selected.filter((e) => e !== target).map((e) => e.id);
    send({ type: 'vault.merge', fromIds, intoId: target.id });
    setPicked([]);
    setInto(null);
  };
  // The label pads the 16 px box to a 40 px hit area without moving it.
  const check = (e: VaultEntity) => (
    <label className="-m-3 flex p-3">
      <input
        type="checkbox"
        aria-label={`Valitse ${e.canonical}`}
        checked={picked.includes(e.id)}
        onChange={() => toggle(e.id)}
        className="size-4 accent-accent"
      />
    </label>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 py-6">
        <h1 className="font-semibold max-md:hidden">{VAULT_TITLE}</h1>
        {!vault ? (
          <p className="text-fg-muted">Ladataan…</p>
        ) : !entities.length && !vault.pending.length ? (
          <p className="text-fg-muted">Ei vielä tunnistettuja nimiä tai tunnuksia.</p>
        ) : (
          <>
            <label className="flex items-center gap-2 self-start">
              <input
                type="checkbox"
                checked={showModelSaw}
                onChange={(e) => setShowModelSaw(e.target.checked)}
                className="size-4 accent-accent"
              />
              Näytä mitä malli näki
            </label>
            {vault.pending.length > 0 && <PendingLane pending={vault.pending} />}
            {selected.length >= 2 && target && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg-raised p-2 pl-4">
                <label htmlFor="merge-into" className="text-secondary text-fg-muted">
                  {selected.length} valittu, yhdistä kohteeseen
                </label>
                <select
                  id="merge-into"
                  value={target.id}
                  onChange={(e) => setInto(Number(e.target.value))}
                  className="h-9 rounded-md border border-border bg-bg px-2"
                >
                  {selected.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.canonical}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={merge}
                  className="ml-auto h-9 rounded-md bg-accent px-4 font-medium text-accent-fg"
                >
                  Yhdistä
                </button>
              </div>
            )}
            {entities.length > 0 && (
              <>
                <table className="w-full text-left max-md:hidden">
                  <thead className="text-secondary text-fg-muted">
                    <tr>
                      <th className="w-8 py-2">
                        <span className="sr-only">Valitse</span>
                      </th>
                      <th className="py-2 pr-4 font-normal">Tyyppi</th>
                      <th className="py-2 pr-4 font-normal">Alkuperäinen</th>
                      <th className="py-2 pr-4 font-normal">Pseudonyymi</th>
                      <th className="py-2 pr-4 font-normal">Tila</th>
                      <th className="py-2 pr-4 text-right font-normal">Nähty</th>
                      <th className="py-2 pr-4 font-normal">Viimeksi</th>
                      <th className="py-2">
                        <span className="sr-only">Toiminnot</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {entities.map((e) => (
                      <tr key={e.id} className="border-t border-border">
                        <td className="py-1">{check(e)}</td>
                        <td className="py-1 pr-4 text-fg-muted">{kind(e.kind)}</td>
                        <td className="py-1 pr-4">{e.canonical}</td>
                        <td className="py-1 pr-4 text-fg-muted">{e.surrogate}</td>
                        <td className="py-1 pr-4 text-fg-muted">{MODE[e.mode]}</td>
                        <td className="py-1 pr-4 text-right tabular-nums">{e.seenCount}</td>
                        <td className="py-1 pr-4 text-fg-muted tabular-nums">{when(e.lastSeen)}</td>
                        <td className="py-1">
                          <ActionRow actions={actionsOf(e, setNeverDetect)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ul className="flex flex-col gap-2 md:hidden" aria-label="Tunnistetut">
                  {entities.map((e) => (
                    <li key={e.id} className="rounded-lg border border-border p-3">
                      <div className="flex items-center gap-3">
                        {check(e)}
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{e.canonical}</div>
                          <div className="text-secondary text-fg-muted">
                            {e.surrogate} · {kind(e.kind)} · {MODE[e.mode]} · nähty {e.seenCount} ·{' '}
                            {when(e.lastSeen)}
                          </div>
                        </div>
                        <ActionMenu e={e} actions={actionsOf(e, setNeverDetect)} />
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <ul className="flex flex-col gap-1 text-secondary text-fg-muted">
              <li>
                Tunnistus ei ole täydellinen. Tunnistamatta jääneet arvot näkyvät korostamattomina.
              </li>
              <li>Lempinimet tunnistetaan vain, jos lisäät ne käsin aliaksiksi.</li>
              <li>
                Pelkkä etunimi yhdistetään keskustelun viimeisimpään samannimiseen henkilöön.
                Epäselvät tapaukset merkitään.
              </li>
            </ul>
          </>
        )}
      </div>
      <NeverDetectDialog e={neverDetect} onClose={() => setNeverDetect(null)} />
    </div>
  );
}
