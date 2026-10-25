import { clsx } from 'clsx';
import {
  Bot,
  Brain,
  CalendarClock,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Settings,
  ShieldCheck,
  Sun,
  Tags,
  X,
} from 'lucide-react';
import { Dialog } from 'radix-ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { googleConnect, integrationsStatus, logout, passkeyRegister } from '../api.ts';
import { disablePush, enablePush, pushSubscription, pushSupported } from '../push.ts';
import { type Theme, useStore } from '../store.ts';
import { disconnect } from '../ws.ts';
import { IconButton } from './IconButton.tsx';

export const THEMES: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: 'system', label: 'Järjestelmä', Icon: Monitor },
  { value: 'light', label: 'Vaalea', Icon: Sun },
  { value: 'dark', label: 'Tumma', Icon: Moon },
];

export const SCREENS = [
  ['vault', ShieldCheck, 'Nimisuoja'],
  ['memory', Brain, 'Muisti'],
  ['topics', Tags, 'Aiheet'],
  ['agents', Bot, 'Agentit'],
  ['automations', CalendarClock, 'Automaatiot'],
] as const;

const row = 'flex h-10 items-center gap-2 rounded-md border border-border px-3 hover:bg-bg-sunken';
const check = 'size-4 accent-accent';
const field = 'h-9 rounded-md border border-border bg-bg px-2';

/** Opens the one settings dialog (rendered by the app shell). */
export function SettingsButton() {
  return (
    <IconButton label="Asetukset" onClick={() => useStore.setState({ settingsOpen: true })}>
      <Settings size={20} />
    </IconButton>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-secondary text-fg-muted">{title}</h3>
      {children}
    </section>
  );
}

function Notifications() {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    pushSubscription().then(
      (s) => setOn(!!s),
      () => setOn(false),
    );
  }, []);
  if (!pushSupported())
    return <p className="text-secondary text-fg-muted">Selain ei tue ilmoituksia.</p>;
  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      await (next ? enablePush() : disablePush());
      setOn(next);
    } catch (err) {
      useStore
        .getState()
        .pushError(
          err instanceof Error && err.message === 'denied'
            ? 'Ilmoitukset estetty selaimen asetuksissa.'
            : 'Ilmoitusten asetus epäonnistui.',
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={on}
        disabled={busy}
        onChange={(e) => void toggle(e.target.checked)}
        className={check}
      />
      Ilmoita, kun vastaus tai hyväksyntä odottaa
    </label>
  );
}

function Integrations() {
  const google = useStore((s) => s.integrations);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    integrationsStatus().then(
      (s) => useStore.setState({ integrations: { connected: s.google.connected } }),
      () => {},
    );
  }, []);
  const connect = async () => {
    setBusy(true);
    try {
      const r = await googleConnect();
      if ('authUrl' in r) window.location.assign(r.authUrl);
      else useStore.setState({ integrations: { connected: true } });
    } catch {
      useStore.getState().pushError('Yhdistäminen epäonnistui.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div>Google Workspace</div>
          <div className="text-secondary text-fg-muted">
            {google === null ? 'Tarkistetaan…' : google.connected ? 'Yhdistetty' : 'Ei yhdistetty'}
          </div>
        </div>
        {google && !google.connected && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void connect()}
            className="h-9 rounded-md border border-border px-3 hover:bg-bg-sunken disabled:text-fg-muted"
          >
            Yhdistä
          </button>
        )}
      </div>
      <p className="text-secondary text-fg-muted">
        Yhteyden voi katkaista Google-tilin asetuksista: Tietoturva → Yhteydet kolmansien osapuolten
        sovelluksiin.
      </p>
    </>
  );
}

/** The whole settings: theme, screens, voice, notifications, integrations, passkey, logout. */
export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = (settingsOpen: boolean) => useStore.setState({ settingsOpen });
  // Leaving for another screen: focus must not return to the gear (its tooltip would open).
  const leaving = useRef(false);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const showModelSaw = useStore((s) => s.showModelSaw);
  const setShowModelSaw = useStore((s) => s.setShowModelSaw);
  const sttAutoSend = useStore((s) => s.sttAutoSend);
  const sttLanguage = useStore((s) => s.sttLanguage);
  const setStt = useStore((s) => s.setStt);
  const [note, setNote] = useState('');

  const addPasskey = async () => {
    setNote('');
    try {
      await passkeyRegister();
      setNote('Avain lisätty.');
    } catch {
      setNote('Avaimen lisäys epäonnistui.');
    }
  };

  const signOut = async () => {
    try {
      await logout();
    } finally {
      disconnect();
      useStore.setState({ settingsOpen: false });
      useStore.getState().setAuth('out');
    }
  };

  const go = (screen: (typeof SCREENS)[number][0]) => {
    leaving.current = true;
    const st = useStore.getState();
    // Under 768 px the sidebar is a drawer that would cover the new screen.
    if (matchMedia('(max-width: 767.98px)').matches) st.setSidebarOpen(false);
    useStore.setState({ settingsOpen: false });
    st.setScreen(screen);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-fg/30 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <Dialog.Content
          onCloseAutoFocus={(e) => {
            if (leaving.current) e.preventDefault();
            leaving.current = false;
          }}
          className="fixed inset-4 z-50 m-auto flex h-fit max-w-sm flex-col gap-6 overflow-y-auto rounded-lg border border-border bg-bg-raised p-6 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="font-semibold">Asetukset</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Sulje">
                <X size={20} />
              </IconButton>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Teema, näkymät, puhe, ilmoitukset, integraatiot ja tili
          </Dialog.Description>
          <fieldset>
            <legend className="mb-2 text-secondary text-fg-muted">Teema</legend>
            <div className="flex gap-1 rounded-md bg-bg-sunken p-1">
              {THEMES.map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={theme === value}
                  onClick={() => setTheme(value)}
                  className={clsx(
                    'flex h-8 flex-1 items-center justify-center gap-1 rounded-sm text-secondary',
                    theme === value ? 'bg-bg text-accent' : 'text-fg-muted hover:text-fg',
                  )}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showModelSaw}
              onChange={(e) => setShowModelSaw(e.target.checked)}
              className={check}
            />
            Näytä mitä malli näki
          </label>
          <div className="flex flex-col gap-2">
            {SCREENS.map(([screen, Icon, label]) => (
              <button key={screen} type="button" onClick={() => go(screen)} className={row}>
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>
          <Section title="Puhe">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={sttAutoSend}
                onChange={(e) => setStt({ sttAutoSend: e.target.checked })}
                className={check}
              />
              Lähetä heti litteroinnin jälkeen
            </label>
            <label className="flex items-center justify-between gap-2">
              Puheen kieli
              <select
                value={sttLanguage}
                onChange={(e) => setStt({ sttLanguage: e.target.value as 'fi' | 'en' | 'sv' })}
                className={field}
              >
                <option value="fi">suomi</option>
                <option value="en">englanti</option>
                <option value="sv">ruotsi</option>
              </select>
            </label>
          </Section>
          <Section title="Ilmoitukset">
            <Notifications />
          </Section>
          <Section title="Integraatiot">
            <Integrations />
          </Section>
          <div className="flex flex-col gap-2">
            <button type="button" onClick={() => void addPasskey()} className={row}>
              <KeyRound size={16} />
              Lisää avain
            </button>
            {note && (
              <p role="status" className="text-secondary text-fg-muted">
                {note}
              </p>
            )}
            <button type="button" onClick={() => void signOut()} className={row}>
              <LogOut size={16} />
              Kirjaudu ulos
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
