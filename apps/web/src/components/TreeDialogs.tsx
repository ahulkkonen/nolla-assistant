import type { TreeEntry } from '@pa/protocol';
import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { treeList, treeMove } from '../api.ts';
import { attachWorkFile, fileError, formatBytes, iconOf } from '../files.ts';

/** The parent folder of a work-dir path ('' is the root). */
export const parentOf = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/**
 * Kansiopolku (phase-11 UI): the segments are link buttons, the last one is text with
 * `aria-current`. A path of more than four levels keeps the root and the last two.
 */
export function Crumbs({ path, onGo }: { path: string; onGo: (path: string) => void }) {
  const parts = path ? path.split('/') : [];
  const all = [
    { name: 'Työkansio', path: '' },
    ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') })),
  ];
  const shown = all.length > 4 ? [all[0], null, ...all.slice(-2)] : all;
  return (
    <nav aria-label="Kansiopolku" className="min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1 text-ui">
        {shown.map((c, i) => (
          <li key={c?.path ?? '…'} className="flex min-w-0 items-center gap-1">
            {i > 0 && (
              <ChevronRight
                size={14}
                aria-hidden="true"
                className="shrink-0 text-muted-foreground"
              />
            )}
            {!c ? (
              <span className="text-muted-foreground">…</span>
            ) : i === shown.length - 1 ? (
              <span aria-current="page" className="truncate font-medium">
                {c.name}
              </span>
            ) : (
              <Button
                variant="link"
                onClick={() => onGo(c.path)}
                className="min-w-0 font-normal text-muted-foreground hover:text-foreground"
              >
                <span className="truncate">{c.name}</span>
              </Button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * A work-dir folder in a dialog: folders open, and (`files`) a file can be picked. Pages load with
 * "Näytä lisää" as on the screen.
 */
function TreeBrowser({
  path,
  onPath,
  files,
  skip,
  picked,
  onPick,
}: {
  path: string;
  onPath: (path: string) => void;
  files: boolean;
  /** A folder that cannot be a target (the folder being moved). */
  skip?: string;
  picked?: string | null;
  onPick?: (path: string) => void;
}) {
  const [list, setList] = useState<{ path: string; entries: TreeEntry[]; next: string | null }>();
  const [failed, setFailed] = useState(false);
  const load = (cursor?: string) =>
    treeList('work', path, cursor).then(
      (l) =>
        setList((prev) => ({
          path,
          entries: cursor && prev ? [...prev.entries, ...l.entries] : l.entries,
          next: l.nextCursor,
        })),
      () => setFailed(true),
    );
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setFailed(false);
    // A folder opens at its top.
    box.current?.scrollTo(0, 0);
    void load();
  }, [path]);

  const shown = (list?.path === path ? list.entries : []).filter(
    (e) => (files || e.type === 'dir') && e.path !== skip,
  );
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Crumbs path={path} onGo={onPath} />
      {/* Sized to the content, 2 to 7 whole rows: a row is never cut at the bottom edge. */}
      <div
        ref={box}
        className="max-h-[calc(7*2.5rem+0.5rem+2px)] min-h-[calc(2*2.5rem+0.5rem+2px)] overflow-y-auto rounded-lg border max-md:max-h-[calc(7*2.75rem+0.5rem+2px)] max-md:min-h-[calc(2*2.75rem+0.5rem+2px)]"
      >
        {failed ? (
          <p className="p-4 text-meta text-muted-foreground">Kansiota ei löydy.</p>
        ) : list?.path === path && !shown.length ? (
          <p className="p-4 text-meta text-muted-foreground">
            {files ? 'Kansio on tyhjä' : 'Ei alikansioita'}
          </p>
        ) : (
          <ul className="p-1">
            {shown.map((e) => {
              const dir = e.type === 'dir';
              const Icon = iconOf(e);
              return (
                <li key={e.path}>
                  <button
                    type="button"
                    {...(dir ? {} : { 'aria-pressed': picked === e.path })}
                    onClick={() => (dir ? onPath(e.path) : onPick?.(e.path))}
                    className={cn(
                      'flex min-h-10 w-full items-center gap-3 rounded-md px-3 text-left text-body hover:bg-accent max-md:min-h-11',
                      !dir && picked === e.path && 'bg-accent font-medium',
                    )}
                  >
                    <Icon size={16} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    {dir ? (
                      <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
                    ) : (
                      <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
                        {formatBytes(e.size)}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {list?.path === path && list.next && (
          <div className="p-1">
            <Button variant="outline" className="w-full" onClick={() => void load(list.next ?? '')}>
              Näytä lisää
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** "Siirrä kohteeseen" (phase-11 UI): pick a folder, then "Siirrä tähän". */
export function MoveDialog({
  entry,
  onClose,
  onMoved,
}: {
  entry: TreeEntry | null;
  onClose: () => void;
  onMoved: (entry: TreeEntry) => void;
}) {
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!entry) return;
    setPath(parentOf(entry.path));
    setError('');
  }, [entry]);

  const move = async () => {
    if (!entry) return;
    try {
      const { entry: moved } = await treeMove(entry.path, joinPath(path, entry.name));
      onMoved(moved);
    } catch (err) {
      setError(fileError(err, { bad_path: 'Kansiota ei voi siirtää itseensä.' }));
    }
  };

  return (
    <Dialog open={!!entry} onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-[480px]">
        <DialogHeader className="min-w-0">
          <DialogTitle>Siirrä kohteeseen</DialogTitle>
          <DialogDescription className="truncate">”{entry?.name}”</DialogDescription>
        </DialogHeader>
        <TreeBrowser
          path={path}
          onPath={(p) => {
            setPath(p);
            setError('');
          }}
          files={false}
          {...(entry?.type === 'dir' ? { skip: entry.path } : {})}
        />
        {error && (
          <p role="alert" className="text-meta text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="grid grid-cols-2 sm:flex">
          <Button variant="outline" onClick={onClose}>
            Peruuta
          </Button>
          {/* Its own folder is no move. */}
          <Button disabled={!entry || path === parentOf(entry.path)} onClick={() => void move()}>
            Siirrä tähän
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Valitse työkansiosta" (the composer's attach menu): one file, then "Liitä". */
export function WorkPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [path, setPath] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (open) setPicked(null);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Valitse työkansiosta</DialogTitle>
          <DialogDescription>Liitettävästä tiedostosta tehdään kopio viestiin.</DialogDescription>
        </DialogHeader>
        <TreeBrowser
          path={path}
          onPath={(p) => {
            setPath(p);
            setPicked(null);
          }}
          files
          picked={picked}
          onPick={setPicked}
        />
        <DialogFooter className="grid grid-cols-2 sm:flex">
          <Button variant="outline" onClick={onClose}>
            Peruuta
          </Button>
          <Button
            disabled={!picked}
            onClick={() => {
              if (!picked) return;
              onClose();
              void attachWorkFile(picked);
            }}
          >
            Liitä
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
