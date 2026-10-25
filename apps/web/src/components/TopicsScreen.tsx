import { Check, Merge, Pencil, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStore } from '../store.ts';
import { send } from '../ws.ts';
import { type Action, ActionMenu, ActionRow } from './Actions.tsx';
import { UNTITLED } from './Sidebar.tsx';

export const TOPICS_TITLE = 'Aiheet';

type Proposal = ReturnType<typeof useStore.getState>['proposals'][number];
type Editing = { id: number; mode: 'rename' | 'merge' } | null;

const field = 'h-9 min-w-0 flex-1 rounded-md border border-border bg-card px-2';
const primary =
  'h-9 rounded-md bg-primary px-4 font-medium text-primary-foreground disabled:opacity-50';

function ProposalRow({
  p,
  editing,
  setEditing,
}: {
  p: Proposal;
  editing: Editing;
  setEditing: (e: Editing) => void;
}) {
  const topics = useStore((s) => s.topics);
  const chatTitle = useStore((s) => s.chats.find((c) => c.id === p.chatId)?.title);
  const [name, setName] = useState(p.name);
  const [into, setInto] = useState('');
  const mode = editing?.id === p.id ? editing.mode : null;
  const accept = (extra: { name?: string; mergeIntoTopicId?: string } = {}) => {
    send({ type: 'topic.accept', proposalId: p.id, ...extra });
    setEditing(null);
  };
  const actions: Action[] = [
    { label: 'Hyväksy', Icon: Check, run: () => accept() },
    {
      label: 'Nimeä ja hyväksy',
      Icon: Pencil,
      run: () => setEditing({ id: p.id, mode: 'rename' }),
    },
    {
      label: topics.length ? 'Yhdistä aiheeseen' : 'Yhdistä aiheeseen (ei aiheita)',
      Icon: Merge,
      ...(topics.length ? { run: () => setEditing({ id: p.id, mode: 'merge' }) } : {}),
    },
    {
      label: 'Hylkää',
      Icon: X,
      run: () => send({ type: 'topic.reject', proposalId: p.id }),
    },
  ];
  const target = into || topics[0]?.id || '';

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-card py-2 pr-1 pl-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{p.name}</div>
          <div className="text-meta text-muted-foreground">{p.why}</div>
          <div className="truncate text-meta text-muted-foreground">
            Keskustelusta: {chatTitle ?? UNTITLED}
          </div>
        </div>
        <div className="max-md:hidden">
          <ActionRow actions={actions} />
        </div>
        <div className="md:hidden">
          <ActionMenu label={`Toiminnot: ${p.name}`} actions={actions} />
        </div>
      </div>
      {mode === 'rename' && (
        <form
          className="flex flex-wrap gap-2 pr-3 pb-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) accept({ name: name.trim().slice(0, 80) });
          }}
        >
          <input
            autoFocus
            aria-label="Aiheen nimi"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
            className={field}
          />
          <button type="submit" className={primary} disabled={!name.trim()}>
            Hyväksy
          </button>
        </form>
      )}
      {mode === 'merge' && (
        <div className="flex flex-wrap gap-2 pr-3 pb-1">
          <select
            aria-label="Yhdistettävä aihe"
            value={target}
            onChange={(e) => setInto(e.target.value)}
            className={field}
          >
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={primary}
            onClick={() => target && accept({ mergeIntoTopicId: target })}
          >
            Yhdistä
          </button>
        </div>
      )}
    </li>
  );
}

export function TopicsScreen() {
  const topics = useStore((s) => s.topics);
  const proposals = useStore((s) => s.proposals);
  const [editing, setEditing] = useState<Editing>(null);

  useEffect(() => send({ type: 'topic.list' }), []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-6">
        <h1 className="font-semibold max-md:hidden">{TOPICS_TITLE}</h1>
        <section aria-labelledby="inbox-title" className="flex flex-col gap-2">
          <h2 id="inbox-title" className="text-meta text-muted-foreground">
            Ehdotukset
          </h2>
          {proposals.length ? (
            <ul className="flex flex-col gap-2">
              {proposals.map((p) => (
                <ProposalRow key={p.id} p={p} editing={editing} setEditing={setEditing} />
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Ei ehdotuksia.</p>
          )}
        </section>
        <section aria-labelledby="topics-title" className="flex flex-col gap-2">
          <h2 id="topics-title" className="text-meta text-muted-foreground">
            Omat aiheet
          </h2>
          {topics.length ? (
            <ul className="flex flex-col">
              {topics.map((t) => (
                <li key={t.id} className="flex items-center gap-3 border-t border-border py-2">
                  <div className="min-w-0 flex-1">
                    <div>{t.name}</div>
                    {t.description && (
                      <div className="truncate text-meta text-muted-foreground">
                        {t.description}
                      </div>
                    )}
                  </div>
                  <span className="text-muted-foreground tabular-nums">
                    {t.count}
                    <span className="sr-only"> keskustelua</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Ei vielä aiheita.</p>
          )}
        </section>
      </div>
    </div>
  );
}
