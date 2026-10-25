import {
  Bot,
  Brain,
  CalendarClock,
  ChevronRight,
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
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
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

/** Opens the one settings dialog (rendered by the app shell). */
export function SettingsButton({
  className,
  tipSide,
  iconSize = 20,
}: {
  className?: string;
  tipSide?: 'right';
  iconSize?: number;
}) {
  return (
    <IconButton
      label="Asetukset"
      {...(className ? { className } : {})}
      {...(tipSide ? { tipSide } : {})}
      onClick={() => useStore.setState({ settingsOpen: true })}
    >
      <Settings size={iconSize} className={iconSize === 20 ? 'size-5' : 'size-4'} />
    </IconButton>
  );
}

/** Section (brief 7.5): heading with 24 above, rows with 1 px dividers. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col pt-6">
      <h3 className="pb-1 text-heading">{title}</h3>
      <div className="flex flex-col divide-y divide-border">{children}</div>
    </section>
  );
}

/** A setting row: label (and helper) left, control right; min 48 h. */
function Row({
  label,
  htmlFor,
  helper,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  helper?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-4 py-2">
      <div className="min-w-0 flex-1">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-body">
            {label}
          </label>
        ) : (
          <div className="text-body">{label}</div>
        )}
        {helper && <p className="text-meta text-muted-foreground">{helper}</p>}
      </div>
      {children}
    </div>
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
  if (!pushSupported()) return <Row label="Ilmoitukset" helper="Selain ei tue ilmoituksia." />;
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
            ? 'Ilmoitukset on estetty selaimen asetuksissa.'
            : 'Ilmoitusten asetus epäonnistui.',
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      label="Ilmoita, kun vastaus tai hyväksyntä odottaa"
      htmlFor="push"
      helper="Ilmoitus tulee, kun keskustelu ei ole auki."
    >
      <Switch id="push" checked={on} disabled={busy} onCheckedChange={(v) => void toggle(v)} />
    </Row>
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
      if ('authUrl' in r) {
        // Only https (http only for a loopback dev or test server, which redirects to itself).
        const url = new URL(r.authUrl, location.href);
        const loopback = ['127.0.0.1', 'localhost'].includes(location.hostname);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
          throw new Error('unsafe auth url');
        window.location.assign(url.href);
      } else useStore.setState({ integrations: { connected: true } });
    } catch {
      useStore.getState().pushError('Yhdistäminen epäonnistui.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      label="Google Workspace"
      helper={
        <>
          <span className="block">
            {google === null ? 'Tarkistetaan…' : google.connected ? 'Yhdistetty' : 'Ei yhdistetty'}
          </span>
          Yhteyden voi katkaista Google-tilin asetuksista: Tietoturva → Yhteydet kolmansien
          osapuolten sovelluksiin.
        </>
      }
    >
      {google && !google.connected && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void connect()}>
          Yhdistä
        </Button>
      )}
    </Row>
  );
}

/** The whole settings (brief 7.5): theme, privacy, screens, voice, notifications, keys. */
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

  const addPasskey = async () => {
    try {
      await passkeyRegister();
      useStore.getState().notify('Avain lisätty.');
    } catch {
      useStore.getState().pushError('Avaimen lisäys epäonnistui. Kirjaudu uudelleen ja yritä.');
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(e) => {
          if (leaving.current) e.preventDefault();
          leaving.current = false;
        }}
        className={cn(
          'flex h-[85dvh] flex-col gap-0 rounded-xl p-0 sm:max-w-[560px]',
          // Phones: full screen, radius 0, safe-area padding.
          'max-md:top-0 max-md:left-0 max-md:h-dvh max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]',
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-6 max-md:px-4">
          <DialogTitle>Asetukset</DialogTitle>
          <IconButton label="Sulje" className="size-8" onClick={() => setOpen(false)}>
            <X size={16} />
          </IconButton>
        </div>
        <DialogDescription className="sr-only">
          Teema, yksityisyys, näkymät, puhe, ilmoitukset, integraatiot ja avaimet
        </DialogDescription>
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-6 pb-6 max-md:px-4">
            <Section title="Teema">
              {/* Segmented control: track --muted, the selected item a raised card. */}
              <div
                role="group"
                aria-label="Teema"
                className="my-2 flex h-9 gap-1 rounded-md bg-muted p-0.5 max-md:h-11"
              >
                {THEMES.map(({ value, label, Icon }) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={theme === value}
                    onClick={() => setTheme(value)}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1.5 rounded-sm text-ui transition-colors duration-100',
                      theme === value
                        ? 'bg-card font-medium text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Icon size={16} />
                    {label}
                  </button>
                ))}
              </div>
              <Row
                label="Näytä mitä malli näki"
                htmlFor="model-saw"
                helper="Tunnistetut nimet näkyvät viesteissä niinä, jotka malli sai."
              >
                <Switch id="model-saw" checked={showModelSaw} onCheckedChange={setShowModelSaw} />
              </Row>
            </Section>
            <section className="flex flex-col gap-2 pt-6">
              <h3 className="text-heading">Hallinta</h3>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border">
                {SCREENS.map(([screen, Icon, label]) => (
                  <li key={screen}>
                    <button
                      type="button"
                      onClick={() => go(screen)}
                      className="flex h-12 w-full items-center gap-3 px-4 text-left text-body transition-colors duration-100 hover:bg-accent"
                    >
                      <Icon size={16} className="text-muted-foreground" />
                      <span className="flex-1">{label}</span>
                      <ChevronRight size={16} className="text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            <Section title="Puhe">
              <Row label="Lähetä heti litteroinnin jälkeen" htmlFor="stt-send">
                <Switch
                  id="stt-send"
                  checked={sttAutoSend}
                  onCheckedChange={(v) => setStt({ sttAutoSend: v })}
                />
              </Row>
              <Row label="Puheen kieli" htmlFor="stt-lang">
                <Select
                  value={sttLanguage}
                  onValueChange={(v) => setStt({ sttLanguage: v as 'fi' | 'en' | 'sv' })}
                >
                  <SelectTrigger id="stt-lang" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="end">
                    <SelectItem value="fi">suomi</SelectItem>
                    <SelectItem value="en">englanti</SelectItem>
                    <SelectItem value="sv">ruotsi</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
            </Section>
            <Section title="Ilmoitukset">
              <Notifications />
            </Section>
            <Section title="Integraatiot">
              <Integrations />
            </Section>
            <Section title="Avaimet">
              <Row label="Pääsyavain" helper="Kirjaudu ilman salasanaa tällä laitteella.">
                <Button variant="outline" size="sm" onClick={() => void addPasskey()}>
                  <KeyRound size={16} />
                  Lisää avain
                </Button>
              </Row>
              <Row label="Istunto" helper="Kirjautuneena tällä laitteella.">
                <Button variant="outline" size="sm" onClick={() => void signOut()}>
                  <LogOut size={16} />
                  Kirjaudu ulos
                </Button>
              </Row>
            </Section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
