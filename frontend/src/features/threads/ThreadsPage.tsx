import { Fragment, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSessionsContext } from '../../shell/SessionsContext';
import { DESKTOP_QUERY } from '../../shell/useMediaQuery';
import { useThread, useThreads, useThreadsTree } from '../journal/useJournalData';
import { startThreadTalk, talkLabel, type TalkState } from '../journal/threadTalk';
import type { Thread, ThreadSource } from '../journal/types';
import { FRONT_EMOJI, useFronts } from '../fronts/useFronts';
import type { Front } from '../fronts/useFronts';
import { CollapsibleCard } from '../body/CollapsibleCard';
import {
  alsoUnder,
  anyThreadHasFronts,
  buildVisibleTree,
  filterByFront,
  grandchildNotes,
  isPrimaryFront,
  partitionByStatus,
  type GrandchildNote,
} from './threadsTree';
import styles from './ThreadsPage.module.css';

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

/**
 * The dedicated Threads page (/threads) — the journal rail's Threads button
 * lands here. Renders the multi-parent DAG (threads-architecture.md §3):
 * roots at top level, their children indented one level under them (render
 * depth capped at 2 — deeper reached by clicking through), a node with 2+
 * parents appearing under each with an "also under" marker, dormant threads
 * collapsed at the bottom, retired hidden behind a toggle. A front lens (top
 * chips row) switches to a flat list of every thread carrying that front.
 * The expanded body is the same fact-card view the ThreadPopover shows
 * (sections, ≤3-line statements, routable source chips), plus talk /
 * open-file — unchanged except it now also shows fronts + "also under".
 */
export function ThreadsPage() {
  const [lens, setLens] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Until she taps, the first thread starts open; after a tap her choice wins.
  const [touched, setTouched] = useState(false);

  const { data: frontsData } = useFronts();
  const fronts = frontsData ?? [];
  const rosterQuery = useThreads(showRetired);
  const treeQuery = useThreadsTree(showRetired);

  const roster = rosterQuery.data?.threads ?? [];
  const tree = treeQuery.data;

  const cardRefs = useRef<Record<string, HTMLElement | null>>({});
  function registerRef(id: string) {
    return (el: HTMLElement | null) => {
      cardRefs.current[id] = el;
    };
  }

  const firstRootId = tree?.roots[0] ?? null;
  const openId = touched ? expanded : (expanded ?? firstRootId);

  function toggle(id: string) {
    setTouched(true);
    setExpanded((cur) => (cur === id ? null : id));
  }

  /** Grandchild links jump to (and expand) a thread rendered elsewhere on
   * the page — scroll-to per §3 ("deeper reached by clicking through"). */
  function jumpTo(id: string) {
    setTouched(true);
    setExpanded(id);
    requestAnimationFrame(() => {
      cardRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  function toggleLens(id: string) {
    setLens((cur) => (cur === id ? null : id));
  }

  // Tree mode: split the fetched DAG by lifecycle, build the ≤2-deep render
  // tree from what's left. Lens mode doesn't use any of this — it's a flat
  // roster filter instead (the lens invariant, §6).
  const { visibleTree, dormantNodes, retiredNodes } = useMemo(() => {
    if (!tree) return { visibleTree: null, dormantNodes: [] as string[], retiredNodes: [] as string[] };
    const { visible, dormant, retired } = partitionByStatus(tree.nodes);
    return { visibleTree: buildVisibleTree(tree, visible), dormantNodes: dormant, retiredNodes: retired };
  }, [tree]);

  const lensMatches = lens ? filterByFront(roster, lens) : [];
  const lensMain = lensMatches.filter((t) => t.status !== 'dormant' && t.status !== 'retired');
  const lensDormant = lensMatches.filter((t) => t.status === 'dormant');
  const lensRetired = lensMatches.filter((t) => t.status === 'retired');

  const loading = lens ? rosterQuery.isLoading : treeQuery.isLoading;
  const errored = lens ? rosterQuery.isError && !rosterQuery.data : treeQuery.isError && !treeQuery.data;
  const empty = !loading && !errored && (lens ? lensMatches.length === 0 : (tree?.roots.length ?? 0) === 0);

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Threads</h1>

      {anyThreadHasFronts(roster) ? (
        <div className={styles.lensRow}>
          {fronts.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`${styles.lensChip} ${lens === f.id ? styles.lensChipActive : ''}`}
              aria-pressed={lens === f.id}
              onClick={() => toggleLens(f.id)}
            >
              {FRONT_EMOJI[f.id] || '🏷️'} {f.name}
            </button>
          ))}
        </div>
      ) : null}

      {loading ? <div className={styles.empty}>Loading…</div> : null}
      {errored ? <div className={styles.empty}>Couldn’t load threads.</div> : null}
      {empty ? <div className={styles.empty}>No threads yet.</div> : null}

      {!loading && !errored && lens ? (
        <FlatLensList
          main={lensMain}
          dormant={lensDormant}
          retired={lensRetired}
          lens={lens}
          fronts={fronts}
          openId={openId}
          onToggle={toggle}
          registerRef={registerRef}
          showRetired={showRetired}
          onToggleShowRetired={() => setShowRetired((v) => !v)}
        />
      ) : null}

      {!loading && !errored && !lens && tree && visibleTree ? (
        <TreeList
          tree={tree}
          visibleTree={visibleTree}
          dormantSlugs={dormantNodes}
          retiredSlugs={retiredNodes}
          fronts={fronts}
          openId={openId}
          onToggle={toggle}
          onJumpTo={jumpTo}
          registerRef={registerRef}
          showRetired={showRetired}
          onToggleShowRetired={() => setShowRetired((v) => !v)}
        />
      ) : null}
    </div>
  );
}

// --- Tree mode ---------------------------------------------------------

interface TreeListProps {
  tree: NonNullable<ReturnType<typeof useThreadsTree>['data']>;
  visibleTree: NonNullable<ReturnType<typeof buildVisibleTree>>;
  dormantSlugs: string[];
  retiredSlugs: string[];
  fronts: Front[];
  openId: string | null;
  onToggle: (id: string) => void;
  onJumpTo: (id: string) => void;
  registerRef: (id: string) => (el: HTMLElement | null) => void;
  showRetired: boolean;
  onToggleShowRetired: () => void;
}

function TreeList({
  tree,
  visibleTree,
  dormantSlugs,
  retiredSlugs,
  fronts,
  openId,
  onToggle,
  onJumpTo,
  registerRef,
  showRetired,
  onToggleShowRetired,
}: TreeListProps) {
  return (
    <>
      {visibleTree.roots.map((rootSlug) => {
        const rootNode = tree.nodes[rootSlug];
        if (!rootNode) return null;
        const children = visibleTree.childrenByRoot[rootSlug] ?? [];
        return (
          <Fragment key={rootSlug}>
            <ThreadCard
              id={rootSlug}
              name={rootNode.name}
              status={rootNode.status}
              kind={rootNode.kind}
              fronts={rootNode.fronts}
              frontsList={fronts}
              open={openId === rootSlug}
              onToggle={onToggle}
              registerRef={registerRef}
            />
            {children.map((childSlug) => {
              const childNode = tree.nodes[childSlug];
              if (!childNode) return null;
              const grandkids = grandchildNotes(tree, visibleTree, childSlug);
              return (
                <ThreadCard
                  key={childSlug}
                  id={childSlug}
                  name={childNode.name}
                  status={childNode.status}
                  kind={childNode.kind}
                  fronts={childNode.fronts}
                  frontsList={fronts}
                  indent
                  alsoUnderNames={alsoUnder(visibleTree, tree, childSlug, rootSlug)}
                  grandchildren={grandkids}
                  open={openId === childSlug}
                  onToggle={onToggle}
                  onJumpTo={onJumpTo}
                  registerRef={registerRef}
                />
              );
            })}
          </Fragment>
        );
      })}

      {dormantSlugs.length > 0 ? (
        <CollapsibleCard cardKey="threadsDormant" title={`Dormant (${dormantSlugs.length})`}>
          {dormantSlugs
            .slice()
            .sort((a, b) => (tree.nodes[a]?.name ?? a).localeCompare(tree.nodes[b]?.name ?? b))
            .map((slug) => {
              const n = tree.nodes[slug];
              if (!n) return null;
              return (
                <ThreadCard
                  key={slug}
                  id={slug}
                  name={n.name}
                  status={n.status}
                  kind={n.kind}
                  fronts={n.fronts}
                  frontsList={fronts}
                  muted
                  open={openId === slug}
                  onToggle={onToggle}
                  registerRef={registerRef}
                />
              );
            })}
        </CollapsibleCard>
      ) : null}

      <RetiredToggle
        showRetired={showRetired}
        onToggleShowRetired={onToggleShowRetired}
        count={showRetired ? retiredSlugs.length : null}
      />
      {showRetired && retiredSlugs.length > 0 ? (
        <div className={styles.retiredGroup}>
          {retiredSlugs
            .slice()
            .sort((a, b) => (tree.nodes[a]?.name ?? a).localeCompare(tree.nodes[b]?.name ?? b))
            .map((slug) => {
              const n = tree.nodes[slug];
              if (!n) return null;
              return (
                <ThreadCard
                  key={slug}
                  id={slug}
                  name={n.name}
                  status={n.status}
                  kind={n.kind}
                  fronts={n.fronts}
                  frontsList={fronts}
                  muted
                  open={openId === slug}
                  onToggle={onToggle}
                  registerRef={registerRef}
                />
              );
            })}
        </div>
      ) : null}
    </>
  );
}

// --- Front lens mode -----------------------------------------------------

interface FlatLensListProps {
  main: Thread[];
  dormant: Thread[];
  retired: Thread[];
  lens: string;
  fronts: Front[];
  openId: string | null;
  onToggle: (id: string) => void;
  registerRef: (id: string) => (el: HTMLElement | null) => void;
  showRetired: boolean;
  onToggleShowRetired: () => void;
}

function FlatLensList({
  main,
  dormant,
  retired,
  lens,
  fronts,
  openId,
  onToggle,
  registerRef,
  showRetired,
  onToggleShowRetired,
}: FlatLensListProps) {
  return (
    <>
      {main.map((t) => (
        <ThreadCard
          key={t.id}
          id={t.id}
          name={t.name}
          status={t.status}
          kind={t.kind}
          fronts={t.fronts}
          frontsList={fronts}
          owns={isPrimaryFront(t, lens)}
          lensFrontId={lens}
          open={openId === t.id}
          onToggle={onToggle}
          registerRef={registerRef}
        />
      ))}

      {dormant.length > 0 ? (
        <CollapsibleCard cardKey="threadsDormant" title={`Dormant (${dormant.length})`}>
          {dormant.map((t) => (
            <ThreadCard
              key={t.id}
              id={t.id}
              name={t.name}
              status={t.status}
              kind={t.kind}
              fronts={t.fronts}
              frontsList={fronts}
              owns={isPrimaryFront(t, lens)}
              lensFrontId={lens}
              muted
              open={openId === t.id}
              onToggle={onToggle}
              registerRef={registerRef}
            />
          ))}
        </CollapsibleCard>
      ) : null}

      <RetiredToggle
        showRetired={showRetired}
        onToggleShowRetired={onToggleShowRetired}
        count={showRetired ? retired.length : null}
      />
      {showRetired && retired.length > 0 ? (
        <div className={styles.retiredGroup}>
          {retired.map((t) => (
            <ThreadCard
              key={t.id}
              id={t.id}
              name={t.name}
              status={t.status}
              kind={t.kind}
              fronts={t.fronts}
              frontsList={fronts}
              owns={isPrimaryFront(t, lens)}
              lensFrontId={lens}
              muted
              open={openId === t.id}
              onToggle={onToggle}
              registerRef={registerRef}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

function RetiredToggle({
  showRetired,
  onToggleShowRetired,
  count,
}: {
  showRetired: boolean;
  onToggleShowRetired: () => void;
  count: number | null;
}) {
  return (
    <button type="button" className={styles.retiredToggle} onClick={onToggleShowRetired}>
      {showRetired ? `Hide retired${count !== null ? ` (${count})` : ''}` : 'Show retired'}
    </button>
  );
}

// --- One thread card (root / child / dormant / retired / flat lens item) -

interface ThreadCardProps {
  id: string;
  name: string;
  status?: string | null;
  kind?: string | null;
  fronts?: string[];
  frontsList: Front[];
  indent?: boolean;
  muted?: boolean;
  alsoUnderNames?: string[];
  grandchildren?: GrandchildNote[];
  /** Front-lens "owns" (primary front match) vs. "visiting" — solid vs. muted emoji. */
  owns?: boolean;
  lensFrontId?: string;
  open: boolean;
  onToggle: (id: string) => void;
  onJumpTo?: (id: string) => void;
  registerRef: (id: string) => (el: HTMLElement | null) => void;
}

function ThreadCard({
  id,
  name,
  status,
  kind,
  fronts,
  frontsList,
  indent,
  muted,
  alsoUnderNames,
  grandchildren,
  owns,
  lensFrontId,
  open,
  onToggle,
  onJumpTo,
  registerRef,
}: ThreadCardProps) {
  const cardClass = [styles.threadCard, indent ? styles.threadCardIndent : '', muted ? styles.threadCardMuted : '']
    .filter(Boolean)
    .join(' ');

  return (
    <section ref={registerRef(id)} className={cardClass}>
      <button type="button" className={styles.threadHeader} aria-expanded={open} onClick={() => onToggle(id)}>
        <span className={styles.threadHeaderMain}>
          <span className={styles.threadName}>
            {lensFrontId ? (
              <span className={owns ? styles.ownsEmoji : styles.visitingEmoji}>{FRONT_EMOJI[lensFrontId] || '🏷️'}</span>
            ) : (
              '⧉'
            )}{' '}
            {name}
          </span>
          {status === 'dormant' || status === 'retired' ? <span className={styles.badge}>{status}</span> : null}
          {kind ? <span className={styles.badgeOutline}>{kind}</span> : null}
        </span>
        {alsoUnderNames && alsoUnderNames.length > 0 ? (
          <span className={styles.alsoUnder}>also under {alsoUnderNames.join(', ')}</span>
        ) : null}
        <span className={styles.chevron}>{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <ThreadBody
          id={id}
          fronts={fronts}
          frontsList={frontsList}
          alsoUnderNames={alsoUnderNames}
          grandchildren={grandchildren}
          onJumpTo={onJumpTo}
        />
      ) : null}
    </section>
  );
}

// --- Expanded body ---------------------------------------------------------

interface ThreadBodyProps {
  id: string;
  fronts?: string[];
  frontsList: Front[];
  alsoUnderNames?: string[];
  grandchildren?: GrandchildNote[];
  onJumpTo?: (id: string) => void;
}

/** The expanded body of one thread — fetched on first expand via useThread.
 * Unchanged fact-card / Talk / open-file behavior, plus (when present) the
 * thread's fronts, "also under" info, and a link/name list of the children
 * that aren't shown inline (render depth cap, §3). */
function ThreadBody({ id, fronts, frontsList, alsoUnderNames, grandchildren, onJumpTo }: ThreadBodyProps) {
  const { data, isLoading, isError } = useThread(id);
  const navigate = useNavigate();
  const { setActive } = useSessionsContext();
  const [talkState, setTalkState] = useState<TalkState>('idle');

  async function talk() {
    if (talkState === 'sending') return;
    setTalkState('sending');
    try {
      const res = await startThreadTalk(id);
      if (window.matchMedia(DESKTOP_QUERY).matches) {
        setTalkState('sent');
      } else {
        setActive(res.session);
        void navigate({ to: '/chat' });
      }
    } catch {
      setTalkState('error');
    }
  }

  function sourceClick(s: ThreadSource) {
    if (s.kind === 'journal') {
      void navigate({ to: '/journal', search: { date: s.val } });
    }
  }

  const frontChips: ReactNode =
    fronts && fronts.length > 0 ? (
      <div className={styles.frontChips}>
        {fronts.map((fid) => {
          const f = frontsList.find((x) => x.id === fid);
          return (
            <span key={fid} className={styles.frontChip}>
              {FRONT_EMOJI[fid] || '🏷️'} {f?.name || fid}
            </span>
          );
        })}
      </div>
    ) : null;

  const alsoUnderNote =
    alsoUnderNames && alsoUnderNames.length > 0 ? (
      <div className={styles.bodyAlsoUnder}>also under {alsoUnderNames.join(', ')}</div>
    ) : null;

  const grandchildNote =
    grandchildren && grandchildren.length > 0 ? (
      <div className={styles.grandchildNote}>
        contains {grandchildren.length} more ↓
        <div className={styles.grandchildList}>
          {grandchildren.map((g) =>
            g.visible ? (
              <button key={g.slug} type="button" className={styles.grandchildLink} onClick={() => onJumpTo?.(g.slug)}>
                {g.name}
              </button>
            ) : (
              <span key={g.slug} className={styles.grandchildName}>
                {g.name}
              </span>
            ),
          )}
        </div>
      </div>
    ) : null;

  if (isLoading) return <div className={styles.bodyNote}>Loading…</div>;
  if (!data) return <div className={styles.bodyNote}>{isError ? 'Couldn’t load this thread.' : 'No thread found.'}</div>;

  let lastHeading: string | null = null;

  return (
    <div className={styles.body}>
      {frontChips}
      {alsoUnderNote}
      {data.status ? <div className={styles.status}>{data.status}</div> : null}
      {data.cards.length === 0 ? <div className={styles.bodyNote}>No facts recorded yet.</div> : null}

      {data.cards.map((c, i) => {
        const showHeading = !!c.heading && c.heading !== lastHeading;
        lastHeading = c.heading || lastHeading;
        return (
          <Fragment key={i}>
            {showHeading ? <div className={styles.section}>{c.heading}</div> : null}
            <div className={styles.factCard}>
              {c.text ? <div className={styles.factText}>{c.text}</div> : null}
              {c.sources.length > 0 ? (
                <div className={styles.sources}>
                  {c.sources.map((s, j) =>
                    s.kind === 'keeper' ? (
                      <a key={j} className={styles.sourceChip} href={`/files?path=${encodeURIComponent(s.val)}`}>
                        {s.label} &rarr;
                      </a>
                    ) : (
                      <button key={j} type="button" className={styles.sourceChip} onClick={() => sourceClick(s)}>
                        {s.label} &rarr;
                      </button>
                    ),
                  )}
                </div>
              ) : null}
            </div>
          </Fragment>
        );
      })}

      {grandchildNote}

      {!isPublicMode() ? (
        <button type="button" className={styles.talkBtn} onClick={talk} disabled={talkState === 'sending'}>
          {talkLabel(talkState)}
        </button>
      ) : null}

      {data.file ? (
        <a className={styles.openFull} href={`/files?path=${encodeURIComponent(data.file)}`}>
          Open full thread &rarr;
        </a>
      ) : null}
    </div>
  );
}
