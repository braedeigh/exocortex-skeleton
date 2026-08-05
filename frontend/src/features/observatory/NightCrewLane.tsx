import { useState } from 'react';
import { getBranchReport } from './api';
import { LaneHead, useLaneOpen } from './LaneHead';
import styles from './NightCrew.module.css';

/**
 * NightCrewLane — "Built for you": everything an agent has finished and left on
 * a branch, waiting on her.
 *
 * FINISHED-AND-WAITING, not live (Sunflower). That is what defines this room,
 * and it's a different axis from its three siblings. Personal, Coding and
 * Orchestra are rooms for sessions that are HAPPENING, sorted by whether she's
 * watching. Nothing here is running — it's all done and holding for a verdict.
 * So the only hierarchy is what asks her for something: `ready` floats to the
 * top, then anything still being built, then the ones that couldn't.
 *
 * WHY IT HOLDS TWO KINDS NOW. The night crew fills it while she sleeps — one
 * green-lit note per branch in a throwaway worktree, tests run, nothing merged
 * (the permission model IS that crew: it can't ask, so it's structurally
 * unable to do the thing worth asking about). But a daytime session's branch
 * sits in exactly the same state, and it was showing up nowhere while a
 * separate page answered the same question in different words. Two surfaces
 * answering "what's waiting for me?" is how a system starts disagreeing with
 * itself. One room, one question. `source` on each card says which kind it is.
 *
 * WHAT A BRANCH CARD MAY NOT BORROW. A night run carries before/after
 * screenshots, a test result and a merge button — all EARNED by being verified
 * in its worktree before the card existed. No gate has run against a bare
 * branch, so it gets none of the three: a merge button there would be one tap
 * that ships unverified work. Its evidence is what changed, plus its own
 * written account, captioned as a claim wherever it appears.
 *
 * THE SCREENSHOT LEADS, THE DIFF FOLDS AWAY (Sunflower's call, confirmed with
 * her). She reads her own app, not diffs — a before/after answers "is this
 * right?" in about a second, where a diff asks a question she isn't the best
 * person in the room to answer. A card with no screenshot leads with its words
 * instead. Deference: the interface recedes so the content does the talking.
 *
 * Reads GET /api/nightcrew (routes/nightcrew.py), which joins the night runs
 * with routes/branches.py's list. Merge is the only control that reaches her
 * real branch, so it confirms first and the server refuses anything it isn't
 * sure about (dirty tree, conflict, non-ready run) — a merge failure lands
 * back on the card in plain words rather than as a git dump she'd decode.
 */

export interface NightRun {
  id: string;
  note_id?: string;
  tab?: string;
  note_text: string;
  status: 'ready' | 'working' | 'failed' | 'parked' | 'merged';
  branch?: string;
  diff_stat?: string;
  test_tail?: string;
  shot_before?: string;
  shot_after?: string;
  cost_usd?: number;
  finished?: string;
  /** Why a failed/parked run stopped. Kept forever even after the branch is
   * swept, so the next worker on this note reads what beat the last one. */
  reason?: string;
  /** Questions the worker left when the note wasn't clear enough to act on.
   * Also written onto the note itself (`night_questions`) — she answers by
   * editing the note, which re-queues it for the next night. */
  question?: string;
  /** The worker's own session — every attempt is one. Opens from the card
   * (night sessions are excluded from the room lanes), and replying in it
   * folds her words into the dev note. */
  conv_id?: string;
  dismissed?: boolean;

  /* --- the room holds more than the night crew now ------------------------
     A daytime session's branch sits in exactly the state everything here is
     in: finished, waiting on her. `source` is what lets ONE card shape serve
     both. A night run has before/after pictures, a test result and a merge
     button — all of which it EARNED by being verified in its worktree before
     the card existed. A bare branch has had no gate run against it and must
     not borrow any of them. */
  source?: 'night' | 'branch';
  /** What a merge would take. */
  files?: string[];
  /** Files in the copy that never reached the branch — a merge would leave
   * these behind. The one thing on this card she can't learn anywhere else. */
  uncommitted?: string[];
  has_report?: boolean;
  commits?: number;
}

/* The card's whole visual vocabulary in one table, the way SessionLane does it
   — adding a status is a row here and a rule in the stylesheet, never another
   branch buried in the markup. */
const STATUS: Record<NightRun['status'], { cls: string; dot: string; label: string }> = {
  ready: { cls: 'cardReady', dot: 'dotReady', label: 'ready for you' },
  // Only a daytime branch reaches this one: a night run is never in progress —
  // she's asleep and it's finished by the time she sees it.
  working: { cls: 'cardWorking', dot: 'dotWorking', label: 'still building' },
  failed: { cls: 'cardFailed', dot: 'dotFailed', label: "couldn't" },
  parked: { cls: 'cardParked', dot: 'dotParked', label: 'parked' },
  merged: { cls: 'cardMerged', dot: 'dotMerged', label: 'merged' },
};

function Card({
  run,
  onDismiss,
  onMerge,
  onOpenSession,
}: {
  run: NightRun;
  onDismiss: (id: string) => void;
  onMerge: (id: string) => Promise<string | null>;
  onOpenSession: (convId: string) => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  // Merging writes to her real branch, so it confirms first — the same
  // two-tap shape the rest of the app uses for anything destructive.
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const s = STATUS[run.status];
  const hasShots = Boolean(run.shot_before && run.shot_after);
  const isBranch = run.source === 'branch';
  // The session's own account of what it did, pulled only when she opens it.
  // Labelled as a claim wherever it shows: a well-written explanation of
  // broken code reads exactly like a good outcome, so it never sits where a
  // test result would.
  const [report, setReport] = useState<string | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);

  function toggleReport() {
    if (report !== null) {
      setReport(null);
      return;
    }
    setLoadingReport(true);
    getBranchReport(run.branch!)
      .then((r) => setReport(r.report ?? ''))
      .catch(() => setReport(''))
      .finally(() => setLoadingReport(false));
  }

  function merge() {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setConfirming(false);
    setMerging(true);
    onMerge(run.id)
      .then(setMergeError)
      .finally(() => setMerging(false));
  }

  return (
    <article className={`${styles.card} ${styles[s.cls]}`}>
      <header className={styles.cardHead}>
        <span className={`${styles.dot} ${styles[s.dot]}`} aria-hidden />
        <span className={styles.status}>{s.label}</span>
        {/* A night run is filed under the dev-note tab it came from; a branch
            has no tab, so it says what it is instead of showing a blank. */}
        <span className={styles.tab}>{isBranch ? 'session' : run.tab}</span>
      </header>

      {/* Her own words are the title — she recognises the note before she
          recognises anything we'd write about it. */}
      <p className={styles.noteText}>{run.note_text}</p>

      {hasShots && (
        <div className={styles.shots}>
          <figure className={styles.shot}>
            <img src={run.shot_before} alt="before" loading="lazy" />
            <figcaption>before</figcaption>
          </figure>
          <figure className={styles.shot}>
            <img src={run.shot_after} alt="after" loading="lazy" />
            <figcaption>after</figcaption>
          </figure>
        </div>
      )}

      {/* Work sitting in the copy that a merge would NOT pick up. Nothing else
          in the app can tell her this, and it's the difference between "the
          session built that" and "the session built that and it's still in a
          folder nobody will look at again". */}
      {run.uncommitted && run.uncommitted.length > 0 && (
        <p className={styles.stranded}>
          {run.uncommitted.length} file{run.uncommitted.length === 1 ? '' : 's'} changed in
          its copy but never committed — merging wouldn&rsquo;t take{' '}
          {run.uncommitted.length === 1 ? 'it' : 'them'}.
        </p>
      )}

      {/* A failed or parked run owes her one plain sentence about what beat it.
          Anything less and the card is a shrug she has to go investigate. */}
      {run.reason && <p className={styles.reason}>{run.reason}</p>}

      {/* The worker's questions, verbatim. They also sit on the note card in
          the panel — this copy is so the morning stack shows what's being
          asked without a trip to the notes. */}
      {run.question && <p className={styles.question}>{run.question}</p>}

      {run.diff_stat && (
        <>
          <button
            type="button"
            className={styles.diffToggle}
            aria-expanded={showDiff}
            onClick={() => setShowDiff((v) => !v)}
          >
            <span className={styles.chevron} data-open={showDiff || undefined}>›</span>
            {run.diff_stat}
          </button>
          {showDiff && (
            <pre className={styles.tail}>
              {/* A night run's evidence is its test output. A branch has none —
                  no gate has been run against it — so it shows the files a
                  merge would take rather than an empty box pretending to be a
                  result. */}
              {isBranch
                ? (run.files ?? []).join('\n') || 'no files'
                : run.test_tail || 'no test output recorded'}
            </pre>
          )}
        </>
      )}

      {/* The session's own account. Only ever offered, never auto-shown, and
          always captioned as a claim. */}
      {isBranch && run.has_report && (
        <>
          <button
            type="button"
            className={styles.diffToggle}
            aria-expanded={report !== null}
            onClick={toggleReport}
          >
            <span className={styles.chevron} data-open={report !== null || undefined}>›</span>
            What it says it did
            <span className={styles.claimNote}>its own account — not verified</span>
          </button>
          {loadingReport && <p className={styles.reason}>reading…</p>}
          {report !== null && !loadingReport && (
            <pre className={styles.report}>{report || 'It never wrote one.'}</pre>
          )}
        </>
      )}

      {/* A merge that couldn't happen has to say why in her words, not git's —
          "you have uncommitted changes" is actionable, a conflict dump is not. */}
      {mergeError && <p className={styles.mergeError}>{mergeError}</p>}

      <footer className={styles.actions}>
        {/* Merge is a NIGHT-RUN affordance and it stays one. A night run earned
            it by being verified in its own worktree before this card existed;
            no gate has been run against a bare branch, so a button here would
            be one tap that ships unverified work — worse than making her type
            it. Merging these lands with the ship-it card, where the gates run
            against the merged result. */}
        {run.status === 'ready' && !isBranch && (
          <button
            type="button"
            className={confirming ? styles.mergeConfirm : styles.merge}
            disabled={merging}
            onClick={merge}
          >
            {merging ? 'Merging…' : confirming ? 'Merge for real?' : 'Merge'}
          </button>
        )}
        {run.status === 'ready' && isBranch && run.branch && (
          <code className={styles.branchName}>{run.branch}</code>
        )}
        {run.status === 'merged' && <span className={styles.merged}>merged</span>}
        {/* The worker's own session, from the card — night sessions live
            HERE, not in the room lanes. Replying in it folds into the note. */}
        {run.conv_id && (
          <button
            type="button"
            className={styles.sessionLink}
            onClick={() => onOpenSession(run.conv_id!)}
          >
            Session ↗
          </button>
        )}
        {/* Dismiss marks a night RUN record dismissed. A branch has no record
            to mark — the way to clear one is to merge it or delete it, neither
            of which is a thing this room does yet. */}
        {!isBranch && (
          <button
            type="button"
            className={styles.dismiss}
            onClick={() => onDismiss(run.id)}
          >
            {run.status === 'ready' ? 'Discard' : 'Clear'}
          </button>
        )}
        {run.cost_usd != null && (
          <span className={styles.cost}>${run.cost_usd.toFixed(2)}</span>
        )}
      </footer>
    </article>
  );
}

export function NightCrewLane({
  runs,
  queued,
  spendUsd,
  onDismiss,
  onMerge,
  onOpenSession,
}: {
  runs: NightRun[];
  /** How many notes are green-lit and would pass the gate tonight. */
  queued: number;
  spendUsd: number;
  onDismiss: (id: string) => void;
  /** Resolves to an error message to show on the card, or null on success. */
  onMerge: (id: string) => Promise<string | null>;
  /** Opens a worker's session (RosterPage's regular session door). */
  onOpenSession: (convId: string) => void;
}) {
  const live = runs.filter((r) => !r.dismissed);
  const ready = live.filter((r) => r.status === 'ready').length;
  const [open, toggleOpen] = useLaneOpen('nightcrew');

  // Collapses like every other room on the page (LaneHead.tsx), and for the
  // same reason its siblings do: the census rides the HEADER, so a shut Night
  // crew still says how many attempts are waiting on a verdict and what last
  // night cost. Nothing that wants her is behind the fold.
  const head = (
    <LaneHead heading="Built for you" open={open} onToggle={toggleOpen} wanting={ready > 0}>
      {/* Only ever one number in the heading, and it's the one that asks
          something of her. Cost sits muted on the right — present so it can
          never surprise her at the end of a month, quiet so it isn't the
          first thing she reads at 6 AM. */}
      {ready > 0 && <span className={styles.readyCount}>{ready} ready</span>}
      <span className={styles.spend}>${spendUsd.toFixed(2)} last night</span>
    </LaneHead>
  );

  if (!open) {
    return <section className={styles.lane}>{head}</section>;
  }

  return (
    <section className={styles.lane}>
      {head}
      {/* One line, not six. Everything the old blurb explained — a worker's
          questions, why one parked, what a merge would miss — is already ON the
          card that needs it, where she'll actually read it. A paragraph of grey
          text above the content is the room talking about itself. */}
      <p className={styles.blurb}>
        Finished work on a branch, waiting on you — the night crew&rsquo;s and
        your daytime sessions&rsquo;. <strong>Nothing merges without you.</strong>
      </p>

      {live.length === 0 ? (
        <div className={styles.idle}>
          <span className={styles.idleDot} aria-hidden />
          {queued > 0
            ? `Nothing waiting. ${queued} note${queued === 1 ? '' : 's'} teed up for tonight.`
            : 'Nothing waiting, and nothing green-lit for tonight.'}
        </div>
      ) : (
        <div className={styles.rows}>
          {live.map((run) => (
            <Card key={run.id} run={run} onDismiss={onDismiss} onMerge={onMerge}
              onOpenSession={onOpenSession} />
          ))}
        </div>
      )}
    </section>
  );
}
