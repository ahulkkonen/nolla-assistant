import type { CatalogModel, ModelChoice } from '@pa/protocol';
import { Check, ChevronDown, Search, ShieldCheck, ShieldOff, Star } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useMobile } from '../media.ts';
import { useStore } from '../store.ts';
import { aliasName, EFFORT_LABEL, shortName, useModel } from '../useModel.ts';
import { send, setDataPolicy } from '../ws.ts';
import { useAgent } from './AgentPicker.tsx';
import { Tip } from './IconButton.tsx';

/** "1 M", "200 k": a context length. */
const tokens = (n: number) =>
  n >= 1e6 ? `${String(Math.round(n / 1e5) / 10).replace('.', ',')} M` : `${Math.round(n / 1e3)} k`;
const usd = (n: number) => n.toFixed(2).replace('.', ',');
/** "2,00 / 10,00": input and output price in $ per 1M tokens; the column header names the unit. */
const price = (m: CatalogModel) => (
  <>
    {usd(m.price.input)}
    <span className="text-muted-foreground">{'\u2009/\u2009'}</span>
    {usd(m.price.output)}
    {/* The unit lives in the visual column header; screen readers hear it here. */}
    <span className="sr-only"> $ / M</span>
  </>
);
/** The catalog's two number columns: fixed widths, so the header and every row line up. */
const COL_CTX = 'w-16 shrink-0 text-right tabular-nums';
const COL_PRICE = 'w-28 shrink-0 text-right tabular-nums';

const ALIAS = '__alias__';

/** Phase-20 decision 15: a chip that works during a reply; the change applies to the next one. */
export const NextTurnTip = ({
  running,
  children,
}: {
  running: boolean;
  children: ReactElement;
}) => (
  <Tip label="Muutos koskee seuraavaa vastausta" {...(running ? {} : { open: false })}>
    {children}
  </Tip>
);

type Option = { value: string; title: string; meta?: string | undefined };

/** Composer chip and menu (phase-10 UI): Auto, favourites, thinking level, the open policy. */
export function ModelPicker() {
  const { chatId, policy, entry, name, models, agentModel, running, choose } = useModel();
  const open = useStore((s) => s.modelMenuOpen);
  const setOpen = (modelMenuOpen: boolean) => useStore.setState({ modelMenuOpen });
  const [catalogOpen, setCatalogOpen] = useState(false);
  const mobile = useMobile();
  const agent = useAgent().name;
  const isOpen = policy.dataPolicy === 'open';

  const label = (
    <>
      {isOpen && mobile && <ShieldOff size={16} className="shrink-0 text-warning" />}
      <span className="max-w-[200px] truncate">{mobile ? shortName(name) : name}</span>
      {/* The space keeps "5.1 Ei ZDR" apart in the visible text that axe compares. */}
      {isOpen && !mobile && ' '}
      {isOpen && !mobile && (
        <Badge variant="warning" aria-hidden="true">
          Ei ZDR
        </Badge>
      )}
    </>
  );
  // The whole name as one label (sr-only parts inside a flex button gain stray spaces). It ends
  // with the badge's own text, so the name contains the visible label (axe).
  const ariaLabel = `Malli: ${name}${isOpen ? ', Ei ZDR' : ''}`;
  // Truncates: `shrink` beats the kit button's `shrink-0`. Ghost at rest like the agent chip; the
  // accent fill only while its menu or sheet is open (`aria-expanded`).
  const chip = 'h-8 min-w-0 shrink rounded-full px-3 font-normal max-md:h-11';

  const catalog = models?.catalog ?? [];
  const favorites = (models?.favorites ?? []).filter((id) => id !== models?.auto);
  const byId = (id: string) => catalog.find((m) => m.id === id);
  const noZdr = (m: CatalogModel | undefined) => (m && !m.zdr ? 'Ei ZDR-reittiä' : undefined);
  const extra =
    policy.modelId && policy.modelId !== 'auto' && !favorites.includes(policy.modelId)
      ? policy.modelId
      : undefined;
  const modelOptions: Option[] = [
    { value: 'auto', title: 'Auto', meta: byId(models?.auto ?? '')?.name ?? models?.auto },
    ...favorites.map((id) => ({ value: id, title: byId(id)?.name ?? id, meta: noZdr(byId(id)) })),
    ...(extra ? [{ value: extra, title: entry?.name ?? extra, meta: noZdr(entry) }] : []),
    ...(policy.modelId === null
      ? [{ value: ALIAS, title: 'Agentin oletus', meta: aliasName(agentModel ?? '') }]
      : []),
  ];
  const efforts = entry?.reasoning;
  const effortOptions: Option[] = efforts
    ? [
        { value: 'auto', title: EFFORT_LABEL.auto, meta: EFFORT_LABEL[efforts.recommended] },
        ...efforts.efforts
          .filter((e) => !(efforts.mandatory && e === 'none'))
          .map((e) => ({ value: e, title: EFFORT_LABEL[e] })),
      ]
    : [];
  // A stored level the model no longer offers counts as Auto (the server resolves it so too).
  const effort =
    policy.reasoning !== 'auto' && efforts?.efforts.includes(policy.reasoning)
      ? policy.reasoning
      : 'auto';
  const effortMeta =
    effort === 'auto' && efforts
      ? `${EFFORT_LABEL.auto} · ${EFFORT_LABEL[efforts.recommended]}`
      : EFFORT_LABEL[effort];

  const pickModel = (value: string) => {
    if (value === ALIAS) return;
    // A new model starts on its own recommended level.
    choose({ modelId: value as ModelChoice['modelId'], reasoning: 'auto' });
  };
  const pickEffort = (value: string) =>
    policy.modelId !== null &&
    choose({ modelId: policy.modelId, reasoning: value as ModelChoice['reasoning'] });
  const openCatalog = () => {
    setOpen(false);
    setCatalogOpen(true);
  };
  const restore = () => chatId && setDataPolicy(chatId, 'zdr');
  const openNote = 'Tämä keskustelu sallii reitit ilman ZDR:ää.';

  const radio = (o: Option) => (
    <DropdownMenuRadioItem key={o.value} value={o.value} className="py-2">
      <OptionText o={o} />
    </DropdownMenuRadioItem>
  );

  const tip = (trigger: ReactElement) => <NextTurnTip running={running}>{trigger}</NextTurnTip>;
  let control: ReactNode;
  if (mobile)
    // Phones: a bottom sheet, so every level fits without a scroll inside a menu.
    control = (
      <>
        {tip(
          <Button
            variant="ghost"
            aria-label={ariaLabel}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className={cn(chip, 'text-muted-foreground hover:text-foreground')}
          >
            {label}
            {/* As on desktop and as the agent chip: the chip opens a choice. */}
            <ChevronDown size={16} className="shrink-0" />
          </Button>,
        )}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="bottom"
            showCloseButton={false}
            className="max-h-[85dvh] gap-1 overflow-y-auto rounded-t-xl px-2 pt-2 pb-[max(env(safe-area-inset-bottom),8px)]"
          >
            <SheetTitle className="sr-only">Mallin valinta</SheetTitle>
            {/* A started chat keeps its agent, so the sheet names it read-only (the composer has no
                agent chip on phones then). */}
            {chatId ? (
              <SheetDescription className="px-3 pt-2 pb-1 text-meta text-muted-foreground">
                Agentti: <span className="text-foreground">{agent}</span>
              </SheetDescription>
            ) : (
              <SheetDescription className="sr-only">
                Valitse keskustelun malli ja ajattelun taso
              </SheetDescription>
            )}
            <Choices
              label="Malli"
              options={modelOptions}
              value={policy.modelId ?? ALIAS}
              onPick={(v) => {
                setOpen(false);
                pickModel(v);
              }}
            />
            <Button
              variant="ghost"
              className="h-11 justify-start gap-3 font-normal"
              onClick={openCatalog}
            >
              <Search size={16} className="text-muted-foreground" />
              Kaikki mallit…
            </Button>
            {efforts && (
              <Choices
                label="Ajattelu"
                options={effortOptions}
                value={effort}
                onPick={(v) => {
                  setOpen(false);
                  pickEffort(v);
                }}
              />
            )}
            {isOpen && (
              <>
                <p className="px-3 pt-2 text-meta text-muted-foreground">{openNote}</p>
                {/* Consent stays an idle action (decision 15). */}
                <Button
                  variant="ghost"
                  disabled={running}
                  className="h-11 justify-start gap-3 font-normal"
                  onClick={() => {
                    setOpen(false);
                    restore();
                  }}
                >
                  <ShieldCheck size={16} className="text-muted-foreground" />
                  Palauta ZDR
                </Button>
              </>
            )}
          </SheetContent>
        </Sheet>
      </>
    );
  else
    control = (
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        {tip(
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              aria-label={ariaLabel}
              className={cn(chip, 'text-muted-foreground hover:text-foreground')}
            >
              {label}
              <ChevronDown size={16} className="shrink-0" />
            </Button>
          </DropdownMenuTrigger>,
        )}
        <DropdownMenuContent side="top" align="start" collisionPadding={8} className="w-[300px]">
          <DropdownMenuLabel className="text-micro text-muted-foreground">Malli</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={policy.modelId ?? ALIAS} onValueChange={pickModel}>
            {modelOptions.map(radio)}
          </DropdownMenuRadioGroup>
          <DropdownMenuItem onSelect={openCatalog}>
            <Search size={16} className="text-muted-foreground" />
            Kaikki mallit…
          </DropdownMenuItem>
          {efforts && (
            <>
              <DropdownMenuSeparator />
              {/* A submenu: the levels never push the menu past the viewport. */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="py-2">
                  <OptionText o={{ value: 'effort', title: 'Ajattelu', meta: effortMeta }} />
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent sideOffset={4} collisionPadding={8} className="w-[220px]">
                    <DropdownMenuRadioGroup value={effort} onValueChange={pickEffort}>
                      {effortOptions.map(radio)}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            </>
          )}
          {isOpen && (
            <>
              <DropdownMenuSeparator />
              <p className="px-2 py-1.5 text-meta text-muted-foreground">{openNote}</p>
              <DropdownMenuItem onSelect={restore} disabled={running}>
                <ShieldCheck size={16} className="text-muted-foreground" />
                Palauta ZDR
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );

  return (
    <>
      {control}
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

function OptionText({ o }: { o: Option }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{o.title}</span>
      {o.meta && <span className="truncate text-meta text-muted-foreground">{o.meta}</span>}
    </span>
  );
}

/** One section of the phone sheet: a radio group of 44 px rows with a check on the current one. */
function Choices({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: Option[];
  value: string;
  onPick: (value: string) => void;
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-labelledby={id} className="flex flex-col">
      <p id={id} className="px-3 pt-2 pb-1 text-micro text-muted-foreground">
        {label}
      </p>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onPick(o.value)}
          className="flex min-h-11 items-center gap-3 rounded-md px-3 py-1 text-left text-ui hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
        >
          <OptionText o={o} />
          {o.value === value && <Check size={16} className="shrink-0" />}
        </button>
      ))}
    </div>
  );
}

/**
 * "Kaikki mallit" (phase-10 UI): search, favourites first, then each lab's newest model ("Uusimmat",
 * phase-21 decision 3), a star per row. Each model is listed once. A plain list, not
 * cmdk: a star button inside a cmdk option would nest interactive controls (axe). The list is one
 * tab stop: ↑↓ move between rows, ←→ between a row and its star.
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
  // Typing stays quick with a few hundred rows: the list follows a step behind.
  const needle = useDeferredValue(q).trim().toLowerCase();
  const favs = useMemo(() => new Set(models?.favorites), [models]);
  const shown = (models?.catalog ?? []).filter(
    (m) => !needle || m.name.toLowerCase().includes(needle) || m.id.includes(needle),
  );
  const favorites = shown.filter((m) => favs.has(m.id));
  // In the server's lab order; a favourite stays in Suosikit.
  const latest = (models?.latest ?? []).flatMap(
    ({ modelId }) => shown.find((m) => m.id === modelId && !favs.has(m.id)) ?? [],
  );
  const others = shown.filter((m) => !favs.has(m.id) && !latest.includes(m));
  const sections = [
    { id: 'models-favorites', title: 'Suosikit', rows: favorites },
    { id: 'models-latest', title: 'Uusimmat', rows: latest },
    { id: 'models-all', title: 'Kaikki mallit', rows: others },
  ].filter((s) => s.rows.length);
  const order = sections.flatMap((s) => s.rows.map((m) => m.id));
  const [cursor, setCursor] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  /** The star to focus again once its row has moved to another section. */
  const refocus = useRef<string | null>(null);

  // Cells are `<id>:pick` and `<id>:star` (ids never hold a colon). One of them is the tab stop.
  const cell = (id: string, col: 'pick' | 'star') => `${id}:${col}`;
  const active = cursor && order.includes(cursor.split(':')[0] ?? '') ? cursor : null;
  const tabStop = active ?? (order[0] ? cell(order[0], 'pick') : null);
  const focusCell = (c: string) =>
    list.current?.querySelector<HTMLElement>(`[data-cell="${CSS.escape(c)}"]`)?.focus();

  useEffect(() => {
    if (!models || !refocus.current) return;
    focusCell(refocus.current);
    refocus.current = null;
  }, [models]);

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = (e.target as HTMLElement).dataset.cell;
    if (!at) return;
    const [id = '', col = 'pick'] = at.split(':') as [string, 'pick' | 'star'];
    const i = order.indexOf(id);
    let next: string | undefined;
    if (e.key === 'ArrowDown') next = order[i + 1] && cell(order[i + 1] as string, col);
    else if (e.key === 'ArrowUp') {
      if (i === 0) {
        e.preventDefault();
        document.getElementById('model-search')?.focus();
        return;
      }
      next = cell(order[i - 1] as string, col);
    } else if (e.key === 'ArrowRight') next = cell(id, 'star');
    else if (e.key === 'ArrowLeft') next = cell(id, 'pick');
    else return;
    e.preventDefault();
    if (next) focusCell(next);
  };

  const row = (m: CatalogModel) => {
    const fav = favs.has(m.id);
    const pick = cell(m.id, 'pick');
    const star = cell(m.id, 'star');
    return (
      <li
        key={m.id}
        // The row with the roving tab stop reads as the one Enter picks (the footer says so).
        className={cn(
          'flex items-center gap-2 rounded-md pr-1 hover:bg-accent',
          (tabStop === pick || tabStop === star) && 'bg-accent',
        )}
      >
        <button
          type="button"
          data-cell={pick}
          tabIndex={tabStop === pick ? 0 : -1}
          onClick={() => onPick(m.id)}
          // The name, then a meta line with the id and the badge; the columns sit at the right.
          className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-x-2 rounded-md px-3 py-1 text-left"
        >
          <span className="flex min-w-0 grow basis-0 flex-col">
            <span className="truncate text-ui">{m.name}</span>
            <span className="flex min-w-0 items-center gap-2">
              {/* The model part of the id, cut from the end; the provider for screen readers. */}
              <span
                title={m.id}
                className="min-w-0 truncate font-mono text-[13px] text-muted-foreground"
              >
                <span className="sr-only">{m.id.slice(0, m.id.indexOf('/') + 1)}</span>
                {m.id.slice(m.id.indexOf('/') + 1)}
              </span>
              {!m.zdr && <Badge variant="warning">Ei ZDR</Badge>}
            </span>
          </span>
          <span className="ml-auto flex gap-6 text-meta max-md:hidden">
            <span className={cn(COL_CTX, 'text-muted-foreground')}>{tokens(m.contextLength)}</span>
            <span className={COL_PRICE}>{price(m)}</span>
          </span>
          {/* Phones: no header row, so the meta line names its units. */}
          <span className="w-full text-meta text-muted-foreground tabular-nums md:hidden">
            {tokens(m.contextLength)} · {usd(m.price.input)} / {usd(m.price.output)} $ / M
          </span>
        </button>
        {/* No tooltip per row: the label names the model, and a few hundred tooltips cost. */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-cell={star}
          tabIndex={tabStop === star ? 0 : -1}
          aria-label={`${fav ? 'Poista suosikeista' : 'Lisää suosikkeihin'}: ${m.name}`}
          aria-pressed={fav}
          // No transparent border: the 44 px phone target is the whole hover fill.
          className="size-7 border-0 text-muted-foreground hover:text-foreground"
          onClick={() => {
            refocus.current = star;
            send({ type: 'models.favorite', modelId: m.id, favorite: !fav });
          }}
        >
          <Star size={16} className={cn(fav && 'fill-current text-warning')} />
        </Button>
      </li>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setQ('');
          setCursor(null);
        }
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
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown' || !tabStop) return;
              e.preventDefault();
              focusCell(tabStop);
            }}
            placeholder="Hae malleja"
            aria-label="Hae malleja"
            className="h-full border-0 bg-transparent px-0 focus-visible:ring-0"
          />
        </div>
        <div
          ref={list}
          onKeyDown={onListKey}
          onFocus={(e) => {
            const at = (e.target as HTMLElement).dataset.cell;
            if (at) setCursor(at);
          }}
          className="max-h-[min(60dvh,420px)] overflow-y-auto px-2 pb-2 max-md:max-h-[50dvh]"
        >
          {!models?.catalog.length ? (
            <p className="px-3 pt-8 pb-6 text-center text-meta text-muted-foreground">
              Mallilista ei ole saatavilla. Yritä myöhemmin.
            </p>
          ) : !shown.length ? (
            <p className="px-3 pt-8 pb-6 text-center text-meta text-muted-foreground">
              Ei tuloksia haulle ”{q.trim()}”
            </p>
          ) : (
            <>
              {/* Right padding = the row's star (28), its gap (8), the row's pr-1 and px-3. */}
              <div className="sticky top-0 z-10 flex justify-end gap-6 bg-card pt-2 pr-[52px] pb-1 text-micro whitespace-nowrap text-muted-foreground max-md:hidden">
                <span className={COL_CTX}>Konteksti</span>
                <span className={COL_PRICE}>$ / M sisään / ulos</span>
              </div>
              {sections.map((s) => (
                <section key={s.id} aria-labelledby={s.id}>
                  <h3 id={s.id} className="px-3 pt-2 pb-1 text-micro text-muted-foreground">
                    {s.title}
                  </h3>
                  <ul>{s.rows.map(row)}</ul>
                </section>
              ))}
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
