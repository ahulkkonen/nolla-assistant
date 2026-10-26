import type { FileRoot, FileUsage, TrashEntry, TreeEntry } from '@pa/protocol';
import {
  Download,
  Eye,
  File,
  FileCode,
  FileImage,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  type LucideIcon,
  MessageSquare,
  Paperclip,
  Pencil,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  fileUsage,
  HttpError,
  trashDelete,
  trashList,
  trashRestore,
  treeDelete,
  treeList,
  treeMkdir,
  treeMove,
  treeRawUrl,
  treeUpload,
} from '../api.ts';
import { attachWorkFile, fileError, formatBytes, formatDate } from '../files.ts';
import { useStore } from '../store.ts';
import { openChat } from '../ws.ts';
import { type Action, ActionMenu, ActionRow } from './Actions.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { DropOverlay, useFileDrop } from './FileDrop.tsx';
import { download, FilePreview } from './FilePreview.tsx';
import { IconButton, Tip } from './IconButton.tsx';
import { EmptyState, ListSkeleton, Page } from './Page.tsx';
import { Segmented } from './Segmented.tsx';
import { Crumbs, joinPath, MoveDialog, parentOf } from './TreeDialogs.tsx';

export const FILES_TITLE = 'Tiedostot';

type View = 'work' | 'files' | 'trash';
const VIEWS = [
  { value: 'work', label: 'Työkansio' },
  { value: 'files', label: 'Liitteet' },
  { value: 'trash', label: 'Roskakori' },
] as const;

/** The upload row's text; the toast for the same error stays within 60 characters. */
const QUOTA_ROW = 'Tallennustila on täynnä. Tyhjennä roskakori tai poista tiedostoja.';

const ICON: Record<NonNullable<TreeEntry['preview']>, LucideIcon> = {
  text: FileText,
  markdown: FileText,
  code: FileCode,
  html: FileCode,
  image: FileImage,
  pdf: FileText,
};
const iconOf = (e: { type: 'dir' | 'file'; preview?: TreeEntry['preview'] }) =>
  e.type === 'dir' ? Folder : e.preview ? ICON[e.preview] : File;

const setView = (patch: Partial<{ root: View; path: string }>) =>
  useStore.setState((s) => ({
    filesView: { ...s.filesView, focus: null, ...patch },
    filePreview: null,
  }));

/** "3,2 Gt / 10 Gt" and a 120 × 4 bar; the tooltip splits the use (phase-11 UI). */
function UsageMeter({ usage }: { usage: FileUsage }) {
  const ratio = usage.quota ? usage.used / usage.quota : 0;
  const text = `${formatBytes(usage.used)} / ${formatBytes(usage.quota)}`;
  return (
    <Tip
      label={`Työkansio ${formatBytes(usage.work)} · Roskakori ${formatBytes(usage.trash)} · Liitteet ${formatBytes(usage.files)}`}
    >
      {/* Focus shows the split too. */}
      <div
        tabIndex={0}
        className="flex items-center justify-end gap-3 rounded-sm text-meta text-muted-foreground"
      >
        <span className="tabular-nums">{text}</span>
        <div
          role="meter"
          aria-label="Tallennustila"
          aria-valuemin={0}
          aria-valuemax={usage.quota}
          aria-valuenow={Math.min(usage.used, usage.quota)}
          aria-valuetext={text}
          className="h-1 w-30 shrink-0 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              'h-full rounded-full',
              ratio >= 1 ? 'bg-destructive' : ratio >= 0.9 ? 'bg-warning' : 'bg-primary',
            )}
            style={{ width: `${Math.min(100, ratio * 100)}%` }}
          />
        </div>
      </div>
    </Tip>
  );
}

/** "Uusi kansio" and "Nimeä uudelleen": one name, "Tallenna"; a taken name shows under the field. */
function NameDialog({
  state,
  dir,
  onClose,
  onDone,
}: {
  state: { mode: 'mkdir' } | { mode: 'rename'; entry: TreeEntry } | null;
  dir: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!state) return;
    setName(state.mode === 'rename' ? state.entry.name : '');
    setError('');
  }, [state]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!state || !clean) return;
    try {
      if (state.mode === 'mkdir') await treeMkdir(joinPath(dir, clean));
      else await treeMove(state.entry.path, joinPath(parentOf(state.entry.path), clean));
      onDone();
    } catch (err) {
      setError(fileError(err));
    }
  };

  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-[420px]">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader className="min-w-0">
            <DialogTitle>
              {state?.mode === 'rename' ? 'Nimeä uudelleen' : 'Uusi kansio'}
            </DialogTitle>
            <DialogDescription className="truncate">
              {state?.mode === 'rename'
                ? `”${state.entry.name}”`
                : 'Kansio tehdään tähän kansioon.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="file-name" className="text-ui font-medium">
              Nimi
            </label>
            <Input
              id="file-name"
              value={name}
              autoComplete="off"
              aria-invalid={!!error}
              aria-describedby={error ? 'file-name-error' : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setError('');
              }}
            />
            {error && (
              <p id="file-name-error" className="text-meta text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter className="grid grid-cols-2 sm:flex">
            <Button type="button" variant="outline" onClick={onClose}>
              Peruuta
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Tallenna
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Upload = { key: string; name: string; progress: number; error?: string; abort?: () => void };

/** One row of the listing: a table row at ≥ 768 px, a card below (brief 7.5 Tables). */
type Row = {
  key: string;
  name: string;
  Icon: LucideIcon;
  /** Opens a folder (the name is a button). */
  open?: () => void;
  cells: ReactNode[];
  /** The phone card's meta line. */
  meta: string;
  /** At most two 28 px icon actions on hover or focus; the rest go into ⋯. */
  icons: Action[];
  menu: Action[];
  /** Only in the phone card's ⋯ menu (there is no "Lähde" column there). */
  cardOnly?: Action[];
  menuLabel: string;
};

function Listing({ label, heads, rows }: { label: string; heads: string[]; rows: Row[] }) {
  return (
    <>
      <div className="max-md:hidden">
        <Table label={label} className="[&_td:first-child]:pl-0 [&_th:first-child]:pl-0">
          <TableHeader>
            <TableRow>
              {heads.map((h) => (
                <TableHead key={h} className={cn(h === 'Koko' && 'text-right')}>
                  {h}
                </TableHead>
              ))}
              <TableHead className="w-0">
                <span className="sr-only">Rivin toiminnot</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key} data-path={r.key} className="group/row">
                <TableCell className="max-w-0 w-full">
                  <span className="flex min-w-0 items-center gap-2">
                    <r.Icon size={16} className="shrink-0 text-muted-foreground" />
                    {r.open ? (
                      <button
                        type="button"
                        onClick={r.open}
                        className="min-w-0 truncate text-left hover:underline"
                      >
                        {r.name}
                      </button>
                    ) : (
                      <span className="min-w-0 truncate">{r.name}</span>
                    )}
                  </span>
                </TableCell>
                {r.cells.map((c, i) => (
                  <TableCell key={i} className="text-muted-foreground">
                    {c}
                  </TableCell>
                ))}
                <TableCell className="w-0 pr-0">
                  {/* Row actions show on hover or focus (brief 7.5). */}
                  <div className="flex justify-end opacity-0 transition-opacity duration-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-aria-expanded:opacity-100 [@media(hover:none)]:opacity-100">
                    <ActionRow actions={r.icons} small />
                    {r.menu.length > 0 && <ActionMenu label={r.menuLabel} actions={r.menu} small />}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col gap-2 md:hidden" aria-label={label}>
        {rows.map((r) => (
          <li
            key={r.key}
            data-path={r.key}
            className="flex items-center gap-3 rounded-lg border bg-card py-3 pr-2 pl-4"
          >
            <r.Icon size={16} className="shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              {r.open ? (
                <button
                  type="button"
                  onClick={r.open}
                  className="block max-w-full truncate text-left font-medium"
                >
                  {r.name}
                </button>
              ) : (
                <p className="truncate font-medium">{r.name}</p>
              )}
              <p className="truncate text-meta text-muted-foreground">{r.meta}</p>
            </div>
            {r.icons.length + r.menu.length > 0 && (
              <ActionMenu
                label={r.menuLabel}
                actions={[...r.icons, ...(r.cardOnly ?? []), ...r.menu]}
              />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** "Lähde": the chat that uploaded or wrote the file, opened at the message. */
function Origin({ origin }: { origin: TreeEntry['origin'] }) {
  if (!origin) return null;
  return (
    <a
      href={`/?chat=${encodeURIComponent(origin.chatId)}`}
      onClick={(e) => {
        e.preventDefault();
        openChat(origin.chatId, origin.messageId);
      }}
      className="block max-w-48 truncate text-link underline-offset-4 hover:underline"
    >
      {origin.chatTitle ?? 'Keskustelu'}
    </a>
  );
}

/** Tiedostot (phase-11): Työkansio, Liitteet and Roskakori with preview, upload and the meter. */
export function FilesScreen() {
  const view = useStore((s) => s.filesView);
  const preview = useStore((s) => s.filePreview);
  const [usage, setUsage] = useState<FileUsage | null>(null);
  const key = `${view.root}:${view.path}`;
  const [list, setList] = useState<{ key: string; entries: TreeEntry[]; next: string | null }>();
  const [trash, setTrash] = useState<{ entries: TrashEntry[]; next: string | null }>();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [naming, setNaming] = useState<Parameters<typeof NameDialog>[0]['state']>(null);
  const [moving, setMoving] = useState<TreeEntry | null>(null);
  const [purge, setPurge] = useState<TrashEntry | 'all' | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const root: FileRoot = view.root === 'files' ? 'files' : 'work';

  const refreshUsage = () => void fileUsage().then(setUsage, () => {});
  const load = async (cursor?: string) => {
    try {
      if (view.root === 'trash') {
        const l = await trashList(cursor);
        setTrash((prev) => ({
          entries: cursor && prev ? [...prev.entries, ...l.entries] : l.entries,
          next: l.nextCursor,
        }));
        return;
      }
      const l = await treeList(view.root, view.path, cursor);
      setList((prev) => ({
        key,
        entries: cursor && prev?.key === key ? [...prev.entries, ...l.entries] : l.entries,
        next: l.nextCursor,
      }));
    } catch (err) {
      // A folder that is gone (moved or deleted elsewhere): back to the root.
      if (err instanceof HttpError && err.code === 'not_found' && view.path) setView({ path: '' });
      else useStore.getState().pushError(fileError(err));
    }
  };
  const reload = () => {
    void load();
    refreshUsage();
  };
  useEffect(() => {
    void load();
  }, [key]);
  useEffect(refreshUsage, []);

  // "Näytä" after "Tallenna tiedostoksi": the file opens in the preview once its folder is listed.
  const entries = list?.key === key ? list.entries : undefined;
  useEffect(() => {
    if (!view.focus || !entries) return;
    const hit = entries.find((e) => e.path === view.focus);
    useStore.setState((s) => ({
      filesView: { ...s.filesView, focus: null },
      ...(hit?.preview ? { filePreview: { root: 'work' as const, entry: hit } } : {}),
    }));
    if (hit)
      document
        .querySelector(`[data-path="${CSS.escape(hit.path)}"]`)
        ?.scrollIntoView({ block: 'center' });
  }, [view.focus, entries]);

  const patch = (k: string, p: Partial<Upload>) =>
    setUploads((u) => u.map((x) => (x.key === k ? { ...x, ...p } : x)));
  const drop = (k: string) => setUploads((u) => u.filter((x) => x.key !== k));
  /** One request per file, with progress; errors stay on the file's row. */
  const upload = async (files: File[]) => {
    if (view.root !== 'work' || !files.length) return;
    const dir = view.path;
    const rows = files.map((f) => ({ key: crypto.randomUUID(), file: f }));
    setUploads((u) => [
      ...u,
      ...rows.map(({ key: k, file }) => ({ key: k, name: file.name, progress: 0 })),
    ]);
    await Promise.all(
      rows.map(async ({ key: k, file }) => {
        const job = treeUpload(dir, file, (progress) => patch(k, { progress }));
        patch(k, { abort: job.abort });
        try {
          await job.done;
          drop(k);
        } catch (err) {
          if (err instanceof DOMException) return drop(k);
          const quota = err instanceof HttpError && err.code === 'quota';
          patch(k, { error: quota ? QUOTA_ROW : fileError(err), abort: () => drop(k) });
          if (quota) useStore.getState().pushError(fileError(err));
        }
      }),
    );
    reload();
  };
  const dropping = useFileDrop(view.root === 'work', (files) => void upload(files));

  const remove = async (e: TreeEntry) => {
    try {
      const { entry } = await treeDelete(e.path);
      if (preview?.entry.path === e.path) useStore.setState({ filePreview: null });
      reload();
      useStore.getState().notify('Siirretty roskakoriin', {
        label: 'Kumoa',
        onClick: () =>
          void trashRestore(entry.id).then(reload, (err: unknown) =>
            useStore.getState().pushError(fileError(err)),
          ),
      });
    } catch (err) {
      useStore.getState().pushError(fileError(err));
    }
  };
  const restore = async (e: TrashEntry) => {
    try {
      await trashRestore(e.id);
      reload();
    } catch (err) {
      useStore.getState().pushError(fileError(err));
    }
  };
  const destroy = async (target: TrashEntry | 'all') => {
    setPurge(null);
    try {
      await trashDelete(target === 'all' ? undefined : target.id);
      reload();
    } catch (err) {
      useStore.getState().pushError(fileError(err));
    }
  };
  const show = (e: TreeEntry) => useStore.setState({ filePreview: { root, entry: e } });

  const fileRow = (e: TreeEntry): Row => {
    const dir = e.type === 'dir';
    const size = dir ? '' : formatBytes(e.size);
    const icons: Action[] = dir
      ? []
      : [
          ...(e.preview ? [{ label: `Esikatsele: ${e.name}`, Icon: Eye, run: () => show(e) }] : []),
          {
            label: `Lataa: ${e.name}`,
            Icon: Download,
            run: () => download(treeRawUrl(root, e.path, true)),
          },
        ];
    const chat: Action[] = e.origin
      ? [
          {
            label: 'Avaa keskustelu',
            Icon: MessageSquare,
            run: () => e.origin && openChat(e.origin.chatId, e.origin.messageId),
          },
        ]
      : [];
    const menu: Action[] =
      root === 'files'
        ? chat
        : [
            ...(dir
              ? []
              : [
                  {
                    label: 'Liitä keskusteluun',
                    Icon: Paperclip,
                    run: () => void attachWorkFile(e.path),
                  },
                ]),
            {
              label: 'Nimeä uudelleen',
              Icon: Pencil,
              run: () => setNaming({ mode: 'rename', entry: e }),
            },
            { label: 'Siirrä', Icon: FolderInput, run: () => setMoving(e) },
            { label: 'Poista', Icon: Trash2, run: () => void remove(e) },
          ];
    return {
      key: e.path,
      name: e.name,
      Icon: iconOf(e),
      ...(dir ? { open: () => setView({ path: e.path }) } : {}),
      cells: [
        <span key="size" className="block text-right tabular-nums">
          {size}
        </span>,
        // With the preview open the table has half the width: no "Lähde", the date only.
        formatDate(e.modifiedAt, !preview),
        ...(preview ? [] : [<Origin key="origin" origin={e.origin} />]),
      ],
      meta: dir ? formatDate(e.modifiedAt, false) : `${size} · ${formatDate(e.modifiedAt, false)}`,
      icons,
      menu,
      ...(root === 'work' ? { cardOnly: chat } : {}),
      menuLabel: `${dir ? 'Kansion' : root === 'files' ? 'Liitteen' : 'Tiedoston'} toiminnot: ${e.name}`,
    };
  };
  const trashRow = (e: TrashEntry): Row => ({
    key: e.id,
    name: e.name,
    Icon: iconOf(e),
    cells: [
      <span key="from" className="block max-w-60 truncate">
        {e.originalPath}
      </span>,
      formatDate(e.deletedAt),
      <span key="size" className="block text-right tabular-nums">
        {formatBytes(e.size)}
      </span>,
    ],
    meta: `${e.originalPath} · ${formatDate(e.deletedAt, false)}`,
    icons: [
      { label: `Palauta: ${e.name}`, Icon: RotateCcw, run: () => void restore(e) },
      { label: `Poista pysyvästi: ${e.name}`, Icon: Trash2, run: () => setPurge(e) },
    ],
    menu: [],
    menuLabel: `Roskakorin toiminnot: ${e.name}`,
  });

  const loading = view.root === 'trash' ? !trash : !entries;
  const next = view.root === 'trash' ? trash?.next : list?.key === key ? list.next : null;

  return (
    <div className="flex min-h-0 flex-1">
      <Page title={FILES_TITLE} wide action={usage && <UsageMeter usage={usage} />}>
        <div className="flex flex-col gap-4">
          <Segmented
            label="Näkymä"
            options={VIEWS}
            value={view.root}
            onChange={(root) => setView({ root, path: '' })}
            className="self-start max-md:w-full"
          />
          {view.root === 'work' && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {/* Phones: the path takes its own line above the buttons. */}
              <div className="min-w-0 flex-1 max-md:basis-full">
                <Crumbs path={view.path} onGo={(path) => setView({ path })} />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => picker.current?.click()}>
                  <Upload size={16} />
                  Lataa tiedostoja
                </Button>
                <Button variant="ghost" onClick={() => setNaming({ mode: 'mkdir' })}>
                  <FolderPlus size={16} />
                  Uusi kansio
                </Button>
              </div>
              <input
                ref={picker}
                id="files-upload"
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void upload([...(e.target.files ?? [])]);
                  e.target.value = '';
                }}
              />
            </div>
          )}
          {view.root === 'trash' && (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <p className="text-meta text-muted-foreground">
                Roskakorin tiedostot poistetaan 30 päivän kuluttua.
              </p>
              {!!trash?.entries.length && (
                <Button variant="outline" onClick={() => setPurge('all')}>
                  <Trash2 size={16} />
                  Tyhjennä roskakori
                </Button>
              )}
            </div>
          )}
          {uploads.length > 0 && (
            <ul aria-label="Lataukset" className="flex flex-col gap-2">
              {uploads.map((u) => {
                const pct = Math.round(u.progress * 100);
                return (
                  <li
                    key={u.key}
                    className="flex items-center gap-3 rounded-lg border py-2 pr-1 pl-3"
                  >
                    <Upload size={16} className="shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-ui">{u.name}</span>
                        {!u.error && (
                          <span className="text-meta text-muted-foreground tabular-nums">
                            {pct} %
                          </span>
                        )}
                      </div>
                      {u.error ? (
                        <p className="text-meta text-destructive">{u.error}</p>
                      ) : (
                        <div
                          role="progressbar"
                          aria-label={`Lataus: ${u.name}`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={pct}
                          className="mt-1 h-0.5 overflow-hidden rounded-full bg-muted"
                        >
                          <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                        </div>
                      )}
                    </div>
                    <IconButton
                      label={`${u.error ? 'Piilota' : 'Peruuta lataus'}: ${u.name}`}
                      className="size-7"
                      onClick={() => (u.error ? drop(u.key) : u.abort?.())}
                    >
                      <X size={16} />
                    </IconButton>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {loading ? (
          <ListSkeleton loading />
        ) : view.root === 'trash' ? (
          trash?.entries.length ? (
            <Listing
              label="Roskakori"
              heads={['Nimi', 'Alkuperäinen sijainti', 'Poistettu', 'Koko']}
              rows={trash.entries.map(trashRow)}
            />
          ) : (
            <EmptyState Icon={Trash2} title="Roskakori on tyhjä" />
          )
        ) : entries?.length ? (
          <Listing
            label={view.root === 'files' ? 'Liitteet' : 'Työkansio'}
            heads={['Nimi', 'Koko', 'Muokattu', ...(preview ? [] : ['Lähde'])]}
            rows={entries.map(fileRow)}
          />
        ) : view.root === 'files' ? (
          <EmptyState Icon={Paperclip} title="Ei liitteitä" />
        ) : (
          <EmptyState
            Icon={FolderOpen}
            title="Kansio on tyhjä"
            line="Tiedostot, jotka avustaja kirjoittaa, näkyvät täällä."
          />
        )}
        {next && (
          <Button variant="outline" className="self-center" onClick={() => void load(next)}>
            Näytä lisää
          </Button>
        )}
      </Page>
      {preview && (
        <FilePreview
          root={preview.root}
          entry={preview.entry}
          onClose={() => useStore.setState({ filePreview: null })}
        />
      )}
      <NameDialog
        state={naming}
        dir={view.path}
        onClose={() => setNaming(null)}
        onDone={() => {
          setNaming(null);
          reload();
        }}
      />
      <MoveDialog
        entry={moving}
        onClose={() => setMoving(null)}
        onMoved={() => {
          setMoving(null);
          reload();
        }}
      />
      <ConfirmDialog
        open={!!purge}
        title={
          purge === 'all'
            ? 'Tyhjennetäänkö roskakori?'
            : `Poistetaanko ”${purge?.name ?? ''}” pysyvästi?`
        }
        action={purge === 'all' ? 'Tyhjennä' : 'Poista'}
        destructive
        onConfirm={() => purge && void destroy(purge)}
        onClose={() => setPurge(null)}
      >
        {purge === 'all'
          ? 'Kaikki roskakorin tiedostot poistetaan. Tätä ei voi perua.'
          : 'Tiedosto poistetaan. Tätä ei voi perua.'}
      </ConfirmDialog>
      {dropping && <DropOverlay />}
    </div>
  );
}
