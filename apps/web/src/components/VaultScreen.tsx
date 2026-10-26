import type { VaultEntity, VaultPending } from '@pa/protocol';
import {
  Brackets,
  Check,
  EyeOff,
  Pin,
  PinOff,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Split,
  UserPlus,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { useStore } from '../store.ts';
import { send } from '../ws.ts';
import { type Action, ActionMenu, ActionRow } from './Actions.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { EmptyState, ListSkeleton, Page } from './Page.tsx';

export const VAULT_TITLE = 'Nimisuoja';

const KIND: Record<string, string> = {
  PERSON: 'henkilö',
  SELF: 'sinä',
  HETU: 'henkilötunnus',
  IBAN: 'tilinumero',
  PHONE: 'puhelinnumero',
  ADDRESS: 'osoite',
  POSTCODE_CITY: 'postinumero',
  EMAIL: 'sähköposti',
  PLATE: 'rekisterinumero',
};
// The sidecar sends kinds in upper case.
const kind = (k: string) => KIND[k.toUpperCase()] ?? k;
const MODE = { realistic: 'realistinen', placeholder: 'paikkamerkki' } as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fi-FI') : '–');

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

const pendingActions = (p: VaultPending) => {
  const resolve = (action: 'confirm' | 'allowlist' | 'dismiss' | 'accept' | 'reject') => () =>
    send({ type: 'vault.pending.resolve', pendingId: p.id, action });
  // Phase 12: the typed name is already a pseudonym, and the message waits for this answer.
  if (p.reason === 'collision')
    return {
      confirm: resolve('accept'),
      confirmLabel: 'Uusi henkilö',
      more: [{ label: 'Sama henkilö', Icon: UserRound, run: resolve('reject') }] satisfies Action[],
    };
  return {
    confirm: resolve('confirm'),
    confirmLabel: 'Vahvista',
    more: [
      { label: 'Lähetä sellaisenaan', Icon: ShieldOff, run: resolve('allowlist') },
      { label: 'Hylkää', Icon: X, run: resolve('dismiss') },
    ] satisfies Action[],
  };
};

/**
 * A collision (phase 12): a yes-or-no question, so both answers are visible buttons. The held
 * message waits for it, so the card says so.
 */
function CollisionRow({
  p,
  owner,
  confirm,
  more,
}: {
  p: VaultPending;
  owner: string | undefined;
  confirm: () => void;
  more: Action[];
}) {
  const same = more[0];
  return (
    <li className="flex flex-col gap-3 rounded-lg border bg-card px-4 py-3 md:flex-row md:items-center">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{p.text}</div>
        <p className="text-meta text-pretty text-muted-foreground">
          Onko tämä uusi henkilö? Nimi on jo pseudonyymi{owner ? ` henkilölle ${owner}` : ''}.
          Viesti odottaa vastausta.
        </p>
      </div>
      {/* Phones: 50 % each under the text, as the confirmation buttons (brief 7.5). */}
      <div className="grid shrink-0 grid-cols-2 gap-2 md:flex">
        <Button
          variant="outline"
          size="sm"
          aria-label={`Uusi henkilö: ${p.text}`}
          onClick={confirm}
        >
          <UserPlus size={16} />
          Uusi henkilö
        </Button>
        {same && (
          <Button
            variant="outline"
            size="sm"
            aria-label={`Sama henkilö: ${p.text}`}
            onClick={same.run}
          >
            <UserRound size={16} />
            Sama henkilö
          </Button>
        )}
      </div>
    </li>
  );
}

function PendingLane({ pending, entities }: { pending: VaultPending[]; entities: VaultEntity[] }) {
  return (
    <section aria-labelledby="pending-title" className="flex flex-col gap-3">
      <h2 id="pending-title" className="text-heading">
        Vahvistettavat
      </h2>
      <ul className="flex flex-col gap-2">
        {pending.map((p) => {
          const { confirm, confirmLabel, more } = pendingActions(p);
          const owner = entities.find((e) => e.id === p.entityId)?.canonical;
          if (p.reason === 'collision')
            return <CollisionRow key={p.id} p={p} owner={owner} confirm={confirm} more={more} />;
          return (
            // Phones: "Vahvista" goes under the text so the text keeps its width.
            <li
              key={p.id}
              className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 rounded-lg border bg-card py-3 pr-2 pl-4 md:grid-cols-[1fr_auto_auto]"
            >
              <div className="col-start-1 row-start-1 min-w-0">
                <div className="truncate font-medium">{p.text}</div>
                <div className="text-meta text-muted-foreground">
                  {`${kind(p.kind)} · suojattu kunnes vahvistat · ${Math.round(p.score * 100)} %`}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={confirm}
                className="col-start-1 row-start-2 justify-self-start md:col-start-2 md:row-start-1"
              >
                <Check size={16} />
                {confirmLabel}
              </Button>
              <div className="col-start-2 row-start-1 md:col-start-3">
                <ActionMenu label={`Toiminnot: ${p.text}`} actions={more} small />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Type and state as badges (brief 7.5). */
function States({ e }: { e: VaultEntity }) {
  return (
    <span className="flex flex-wrap gap-1">
      <Badge variant="outline">{MODE[e.mode]}</Badge>
      {e.pinned && <Badge variant="info">kiinnitetty</Badge>}
      {e.allowlisted && <Badge variant="warning">sellaisenaan</Badge>}
    </span>
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
  // The label pads the 16 px box to a 44 px hit area without moving it.
  const check = (e: VaultEntity) => (
    <label className="-m-3.5 flex p-3.5">
      <input
        type="checkbox"
        aria-label={`Valitse ${e.canonical}`}
        checked={picked.includes(e.id)}
        onChange={() => toggle(e.id)}
        className="size-4 rounded-xs accent-primary"
      />
    </label>
  );
  // Two quick toggles stay visible on hover or focus; the rest are in the menu.
  const rowActions = (e: VaultEntity) => {
    const all = actionsOf(e, setNeverDetect);
    return { quick: all.slice(0, 1), more: all.slice(1) };
  };

  return (
    <Page title={VAULT_TITLE} wide>
      {!vault ? (
        <ListSkeleton loading />
      ) : (
        <>
          <div className="flex min-h-12 items-center gap-4 border-b">
            <label htmlFor="vault-model-saw" className="flex-1 text-body">
              Näytä mitä malli näki
            </label>
            <Switch id="vault-model-saw" checked={showModelSaw} onCheckedChange={setShowModelSaw} />
          </div>
          {!entities.length && !vault.pending.length && (
            <EmptyState
              Icon={ShieldCheck}
              title="Ei vielä tunnistettuja nimiä tai tunnuksia"
              line="Ne näkyvät täällä, kun viestissä tunnistetaan nimi tai tunnus."
            />
          )}
          {vault.pending.length > 0 && (
            <PendingLane pending={vault.pending} entities={vault.entities} />
          )}
          {entities.length > 0 && (
            <section aria-labelledby="entities-title" className="flex flex-col gap-3">
              <h2 id="entities-title" className="text-heading">
                Tunnistetut
              </h2>
              {selected.length >= 2 && target && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted px-3 py-2">
                  <span className="text-meta text-muted-foreground tabular-nums">
                    {selected.length} valittu
                  </span>
                  <label htmlFor="merge-into" className="text-ui">
                    Yhdistä kohteeseen
                  </label>
                  <Select value={String(target.id)} onValueChange={(v) => setInto(Number(v))}>
                    <SelectTrigger id="merge-into" className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {selected.map((e) => (
                        <SelectItem key={e.id} value={String(e.id)}>
                          {e.canonical}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button onClick={merge} className="ml-auto">
                    Yhdistä
                  </Button>
                </div>
              )}
              <div className="max-md:hidden">
                <Table
                  label="Tunnistetut nimet ja tunnukset"
                  className="[&_td:first-child]:pl-0 [&_th:first-child]:pl-0"
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8">
                        <span className="sr-only">Valitse</span>
                      </TableHead>
                      <TableHead>Alkuperäinen</TableHead>
                      <TableHead>Tyyppi</TableHead>
                      <TableHead>Pseudonyymi</TableHead>
                      <TableHead>Tila</TableHead>
                      <TableHead className="text-right">Nähty</TableHead>
                      <TableHead>Viimeksi</TableHead>
                      <TableHead>
                        <span className="sr-only">Toiminnot</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entities.map((e) => {
                      const { quick, more } = rowActions(e);
                      return (
                        <TableRow
                          key={e.id}
                          className="group/row"
                          data-state={picked.includes(e.id) ? 'selected' : undefined}
                        >
                          <TableCell>{check(e)}</TableCell>
                          <TableCell className="font-medium">{e.canonical}</TableCell>
                          <TableCell>
                            <Badge>{kind(e.kind)}</Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{e.surrogate}</TableCell>
                          <TableCell>
                            <States e={e} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{e.seenCount}</TableCell>
                          <TableCell className="text-muted-foreground tabular-nums">
                            {when(e.lastSeen)}
                          </TableCell>
                          <TableCell className="w-0 pr-0">
                            <div className="flex justify-end opacity-0 transition-opacity duration-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-aria-expanded:opacity-100 [@media(hover:none)]:opacity-100">
                              <ActionRow actions={quick} small />
                              <ActionMenu
                                label={`Toiminnot: ${e.canonical}`}
                                actions={more}
                                small
                              />
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <ul className="flex flex-col gap-2 md:hidden" aria-label="Tunnistetut">
                {entities.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-center gap-3 rounded-lg border bg-card py-3 pr-2 pl-4"
                  >
                    {check(e)}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{e.canonical}</div>
                      <div className="text-meta text-muted-foreground [overflow-wrap:anywhere]">
                        {e.surrogate} · {kind(e.kind)} · {MODE[e.mode]} · nähty {e.seenCount} ·{' '}
                        {when(e.lastSeen)}
                      </div>
                    </div>
                    <ActionMenu
                      label={`Toiminnot: ${e.canonical}`}
                      actions={actionsOf(e, setNeverDetect)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(entities.length > 0 || vault.pending.length > 0) && (
            <ul className="flex flex-col gap-1 text-meta text-muted-foreground text-pretty">
              <li>
                Tunnistus ei ole täydellinen. Tunnistamatta jääneet arvot näkyvät korostamattomina.
              </li>
              <li>Lempinimet tunnistetaan vain, jos lisäät ne käsin aliaksiksi.</li>
              <li>
                Pelkkä etunimi yhdistetään keskustelun viimeisimpään samannimiseen henkilöön.
                Epäselvät tapaukset merkitään.
              </li>
            </ul>
          )}
        </>
      )}
      <ConfirmDialog
        open={!!neverDetect}
        title={`Lopetetaanko arvon ”${neverDetect?.canonical ?? ''}” tunnistus?`}
        action="Lopeta tunnistus"
        onConfirm={() =>
          neverDetect && send({ type: 'vault.neverDetect', entityId: neverDetect.id })
        }
        onClose={() => setNeverDetect(null)}
      >
        Arvoa ei enää tunnisteta eikä suojata viesteissä.
      </ConfirmDialog>
    </Page>
  );
}
