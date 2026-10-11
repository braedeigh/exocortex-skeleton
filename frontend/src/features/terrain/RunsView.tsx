import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useCreek } from './creek/api';
import { getAutomations } from '../automations/api';
import { buildRunners, downstreamFiles, sinceLabel, type Runner } from './runFlow';
import { TerrainRoomHeader } from './TerrainRoomHeader';
import styles from './RunsView.module.css';

/**
 * RunsView — "how does code actually run through this app?", answered as a
 * picture instead of a paragraph.
 *
 * The whole page is one sentence, repeated once per runner:
 *
 *     something FIRES this  ->  it WRITES these collections  ->  this code
 *                               READS them, later
 *
 * That shape is the point. The instinct when you can't see an app's flow is to
 * look for a call chain — this function calls that one, on down. There isn't
 * one here, and hunting for it is what makes the app feel unreadable. Work
 * moves by a runner writing to a store and exiting; whoever reads next shows up
 * minutes or hours later and the two never meet. So the drawing has exactly two
 * hops, because two hops is where the evidence honestly stops.
 *
 * The three columns are three different STRENGTHS of claim, and the page never
 * pretends otherwise:
 *
 *   RUNNER      recorded fact. The write journal stamps the process that made
 *               every write, and a background job is its own process.
 *   COLLECTION  recorded fact, to the second — what changed and when.
 *   READERS     static wiring only. Their source contains a read of that
 *               collection; nothing ever observed them running. Drawn faintest
 *               for exactly that reason.
 *
 * Rows are collapsed by default and open one at a time on tap — the same
 * card-is-the-view, chevron-remembers pattern the rest of the app uses. Nothing
 * here writes anything; it's a reading surface over /api/creek and
 * /api/automations.
 *
 * Prompt that produced it: "I just am confused about how code runs through the
 * app. And I want to visualize it."
 */
export function RunsView() {
  const { data: creek, isLoading, isError } = useCreek(14);
  const { data: autos } = useQuery({
    queryKey: ['automations'] as const,
    queryFn: ({ signal }) => getAutomations(signal),
    staleTime: 60_000,
  });

  const runners = useMemo(
    () => buildRunners(creek, autos?.runs ?? []),
    [creek, autos],
  );

  // One open at a time: this page is for following a single path from end to
  // end, and several open at once puts the thing being compared off-screen.
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className={styles.page}>
      <TerrainRoomHeader title="What runs" sub="Which process fires, what it writes, and who picks that up later." />
      <p className={styles.blurb}>
        Code here doesn't move in a call chain. Something <strong>fires</strong> a
        runner, the runner <strong>writes</strong> to a collection and exits, and
        other code <strong>reads</strong> that collection later — minutes or hours
        later, never meeting the thing that wrote it. The store is a mailbox, not
        a phone call. That's why nothing "calls all the way down", and it's the
        whole shape of the app.
      </p>

      <div className={styles.legend}>
        <span className={styles.legendStep}>
          <span className={`${styles.legendDot} ${styles.dotRunner}`} />
          runner — recorded: the journal stamps which process wrote
        </span>
        <span className={styles.legendStep}>
          <span className={`${styles.legendDot} ${styles.dotColl}`} />
          collection — recorded, to the second
        </span>
        <span className={styles.legendStep}>
          <span className={`${styles.legendDot} ${styles.dotReader}`} />
          readers — wiring only, never observed running
        </span>
      </div>

      {isLoading ? <p className={styles.state}>Reading the write journal…</p> : null}
      {isError ? <p className={styles.state}>Couldn't load the creek.</p> : null}
      {!isLoading && !isError && runners.length === 0 ? (
        <p className={styles.state}>
          Nothing has written through the store in this window.
        </p>
      ) : null}

      {runners.map((r) => (
        <RunnerCard
          key={r.caller}
          runner={r}
          open={open === r.caller}
          onToggle={() => setOpen(open === r.caller ? null : r.caller)}
        />
      ))}
    </div>
  );
}

function RunnerCard({
  runner,
  open,
  onToggle,
}: {
  runner: Runner;
  open: boolean;
  onToggle: () => void;
}) {
  const downstream = useMemo(() => downstreamFiles(runner), [runner]);
  // The freshest write across everything this runner touched. The registry's
  // last_run is preferred when there is one — it's the run itself rather than a
  // side effect of it — but most runners aren't registered, so the journal has
  // to answer for them.
  const last =
    runner.lastRun ??
    runner.collections.reduce<string | null>(
      (acc, c) => (c.lastWrite && (!acc || c.lastWrite > acc) ? c.lastWrite : acc),
      null,
    );

  return (
    <section className={styles.runner}>
      <button
        type="button"
        className={styles.runnerHead}
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className={`${styles.chev} ${open ? styles.chevOpen : ''}`}>▶</span>
        <span className={styles.runnerMain}>
          <span className={styles.runnerName}>{runner.label}</span>
          {runner.file ? (
            <span className={styles.runnerFile}>{runner.file}</span>
          ) : null}
          <span className={styles.trigger}>
            fired by {runner.triggerDetail} · last {sinceLabel(last)}
            {runner.lastStatus === 'error' ? ' · last run errored' : ''}
          </span>
        </span>
        <span className={styles.runnerStats}>
          <span className={styles.statBig}>{runner.writes.toLocaleString()}</span>
          writes into {runner.collections.length}
          <br />
          {downstream.length} file{downstream.length === 1 ? '' : 's'} read after
        </span>
      </button>

      {open ? (
        <div className={styles.body}>
          {runner.collections.map((c) => (
            <div className={styles.flowRow} key={c.id}>
              <div>
                <div className={styles.collName}>{c.id}</div>
                <div className={styles.collMeta}>
                  {c.writes.toLocaleString()} write{c.writes === 1 ? '' : 's'} ·
                  changed {sinceLabel(c.lastWrite)}
                </div>
              </div>
              <div>
                <div className={styles.readerLabel}>then read by</div>
                {c.readers.length > 0 ? (
                  <div className={styles.readers}>
                    {c.readers.map((p) => (
                      <span className={styles.reader} key={p}>
                        {p}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className={styles.none}>
                    nothing in this repo reads it — it's an output, or the reader
                    lives outside the scan
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
