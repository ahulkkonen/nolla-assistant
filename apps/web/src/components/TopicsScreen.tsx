import { Check, Merge, Pencil, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useStore } from '../store.ts';
import { send } from '../ws.ts';
import { type Action, ActionMenu } from './Actions.tsx';
import { ListSkeleton, Page } from './Page.tsx';
import { UNTITLED } from './Sidebar.tsx';

export const TOPICS_TITLE = 'Aiheet';

type Proposal = ReturnType<typeof useStore.getState>['proposals'][number];
type Editing = { id: number; mode: 'rename' | 'merge' } | null;

/** A topic suggestion (brief 7.5): a card, "Hyväksy" visible, the rest in ⋯. */
function ProposalCard({
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
  const more: Action[] = [
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
    { label: 'Hylkää', Icon: X, run: () => send({ type: 'topic.reject', proposalId: p.id }) },
  ];
  const target = into || topics[0]?.id || '';

  return (
    <li className="flex flex-col gap-3 rounded-lg border bg-card py-3 pr-2 pl-4">
      {/* Phones: "Hyväksy" moves under the text so the text keeps its width. */}
      <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 md:grid-cols-[1fr_auto_auto]">
        <div className="col-start-1 row-start-1 min-w-0">
          <div className="font-medium">{p.name}</div>
          <div className="text-meta text-muted-foreground text-pretty">{p.why}</div>
          <div className="truncate text-meta text-muted-foreground">
            Keskustelusta: {chatTitle ?? UNTITLED}
          </div>
        </div>
        {!mode && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => accept()}
            className="col-start-1 row-start-2 justify-self-start md:col-start-2 md:row-start-1"
          >
            <Check size={16} />
            Hyväksy
          </Button>
        )}
        <div className="col-start-2 row-start-1 md:col-start-3">
          <ActionMenu label={`Toiminnot: ${p.name}`} actions={more} small />
        </div>
      </div>
      {mode === 'rename' && (
        <form
          className="flex flex-wrap gap-2 pr-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) accept({ name: name.trim().slice(0, 80) });
          }}
        >
          <Input
            autoFocus
            aria-label="Aiheen nimi"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
            className="min-w-0 flex-1"
          />
          <Button type="submit" disabled={!name.trim()}>
            Hyväksy
          </Button>
        </form>
      )}
      {mode === 'merge' && (
        <div className="flex flex-wrap gap-2 pr-2">
          <Select value={target} onValueChange={setInto}>
            <SelectTrigger aria-label="Yhdistettävä aihe" className="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {topics.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => target && accept({ mergeIntoTopicId: target })}>Yhdistä</Button>
        </div>
      )}
    </li>
  );
}

export function TopicsScreen() {
  const topics = useStore((s) => s.topics);
  const proposals = useStore((s) => s.proposals);
  const loaded = useStore((s) => s.topicsLoaded);
  const [editing, setEditing] = useState<Editing>(null);

  useEffect(() => send({ type: 'topic.list' }), []);

  return (
    <Page title={TOPICS_TITLE}>
      <section aria-labelledby="inbox-title" className="flex flex-col gap-3">
        <h2 id="inbox-title" className="text-heading">
          Ehdotukset
        </h2>
        <ListSkeleton loading={!loaded} rows={2} />
        {loaded &&
          (proposals.length ? (
            <ul className="flex flex-col gap-2">
              {proposals.map((p) => (
                <ProposalCard key={p.id} p={p} editing={editing} setEditing={setEditing} />
              ))}
            </ul>
          ) : (
            <p className="text-meta text-muted-foreground">Ei ehdotuksia.</p>
          ))}
      </section>
      <section aria-labelledby="topics-title" className="flex flex-col gap-3">
        <h2 id="topics-title" className="text-heading">
          Omat aiheet
        </h2>
        <ListSkeleton loading={!loaded} rows={3} />
        {loaded &&
          (topics.length ? (
            <ul className="flex flex-col divide-y divide-border border-y">
              {topics.map((t) => (
                <li key={t.id} className="flex min-h-14 items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{t.name}</div>
                    {t.description && (
                      <div className="truncate text-meta text-muted-foreground">
                        {t.description}
                      </div>
                    )}
                  </div>
                  <Badge className="tabular-nums">
                    {t.count}
                    <span className="sr-only"> keskustelua</span>
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-meta text-muted-foreground">
              Ei vielä aiheita. Hyväksytyt ehdotukset näkyvät täällä.
            </p>
          ))}
      </section>
    </Page>
  );
}
