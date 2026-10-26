import { Info, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { firstUserLine, type MemoryState, pendingLines, useStore } from '../store.ts';
import { openChat, send } from '../ws.ts';
import { useLeaveGuard } from './ConfirmDialog.tsx';
import { Page, useSlow } from './Page.tsx';
import { UNTITLED } from './Sidebar.tsx';

export const MEMORY_TITLE = 'Muisti';

type Target = 'user' | 'memory';
type Drafts = Record<Target, string | null>;

const CAPS = { user: 1500, memory: 2500 } as const;
const FILE = { user: 'USER.md', memory: 'MEMORY.md' } as const;
const LABEL = { user: 'Käyttäjä (USER.md)', memory: 'Muisti (MEMORY.md)' } as const;
/** "Lisäys: MEMORY.md": what the write does, and to which file. */
const ACTION = { add: 'Lisäys', replace: 'Korvaus', remove: 'Poisto' } as const;
const PLACEHOLDER = {
  user: 'Kerro itsestäsi: kuka olet, mitä toivot vastauksilta, pysyvät ohjeet.',
  memory: 'Agentti lisää tänne pysyviä tietoja. Voit muokata niitä itse.',
} as const;

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

/**
 * One diff line (brief 7.5): added on --success-subtle with "+", removed on --destructive-subtle
 * with "−", no strike-through; the sign is announced as a word.
 */
export function DiffLine({ sign, text }: { sign: string; text: string }) {
  return (
    <div
      className={cn(
        'flex gap-2 rounded-xs px-2 break-words whitespace-pre-wrap',
        sign === '+' && 'bg-success-subtle',
        sign === '-' && 'bg-destructive-subtle',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'w-3 shrink-0 select-none',
          sign === '+' && 'text-success',
          sign === '-' && 'text-destructive',
        )}
      >
        {sign === '-' ? '−' : sign.trim()}
      </span>
      <span className="min-w-0 flex-1">
        {(sign === '+' || sign === '-') && (
          <span className="sr-only">{sign === '+' ? 'Lisätty: ' : 'Poistettu: '}</span>
        )}
        {text || ' '}
      </span>
    </div>
  );
}

/** A unified diff in mono 13/20; each file's name as a micro label. */
function Diff({ diff }: { diff: string }) {
  return (
    <div className="flex flex-col gap-0.5 overflow-x-auto font-mono text-[13px] leading-5">
      {diff.split('\n').map((line, i) => {
        if (line.startsWith('--- ') || line.startsWith('@@')) return null;
        const key = `${i}:${line}`;
        if (line.startsWith('+++ b/'))
          return (
            <div key={key} className="pt-2 font-sans text-micro text-muted-foreground first:pt-0">
              {line.slice(6)}
            </div>
          );
        return <DiffLine key={key} sign={line[0] ?? ' '} text={line.slice(1)} />;
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
    <li className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-1 text-meta text-muted-foreground">
        {ACTION[p.action]}: <span className="font-mono">{FILE[p.target]}</span> ·
        <Button variant="link" className="text-meta" onClick={() => openChat(p.chatId)}>
          {chatTitle ?? UNTITLED}
        </Button>
      </div>
      <div
        className={cn(
          !open &&
            long &&
            'max-h-24 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]',
        )}
      >
        <Diff diff={lines.join('\n')} />
      </div>
      {long && (
        <Button variant="link" className="self-start text-meta" onClick={() => setOpen(!open)}>
          {open ? 'Näytä vähemmän' : 'Näytä lisää'}
        </Button>
      )}
      <div className="flex justify-end gap-2 max-md:grid max-md:grid-cols-2">
        <Button
          variant="ghost"
          onClick={() => send({ type: 'memory.approve', pendingId: p.id, approve: false })}
        >
          Hylkää
        </Button>
        <Button onClick={() => send({ type: 'memory.approve', pendingId: p.id, approve: true })}>
          Hyväksy
        </Button>
      </div>
    </li>
  );
}

/** A memory file as a card (brief 7.5): heading, counter, mono textarea, "Tallenna". */
function Pane({
  target,
  value,
  dirty,
  readOnly,
  onChange,
  onSave,
}: {
  target: Target;
  value: string;
  dirty: boolean;
  readOnly: boolean;
  onChange: (text: string) => void;
  /** Undefined while the panes hold a consolidation draft (saved together by "Hyväksy"). */
  onSave: (() => void) | undefined;
}) {
  const over = value.length > CAPS[target];
  const near = value.length >= CAPS[target] * 0.9;
  const id = `memory-${target}`;
  const canSave = !!onSave && dirty && !over;
  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-heading">
          {LABEL[target]}
        </label>
        <span
          id={`${id}-count`}
          className={cn(
            'text-meta text-muted-foreground tabular-nums',
            near && 'text-warning',
            over && 'font-medium text-destructive',
          )}
        >
          {value.length} / {CAPS[target]}
          {over && ' · liian pitkä'}
        </span>
      </div>
      <Textarea
        id={id}
        value={value}
        readOnly={readOnly}
        placeholder={PLACEHOLDER[target]}
        aria-invalid={over || undefined}
        aria-describedby={`${id}-count`}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            if (canSave) onSave();
          }
        }}
        className={cn(
          'field-sizing-fixed min-h-60 font-mono text-[14px] leading-[22px] max-md:text-[16px]',
          readOnly ? 'resize-none bg-muted hover:border-border' : 'resize-y',
        )}
      />
      {onSave && !readOnly && (
        <Button className="self-end" disabled={!canSave} onClick={onSave}>
          Tallenna
        </Button>
      )}
    </section>
  );
}

export function MemoryScreen() {
  const mem = useStore((s) => s.memory);
  const errors = useStore((s) => s.errorCount);
  const [drafts, setDrafts] = useState<Drafts>({ user: null, memory: null });
  // Panes hold the consolidation proposal as editable drafts.
  const [editing, setEditing] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  // Only real differences count: opening a pane or the editor alone must not trigger the guard.
  const dirty =
    !!mem && (['user', 'memory'] as const).some((t) => drafts[t] !== null && drafts[t] !== mem[t]);
  const guard = useLeaveGuard('memory', dirty, 'Muistiin tehdyt muokkaukset menetetään.', () => {
    setDrafts({ user: null, memory: null });
    setEditing(false);
  });
  const slow = useSlow(!mem);

  useEffect(() => send({ type: 'memory.list' }), []);
  // A save is done when the server echoes the text (a "Tallennettu" toast); an error toast also
  // ends the wait.
  useEffect(() => {
    setConsolidating(false);
    if (!mem || editing) return;
    if ((['user', 'memory'] as const).some((t) => drafts[t] !== null && drafts[t] === mem[t]))
      useStore.getState().notify('Tallennettu');
    setDrafts((d) => ({
      user: d.user === mem.user ? null : d.user,
      memory: d.memory === mem.memory ? null : d.memory,
    }));
  }, [mem, errors]);

  if (!mem)
    return (
      <Page title={MEMORY_TITLE} wide>
        {/* Memory panes load as one 240 px block each (brief 7.5), after 300 ms. */}
        {slow && (
          <div aria-hidden="true" className="grid gap-6 xl:grid-cols-2">
            <Skeleton className="h-60 rounded-lg" />
            <Skeleton className="h-60 rounded-lg" />
          </div>
        )}
      </Page>
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
    <Button
      variant="outline"
      disabled={consolidating}
      onClick={() => {
        setConsolidating(true);
        send({ type: 'memory.consolidate' });
      }}
    >
      {consolidating && <LoaderCircle size={16} className="animate-spin" />}
      {consolidating ? 'Tiivistetään…' : 'Tiivistä nyt'}
    </Button>
  );

  return (
    <Page title={MEMORY_TITLE} wide {...(c ? {} : { action: consolidate })}>
      {mem.pending.length > 0 && (
        <section aria-labelledby="pending-writes" className="flex flex-col gap-3">
          <h2 id="pending-writes" className="text-heading">
            Odottavat kirjoitukset
          </h2>
          <ul className="flex flex-col gap-2">
            {mem.pending.map((p) => (
              <PendingItem key={p.id} p={p} />
            ))}
          </ul>
        </section>
      )}
      {c && (
        <section
          aria-labelledby="consolidation"
          className="flex flex-col gap-3 rounded-lg border bg-card p-4"
        >
          <h2 id="consolidation" className="text-heading">
            Tiivistysehdotus
          </h2>
          {editing ? (
            <p className="text-meta text-muted-foreground">
              Muokkaat ehdotusta alla. Hyväksy tallentaa molemmat tiedostot.
            </p>
          ) : (
            <Diff diff={c.diff} />
          )}
          <div className="flex justify-end gap-2 max-md:grid max-md:grid-cols-3">
            <Button variant="ghost" onClick={() => resolve(false)}>
              Hylkää
            </Button>
            {editing ? (
              <Button
                variant="outline"
                onClick={() => {
                  setEditing(false);
                  setDrafts({ user: null, memory: null });
                }}
              >
                Peruuta
              </Button>
            ) : (
              <Button variant="outline" onClick={startEdit}>
                Muokkaa
              </Button>
            )}
            <Button disabled={editing && overCap} onClick={() => resolve(true)}>
              Hyväksy
            </Button>
          </div>
        </section>
      )}
      <div className="flex flex-col gap-3">
        {c && !editing && (
          <p className="flex items-center gap-2 rounded-lg bg-info-subtle px-3 py-2 text-meta text-foreground">
            <Info size={16} className="shrink-0 text-info" />
            Ratkaise tiivistysehdotus ennen muokkausta.
          </p>
        )}
        <div className="grid gap-6 xl:grid-cols-2">
          {(['user', 'memory'] as const).map((t) => (
            <Pane
              key={t}
              target={t}
              value={text(t)}
              dirty={drafts[t] !== null && drafts[t] !== mem[t]}
              readOnly={!!c && !editing}
              onChange={(v) => setDrafts((d) => ({ ...d, [t]: v }))}
              onSave={editing ? undefined : () => save(t)}
            />
          ))}
        </div>
      </div>
      {guard}
    </Page>
  );
}
