import { type ApprovalView, SEARCH_ENTITY_REASON, WEB_SEARCH_TOOL } from '@pa/protocol';
import { Clock, ShieldAlert } from 'lucide-react';
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { runText } from '../cron.ts';
import { type Approval, useStore } from '../store.ts';
import { respondApproval } from '../ws.ts';
import { UNTITLED } from './Sidebar.tsx';

/**
 * An argument value: mono, clamped at 6 lines with a fade and "Näytä lisää" (brief 7.5).
 * `children` shows `text` with marks (a URL's host).
 */
function Value({ text, children }: { text: string; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(false);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !more) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [text, more]);
  return (
    <dd className="min-w-0">
      <div
        ref={ref}
        className={cn(
          'font-mono text-[13px] leading-5 break-words whitespace-pre-wrap text-foreground',
          !more && 'line-clamp-6',
          !more && clamped && '[mask-image:linear-gradient(to_bottom,black_60%,transparent)]',
        )}
      >
        {children ?? text}
      </div>
      {(clamped || more) && (
        <Button
          variant="link"
          aria-expanded={more}
          className="text-meta max-md:min-h-11"
          onClick={() => setMore(!more)}
        >
          {more ? 'Näytä vähemmän' : 'Näytä lisää'}
        </Button>
      )}
    </dd>
  );
}

/** Lines of a diff or YAML block before "Näytä lisää" (phase-25 decision 25). */
export const CLAMP = 16;

/**
 * Mono 13/20 lines in a muted block. Lines wrap (UI review 5), so a long line never widens the
 * card. Over 16 rows (16 lines, or fewer that wrap past 320 px) it shows 16, the last four
 * fading out, and "Näytä lisää".
 */
export function Lines({
  label,
  lines,
  line,
}: {
  label: string;
  lines: string[];
  line: (text: string) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Wrapped rows: only the box knows its height, and it changes with the card's width.
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || all) return;
    const measure = () => setTall(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [lines, all]);
  const over = lines.length > CLAMP || tall;
  return (
    // 8 px from the box to the link's line box (the link has a 1 px border).
    <div className="flex flex-col items-start gap-[7px] max-md:gap-0">
      <div
        role="region"
        aria-label={label}
        className="w-full rounded-md bg-muted py-2 font-mono text-[13px] leading-5 text-foreground"
      >
        {/* 16 rows of 20 px; the fade runs from the top of row 13 to the bottom of row 16. */}
        <div
          ref={box}
          className={cn(
            !all && 'max-h-80 overflow-hidden',
            !all && over && '[mask-image:linear-gradient(to_bottom,black_240px,transparent_320px)]',
          )}
        >
          {(all ? lines : lines.slice(0, CLAMP)).map((l, i) => (
            <div key={`${i}:${l}`}>{line(l)}</div>
          ))}
        </div>
      </div>
      {over && (
        <Button
          variant="link"
          aria-expanded={all}
          // Phones: the 44 px target overlaps the box, so the text stays 8 px below it.
          className="text-meta max-md:-mt-[5px] max-md:min-h-11"
          onClick={() => setAll(!all)}
        >
          {all ? 'Näytä vähemmän' : 'Näytä lisää'}
        </Button>
      )}
    </div>
  );
}

/**
 * One unified diff line: a 4 px sign column and the `DiffLine` tints (brief 7.5), the sign as a
 * glyph and an sr-only word; hunk lines (`@@`) muted. The bar and the sign are a hanging gutter:
 * the text starts 24 px in and wraps under itself.
 */
function DiffRow({ line }: { line: string }) {
  const add = line[0] === '+';
  const del = line[0] === '-';
  const hunk = line[0] === '@' || line[0] === '\\';
  return (
    <div
      className={cn(
        'flex pr-3',
        add && 'bg-success-subtle',
        del && 'bg-destructive-subtle',
        hunk && 'text-muted-foreground',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('w-1 shrink-0', add && 'bg-success', del && 'bg-destructive')}
      />
      <span
        aria-hidden="true"
        className={cn(
          'w-5 shrink-0 text-center select-none',
          add && 'text-success',
          del && 'text-destructive',
        )}
      >
        {add ? '+' : del ? '−' : ''}
      </span>
      <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {(add || del) && <span className="sr-only">{add ? 'Lisätty: ' : 'Poistettu: '}</span>}
        {(hunk ? line : line.slice(1)) || ' '}
      </span>
    </div>
  );
}

/**
 * A YAML line that wraps with its continuation under the value: the indent, a list dash and a
 * `key: ` hang (mono, so `ch` is exact).
 */
const yamlRow = (l: string) => {
  const hang = /^ *(?:- )*(?:[\w-]+: )?/.exec(l)?.[0].length ?? 0;
  return (
    <div
      className="px-3 whitespace-pre-wrap [overflow-wrap:anywhere]"
      {...(hang
        ? { style: { paddingLeft: `calc(0.75rem + ${hang}ch)`, textIndent: `-${hang}ch` } }
        : {})}
    >
      {l || ' '}
    </div>
  );
};
const linesOf = (text: string) => text.replace(/\n$/, '').split('\n');
/** The top-level `name:` of a YAML file or a mode's frontmatter, unquoted. */
const nameIn = (text: string) => /^name:[ \t]*["']?(.*?)["']?[ \t]*$/m.exec(text)?.[1] || null;
/** A mode file's frontmatter as Pi's `parseFrontmatter` cuts it; '' without one. */
const frontmatter = (text: string) => {
  const t = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const end = t.startsWith('---') ? t.indexOf('\n---', 3) : -1;
  return end < 0 ? '' : t.slice(4, end);
};
const quoted = (s: string) => `”${s}”`;
type HarnessView = Exclude<ApprovalView, { kind: 'fetch' }>;

/** The card title of a harness view (phase-25 decision 25). */
function heading(v: HarnessView, args: Record<string, unknown>) {
  if (v.kind === 'diff') {
    const id = /^modes\/(.+)\.md$/.exec(v.file)?.[1];
    if (!id) return 'Muutetaanko avustajan ohjetta?';
    // A `name:` in the body is prose, not the mode's name.
    const name = quoted(nameIn(frontmatter(String(args.content ?? ''))) ?? id);
    return v.created ? `Lisätäänkö tila ${name}?` : `Muutetaanko tilaa ${name}?`;
  }
  if (v.kind === 'yaml') {
    const name = quoted(nameIn(v.yaml) ?? /([^/]+)\.yaml$/.exec(v.file)?.[1] ?? v.file);
    return v.created ? `Luodaanko automaatio ${name}?` : `Muutetaanko automaatiota ${name}?`;
  }
  return v.query !== null
    ? `Haetaanko keskustelu otsikolla ${quoted(v.query)}?`
    : `Luetaanko keskustelu ${quoted(v.title || UNTITLED)}?`;
}

const meta = 'text-meta text-pretty text-muted-foreground';

/** The body of a harness view: the file and its diff or YAML, or the chat to read. */
function ViewBody({ v }: { v: HarnessView }) {
  if (v.kind === 'chat') {
    if (v.query !== null)
      return <p className={meta}>Avustaja lukee osuman tai saa listan osumista.</p>;
    const n = v.messages;
    return (
      <div className="flex flex-col gap-1">
        <p className="text-ui tabular-nums">
          {[
            v.createdAt && new Date(v.createdAt).toLocaleDateString('fi-FI'),
            n !== null && `${n} ${n === 1 ? 'viesti' : 'viestiä'}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p className={meta}>Malli saa tekstin pseudonymisoituna.</p>
      </div>
    );
  }
  return (
    <>
      <p className={meta}>
        {v.created ? 'Luodaan uusi tiedosto' : 'Muutetaan tiedostoa'}{' '}
        <span className="font-mono [overflow-wrap:anywhere]">{v.file}</span>
      </p>
      {v.kind === 'diff' ? (
        <Lines
          label={`Muutos: ${v.file}`}
          lines={linesOf(v.diff)}
          line={(l) => <DiffRow line={l} />}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <Lines label={v.file} lines={linesOf(v.yaml)} line={yamlRow} />
          <p className={cn(meta, 'tabular-nums')}>
            {/* No-break spaces: a run never wraps inside itself, only after a comma. */}
            {v.nextRuns.length
              ? `Seuraavat ajot: ${v.nextRuns.map((r) => runText(r).replaceAll(' ', '\u00a0')).join(', ')}`
              : 'Automaatio on pois päältä, eikä sitä ajeta.'}
          </p>
        </div>
      )}
      {/* An automation has no "next reply": its change shows at its next run. */}
      <p className={meta}>
        {v.kind === 'diff'
          ? 'Muutos tulee voimaan seuraavassa vastauksessa ja tallentuu versiohistoriaan.'
          : 'Muutos tallentuu versiohistoriaan.'}
      </p>
    </>
  );
}

/**
 * "https://www.hs.fi/x": the host (`URL.host`, as the fetch sees it) in foreground and semibold,
 * the rest muted. Userinfo before an `@` stays visible, muted and named for screen readers, so
 * "https://www.hs.fi@evil.com" shows evil.com as the host. Text that does not parse stays plain.
 */
function Url({ url }: { url: string }) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!/^https?:$/.test(u.protocol) || !u.host) return url;
  const user = u.username + (u.password ? `:${u.password}` : '');
  return (
    <>
      <span className="text-muted-foreground">{`${u.protocol}//`}</span>
      {user && (
        <span className="text-muted-foreground">
          <span className="sr-only">käyttäjätiedot </span>
          {user}@
        </span>
      )}
      <span className="font-semibold">{u.host}</span>
      <span className="text-muted-foreground">{u.pathname + u.search + u.hash}</span>
    </>
  );
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });

/** The line that external content entered the turn or chat: `ShieldAlert` and meta in --warning. */
export function TaintLine({
  className,
  children,
}: {
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <p className={cn('flex items-start gap-2 text-meta text-pretty text-warning', className)}>
      <ShieldAlert size={16} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * The real (unmasked) arguments of a gated tool call, inline in the thread. Focus stays where it
 * is, so a typed Enter never approves; the thread announces the request (Thread.tsx). After a
 * decision the card goes and its tool row shows the outcome. A harness call shows its view (a
 * diff, YAML or the chat to read) instead of the arguments (phase 25).
 */
export function ApprovalCard({ a }: { a: Approval }) {
  const titleId = useId();
  // The server denies at `expiresAt`; the tool row turns "vanhentunut" at the same moment.
  useEffect(() => {
    const t = setTimeout(
      () => useStore.getState().expireApproval(a.requestId),
      Math.max(0, Date.parse(a.expiresAt) - Date.now()),
    );
    return () => clearTimeout(t);
  }, [a.requestId, a.expiresAt]);

  const record =
    a.args && typeof a.args === 'object' && !Array.isArray(a.args)
      ? (a.args as Record<string, unknown>)
      : null;
  const args = record ? Object.entries(record) : [['', a.args] as const];
  const v = a.view;
  // Phase 14: a search whose query names a vault entity; phase 25: a URL that the fetch guard
  // asks about. The reason is the title.
  const query = record?.query;
  const guard =
    v?.kind === 'fetch'
      ? {
          label: 'Osoite:',
          text: v.url,
          marked: <Url url={v.url} />,
          note: 'Osoite lähtee sivun palvelimelle sellaisenaan. Hylkää, niin avustaja vastaa ilman sivua.',
        }
      : // Only the entity guard's card; anything else (`approval.always`) keeps the generic list.
        !v &&
          a.tool === WEB_SEARCH_TOOL &&
          a.reason === SEARCH_ENTITY_REASON &&
          String(query ?? '').trim() !== ''
        ? {
            label: 'Haku:',
            text: show(query),
            marked: undefined,
            note: 'Kysely lähtee hakupalveluun sellaisenaan. Hylkää, niin avustaja hakee ilman henkilöä.',
          }
        : null;
  const harness = v && v.kind !== 'fetch' ? v : null;
  const reason =
    !guard && !harness && a.reason !== `Työkalu ${a.tool} vaatii hyväksynnän.` ? a.reason : '';

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-warning-line bg-card p-4"
    >
      <h2 id={titleId} className="flex items-start gap-2 text-heading">
        <ShieldAlert size={16} className="mt-1 shrink-0 text-warning" />
        {guard ? (
          <span>{a.reason}</span>
        ) : harness ? (
          <span>{heading(harness, record ?? {})}</span>
        ) : (
          <span>
            Hyväksytäänkö työkalu <span className="font-mono">{a.tool}</span>?
          </span>
        )}
      </h2>
      {a.tainted && (
        // Under the title, before the body: 8 px above and below, the card's 12 px gap less 4.
        <TaintLine className="-my-1">
          Tämä vuoro luki ulkopuolista sisältöä. Hyväksy vain, jos pyysit{' '}
          {a.tool === 'chat_read' ? 'lukemista' : 'muutosta'} itse.
        </TaintLine>
      )}
      {reason && <p className="text-meta text-muted-foreground">{reason}</p>}
      {guard ? (
        <>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-2">
            <dt className="font-mono text-[13px] leading-5 text-muted-foreground">{guard.label}</dt>
            <Value text={guard.text}>{guard.marked}</Value>
          </dl>
          <p className={meta}>{guard.note}</p>
        </>
      ) : harness ? (
        <ViewBody v={harness} />
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          {args.map(([k, val]) => (
            <div key={k} className="contents">
              <dt className="max-w-32 truncate font-mono text-[13px] leading-5 text-muted-foreground">
                {k}
              </dt>
              <Value text={show(val)} />
            </div>
          ))}
        </dl>
      )}
      <div className="flex flex-wrap items-center gap-2 max-md:grid max-md:grid-cols-2">
        <p className="mr-auto flex items-center gap-1.5 text-meta text-muted-foreground tabular-nums max-md:col-span-2">
          <Clock size={16} />
          Vanhenee klo {clock(a.expiresAt)}
        </p>
        <Button variant="outline" onClick={() => respondApproval(a.requestId, false)}>
          Hylkää
        </Button>
        <Button onClick={() => respondApproval(a.requestId, true)}>Hyväksy</Button>
      </div>
    </section>
  );
}
