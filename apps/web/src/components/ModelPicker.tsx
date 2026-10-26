import type { CatalogModel, ModelChoice, ReasoningEffort } from '@pa/protocol';
import { ChevronDown, Search, ShieldCheck, ShieldOff, Star } from 'lucide-react';
import { type KeyboardEvent, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useMobile } from '../media.ts';
import { useStore } from '../store.ts';
import { send } from '../ws.ts';
import { IconButton, Tip } from './IconButton.tsx';

/** Thinking levels in Finnish (docs/decisions/phase-10-models.md, UI). */
export const EFFORT_LABEL: Record<'auto' | ReasoningEffort, string> = {
  auto: 'Automaattinen',
  max: 'Maksimi',
  xhigh: 'Erittäin korkea',
  high: 'Korkea',
  medium: 'Keskitaso',
  low: 'Matala',
  minimal: 'Minimaalinen',
  none: 'Pois',
};

/** The alias of an agent profile as infra/models.json names it: `zdr/strong` → "Strong (ZDR)". */
const aliasName = (alias: string) => {
  const base = alias.replace(/^zdr\//, '').replace(/-/g, ' ');
  return `${base.charAt(0).toUpperCase()}${base.slice(1)} (ZDR)`;
};

/** "1 M", "200 k": a context length. */
const tokens = (n: number) =>
  n >= 1e6 ? `${String(Math.round(n / 1e5) / 10).replace('.', ',')} M` : `${Math.round(n / 1e3)} k`;
/** "2,00 / 10,00 $": input and output price per 1M tokens. */
const price = (m: CatalogModel) =>
  `${m.price.input.toFixed(2).replace('.', ',')} / ${m.price.output.toFixed(2).replace('.', ',')} $`;

/**
 * The model of the open chat (or the new chat's pending choice): its policy, the catalog entry
 * it resolves to, and its display name.
 */
export function useModel() {
  const chatId = useStore((s) => s.activeChatId);
  const chat = useStore((s) => s.chats.find((c) => c.id === s.activeChatId));
  const pending = useStore((s) => s.pendingModel);
  const models = useStore((s) => s.models);
  const agentModel = useStore(
    (s) => s.agents.find((a) => a.id === (chat?.agentId ?? s.pendingAgentId))?.model,
  );
  const running = useStore((s) => (chatId ? s.agentStatus[chatId] === 'running' : false));
  const policy = chat?.modelPolicy ?? { ...pending, dataPolicy: 'zdr' as const };
  const id = policy.modelId === 'auto' ? models?.auto : policy.modelId;
  const entry = id ? models?.catalog.find((m) => m.id === id) : undefined;
  const name =
    policy.modelId === 'auto'
      ? 'Auto'
      : policy.modelId === null
        ? aliasName(agentModel ?? 'zdr/strong')
        : (entry?.name ?? policy.modelId);
  /** Sets the model or the level: the pending choice in a new chat, `chat.setModel` after. */
  const choose = (choice: ModelChoice) => {
    if (chatId && chat) send({ type: 'chat.setModel', chatId, ...choice });
    else useStore.setState({ pendingModel: choice });
  };
  return { chatId, policy, entry, name, models, agentModel, running, choose };
}

const ALIAS = '__alias__';

/** Composer chip and menu (phase-10 UI): Auto, favourites, thinking level, the open policy. */
export function ModelPicker() {
  const { chatId, policy, entry, name, models, agentModel, running, choose } = useModel();
  const open = useStore((s) => s.modelMenuOpen);
  const setOpen = (modelMenuOpen: boolean) => useStore.setState({ modelMenuOpen });
  const [catalogOpen, setCatalogOpen] = useState(false);
  const mobile = useMobile();
  const isOpen = policy.dataPolicy === 'open';
  const label = (
    <>
      {isOpen && mobile && <ShieldOff size={16} className="shrink-0 text-warning" />}
      <span className="max-w-[200px] truncate">{name}</span>
      {/* The space keeps "5.1 Ei ZDR" apart in the visible text that axe compares. */}
      {isOpen && !mobile && ' '}
      {isOpen && !mobile && (
        <Badge variant="warning" aria-hidden="true">
          Ei ZDR
        </Badge>
      )}
    </>
  );
  // Truncates: `shrink` beats the kit button's `shrink-0`.
  // The whole name as one label (sr-only parts inside a flex button gain stray spaces). It ends
  // with the badge's own text, so the name contains the visible label (axe).
  const ariaLabel = `Malli: ${name}${isOpen ? ', Ei ZDR' : ''}`;
  const chip = 'h-8 min-w-0 shrink rounded-full px-3 font-normal max-md:h-11';

  if (running)
    return (
      <Tip label="Malli vaihdetaan, kun vastaus on valmis">
        <Button
          variant="ghost"
          aria-disabled="true"
          aria-label={ariaLabel}
          className={cn(
            chip,
            'cursor-not-allowed text-muted-foreground hover:bg-transparent hover:text-muted-foreground',
          )}
        >
          {label}
        </Button>
      </Tip>
    );

  const catalog = models?.catalog ?? [];
  const favorites = (models?.favorites ?? []).filter((id) => id !== models?.auto);
  const extra =
    policy.modelId &&
    policy.modelId !== 'auto' &&
    !favorites.includes(policy.modelId) &&
    policy.modelId;
  const autoEntry = catalog.find((m) => m.id === models?.auto);
  const model = (id: string) => catalog.find((m) => m.id === id);
  const efforts = entry?.reasoning;
  const pick = (value: string) => {
    if (value === ALIAS) return;
    // A new model starts on its own recommended level.
    choose({ modelId: value as ModelChoice['modelId'], reasoning: 'auto' });
  };
  const restore = () => {
    if (!chatId) return;
    send({ type: 'chat.setDataPolicy', chatId, dataPolicy: 'zdr' });
    useStore.getState().notify('ZDR palautettu');
  };

  const item = (value: string, title: string, meta?: string) => (
    <DropdownMenuRadioItem key={value} value={value} className="py-2">
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{title}</span>
        {meta && <span className="truncate text-meta text-muted-foreground">{meta}</span>}
      </span>
    </DropdownMenuRadioItem>
  );

  return (
    <>
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            aria-label={ariaLabel}
            className={cn(chip, 'text-muted-foreground hover:text-foreground')}
          >
            {label}
            {!mobile && <ChevronDown size={16} className="shrink-0" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          collisionPadding={8}
          className="w-[min(300px,calc(100vw-32px))]"
        >
          <DropdownMenuLabel className="text-micro text-muted-foreground">Malli</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={policy.modelId === null ? ALIAS : policy.modelId}
            onValueChange={pick}
          >
            {item('auto', 'Auto', autoEntry?.name ?? models?.auto)}
            {favorites.map((id) => {
              const m = model(id);
              return item(id, m?.name ?? id, m && !m.zdr ? 'Ei ZDR-reittiä' : undefined);
            })}
            {extra &&
              item(extra, entry?.name ?? extra, entry && !entry.zdr ? 'Ei ZDR-reittiä' : undefined)}
            {policy.modelId === null && item(ALIAS, 'Agentin oletus', aliasName(agentModel ?? ''))}
          </DropdownMenuRadioGroup>
          <DropdownMenuItem
            onSelect={() => {
              setOpen(false);
              setCatalogOpen(true);
            }}
          >
            <Search size={16} className="text-muted-foreground" />
            Kaikki mallit…
          </DropdownMenuItem>
          {efforts && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-micro text-muted-foreground">
                Ajattelu
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={policy.reasoning}
                onValueChange={(reasoning) =>
                  policy.modelId !== null &&
                  choose({
                    modelId: policy.modelId,
                    reasoning: reasoning as ModelChoice['reasoning'],
                  })
                }
              >
                {item('auto', EFFORT_LABEL.auto, EFFORT_LABEL[efforts.recommended])}
                {efforts.efforts.map((e) => item(e, EFFORT_LABEL[e]))}
              </DropdownMenuRadioGroup>
            </>
          )}
          {isOpen && (
            <>
              <DropdownMenuSeparator />
              <p className="px-2 py-1.5 text-meta text-muted-foreground">
                Tämä keskustelu sallii reitit ilman ZDR:ää.
              </p>
              <DropdownMenuItem onSelect={restore}>
                <ShieldCheck size={16} className="text-muted-foreground" />
                Palauta ZDR
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <CatalogDialog
        open={catalogOpen}
        onOpenChange={setCatalogOpen}
        onPick={(id) => {
          choose({ modelId: id, reasoning: 'auto' });
          setCatalogOpen(false);
        }}
      />
    </>
  );
}

/**
 * "Kaikki mallit" (phase-10 UI): search, favourites first, a star per row. A plain list, not
 * cmdk: a star button inside a cmdk option would nest interactive controls (axe).
 */
function CatalogDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (id: string) => void;
}) {
  const models = useStore((s) => s.models);
  const [q, setQ] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const needle = q.trim().toLowerCase();
  const catalog = (models?.catalog ?? []).filter(
    (m) => !needle || m.name.toLowerCase().includes(needle) || m.id.includes(needle),
  );
  const favs = models?.favorites ?? [];
  const favorites = catalog.filter((m) => favs.includes(m.id));

  /** ↑↓ move between the rows' select buttons; from the field, ↓ enters the list. */
  const move = (e: KeyboardEvent, from: HTMLElement | null) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-model-row]') ?? [])];
    if (!rows.length) return;
    e.preventDefault();
    const at = from ? rows.indexOf(from) : -1;
    const next = e.key === 'ArrowDown' ? Math.min(at + 1, rows.length - 1) : at - 1;
    if (next < 0) document.getElementById('model-search')?.focus();
    else rows[next]?.focus();
  };

  const row = (m: CatalogModel) => {
    const fav = favs.includes(m.id);
    return (
      <li key={m.id} className="flex items-center gap-2 rounded-md pr-1 hover:bg-accent">
        <button
          type="button"
          data-model-row
          onClick={() => onPick(m.id)}
          onKeyDown={(e) => move(e, e.currentTarget)}
          className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-md px-3 py-1 text-left"
        >
          <span className="truncate text-ui">{m.name}</span>
          <span className="flex min-w-0 gap-2 text-meta text-muted-foreground">
            <span className="truncate font-mono text-[13px]">{m.id}</span>
            <span className="shrink-0 tabular-nums">{tokens(m.contextLength)}</span>
            <span className="shrink-0 tabular-nums">{price(m)}</span>
          </span>
        </button>
        {!m.zdr && <Badge variant="warning">Ei ZDR</Badge>}
        <IconButton
          label={`${fav ? 'Poista suosikeista' : 'Lisää suosikkeihin'}: ${m.name}`}
          aria-pressed={fav}
          className="size-7"
          onClick={() => send({ type: 'models.favorite', modelId: m.id, favorite: !fav })}
        >
          <Star size={16} className={cn(fav && 'fill-current text-warning')} />
        </IconButton>
      </li>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setQ('');
      }}
    >
      {/* The palette's frame (brief 7.5): 560 wide, top at 15vh, radius 12; phones inset 8. */}
      <DialogContent
        showCloseButton={false}
        className="top-[15vh] translate-y-0 gap-0 overflow-hidden rounded-lg p-0 shadow-md sm:max-w-[560px] max-md:top-2 max-md:left-2 max-md:w-[calc(100%-16px)] max-md:max-w-none max-md:translate-x-0"
      >
        <DialogTitle className="sr-only">Kaikki mallit</DialogTitle>
        <DialogDescription className="sr-only">
          Hae malli, valitse se keskusteluun tai lisää se suosikkeihin
        </DialogDescription>
        <div className="flex h-12 items-center gap-2 border-b px-4">
          <Search size={16} className="shrink-0 text-muted-foreground" />
          <Input
            id="model-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => move(e, null)}
            placeholder="Hae malleja"
            aria-label="Hae malleja"
            className="h-full border-0 bg-transparent px-0 focus-visible:ring-0"
          />
        </div>
        <div
          ref={list}
          className="max-h-[min(60dvh,420px)] overflow-y-auto p-2 max-md:max-h-[50dvh]"
        >
          {!models?.catalog.length ? (
            <p className="px-3 py-6 text-center text-meta text-muted-foreground">
              Mallilista ei ole saatavilla. Yritä myöhemmin.
            </p>
          ) : !catalog.length ? (
            <p className="px-3 py-6 text-center text-meta text-muted-foreground">
              Ei tuloksia haulle ”{q.trim()}”
            </p>
          ) : (
            <>
              {favorites.length > 0 && (
                <section aria-labelledby="models-favorites">
                  <h3
                    id="models-favorites"
                    className="px-3 pt-2 pb-1 text-micro text-muted-foreground"
                  >
                    Suosikit
                  </h3>
                  <ul>{favorites.map(row)}</ul>
                </section>
              )}
              <section aria-labelledby="models-all">
                <h3 id="models-all" className="px-3 pt-2 pb-1 text-micro text-muted-foreground">
                  Kaikki mallit
                </h3>
                <ul>{catalog.map(row)}</ul>
              </section>
            </>
          )}
        </div>
        <p className="flex h-8 items-center border-t px-4 text-micro text-muted-foreground max-md:hidden">
          ↑↓ liiku · ↵ valitse · Esc sulje
        </p>
      </DialogContent>
    </Dialog>
  );
}
