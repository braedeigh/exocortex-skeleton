import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { sessionLocation } from './sessionLocation';
import {
  GROUPS,
  KIND_LABEL,
  RANGES,
  fmtAgo,
  fmtCost,
  fmtShare,
  fmtTokens,
  getBurn,
  getBurnSession,
  minutesSince,
  type BurnBucket,
  type BurnGroup,
  type BurnRange,
  type BurnRow,
  type BurnSession,
  type BurnState,
  type TokenKind,
} from './tokenBurn';
import pageStyles from './NightCrewPage.module.css';
import styles from './TokenBurnPage.module.css';

/**
 * TokenBurnPage — /observatory/burn: how many tokens the agents use, where,
 * and when. Reached by the Token burn door on the roster.
 *
 * Built from her screenshot of a "TOKEN BURN :: FLEET" dashboard and
 * adapted to what this app actually records. Top to bottom:
 *
 *  - Four tiles: tokens in the window, the share that was re-read from cache
 *    (the cheap kind, and most of them), what the agents wrote, and the
 *    estimated cost — an estimate at API list prices, never a bill.
 *  - A freshness line, flagged STALE only when a log has sat unread past the
 *    hourly pass (toolcallstore.freshness).
 *  - Group (model / session / room / kind) and range (24h / 7d / 30d / all).
 *  - "When": tokens per hour (24h) or per day, each turn counted when it
 *    ended. Tap or hover a bar to read it.
 *  - The table, with a share bar per row and the total on top. A session row
 *    opens a drill-down: the session turn by turn, each turn with the model
 *    calls inside it, so any number here can be followed to the calls that
 *    made it. Its "Open session" button (or Enter) goes to the session.
 *  - "Source & coverage": what's exact, what's estimated, what's missing.
 *
 * Keyboard (a real keyboard only): h/l group, shift+h/l range, j/k rows,
 * enter opens the row's session, space opens its turns.
 *
 * All adding-up happens on the server (routes/token_burn.py, proved by
 * tests/test_token_burn_routes.py); this page only draws it.
 */

const GROUP_KEY = 'tokenBurn.group';
const RANGE_KEY = 'tokenBurn.range';

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

const RANGE_WORD: Record<BurnRange, string> = { '24h': '24h', '7d': '7d', '30d': '30d', all: 'all time' };

export function TokenBurnPage() {
  const navigate = useNavigate();
  const [group, setGroup] = useState<BurnGroup>(() =>
    stored(GROUP_KEY, GROUPS.map((g) => g.key), 'model'),
  );
  const [range, setRange] = useState<BurnRange>(() =>
    stored(RANGE_KEY, RANGES.map((r) => r.key), '30d'),
  );
  const [data, setData] = useState<BurnState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [openConv, setOpenConv] = useState<string | null>(null);
  const rowRefs = useRef<(HTMLElement | null)[]>([]);

  // Remember her view, so the page opens where she left it.
  useEffect(() => {
    try {
      localStorage.setItem(GROUP_KEY, group);
      localStorage.setItem(RANGE_KEY, range);
    } catch {
      /* private mode — the page still works, it just forgets */
    }
  }, [group, range]);

  // Load the view whenever the grouping or the window changes.
  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    getBurn(group, range, ac.signal)
      .then((d) => {
        setData(d);
        setSelected(0);
        setOpenConv(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load the numbers.');
      });
    return () => ac.abort();
  }, [group, range]);

  const rows = data?.rows ?? [];
  const openSession = useCallback((conv: string) => void navigate(sessionLocation(conv)), [navigate]);

  // Keyboard shortcuts, the screenshot's set — ignored while typing anywhere.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = (list: { key: string }[], current: string, by: number) => {
      const i = list.findIndex((x) => x.key === current);
      return list[(i + by + list.length) % list.length].key;
    };
    const k = e.key;
    if (k === 'h' || k === 'l') setGroup(step(GROUPS, group, k === 'l' ? 1 : -1) as BurnGroup);
    else if (k === 'H' || k === 'L') setRange(step(RANGES, range, k === 'L' ? 1 : -1) as BurnRange);
    else if (k === 'j' || k === 'k') {
      const next = Math.min(Math.max(selected + (k === 'j' ? 1 : -1), 0), Math.max(rows.length - 1, 0));
      setSelected(next);
      rowRefs.current[next]?.scrollIntoView({ block: 'nearest' });
    } else if (k === 'Enter' && rows[selected]?.conv) openSession(rows[selected].conv as string);
    else if (k === ' ' && rows[selected]?.conv) {
      const conv = rows[selected].conv as string;
      setOpenConv((c) => (c === conv ? null : conv));
    } else return;
    e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const totals = data?.totals;
  const rangeWord = RANGE_WORD[range];

  return (
    <div className={pageStyles.page}>
      <div className={styles.inner}>
        <div className={pageStyles.header}>
          <button type="button" className={pageStyles.back} onClick={() => void navigate({ to: '/observatory' })}>
            &larr; Observatory
          </button>
          <h1 className={pageStyles.title}>Token burn</h1>
          <span className={styles.keys} aria-hidden="true">
            h/l view · shift+h/l range · j/k rows · enter opens
          </span>
        </div>

        {/* The four tiles: how much, how much of it was cheap re-reading,
            what was actually written, and the estimated cost. */}
        <div className={styles.tiles}>
          <Tile label="Tokens" value={fmtTokens(totals?.tokens)} note={`tokens / ${rangeWord}`} />
          <Tile
            label="Re-read"
            value={totals?.tokens ? fmtShare(totals.cache_read / totals.tokens) : '—'}
            note={
              totals?.cost_usd
                ? `of tokens · ≈${fmtShare(totals.kind_cost_usd.cache_read / totals.cost_usd)} of cost`
                : 'of tokens, from cache'
            }
          />
          <Tile
            label="Written"
            value={fmtTokens(totals?.output)}
            note={totals ? `${totals.turns.toLocaleString()} turns · ${totals.sessions} sessions` : ''}
          />
          <Tile label="Est. cost" value={fmtCost(totals?.cost_usd)} note="list prices, not a bill" />
        </div>

        {data ? <Freshness data={data} /> : null}

        {/* Group and range, one row above everything they filter. */}
        <div className={styles.controls}>
          <Segmented label="Group" options={GROUPS} value={group} onChange={setGroup} />
          <Segmented label="Range" options={RANGES} value={range} onChange={setRange} />
          <span className={styles.rowCount}>{rows.length} rows</span>
        </div>

        {error ? <div className={styles.note}>{error}</div> : null}
        {!data && !error ? <div className={styles.note}>Adding it up…</div> : null}

        {data ? <When timeline={data.timeline} range={range} since={data.since} /> : null}

        {data && totals ? (
          <div className={styles.table} role="table" aria-label="Token burn">
            <div className={`${styles.row} ${styles.head}`} role="row">
              <span role="columnheader">{GROUPS.find((g) => g.key === group)?.label.replace('by ', '')}</span>
              <span role="columnheader" className={styles.num}>tokens</span>
              <span role="columnheader" className={styles.num}>est. cost</span>
              <span role="columnheader" className={`${styles.num} ${styles.turnsCol}`}>turns</span>
              <span role="columnheader" className={styles.num}>share</span>
            </div>
            <div className={`${styles.row} ${styles.totalRow}`} role="row">
              <span className={styles.name}>All · {GROUPS.find((g) => g.key === group)?.label}</span>
              <span className={styles.num}>{fmtTokens(totals.tokens)}</span>
              <span className={styles.num}>{fmtCost(totals.cost_usd)}</span>
              <span className={`${styles.num} ${styles.turnsCol}`}>{totals.turns.toLocaleString()}</span>
              <ShareCell share={totals.tokens ? 1 : 0} />
            </div>
            {rows.length === 0 ? <div className={styles.note}>Nothing ran in this window.</div> : null}
            {rows.map((r, i) => (
              <Fragment key={r.key}>
                <Row
                  row={r}
                  group={group}
                  selected={i === selected}
                  open={openConv === r.conv}
                  refCallback={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  onSelect={() => {
                    setSelected(i);
                    if (r.conv) setOpenConv((c) => (c === r.conv ? null : (r.conv as string)));
                  }}
                />
                {r.conv && openConv === r.conv ? (
                  <SessionDrill conv={r.conv} onOpen={() => openSession(r.conv as string)} />
                ) : null}
              </Fragment>
            ))}
          </div>
        ) : null}

        {data ? <Coverage data={data} /> : null}
      </div>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      <span className={styles.tileNote}>{note}</span>
    </div>
  );
}

/** When the numbers were last read in, flagged only when it matters: STALE
 * means a log has waited past the hourly pass, i.e. the pass isn't running. */
function Freshness({ data }: { data: BurnState }) {
  const f = data.freshness;
  return (
    <div className={styles.fresh}>
      updated {fmtAgo(minutesSince(f.updated_at))} · latest turn {fmtAgo(minutesSince(f.latest_turn_at))}
      {f.stale ? (
        <span className={styles.stale}>STALE — the hourly pass hasn't read {f.waiting} log{f.waiting === 1 ? '' : 's'}</span>
      ) : f.waiting > 0 ? (
        <span> · {f.waiting} log{f.waiting === 1 ? '' : 's'} waiting for the hourly pass</span>
      ) : null}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className={styles.segGroup} role="group" aria-label={label}>
      <span className={styles.segLabel}>{label}</span>
      <div className={styles.seg}>
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            className={[styles.segBtn, o.key === value ? styles.segOn : ''].filter(Boolean).join(' ')}
            aria-pressed={o.key === value}
            onClick={() => onChange(o.key)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Every bucket in the window, empty ones included, so a quiet stretch shows
 * as a gap rather than being squeezed out. */
function fillBuckets(timeline: BurnBucket[], range: BurnRange, since: string | null): BurnBucket[] {
  const byKey = new Map(timeline.map((b) => [b.bucket, b]));
  const hourly = range === '24h';
  const pad = (n: number) => String(n).padStart(2, '0');
  const keyOf = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` + (hourly ? `T${pad(d.getHours())}` : '');
  const start = since ? new Date(since) : timeline.length ? new Date(timeline[0].bucket.slice(0, 10)) : new Date();
  const end = new Date();
  const out: BurnBucket[] = [];
  const cursor = new Date(start);
  if (hourly) cursor.setMinutes(0, 0, 0);
  else cursor.setHours(0, 0, 0, 0);
  while (cursor <= end && out.length < 400) {
    const key = keyOf(cursor);
    out.push(byKey.get(key) ?? { bucket: key, input: 0, cache_write: 0, cache_read: 0, output: 0, cost_usd: 0, turns: 0 });
    if (hourly) cursor.setHours(cursor.getHours() + 1);
    else cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function bucketName(key: string): string {
  const [date, hour] = key.split('T');
  const d = new Date(`${date}T00:00:00`);
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return hour != null ? `${day}, ${hour}:00` : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

const bucketTokens = (b: BurnBucket) => b.input + b.cache_write + b.cache_read + b.output;

/** "When": tokens per hour or per day, one hue, the total only; the readout
 * under it breaks the tapped bar down by kind. */
function When({ timeline, range, since }: { timeline: BurnBucket[]; range: BurnRange; since: string | null }) {
  const buckets = useMemo(() => fillBuckets(timeline, range, since), [timeline, range, since]);
  const [picked, setPicked] = useState<number | null>(null);
  const max = Math.max(1, ...buckets.map(bucketTokens));
  // The readout shows the tapped bar, else the latest one that spent anything.
  const lastBusy = buckets.map(bucketTokens).findLastIndex((t) => t > 0);
  const shown = buckets[picked ?? lastBusy];
  if (buckets.length === 0) return null;
  return (
    <section className={styles.when}>
      <h2 className={styles.whenTitle}>Tokens per {range === '24h' ? 'hour' : 'day'}</h2>
      <div className={styles.bars} onMouseLeave={() => setPicked(null)}>
        {buckets.map((b, i) => {
          const t = bucketTokens(b);
          return (
            <button
              key={b.bucket}
              type="button"
              className={[styles.barHit, i === (picked ?? lastBusy) ? styles.barPicked : ''].filter(Boolean).join(' ')}
              aria-label={`${bucketName(b.bucket)}: ${fmtTokens(t)} tokens`}
              onMouseEnter={() => setPicked(i)}
              onFocus={() => setPicked(i)}
              onClick={() => setPicked(i)}
            >
              <span className={styles.bar} style={{ height: t ? `${Math.max(2, (t / max) * 100)}%` : 0 }} />
            </button>
          );
        })}
      </div>
      <div className={styles.axis}>
        <span>{bucketName(buckets[0].bucket)}</span>
        <span>{bucketName(buckets[buckets.length - 1].bucket)}</span>
      </div>
      {shown ? (
        <div className={styles.readout}>
          <strong>{bucketName(shown.bucket)}</strong> · {fmtTokens(bucketTokens(shown))} tokens ·{' '}
          {fmtTokens(shown.cache_read)} re-read · {fmtTokens(shown.cache_write)} newly cached ·{' '}
          {fmtTokens(shown.output)} written · {shown.turns} turn{shown.turns === 1 ? '' : 's'} ·{' '}
          {fmtCost(shown.cost_usd)} est.
        </div>
      ) : null}
    </section>
  );
}

function ShareCell({ share }: { share: number }) {
  return (
    <span className={styles.shareCell}>
      <span className={styles.shareTrack} aria-hidden="true">
        <span className={styles.shareFill} style={{ width: `${Math.min(100, share * 100)}%` }} />
      </span>
      <span className={styles.sharePct}>{fmtShare(share)}</span>
    </span>
  );
}

function Row({
  row,
  group,
  selected,
  open,
  refCallback,
  onSelect,
}: {
  row: BurnRow;
  group: BurnGroup;
  selected: boolean;
  open: boolean;
  refCallback: (el: HTMLElement | null) => void;
  onSelect: () => void;
}) {
  // The small chip beside a name: how many sessions a model or room spans,
  // or which room a session sits in.
  const chip =
    group === 'session' ? row.room : group === 'kind' ? null : `${row.sessions} session${row.sessions === 1 ? '' : 's'}`;
  const cells = (
    <>
      <span className={styles.name}>
        {group === 'session' ? <span className={styles.caret} aria-hidden="true">{open ? '▾' : '▸'}</span> : null}
        <span className={styles.nameText}>{row.label}</span>
        {chip ? <span className={styles.chip}>{chip}</span> : null}
      </span>
      <span className={styles.num}>{fmtTokens(row.tokens)}</span>
      <span className={styles.num}>
        {fmtCost(row.cost_usd)}
        {group === 'kind' ? <span className={styles.approx}>≈</span> : null}
      </span>
      <span className={`${styles.num} ${styles.turnsCol}`}>{row.turns == null ? '—' : row.turns.toLocaleString()}</span>
      <ShareCell share={row.share} />
    </>
  );
  const className = [styles.row, selected ? styles.rowSelected : ''].filter(Boolean).join(' ');
  // Session rows are buttons (they open the drill-down); the rest are plain rows.
  return row.conv ? (
    <button
      ref={refCallback}
      type="button"
      role="row"
      className={`${className} ${styles.rowButton}`}
      aria-expanded={open}
      onClick={onSelect}
    >
      {cells}
    </button>
  ) : (
    <div ref={refCallback} role="row" className={className} onClick={onSelect}>
      {cells}
    </div>
  );
}

const TURNS_SHOWN = 15;

/** One session, turn by turn (newest first), each with the model calls inside
 * it — only calls from 09-27 on are on record, so older turns list none. */
function SessionDrill({ conv, onOpen }: { conv: string; onOpen: () => void }) {
  const [data, setData] = useState<BurnSession | null>(null);
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState(TURNS_SHOWN);
  useEffect(() => {
    const ac = new AbortController();
    getBurnSession(conv, ac.signal)
      .then(setData)
      .catch(() => {
        if (!ac.signal.aborted) setFailed(true);
      });
    return () => ac.abort();
  }, [conv]);
  const turns = data ? [...data.turns].reverse() : [];
  return (
    <div className={styles.drill}>
      <div className={styles.drillHead}>
        <span className={styles.drillTitle}>Turn by turn, newest first</span>
        <button type="button" className={styles.openBtn} onClick={onOpen}>
          Open session &rarr;
        </button>
      </div>
      {failed ? <div className={styles.note}>Couldn&rsquo;t load this session&rsquo;s turns.</div> : null}
      {!data && !failed ? <div className={styles.note}>Loading…</div> : null}
      {turns.slice(0, shown).map((t) => (
        <div key={t.seq ?? 'running'} className={styles.turn}>
          <div className={styles.turnHead}>
            <span>{t.seq == null ? 'Still running' : `Turn ${t.seq}`}</span>
            <span className={styles.turnWhen}>{t.at ? new Date(t.at).toLocaleString() : ''}</span>
            {t.seq != null ? (
              <span className={styles.turnNums}>
                {fmtTokens(t.cache_read)} re-read · {fmtTokens(t.cache_write)} new · {fmtTokens(t.output)} written ·{' '}
                {fmtCost(t.cost_usd)}
              </span>
            ) : null}
          </div>
          {t.calls.length ? (
            <ol className={styles.calls}>
              {t.calls.map((c, i) => (
                <li key={i} className={styles.call}>
                  <span className={styles.callTime}>{c.at.slice(11, 19)}</span>
                  <span className={styles.callNums}>
                    {fmtTokens(c.cache_read)} re-read · {fmtTokens(c.cache_write)} new · {fmtTokens(c.output)} written
                  </span>
                  <span className={styles.callTools}>
                    {c.subagent ? 'subagent · ' : ''}
                    {c.tools ?? 'reply'}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ))}
      {turns.length > shown ? (
        <button type="button" className={styles.moreBtn} onClick={() => setShown((n) => n + TURNS_SHOWN)}>
          Show earlier turns
        </button>
      ) : null}
    </div>
  );
}

/** What's exact, what's estimated, what isn't in here — shut by default. */
function Coverage({ data }: { data: BurnState }) {
  const t = data.totals;
  const kinds: TokenKind[] = ['cache_read', 'cache_write', 'input', 'output'];
  return (
    <details className={styles.coverage}>
      <summary className={styles.coverageSummary}>
        <span>Source &amp; coverage</span>
        <span className={styles.coverageAside}>estimates, not invoices</span>
      </summary>
      <ul className={styles.coverageList}>
        <li>
          Every Observatory turn since {data.coverage.first_day ?? '—'}. Each turn counts only its own share: when one
          agent process runs several turns, the harness reports running totals, and those are subtracted.
        </li>
        <li>
          Token counts are exact — they come from each model call&rsquo;s API response. In this window:{' '}
          {kinds.map((k, i) => (
            <span key={k}>
              {i ? ', ' : ''}
              {KIND_LABEL[k].toLowerCase()} {fmtTokens(t[k])}
            </span>
          ))}
          . Of the written tokens, {fmtTokens(t.thinking)} were thinking.
        </li>
        <li>
          Cost is the harness&rsquo;s own estimate at API list prices. On a subscription it&rsquo;s a yardstick, not a
          bill. &ldquo;By kind&rdquo; splits each model&rsquo;s cost by list-price ratios (fresh 1, cached 2, re-read
          0.1, written 5), so those dollars are marked ≈.
        </li>
        <li>&ldquo;When&rdquo; dates each turn by when it ended; a long turn lands in one bar.</li>
        <li>
          Not in these totals: {data.outside.calls.toLocaleString()} model calls made outside the Observatory (a
          terminal, tmux, one-off jobs) in this window, re-reading {fmtTokens(data.outside.context_tokens)} tokens of
          context. Their output and cost aren&rsquo;t on record.
        </li>
        {data.range === 'all' && data.coverage.undated_turns ? (
          <li>{data.coverage.undated_turns} turns have no time on record; they&rsquo;re counted here but not in the chart.</li>
        ) : null}
        <li>Turns killed partway (a server restart) never report, and aren&rsquo;t counted.</li>
      </ul>
    </details>
  );
}
