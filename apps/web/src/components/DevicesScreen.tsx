import type { DeviceSession } from '@pa/protocol';
import { LogOut, MonitorSmartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { sessionRevoke, sessionsList, sessionsRevokeAll } from '../api.ts';
import { formatDate } from '../files.ts';
import { useStore } from '../store.ts';
import { messageTime } from '../thread.ts';
import { signedOut } from '../ws.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { EmptyState, ListSkeleton, Page } from './Page.tsx';

export const DEVICES_TITLE = 'Laitteet';

const label = (s: DeviceSession) => s.label ?? 'Tuntematon laite';
/** "Viimeksi klo 17.20" today, else the date. */
const lastSeen = (iso: string) => {
  const t = messageTime(iso);
  return `Viimeksi ${t.startsWith('klo') ? t : formatDate(iso, false)}`;
};

/** Laitteet (phase-15 decisions 11 and 12): the signed-in sessions, and signing them out. */
export function DevicesScreen() {
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [confirm, setConfirm] = useState<DeviceSession | 'all' | null>(null);
  const load = () =>
    void sessionsList().then(
      (r) => setSessions(r.sessions),
      () => useStore.getState().pushError('Laitteita ei voitu hakea.'),
    );
  useEffect(load, []);

  const signOut = async (target: DeviceSession | 'all') => {
    setConfirm(null);
    try {
      if (target === 'all') {
        await sessionsRevokeAll();
        useStore.getState().notify('Muut laitteet kirjattu ulos');
      } else {
        await sessionRevoke(target.id);
        // This device: the cookie is gone. The same sign-out as the socket's 4401, which may
        // come first or not at all.
        if (target.current) return signedOut();
      }
      load();
    } catch {
      useStore.getState().pushError('Uloskirjaus epäonnistui. Yritä uudelleen.');
    }
  };

  return (
    <Page title={DEVICES_TITLE}>
      {!sessions ? (
        <ListSkeleton loading />
      ) : !sessions.length ? (
        <EmptyState Icon={MonitorSmartphone} title="Ei kirjautuneita laitteita" />
      ) : (
        <section aria-label="Kirjautuneet laitteet" className="flex flex-col gap-6">
          <ul className="flex flex-col divide-y divide-border border-y max-md:border-t-0">
            {sessions.map((s) => (
              <li key={s.id} className="flex min-h-14 items-center gap-3 py-2">
                <MonitorSmartphone size={16} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{label(s)}</span>
                    {s.current && <Badge variant="info">Tämä laite</Badge>}
                  </div>
                  {/* The separator ends a segment: a wrapped line never starts with "·". */}
                  <p className="flex flex-wrap gap-x-1 text-meta text-muted-foreground">
                    <span className="whitespace-nowrap">
                      Kirjautunut {formatDate(s.createdAt, false)} ·
                    </span>
                    <span className="whitespace-nowrap">{lastSeen(s.lastSeenAt)}</span>
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  // The sign-in time tells two rows of the same browser apart.
                  aria-label={`Kirjaa ulos: ${label(s)}, kirjautunut ${formatDate(s.createdAt)}${s.current ? ' (tämä laite)' : ''}`}
                  onClick={() => (s.current ? setConfirm(s) : void signOut(s))}
                >
                  Kirjaa ulos
                </Button>
              </li>
            ))}
          </ul>
          <Button variant="outline" className="self-start" onClick={() => setConfirm('all')}>
            <LogOut size={16} />
            Kirjaa ulos kaikkialta
          </Button>
        </section>
      )}
      <ConfirmDialog
        open={!!confirm}
        title={
          confirm === 'all'
            ? 'Kirjataanko kaikki muut laitteet ulos?'
            : 'Kirjataanko tämä laite ulos?'
        }
        action="Kirjaa ulos"
        onConfirm={() => confirm && void signOut(confirm)}
        onClose={() => setConfirm(null)}
      >
        {confirm === 'all'
          ? 'Tämä laite pysyy kirjautuneena.'
          : 'Kirjaudut uudelleen salasanalla tai pääsyavaimella.'}
      </ConfirmDialog>
    </Page>
  );
}
