/**
 * TraceStage.tsx — one captured trace or journey, drawn as time.
 *
 * Plain English: the creek's ribbons say WHICH files and collections a
 * journey touched; this says in what ORDER and for how long. A waterfall per
 * part — the browser's own events, each request, the turn in its own process
 * with the agent's tool calls under it — time running left to right, nesting
 * as indentation, a bar's width the time that hop took. Each part keeps its
 * own clock (the parts ran in different processes), which is why they're
 * stacked rather than spliced.
 *
 * Lifted out of the Wiring room when the trace moved into the creek: the
 * static import graph and "where did this go" were two questions in one
 * room. Layout math is wiringMath.ts (layoutWaterfall, visitedFiles);
 * data shapes are wiring/api.ts.
 */
import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import type { TraceDetail, TracePart, TraceSpan } from '../wiring/api';
import {
  WATERFALL_W,
  baseName,
  formatDuration,
  layoutWaterfall,
  shortFunc,
  visitedFiles,
} from '../wiring/wiringMath';
import styles from './TraceStage.module.css';

export function TraceStage({
  trace,
  onFocus,
}: {
  trace: TraceDetail;
  onFocus: (f: { repo: string; path: string }) => void;
}) {
  const isJourney = trace.kind === 'journey';
  return (
    <div className={styles.traceStage}>
      {isJourney ? (
        <header className={styles.wfHead}>
          <span className={styles.wfEntry}>journey · {trace.label || trace.id}</span>
          <span className={styles.wfMeta}>
            {trace.parts.length} parts · {formatDuration(trace.duration_us)} window ·{' '}
            <Link to="/terrain/files" search={{ journey: trace.id }} className={styles.replayLink}>
              replay on the terrain →
            </Link>
          </span>
        </header>
      ) : (
        <Waterfall part={trace} onFocus={onFocus} />
      )}
      {trace.parts.map((part) =>
        part.kind === 'browser' ? (
          <div key={part.id} className={styles.partWrap}>
            <p className={styles.partNote}>
              In the browser. Times are from the moment this tab learned the journey was armed.
            </p>
            <BrowserPart part={part} onFocus={onFocus} />
          </div>
        ) : (
          <div key={part.id} className={styles.partWrap}>
            <p className={styles.partNote}>
              {part.kind === 'turn'
                ? `…continues in another process (pid ${part.pid}). Its own clock — the times below start again from zero.`
                : `Request · ${part.started_at.slice(11, 23)} — its own clock.`}
            </p>
            <Waterfall part={part} onFocus={onFocus} />
            {part.agent_calls && part.agent_calls.length > 0 ? (
              <AgentCalls calls={part.agent_calls} onFocus={onFocus} />
            ) : null}
          </div>
        ),
      )}
    </div>
  );
}

/** The browser's events, one row each: what was tapped and where it landed,
 * what was fetched and how long it took. A component that resolved to a file
 * is a button through to the wiring for that file. */
function BrowserPart({
  part,
  onFocus,
}: {
  part: { entry: string; duration_us: number; spans: TraceSpan[] };
  onFocus: (f: { repo: string; path: string }) => void;
}) {
  const rows = layoutWaterfall(part.spans, part.duration_us);
  return (
    <section className={styles.waterfall}>
      <header className={styles.wfHead}>
        <span className={styles.wfEntry}>browser</span>
        <span className={styles.wfMeta}>
          {part.spans.length} events · {formatDuration(part.duration_us)}
        </span>
      </header>
      <ul className={styles.wfRows}>
        {part.spans.map((span, i) => {
          const row = rows[i];
          const resolved = span.dst_repo !== 'browser';
          const dur = (span.t1_us ?? span.t0_us) - span.t0_us;
          return (
            <li key={span.seq} className={styles.wfRow}>
              <button
                type="button"
                className={styles.wfLabel}
                disabled={!resolved}
                onClick={() => resolved && onFocus({ repo: span.dst_repo, path: span.dst })}
                title={span.src ?? span.dst}
              >
                <span className={styles.entryTag}>{span.src_func}</span>
                <span className={styles.wfFile}>
                  {span.src_func === 'fetch' ? span.dst_func : resolved ? baseName(span.dst) : (span.src ?? span.dst)}
                </span>
                <span className={styles.wfFunc}>
                  {span.src_func === 'fetch' ? '' : span.dst_func}
                </span>
              </button>
              <div className={styles.wfTrack} style={{ width: WATERFALL_W }}>
                <div className={styles.wfBar} style={{ left: row.x, width: row.width }} aria-hidden="true" />
                {dur > 0 ? (
                  <span className={styles.wfDur} style={{ left: row.x + row.width + 6 }}>
                    {formatDuration(dur)}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What the agent itself did during a turn — from the transcript, placed by
 * wall clock against the part's start. */
function AgentCalls({
  calls,
  onFocus,
}: {
  calls: NonNullable<TracePart['agent_calls']>;
  onFocus: (f: { repo: string; path: string }) => void;
}) {
  return (
    <section className={styles.waterfall}>
      <header className={styles.wfHead}>
        <span className={styles.wfEntry}>the agent's own tool calls</span>
        <span className={styles.wfMeta}>{calls.length} · from the transcript, wall clock</span>
      </header>
      <ul className={styles.wfRows}>
        {calls.map((c) => (
          <li key={c.seq} className={styles.wfRow}>
            <button
              type="button"
              className={styles.wfLabel}
              disabled={!c.repo || !c.rel}
              onClick={() => c.repo && c.rel && onFocus({ repo: c.repo, path: c.rel })}
              title={c.path}
            >
              <span className={styles.dynTag}>{c.name}</span>
              <span className={styles.wfFile}>{c.rel ? baseName(c.rel) : c.path}</span>
              <span className={styles.wfFunc}>+{formatDuration(c.t0_us)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Waterfall({
  part,
  onFocus,
}: {
  part: { entry: string; duration_us: number; truncated: number; spans: TraceSpan[]; pid: number | null };
  onFocus: (f: { repo: string; path: string }) => void;
}) {
  const rows = layoutWaterfall(part.spans, part.duration_us);
  const visited = useMemo(
    () => visitedFiles(part.spans, part.duration_us),
    [part.spans, part.duration_us],
  );
  return (
    <section className={styles.waterfall}>
      <header className={styles.wfHead}>
        <span className={styles.wfEntry}>{part.entry}</span>
        <span className={styles.wfMeta}>
          {formatDuration(part.duration_us)} · {part.spans.length} hops ·{' '}
          {visited.length} files
          {part.truncated ? ' · TRUNCATED' : ''}
        </span>
      </header>
      <ul className={styles.wfRows}>
        {part.spans.map((span, i) => {
          const row = rows[i];
          const dur = (span.t1_us ?? part.duration_us) - span.t0_us;
          return (
            <li key={span.seq} className={styles.wfRow}>
              <button
                type="button"
                className={styles.wfLabel}
                style={{ paddingLeft: 8 + span.depth * 14 }}
                onClick={() => onFocus({ repo: span.dst_repo, path: span.dst })}
                title={`${span.src ?? 'outside our code'} → ${span.dst}`}
              >
                {span.src === null ? (
                  <span className={styles.entryTag}>entry</span>
                ) : span.static === false ? (
                  <span className={styles.dynTag} title="the import graph has no edge for this call">
                    dynamic
                  </span>
                ) : null}
                <span className={styles.wfFile}>{baseName(span.dst)}</span>
                <span className={styles.wfFunc}>{shortFunc(span.dst_func)}</span>
              </button>
              <div className={styles.wfTrack} style={{ width: WATERFALL_W }}>
                <div
                  className={styles.wfBar}
                  style={{ left: row.x, width: row.width }}
                  aria-hidden="true"
                />
                {/* A floored bar is drawn far wider than its real duration, so
                    the number is dropped rather than printed beside a bar that
                    contradicts it. */}
                {row.floored ? null : (
                  <span className={styles.wfDur} style={{ left: row.x + row.width + 6 }}>
                    {formatDuration(dur)}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
