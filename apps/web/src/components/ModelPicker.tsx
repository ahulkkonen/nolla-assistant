import type { CatalogModel, ModelChoice } from '@pa/protocol';
import {
  Check,
  ChevronDown,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Star,
} from 'lucide-react';
import {
  Fragment,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
import {
  Sheet,
  SheetCloseButton,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useMobile } from '../media.ts';
import { effectiveModes, useStore } from '../store.ts';
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

/**
 * Phase-23 decision 8: the output modes of the chat, or of the new chat (null) until its
 * `chat.create`. The Tila chip (≥ 768) and the phone sheet share it; like the model, a toggle
 * applies to the next reply. `names`: the active modes in the server's order.
 */
export function useModes(chatId: string | null) {
  const all = useStore((s) => s.modes);
  const stored = useStore((s) => effectiveModes(s, chatId));
  // The list of the last toggle until `chat.updated` brings it: a quick second toggle builds on
  // the first. Ponytail: a refused `chat.setModes` keeps it until the chat changes.
  const local = useRef<{ chatId: string | null; modes: string[] } | null>(null);
  const [, setShown] = useState<string[]>();
  const optimistic = local.current?.chatId === chatId ? local.current.modes : null;
  const active = optimistic ?? stored;
  useEffect(() => {
    const key = (l: string[]) => [...l].sort().join('\n');
    if (local.current && key(local.current.modes) === key(stored)) local.current = null;
  }, [stored]);
  const names = all
    .filter((m) => active.includes(m.id))
    .map((m) => m.name)
    .join(', ');
  const toggle = (id: string) => {
    // A deleted mode leaves the list: the server refuses an id it does not hold.
    const cur = (local.current?.chatId === chatId && local.current.modes) || active;
    const next = all
      .map((m) => m.id)
      .filter((m) => (m === id ? !cur.includes(id) : cur.includes(m)));
    local.current = { chatId, modes: next };
    setShown(next);
    if (chatId) send({ type: 'chat.setModes', chatId, modes: next });
    else useStore.setState({ pendingModes: next });
  };
  return { all, active, names, toggle };
}

/**
 * "Hyväksy automaattisesti" for the chat (phase-21 decision 7), as `useModes`. The next tool
 * call reads it, also during a reply. Null for an agent with no gated tool.
 */
export function useAutoApprove(chatId: string) {
  const auto = useStore((s) => s.autoApprove[chatId]);
  if (!auto?.tools.length) return null;
  const { on, tools } = auto;
  const which = `ilman hyväksyntää: ${tools.join(', ')}`;
  const lead = on ? 'Ajetaan' : 'Kun päällä, ajetaan';
  return {
    on,
    which,
    /** What the switch does, as text (the tooltip's text for screen readers). */
    tip: `${lead} ${which}`,
    /** The same with the tool names as code in mono (brief 7.9). */
    help: (
      <>
        {lead} ilman hyväksyntää:{' '}
        {tools.map((t, i) => (
          <Fragment key={t}>
            {i > 0 && ', '}
            <span className="font-mono">{t}</span>
          </Fragment>
        ))}
      </>
    ),
    toggle: () => send({ type: 'chat.setAutoApprove', chatId, on: !on }),
  };
}

type Option = { value: string; title: string; meta?: string | undefined };

/**
 * The composer chips that open a choice (model, Tila). Ghost at rest like the agent chip; the
 * accent fill only while the menu or sheet is open (`aria-expanded`). The model chip truncates:
 * `shrink` beats the kit button's `shrink-0`.
 */
const CHIP =
  'h-8 min-w-0 shrink rounded-full px-3 font-normal text-muted-foreground hover:text-foreground max-md:h-11';

const measure = globalThis.document?.createElement('canvas').getContext('2d');

/**
 * Whether `text` fits in `max` px in the font of `ref`'s element; again once the fonts load, and
 * when `shown` turns on (the element mounts after a render without it).
 */
function useFits(ref: RefObject<HTMLElement | null>, text: string, max: number, shown = true) {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const check = () => {
      if (!ref.current || !measure) return;
      measure.font = getComputedStyle(ref.current).font;
      setFits(measure.measureText(text).width <= max);
    };
    check();
    void document.fonts?.ready.then(check);
  }, [text, max, shown]);
  return fits;
}

/**
 * Phase-23 decision 8: the "Tila" chip (≥ 768; phones have the model sheet's rows). One check box
 * per mode, and a toggle keeps the menu open. The label lists the active modes when they fit in
 * 200 px and the toolbar has room, else "Tila · 2"; "Tila" when none is on. It is never cut inside
 * a name. A toolbar without room turns the auto-approve chip into a shield first, then asks for
 * "Tila · 2" (`compact`, Composer.tsx).
 */
export function ModesChip({
  chatId,
  running,
  compact = false,
}: {
  chatId: string | null;
  running: boolean;
  /** The toolbar has no room for the names even with the auto-approve shield. */
  compact?: boolean;
}) {
  const { all, active, names, toggle } = useModes(chatId);
  const label = useRef<HTMLSpanElement>(null);
  // Called before the early return: the modes may load after the first render.
  const fits = useFits(label, names, 200, all.length > 0);
  if (!all.length) return null;
  const on = all.filter((m) => active.includes(m.id)).length;
  const full = on > 0 && fits && !compact;
  const shown = !on ? 'Tila' : full ? names : `Tila · ${on}`;
  return (
    <DropdownMenu modal={false}>
      <NextTurnTip running={running}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            // The name holds the visible label (axe); "Tila · 2" adds the whole list.
            aria-label={full ? `Tila: ${names}` : shown}
            {...(on && !full ? { 'aria-description': names } : {})}
            className={cn(CHIP, 'shrink-0 max-md:hidden')}
          >
            <span ref={label} className="whitespace-nowrap">
              {shown}
            </span>
            <ChevronDown size={16} className="shrink-0" />
          </Button>
        </DropdownMenuTrigger>
      </NextTurnTip>
      <DropdownMenuContent side="top" align="start" collisionPadding={8} className="w-[320px]">
        <DropdownMenuLabel className="text-micro text-muted-foreground">Tila</DropdownMenuLabel>
        {all.map((m) => (
          <DropdownMenuCheckboxItem
            key={m.id}
            checked={active.includes(m.id)}
            onCheckedChange={() => toggle(m.id)}
            onSelect={(e) => e.preventDefault()}
            className="min-h-10 py-2"
          >
            <OptionText o={{ value: m.id, title: m.name, meta: m.description || undefined }} />
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
      {/* `data-fit`: the composer toolbar reads whether the name is cut (Composer.tsx). */}
      <span data-fit className="max-w-[200px] truncate">
        {mobile ? shortName(name) : name}
      </span>
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
            className={CHIP}
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
            className="max-h-[85dvh] gap-1 overflow-y-auto rounded-t-xl px-2 pt-4 pb-[max(env(safe-area-inset-bottom),8px)]"
          >
            <SheetTitle className="sr-only">Mallin valinta</SheetTitle>
            {/* The receipt sheet's header (UI review 3): Sulje's 44 px target centred on the first
                meta line (−13 px = (44 − 18) / 2). */}
            <div className="flex items-start gap-2 pl-3">
              {/* A started chat keeps its agent, so the sheet names it read-only (the composer has
                  no agent chip on phones then). */}
              {chatId ? (
                <SheetDescription className="min-w-0 flex-1 pb-1 text-meta text-muted-foreground">
                  Agentti: <span className="text-foreground">{agent}</span>
                </SheetDescription>
              ) : (
                // An empty chat: a label in its place, so the row is not empty (UI review 4);
                // Sulje centred on its 20 px line (−12 px).
                <SheetDescription className="min-w-0 flex-1 pb-1 font-medium text-foreground">
                  Malli ja ajattelu
                </SheetDescription>
              )}
              <SheetCloseButton className={cn('ml-auto', chatId ? '-my-[13px]' : '-my-3')} />
            </div>
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
            <ChatSwitches chatId={chatId} />
          </SheetContent>
        </Sheet>
      </>
    );
  else
    control = (
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        {tip(
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" aria-label={ariaLabel} className={CHIP}>
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

/** A titled group of the phone sheet: a micro muted heading that names the group. */
function SheetGroup({
  label,
  role = 'group',
  children,
}: {
  label: string;
  role?: 'group' | 'radiogroup';
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div role={role} aria-labelledby={id} className="flex flex-col">
      <p id={id} className="px-3 pt-2 pb-1 text-micro text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
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
  return (
    <SheetGroup label={label} role="radiogroup">
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
    </SheetGroup>
  );
}

/**
 * The chat's switches in the phone sheet: next to the queue's two run buttons, their composer
 * chips squeezed the model chip to its chevron. A group "Tila" with one row per mode (phase-23
 * decision 8; a new chat too), then "Tässä keskustelussa" with auto-approve (a started chat). Every
 * label starts at the rows' text edge; the shield sits beside the switch.
 */
function ChatSwitches({ chatId }: { chatId: string | null }) {
  const modes = useModes(chatId);
  const auto = useAutoApprove(chatId ?? '');
  return (
    <>
      {modes.all.length > 0 && (
        <SheetGroup label="Tila">
          {modes.all.map((m) => (
            <SwitchRow
              key={m.id}
              label={m.name}
              {...(m.description ? { helper: m.description } : {})}
              checked={modes.active.includes(m.id)}
              onToggle={() => modes.toggle(m.id)}
            />
          ))}
        </SheetGroup>
      )}
      {auto && (
        <SheetGroup label="Tässä keskustelussa">
          <SwitchRow
            icon={
              auto.on ? (
                <ShieldAlert size={16} className="shrink-0 text-warning" />
              ) : (
                <Shield size={16} className="shrink-0 text-muted-foreground" />
              )
            }
            label="Hyväksy automaattisesti"
            helper={auto.help}
            checked={auto.on}
            onToggle={auto.toggle}
          />
        </SheetGroup>
      )}
    </>
  );
}

/**
 * A 44 px sheet row: the whole row turns the switch; the switch is named by the label only. The
 * icon sits before the switch, so the label keeps the rows' text edge.
 */
function SwitchRow({
  icon,
  label,
  helper,
  checked,
  onToggle,
}: {
  icon?: ReactNode;
  label: string;
  helper?: ReactNode;
  checked: boolean;
  onToggle: () => void;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className="flex min-h-11 items-center gap-3 rounded-md px-3 py-1 text-ui hover:bg-accent"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span id={`${id}-label`}>{label}</span>
        {helper && (
          // `pretty`: no lone word on the last line (brief 7.2; UI review 4: "bash").
          <span id={`${id}-help`} className="text-meta text-pretty text-muted-foreground">
            {helper}
          </span>
        )}
      </span>
      {icon}
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onToggle}
        aria-labelledby={`${id}-label`}
        {...(helper ? { 'aria-describedby': `${id}-help` } : {})}
      />
    </label>
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
