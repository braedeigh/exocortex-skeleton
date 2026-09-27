import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { getSpinoffTree, type SpinoffTreeNode } from './api';
import { buildSpinoffTree, treeTitle, type SpinoffBranch } from './spinoffTree';
import { sessionLocation } from './sessionLocation';
import pageStyles from './NightCrewPage.module.css';
import styles from './SpinoffTreePage.module.css';

/**
 * /observatory/tree — the spinoff family tree: which session was spun off from which.
 *
 * Every spinoff remembers its parent (routes/spinoff.py writes `spawned_from`
 * at birth; scripts/backfill_spawned_from.py filled in the older ones). This
 * page reads them all — archived included, since most of the tree is history
 * — and draws each family as an indented outline, parent above, children
 * nested beneath with a guide line. Tapping a row opens that session.
 *
 * Reads GET /api/spinoff/tree; the folding is spinoffTree.ts. A reading
 * surface off the roster, like the Helpers and Night crew pages, and borrows
 * their page chrome.
 *
 * Prompt that produced it: "keeping a table so that i can connect sessions
 * between one another, like label where the /spinoff came from so a tree can
 * be constructed from the IDs" — and "tree view now".
 */
export function SpinoffTreePage() {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<SpinoffTreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getSpinoffTree(controller.signal)
      .then((body) => setNodes(body.nodes))
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Couldn't load.");
      });
    return () => controller.abort();
  }, []);

  const families = useMemo(() => buildSpinoffTree(nodes ?? []), [nodes]);

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.inner}>
        <div className={pageStyles.header}>
          <button
            type="button"
            className={pageStyles.back}
            onClick={() => void navigate({ to: '/observatory' })}
          >
            &larr; Observatory
          </button>
          <h1 className={pageStyles.title}>Spinoff tree</h1>
        </div>

        <p className={styles.intro}>
          Which session was spun off from which. Each family starts at the session it grew
          from; the newest families are on top. Tap any row to open that session.
        </p>

        {error ? <div className={styles.empty}>{error}</div> : null}
        {!error && nodes && families.length === 0 ? (
          <div className={styles.empty}>Nothing has been spun off yet.</div>
        ) : null}

        <ul className={styles.families}>
          {families.map((family) => (
            <li key={family.node.id} className={styles.family}>
              <Branch branch={family} onOpen={(id) => void navigate(sessionLocation(id))} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** One session and, nested under it, everything spun off from it. */
function Branch({ branch, onOpen }: { branch: SpinoffBranch; onOpen: (id: string) => void }) {
  const { node, children } = branch;
  const status = node.running ? 'running' : node.archived ? 'closed' : 'open';
  return (
    <>
      <button
        type="button"
        className={[styles.row, styles[`row_${status}`] ?? ''].filter(Boolean).join(' ')}
        onClick={() => onOpen(node.id)}
      >
        <span className={styles.rowMain}>
          <span className={styles.rowTitle}>{treeTitle(node)}</span>
          <span className={styles.rowLine}>
            {[viaWord(node.via), when(node.started), node.lane, status].filter(Boolean).join(' · ')}
          </span>
        </span>
        {children.length > 0 ? (
          <span className={styles.count}>
            {children.length} spun off
          </span>
        ) : null}
      </button>
      {children.length > 0 ? (
        <ul className={styles.children}>
          {children.map((child) => (
            <li key={child.node.id}>
              <Branch branch={child} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** How a session was born, in words. A session nothing spawned says nothing. */
function viaWord(via: string | null): string {
  switch (via) {
    case 'skill':
      return 'spun off';
    case 'go':
      return 'spun off (Go)';
    case 'fork':
      return 'fork';
    case 'helper':
      return 'helper button';
    case 'steward':
      return 'steward';
    case 'terminal':
      return 'from a terminal';
    case 'app':
      return 'from the app';
    default:
      return '';
  }
}

/** "Aug 22, 3:14 PM" — local, short; the year only when it isn't this one. */
function when(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}
