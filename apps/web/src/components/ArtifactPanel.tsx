import { type Artifact, artifactExt } from '@pa/protocol';
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  FileCode,
  FileImage,
  Save,
  X,
} from 'lucide-react';
import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn, saveFile } from '@/lib/utils';
import { saveArtifact } from '../api.ts';
import { fileError, showInFiles } from '../files.ts';
import { useMobile } from '../media.ts';
import { stem } from '../render.ts';
import { useStore } from '../store.ts';
import { ActionMenu } from './Actions.tsx';
import { ChartFallback, useFigure } from './Figure.tsx';
import { IconButton } from './IconButton.tsx';
import { postWhenReady, SANDBOX_URL, SandboxFrame } from './Sandbox.tsx';
import { SidePanel } from './SidePanel.tsx';

const EMPTY: Artifact[] = [];
const TAB = 'data-active:bg-card data-active:shadow-sm dark:data-active:bg-card';

function download(a: Artifact) {
  saveFile(new Blob([a.content], { type: 'text/plain' }), `${stem(a)}.${artifactExt(a)}`);
}

/** "Tallenna tiedostoksi" (phase-11 decision 12): into the work dir, with real values. */
async function saveToWork(chatId: string, artifactId: string) {
  try {
    const { entry } = await saveArtifact(chatId, artifactId);
    useStore.getState().notify('Tallennettu Työkansioon', {
      label: 'Näytä',
      onClick: () => showInFiles(entry.path),
    });
  } catch (err) {
    useStore.getState().pushError(fileError(err));
  }
}

/**
 * The document opens the sandbox page in a new tab and posts itself there; the page's `sandbox`
 * CSP keeps it off the app's origin.
 */
function openInTab(doc: string) {
  const win = window.open(SANDBOX_URL, '_blank');
  const stop = postWhenReady(() => win, doc);
  setTimeout(stop, 60_000);
}

/**
 * The side panel (brief 7.4, 7.5): docked right from 1024 px (440, at 1280 px
 * clamp(440px, 40vw, 640px)), a full-screen sheet below. Header: title, Esikatselu / Koodi, actions.
 */
export function ArtifactPanel() {
  const open = useStore((s) => s.openArtifact);
  const list = useStore((s) => (s.openArtifact ? s.artifacts[s.openArtifact.chatId] : undefined));
  const artifacts = list ?? EMPTY;
  const a = artifacts.find((x) => x.id === open?.id);
  const { doc: ready, frame, exportAs } = useFigure(a);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<'preview' | 'code'>('preview');
  const mobile = useMobile();

  if (!open || !a) return null;
  const close = () => useStore.setState({ openArtifact: null });
  const copy = () =>
    void navigator.clipboard.writeText(a.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  const exportable = (a.kind === 'vega-lite' || a.kind === 'mermaid') && !!ready?.html;
  const title = <span className="truncate">{a.title}</span>;
  const code = (
    <pre
      translate="no"
      // A scrollable region must be focusable (brief 7.8).
      tabIndex={0}
      className="size-full overflow-auto rounded-lg bg-muted p-4 font-mono text-code whitespace-pre"
    >
      {a.content}
    </pre>
  );
  const preview = ready?.refused ? (
    <ChartFallback refused={ready.refused} />
  ) : ready?.error ? (
    <p className="p-1 text-muted-foreground">Artefaktin näyttäminen epäonnistui: {ready.error}</p>
  ) : ready?.html ? (
    <SandboxFrame ref={frame} title={a.title} html={ready.html} themed />
  ) : (
    <p className="p-1 text-muted-foreground">Ladataan…</p>
  );

  const panel = (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as 'preview' | 'code')}
      className="h-full gap-0"
      asChild
    >
      <aside aria-label="Artefaktit" className="flex h-full min-h-0 flex-col bg-card">
        {/* The tabs take a second row, so the title keeps the header's width. */}
        <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 border-b px-4">
          <h2 className="flex h-12 min-w-0 flex-1 items-center text-ui font-semibold">
            {artifacts.length > 1 ? (
              // More than one artifact in the chat: the title picks between them.
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger className="flex min-w-0 items-center gap-1 rounded-md hover:text-muted-foreground">
                  {title}
                  <ChevronDown size={16} className="shrink-0 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-auto min-w-56">
                  <DropdownMenuRadioGroup
                    value={a.id}
                    onValueChange={(id) =>
                      useStore.setState({ openArtifact: { chatId: open.chatId, id } })
                    }
                  >
                    {artifacts.map((x) => (
                      <DropdownMenuRadioItem key={x.id} value={x.id}>
                        {x.title}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              title
            )}
          </h2>
          <TabsList className="order-last mb-2 w-full max-md:h-11!">
            {/* Selected: --card with --shadow-sm (brief 7.5), not the canvas colour. */}
            <TabsTrigger value="preview" className={TAB}>
              Esikatselu
            </TabsTrigger>
            <TabsTrigger value="code" className={TAB}>
              Koodi
            </TabsTrigger>
          </TabsList>
          {/* Phones: Kopioi is in the Lataa menu and the 44 px targets keep 8 px apart. */}
          {/* 32 px buttons 4 apart (44 px and 8 apart on phones): one pitch for all. */}
          <div className="flex gap-1 max-md:gap-2">
            {!mobile && (
              <IconButton label={copied ? 'Kopioitu' : 'Kopioi'} className="size-8" onClick={copy}>
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </IconButton>
            )}
            {/* One "Lataa" menu for every kind; four icons in the header (phase-19 UI review). */}
            <ActionMenu
              label="Lataa"
              className="size-8"
              Icon={Download}
              actions={[
                ...(exportable
                  ? [
                      { label: 'Lataa SVG', Icon: FileImage, run: () => exportAs('svg') },
                      { label: 'Lataa PNG', Icon: FileImage, run: () => exportAs('png') },
                    ]
                  : []),
                ...(mobile ? [{ label: 'Kopioi', Icon: Copy, run: copy }] : []),
                { label: 'Lataa lähdekoodi', Icon: FileCode, run: () => download(a) },
                // A code block opened from a message (`local-…`) has no artifact on the server.
                ...(a.id.startsWith('local-')
                  ? []
                  : [
                      {
                        label: 'Tallenna työkansioon',
                        Icon: Save,
                        run: () => void saveToWork(open.chatId, a.id),
                      },
                    ]),
              ]}
            />
            <IconButton
              label="Avaa uudessa ikkunassa"
              className="size-8"
              disabled={!ready?.html}
              onClick={() => ready?.html && openInTab(ready.html)}
            >
              <ExternalLink size={16} />
            </IconButton>
            <IconButton label="Sulje artefaktit" className="size-8" onClick={close}>
              <X size={16} />
            </IconButton>
          </div>
        </div>
        <TabsContent value="preview" className={cn('min-h-0 flex-1', !ready?.html && 'p-3')}>
          {preview}
        </TabsContent>
        <TabsContent value="code" className="min-h-0 flex-1 p-3">
          {code}
        </TabsContent>
      </aside>
    </Tabs>
  );

  return (
    <SidePanel title={a.title} description="Artefakti" onClose={close}>
      {panel}
    </SidePanel>
  );
}
