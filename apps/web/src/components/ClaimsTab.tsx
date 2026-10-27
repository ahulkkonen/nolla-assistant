import { CLAIM_TEXT_MAX, type Claim, type ClaimKind } from '@pa/protocol';
import { ChevronRight, Lightbulb } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { firstUserLine, useStore } from '../store.ts';
import { claimSend, openChat, send } from '../ws.ts';
import { EmptyState, ListSkeleton } from './Page.tsx';
import { UNTITLED } from './Sidebar.tsx';

/** Claim kinds in Finnish (the MEMORY.md section names of phase-17 decision 28, singular). */
export const KIND_LABEL: Record<ClaimKind, string> = {
  preference: 'Mieltymys',
  rhythm: 'Rytmi',
  goal: 'Tavoite',
  fact: 'Fakta',
  relationship: 'Ihminen',
  decision_pattern: 'Päätöstapa',
  quirk: 'Tapa',
};

const TEXT_MIN = 3;
const percent = new Intl.NumberFormat('fi', { style: 'percent', maximumFractionDigits: 0 });
const dayFormat = new Intl.DateTimeFormat('fi', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
});

/** "12.10.2026" from an ISO time or a `VVVV-KK-PP` day; "10.2026" from a `VVVV-KK` month. */
export function claimDate(s: string) {
  const month = /^(\d{4})-(\d{2})$/.exec(s);
  if (month) return `${Number(month[2])}.${month[1]}`;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(s);
  return dayFormat.format(d);
}

/** Tomorrow as `VVVV-KK-PP` in local time: the earliest expiry the server takes. */
const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** "Avaa keskustelu: <title>" for a quote's chat, or "Keskustelu poistettu". */
function ChatLink({ chatId }: { chatId: string | null }) {
  const known = useStore((s) => !!chatId && s.chats.some((c) => c.id === chatId));
  const title = useStore((s) =>
    chatId
      ? (s.chats.find((c) => c.id === chatId)?.title ?? firstUserLine(s.messages[chatId]))
      : undefined,
  );
  if (!chatId || !known)
    return <span className="text-meta text-muted-foreground">Keskustelu poistettu</span>;
  return (
    <Button
      variant="link"
      className="min-w-0 justify-start text-meta max-md:min-h-11"
      aria-label={`Avaa keskustelu: ${title ?? UNTITLED}`}
      onClick={() => openChat(chatId)}
    >
      <span className="truncate">Avaa keskustelu</span>
    </Button>
  );
}

/** Up to 3 quotes, each with its chat. */
function Evidence({ claim }: { claim: Claim }) {
  if (!claim.evidence.length) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="Lähteet">
      {claim.evidence.map((e, i) => (
        <li
          // Quotes have no id; their order is the server's (newest first).
          key={i}
          className="flex flex-col gap-0.5 border-l-2 border-border pl-3"
        >
          <q className="font-serif text-meta text-pretty text-muted-foreground italic">{e.quote}</q>
          <span className="flex flex-wrap items-center gap-x-2">
            {e.stance === 'contradicts' && <span className="text-meta text-warning">Vastaan</span>}
            <ChatLink chatId={e.chatId} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "Rytmi · varmuus 70 % · alkaen 10.2026": the meta line of a claim, `extra` at its end. */
function Meta({ claim, extra = [] }: { claim: Claim; extra?: (string | false | null)[] }) {
  const parts = [
    KIND_LABEL[claim.kind],
    `varmuus ${percent.format(claim.confidence)}`,
    claim.validFrom && `alkaen ${claimDate(claim.validFrom)}`,
    claim.validTo && `voimassa ${claimDate(claim.validTo)} asti`,
    ...extra,
  ].filter(Boolean);
  return <p className="text-meta text-muted-foreground tabular-nums">{parts.join(' · ')}</p>;
}

/** The inline editor: 3–240 characters, a live counter, Enter with Ctrl/Cmd saves. */
function TextEdit({
  value,
  onChange,
  onSave,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  const id = useId();
  const n = value.trim().length;
  const bad = n < TEXT_MIN || n > CLAIM_TEXT_MAX;
  return (
    <div className="flex flex-col gap-1">
      <Textarea
        autoFocus
        aria-label="Havainto"
        aria-invalid={bad || undefined}
        aria-describedby={id}
        value={value}
        rows={2}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !bad) {
            e.preventDefault();
            onSave();
          }
        }}
        className="field-sizing-content resize-none"
      />
      <span
        id={id}
        className={cn(
          'self-end text-meta text-muted-foreground tabular-nums',
          n > CLAIM_TEXT_MAX && 'font-medium text-destructive',
        )}
      >
        {n} / {CLAIM_TEXT_MAX}
      </span>
    </div>
  );
}

/** The expiry field: a date from tomorrow on; a past day says so. */
function ExpiryField({
  value,
  onChange,
  past,
}: {
  value: string;
  onChange: (v: string) => void;
  past: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-2 text-ui">
        Voimassa asti
        <Input
          type="date"
          min={tomorrow()}
          value={value}
          aria-invalid={past || undefined}
          aria-describedby={past ? id : undefined}
          onChange={(e) => onChange(e.target.value)}
          className="w-44 max-md:w-full"
        />
      </label>
      {past && (
        <p id={id} className="text-meta text-destructive">
          Valitse huominen tai myöhempi päivä.
        </p>
      )}
    </div>
  );
}

type Mode = 'idle' | 'edit' | 'expiry';

/** A `validTo` as the date input holds it: a month (`VVVV-KK`) becomes its last day. */
export function expiryDay(v: string | null) {
  if (!v) return '';
  const month = /^(\d{4})-(\d{2})$/.exec(v);
  if (!month) return v;
  const last = new Date(Number(month[1]), Number(month[2]), 0).getDate();
  return `${v}-${String(last).padStart(2, '0')}`;
}

/** The inline text of a failed action: a past or bad date in Finnish, else the error text. */
const failText = (e: { code: string; message: string }) =>
  e.code === 'invalid' ? 'Päivä on mennyt tai virheellinen.' : e.message;

/** The claim's action state from the store: busy while its action is on its way. */
function useClaimAction(id: number) {
  const busy = useStore((s) => s.claimAction?.id === id);
  const error = useStore((s) => (s.claimError?.id === id ? s.claimError : null));
  return { busy, error };
}

/**
 * One claim card. Proposed: Hyväksy (with an edited text or an expiry when set), Muokkaa, Hylkää,
 * Voimassa asti. Active: Muokkaa and Voimassa asti save with `claims.update`; Hylkää closes it.
 * Buttons wait while an action is on its way. A failed save keeps the editor and its draft; a
 * done one closes it. A change pushed while editing keeps the draft and says "Päivitetty".
 */
function ClaimCard({ claim }: { claim: Claim }) {
  const proposed = claim.status === 'proposed';
  const { busy, error } = useClaimAction(claim.id);
  const [mode, setMode] = useState<Mode>('idle');
  const [text, setText] = useState(claim.text);
  const initialExpiry = expiryDay(claim.validTo);
  const [expiry, setExpiry] = useState(initialExpiry);
  // The text this card last saw from the server, and whether it changed under an open editor.
  const [seen, setSeen] = useState(claim.text);
  const [sent, setSent] = useState(false);
  const updated = mode === 'edit' && !sent && seen !== claim.text;
  useEffect(() => {
    if (!sent || busy) return;
    // The answer came: done (a new state) unless it failed.
    setSent(false);
    if (error) return;
    setMode('idle');
    setText(claim.text);
    setSeen(claim.text);
  }, [busy]);
  useEffect(() => {
    if (mode === 'idle') {
      setText(claim.text);
      setSeen(claim.text);
    }
  }, [claim.text]);

  const n = text.trim().length;
  const textOk = n >= TEXT_MIN && n <= CLAIM_TEXT_MAX;
  const edited = text.trim() !== claim.text;
  // Local days: the date input is local; the server checks against the UTC day (same in Finland).
  const pastDay = !!expiry && expiry < tomorrow();
  const act = (msg: Parameters<typeof claimSend>[0]) => {
    setSent(true);
    claimSend(msg);
  };
  const reset = () => {
    setMode('idle');
    setText(claim.text);
    setSeen(claim.text);
    setExpiry(initialExpiry);
  };
  const accept = () =>
    act({
      type: 'claims.review',
      id: claim.id,
      action: 'accept',
      ...(mode === 'edit' && edited ? { text: text.trim() } : {}),
      ...(mode === 'expiry' && expiry ? { validTo: expiry } : {}),
    });
  const reject = () => act({ type: 'claims.review', id: claim.id, action: 'reject' });
  const save = () =>
    act({
      type: 'claims.update',
      id: claim.id,
      // Null only when the user cleared a date that was set.
      ...(mode === 'edit' ? { text: text.trim() } : { validTo: expiry || null }),
    });
  const meta = proposed
    ? []
    : [
        !claim.validFrom && `alkaen ${claimDate(claim.recordedAt)}`,
        claim.lastConfirmedAt && `vahvistettu ${claimDate(claim.lastConfirmedAt)}`,
        `nähty ${claim.timesSeen} kertaa`,
      ];

  /** "Hyväksy: Käyttäjä juo…": every action names its claim. */
  const named = (action: string) => `${action}: ${claim.text}`;
  const saveOff =
    busy ||
    (mode === 'edit'
      ? !textOk || (!proposed && !edited)
      : pastDay || (proposed ? !expiry : expiry === initialExpiry));

  return (
    <li className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      {mode === 'edit' ? (
        <TextEdit
          value={text}
          onChange={setText}
          onSave={() => !saveOff && (proposed ? accept() : save())}
        />
      ) : (
        <p className="text-heading text-pretty hyphens-auto">{claim.text}</p>
      )}
      <Meta claim={claim} extra={meta} />
      {proposed && claim.supersedes && (
        // A contradiction: the old claim, quieter, no strike-through (brief 7.1).
        <p className="text-meta text-pretty text-muted-foreground">
          Korvaa: {claim.supersedes.text}
        </p>
      )}
      {updated && <p className="text-meta text-muted-foreground">Päivitetty: {claim.text}</p>}
      {proposed && <Evidence claim={claim} />}
      {mode === 'expiry' && <ExpiryField value={expiry} onChange={setExpiry} past={pastDay} />}
      {error && (
        <p role="alert" className="text-meta text-destructive">
          {failText(error)}
        </p>
      )}
      <div
        className={cn(
          'flex flex-wrap justify-end gap-2 max-md:grid max-md:grid-cols-2',
          // Active, idle: three actions in one phone row.
          !proposed && mode === 'idle' && 'max-md:grid-cols-3',
        )}
      >
        {mode === 'idle' ? (
          <>
            <Button variant="ghost" disabled={busy} onClick={reject} aria-label={named('Hylkää')}>
              Hylkää
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setMode('expiry')}
              aria-label={named('Voimassa asti')}
            >
              Voimassa asti
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setMode('edit')}
              aria-label={named('Muokkaa')}
            >
              Muokkaa
            </Button>
            {proposed && (
              <Button disabled={busy} onClick={accept} aria-label={named('Hyväksy')}>
                Hyväksy
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={reset} aria-label={named('Peruuta')}>
              Peruuta
            </Button>
            <Button
              disabled={saveOff}
              aria-label={named(proposed ? 'Hyväksy' : 'Tallenna')}
              onClick={proposed ? accept : save}
            >
              {proposed ? 'Hyväksy' : 'Tallenna'}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

/** A stale claim: keep (confirms it now) or lower the confidence by 0.2. */
function StaleRow({ claim }: { claim: Claim }) {
  const { busy, error } = useClaimAction(claim.id);
  return (
    <li className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <p className="text-heading text-pretty hyphens-auto">{claim.text}</p>
      <Meta
        claim={claim}
        extra={[`vahvistettu ${claimDate(claim.lastConfirmedAt ?? claim.recordedAt)}`]}
      />
      {error && (
        <p role="alert" className="text-meta text-destructive">
          {failText(error)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2 max-md:grid max-md:grid-cols-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => claimSend({ type: 'claims.stale', id: claim.id, action: 'lower' })}
          aria-label={`Laske luottamusta: ${claim.text}`}
        >
          Laske luottamusta
        </Button>
        <Button
          disabled={busy}
          onClick={() => claimSend({ type: 'claims.stale', id: claim.id, action: 'keep' })}
          aria-label={`Pidä: ${claim.text}`}
        >
          Pidä
        </Button>
      </div>
    </li>
  );
}

/** One section: heading with a count, a helper line, the list or its empty line. */
function Section({
  id,
  title,
  count,
  line,
  empty,
  children,
}: {
  id: string;
  title: string;
  count: number;
  line?: string;
  empty?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="flex items-baseline gap-2 text-heading">
          {title}
          <span className="text-meta font-normal text-muted-foreground tabular-nums">{count}</span>
        </h2>
        {line && <p className="text-meta text-muted-foreground">{line}</p>}
      </div>
      {count ? (
        <ul className="flex flex-col gap-2">{children}</ul>
      ) : (
        empty && <p className="text-meta text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

/**
 * "Havainnot" (phase-17 W1): claims the assistant learned, to review. Proposed first (supersede
 * proposals on top, as the server sends them), then active, stale and the superseded history.
 */
export function ClaimsTab() {
  const claims = useStore((s) => s.claims);
  const [history, setHistory] = useState(false);
  useEffect(() => send({ type: 'claims.list' }), []);

  if (!claims) return <ListSkeleton loading />;
  const { proposed, active, stale, superseded, precision } = claims;
  if (!proposed.length && !active.length && !superseded.length)
    return (
      <EmptyState
        Icon={Lightbulb}
        title="Ei vielä havaintoja"
        line="Avustaja kerää havaintoja keskusteluista. Ne näkyvät tässä tarkistettavina."
      />
    );
  // Stale claims show in their own section, not twice.
  const staleIds = new Set(stale.map((c) => c.id));
  return (
    <div className="flex flex-col gap-8">
      <Section
        id="claims-proposed"
        title="Ehdotetut"
        count={proposed.length}
        empty="Ei tarkistettavia ehdotuksia."
      >
        {proposed.map((c) => (
          <ClaimCard key={`${c.id}:${c.validTo}`} claim={c} />
        ))}
      </Section>
      <Section
        id="claims-active"
        title="Aktiiviset"
        count={active.filter((c) => !staleIds.has(c.id)).length}
        empty="Ei aktiivisia havaintoja."
      >
        {active
          .filter((c) => !staleIds.has(c.id))
          .map((c) => (
            <ClaimCard key={`${c.id}:${c.validTo}`} claim={c} />
          ))}
      </Section>
      {stale.length > 0 && (
        <Section
          id="claims-stale"
          title="Vanhentuvat"
          count={stale.length}
          line="Näitä ei ole vahvistettu 90 päivään."
        >
          {stale.map((c) => (
            <StaleRow key={c.id} claim={c} />
          ))}
        </Section>
      )}
      {superseded.length > 0 && (
        <section aria-labelledby="claims-superseded" className="flex flex-col gap-3">
          <h2 id="claims-superseded" className="text-heading">
            <Button
              variant="ghost"
              aria-expanded={history}
              aria-controls="claims-superseded-list"
              onClick={() => setHistory(!history)}
              // A disclosure, not a toggle: no fill while open.
              className="-ml-2 gap-1 px-2 text-heading aria-expanded:bg-transparent"
            >
              <ChevronRight
                size={16}
                className={cn('transition-transform duration-150', history && 'rotate-90')}
              />
              Korvatut
              <span className="text-meta font-normal text-muted-foreground tabular-nums">
                {superseded.length}
              </span>
            </Button>
          </h2>
          {history && (
            <ul id="claims-superseded-list" className="flex flex-col divide-y">
              {superseded.map((c) => (
                <li key={c.id} className="flex flex-col gap-0.5 py-3">
                  <span className="text-body text-pretty text-muted-foreground">{c.text}</span>
                  <span className="text-meta text-muted-foreground tabular-nums">
                    {KIND_LABEL[c.kind]}
                    {c.validTo && ` · päättyi ${claimDate(c.validTo)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <p className="text-meta text-muted-foreground tabular-nums">
        Hyväksytty {precision.accepted} · hylätty {precision.rejected}
      </p>
    </div>
  );
}
