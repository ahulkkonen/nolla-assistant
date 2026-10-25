import { clsx } from 'clsx';
import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { firstUserLine, type MemoryState, pendingLines, useStore } from '../store.ts';
import { openChat, send } from '../ws.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { UNTITLED } from './Sidebar.tsx';

export const MEMORY_TITLE = 'Muisti';

type Target = 'user' | 'memory';
type Drafts = Record<Target, string | null>;

const CAPS = { user: 1500, memory: 2500 } as const;
const FILE = { user: 'USER.md', memory: 'MEMORY.md' } as const;
const LABEL = { user: 'Käyttäjä (USER.md)', memory: 'Muisti (MEMORY.md)' } as const;
const ACTION = { add: 'Lisää', replace: 'Korvaa', remove: 'Poista' } as const;
const TARGET = { user: 'käyttäjä', memory: 'muisti' } as const;
const PLACEHOLDER = {
  user: 'Kerro itsestäsi: kuka olet, mitä toivot vastauksilta, pysyvät ohjeet.',
  memory: 'Agentti lisää tänne pysyviä tietoja. Voit muokata niitä itse.',
} as const;

const primary =
  'h-10 rounded-md bg-accent px-4 font-medium text-accent-fg disabled:bg-bg-sunken disabled:text-fg-muted';
const secondary =
  'h-10 rounded-md border border-border px-4 font-medium hover:bg-bg-sunken disabled:text-fg-muted';

/**
 * The proposed file from the server's whole-file unified diff (context and `+` lines of that
 * file's section); the current text when the diff does not touch the file.
 */
export function proposed(diff: string, file: string, current: string): string {
  const lines = diff.split('\n');
  const start = lines.indexOf(`+++ b/${file}`);
  if (start < 0) return current;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('--- a/')) break;
    if (line.startsWith('@@')) continue;
    if (line.startsWith(' ') || line.startsWith('+')) out.push(line.slice(1));
  }
  return out.join('\n');
}

function Diff({ diff }: { diff: string }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-bg p-3 font-mono text-secondary">
      {diff.split('\n').map((line, i) => {
        if (line.startsWith('--- ') || line.startsWith('@@')) return null;
        const key = `${i}:${line}`;
        if (line.startsWith('+++ b/'))
          return (
            <div key={key} className="pt-2 font-sans text-fg-muted first:pt-0">
              {line.slice(6)}
            </div>
          );
        const sign = line[0] ?? ' ';
        return (
          <div
            key={key}
            className={clsx(
              'flex gap-2 whitespace-pre-wrap break-words',
              sign === '+' && 'bg-bg-sunken',
              sign === '-' && 'text-fg-muted line-through',
            )}
          >
            <span aria-hidden className="w-3 shrink-0 select-none no-underline">
              {sign.trim()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="sr-only">
                {sign === '+' ? 'lisätty: ' : sign === '-' ? 'poistettu: ' : ''}
              </span>
              {line.slice(1) || ' '}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function PendingItem({ p }: { p: MemoryState['pending'][number] }) {
  const [open, setOpen] = useState(false);
  const chatTitle = useStore(
    (s) => s.chats.find((c) => c.id === p.chatId)?.title ?? firstUserLine(s.messages[p.chatId]),
  );
  const lines = pendingLines(p);
  const long = lines.length > 3 || p.text.length > 240;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-bg-raised p-4">
      <div className="text-secondary text-fg-muted">
        {ACTION[p.action]} · {TARGET[p.target]} ·{' '}
        <button
          type="button"
          onClick={() => openChat(p.chatId)}
          className="underline underline-offset-2 hover:text-fg"
        >
          {chatTitle ?? UNTITLED}
        </button>
      </div>
      <div className={clsx(!open && long && 'max-h-24 overflow-hidden')}>
        <Diff diff={lines.join('\n')} />
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="self-start text-secondary text-fg-muted underline underline-offset-2 hover:text-fg"
        >
          {open ? 'Näytä vähemmän' : 'Näytä lisää'}
        </button>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className={secondary}
          onClick={() => send({ type: 'memory.approve', pendingId: p.id, approve: false })}
        >
          Hylkää
        </button>
        <button
          type="button"
          className={primary}
          onClick={() => send({ type: 'memory.approve', pendingId: p.id, approve: true })}
        >
          Hyväksy
        </button>
      </div>
    </li>
  );
}

function Pane({
  target,
  value,
  dirty,
  saved,
  readOnly,
  onChange,
  onSave,
}: {
  target: Target;
  value: string;
  dirty: boolean;
  /** "Tallennettu" for 2 s after the server echoed a save. */
  saved: boolean;
  readOnly: boolean;
  onChange: (text: string) => void;
  /** Undefined while the panes hold a consolidation draft (saved together by "Hyväksy"). */
  onSave: (() => void) | undefined;
}) {
  const over = value.length > CAPS[target];
  const id = `memory-${target}`;
  const canSave = !!onSave && dirty && !over;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="font-medium">
          {LABEL[target]}
        </label>
        <span className="flex items-baseline gap-2">
          {saved && (
            <span role="status" className="text-secondary text-fg-muted">
              Tallennettu
            </span>
          )}
          <span
            id={`${id}-count`}
            className={clsx('text-secondary text-fg tabular-nums', over && 'font-medium')}
          >
            {value.length} / {CAPS[target]}
            {over && ' · liian pitkä'}
          </span>
        </span>
      </div>
      <textarea
        id={id}
        value={value}
        readOnly={readOnly}
        placeholder={PLACEHOLDER[target]}
        aria-invalid={over || undefined}
        aria-describedby={`${id}-count`}
        rows={target === 'user' ? 8 : 12}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            if (canSave) onSave();
          }
        }}
        className={clsx(
          'w-full resize-y rounded-md border border-border p-3 font-mono text-secondary placeholder:text-fg-muted',
          readOnly ? 'bg-bg-sunken' : 'bg-bg',
        )}
      />
      {onSave && !readOnly && (
        <button
          type="button"
          className={`${primary} self-end`}
          disabled={!canSave}
          onClick={onSave}
        >
          Tallenna
        </button>
      )}
    </section>
  );
}

export function MemoryScreen() {
  const mem = useStore((s) => s.memory);
  const errors = useStore((s) => s.errors.length);
  const [drafts, setDrafts] = useState<Drafts>({ user: null, memory: null });
  // Panes hold the consolidation proposal as editable drafts.
  const [editing, setEditing] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [saved, setSaved] = useState<Target | null>(null);
  /** Where the user tried to go with unsaved drafts; the dialog asks before leaving. */
  const [leave, setLeave] = useState<{ screen: string; activeChatId: string | null } | null>(null);
  const dirty =
    !!mem &&
    (editing ||
      (['user', 'memory'] as const).some((t) => drafts[t] !== null && drafts[t] !== mem[t]));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => send({ type: 'memory.list' }), []);
  // A save is done when the server echoes the text; an error toast also ends the wait.
  useEffect(() => {
    setConsolidating(false);
    if (!mem || editing) return;
    setDrafts((d) => {
      for (const t of ['user', 'memory'] as const)
        if (d[t] !== null && d[t] === mem[t]) setSaved(t);
      return {
        user: d.user === mem.user ? null : d.user,
        memory: d.memory === mem.memory ? null : d.memory,
      };
    });
  }, [mem, errors]);
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), 2000);
    return () => clearTimeout(t);
  }, [saved]);

  // Unsaved drafts: the browser asks on unload; any in-app navigation is undone and asked here.
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (!dirtyRef.current || prev.screen !== 'memory' || s.screen === 'memory') return;
        setLeave({ screen: s.screen, activeChatId: s.activeChatId });
        useStore.setState({ screen: 'memory', activeChatId: prev.activeChatId });
      }),
    [],
  );

  if (!mem)
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <p className="mx-auto w-full max-w-3xl py-6 text-fg-muted">Ladataan…</p>
      </div>
    );

  const c = mem.consolidation;
  const text = (t: Target) => drafts[t] ?? mem[t];
  const save = (t: Target) => {
    const value = drafts[t];
    if (value !== null) send({ type: 'memory.edit', target: t, text: value });
  };
  const startEdit = () => {
    if (!c) return;
    setDrafts({
      user: proposed(c.diff, FILE.user, mem.user),
      memory: proposed(c.diff, FILE.memory, mem.memory),
    });
    setEditing(true);
  };
  const resolve = (accept: boolean) => {
    if (!c) return;
    send({
      type: 'memory.consolidation.resolve',
      id: c.id,
      accept,
      ...(accept && editing ? { user: text('user'), memory: text('memory') } : {}),
    });
    setEditing(false);
    setDrafts({ user: null, memory: null });
  };
  const overCap = text('user').length > CAPS.user || text('memory').length > CAPS.memory;
  const consolidate = (
    <button
      type="button"
      className={`${secondary} flex items-center gap-2`}
      disabled={consolidating}
      onClick={() => {
        setConsolidating(true);
        send({ type: 'memory.consolidate' });
      }}
    >
      {consolidating && <LoaderCircle size={16} className="animate-spin" />}
      {consolidating ? 'Tiivistetään…' : 'Tiivistä nyt'}
    </button>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-6">
        <div className="flex items-center justify-between gap-2 max-md:justify-end">
          <h1 className="font-semibold max-md:hidden">{MEMORY_TITLE}</h1>
          {!c && consolidate}
        </div>
        {mem.pending.length > 0 && (
          <section aria-labelledby="pending-writes" className="flex flex-col gap-2">
            <h2 id="pending-writes" className="text-secondary text-fg-muted">
              Odottavat kirjoitukset
            </h2>
            <ul className="flex flex-col gap-2">
              {mem.pending.map((p) => (
                <PendingItem key={p.id} p={p} />
              ))}
            </ul>
          </section>
        )}
        {c ? (
          <section aria-labelledby="consolidation" className="flex flex-col gap-2">
            <h2 id="consolidation" className="text-secondary text-fg-muted">
              Tiivistysehdotus
            </h2>
            {editing ? (
              <p className="text-secondary text-fg-muted">
                Muokkaat ehdotusta alla. Hyväksy tallentaa molemmat tiedostot.
              </p>
            ) : (
              <Diff diff={c.diff} />
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={secondary} onClick={() => resolve(false)}>
                Hylkää
              </button>
              {editing ? (
                <button
                  type="button"
                  className={secondary}
                  onClick={() => {
                    setEditing(false);
                    setDrafts({ user: null, memory: null });
                  }}
                >
                  Peruuta muokkaus
                </button>
              ) : (
                <button type="button" className={secondary} onClick={startEdit}>
                  Muokkaa
                </button>
              )}
              <button
                type="button"
                className={primary}
                disabled={editing && overCap}
                onClick={() => resolve(true)}
              >
                Hyväksy
              </button>
            </div>
          </section>
        ) : null}
        {c && !editing && (
          <p className="text-secondary text-fg-muted">
            Ratkaise tiivistysehdotus ennen muokkausta.
          </p>
        )}
        {(['user', 'memory'] as const).map((t) => (
          <Pane
            key={t}
            target={t}
            value={text(t)}
            dirty={drafts[t] !== null && drafts[t] !== mem[t]}
            saved={saved === t}
            readOnly={!!c && !editing}
            onChange={(v) => setDrafts((d) => ({ ...d, [t]: v }))}
            onSave={editing ? undefined : () => save(t)}
          />
        ))}
      </div>
      <ConfirmDialog
        open={!!leave}
        title="Hylätäänkö tallentamattomat muutokset?"
        action="Hylkää muutokset"
        onConfirm={() => {
          dirtyRef.current = false;
          setDrafts({ user: null, memory: null });
          setEditing(false);
          if (leave) useStore.setState(leave as Partial<ReturnType<typeof useStore.getState>>);
        }}
        onClose={() => setLeave(null)}
      >
        Muistiin tehdyt muokkaukset menetetään.
      </ConfirmDialog>
    </div>
  );
}
