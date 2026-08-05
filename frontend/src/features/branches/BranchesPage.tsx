/**
 * BranchesPage — what the agents have built for you and you haven't taken yet.
 *
 * Sessions that build for you work in their own copy of the app and leave the
 * work on a branch. Nothing merges by itself, so those branches pile up
 * invisibly — this is that pile, one card each.
 *
 * The page is organised around ONE question: does this need me? Everything
 * `waiting` goes at the top, under a count. Everything else collapses into a
 * quiet list underneath, because a finished branch is history, not a task.
 *
 * The split that matters. Each card has two halves and they are visually
 * separate on purpose: the NUMBERS (commits, files, +/-) come from git, and the
 * REPORT is the session's own prose about what it did. A well-written
 * explanation of broken code reads exactly like a good outcome, so the prose
 * never gets to sit where a test result would. The report is fetched only when
 * you open it — it isn't in the list payload at all.
 *
 * Read-only by design. Merging is her tap and it lands with the ship-it card,
 * where the gates can run first; a button here would merge untested.
 *
 * Prompt that produced it: "is there any way to make this into a visual UI that
 * i can look at to understand it better?"
 */
import { useCallback, useEffect, useState } from 'react';
import { getBranches, getReport } from './api';
import type { Branch, BranchState } from './types';
import styles from './BranchesPage.module.css';

/** Plain English for each state — she reads these, not the enum. */
const STATE_LABEL: Record<BranchState, string> = {
  waiting: 'waiting for you',
  working: 'still building',
  taken: 'merged',
  empty: 'built nothing',
  done: 'nothing to take',
};

function ageLabel(days: number | null): string {
  if (days === null) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function BranchCard({ branch }: { branch: Branch }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next && report === null && branch.has_report) {
      setLoading(true);
      getReport(branch.branch)
        .then((r) => setReport(r.report ?? ''))
        .catch(() => setReport(''))
        .finally(() => setLoading(false));
    }
  }, [open, report, branch.branch, branch.has_report]);

  const who = branch.session?.title ?? branch.night_run?.note ?? branch.subject;

  return (
    <article className={`${styles.card} ${styles[branch.state]}`}>
      <button className={styles.cardHead} onClick={toggle} aria-expanded={open}>
        <span className={styles.chevron} aria-hidden>{open ? '▾' : '▸'}</span>
        <span className={styles.who}>{who}</span>
        <span className={`${styles.badge} ${styles[`badge_${branch.state}`]}`}>
          {STATE_LABEL[branch.state]}
        </span>
      </button>

      <div className={styles.meta}>
        <code className={styles.branchName}>{branch.branch}</code>
        <span className={styles.age}>{ageLabel(branch.age_days)}</span>
      </div>

      {/* The git half. Everything here is measured, not claimed. */}
      {branch.commits > 0 && (
        <div className={styles.facts}>
          <span>{branch.commits} commit{branch.commits === 1 ? '' : 's'}</span>
          <span>{branch.files.length} file{branch.files.length === 1 ? '' : 's'}</span>
          {branch.diff_stat && <span className={styles.diffStat}>{branch.diff_stat}</span>}
        </div>
      )}

      {/* Work sitting in the copy that a merge would NOT pick up. The one
          thing on this page you can't find out any other way. */}
      {branch.uncommitted.length > 0 && (
        <p className={styles.stranded}>
          {branch.uncommitted.length} file{branch.uncommitted.length === 1 ? '' : 's'} changed
          in the copy but never committed — merging would not take {branch.uncommitted.length === 1 ? 'it' : 'them'}.
        </p>
      )}

      {branch.night_run?.reason && (
        <p className={styles.reason}>{branch.night_run.reason}</p>
      )}

      {open && (
        <div className={styles.body}>
          {branch.files.length > 0 && (
            <>
              <h4 className={styles.subhead}>Files it changed</h4>
              <ul className={styles.fileList}>
                {branch.files.map((f) => <li key={f}><code>{f}</code></li>)}
              </ul>
            </>
          )}

          <h4 className={styles.subhead}>
            What it says it did
            {/* Named as a claim, every time it appears. */}
            <span className={styles.claimNote}>the session's own account — not verified</span>
          </h4>
          {loading && <p className={styles.muted}>reading…</p>}
          {!loading && branch.has_report && report
            ? <pre className={styles.report}>{report}</pre>
            : !loading && <p className={styles.muted}>This session didn't write one.</p>}

          {branch.worktree && (
            <p className={styles.muted}>
              Still has its copy of the app at <code>{branch.worktree}</code>
            </p>
          )}
        </div>
      )}
    </article>
  );
}

export function BranchesPage() {
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    getBranches(ac.signal)
      .then((r) => setBranches(r.branches))
      .catch((e) => setError(String(e)));
    return () => ac.abort();
  }, []);

  if (error) return <div className={styles.page}><p className={styles.muted}>{error}</p></div>;
  if (!branches) return <div className={styles.page}><p className={styles.muted}>reading the repo…</p></div>;

  const waiting = branches.filter((b) => b.state === 'waiting');
  // Still-building sessions sit between the two: nothing to decide yet, but
  // they're live, so burying them with the finished ones would be wrong.
  const working = branches.filter((b) => b.state === 'working');
  const rest = branches.filter((b) => b.state !== 'waiting' && b.state !== 'working');

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Built for you</h1>
      </header>

      <p className={styles.intro}>
        Sessions that build for you work in their own copy of the app and leave the
        result on a branch. Nothing merges by itself — so anything below that says
        <strong> waiting for you</strong> is finished work you haven't taken.
      </p>

      {waiting.length === 0 ? (
        <p className={styles.empty}>Nothing is waiting. Everything built has been dealt with.</p>
      ) : (
        <>
          <h2 className={styles.sectionHead}>
            {waiting.length} waiting for you
          </h2>
          {waiting.map((b) => <BranchCard key={b.branch} branch={b} />)}
        </>
      )}

      {working.length > 0 && (
        <>
          <h2 className={styles.sectionHead}>
            {working.length} still being built
          </h2>
          {working.map((b) => <BranchCard key={b.branch} branch={b} />)}
        </>
      )}

      {rest.length > 0 && (
        <>
          <h2 className={`${styles.sectionHead} ${styles.quiet}`}>
            {rest.length} done — nothing needed
          </h2>
          {rest.map((b) => <BranchCard key={b.branch} branch={b} />)}
        </>
      )}
    </div>
  );
}
