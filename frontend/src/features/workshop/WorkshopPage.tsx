import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useFlow } from '../flow/api';
import { useTerrain, useTerrainFile } from '../terrain/api';
import { relativeAge } from '../terrain/terrainGraph';
import {
  agentWorkingSet,
  findSnippetRange,
  portholeWindow,
  type WorkingFile,
} from './workshopMath';
import styles from './WorkshopPage.module.css';

/**
 * WorkshopPage — the agent's desk, one of the terrain's rooms
 * (/terrain/workshop?agent=…, routes/terrain_.workshop.tsx).
 *
 * Pick an agent and every file it has been WRITING opens at once: the most
 * recently touched as the HERO on the left — whole, scrollable, introduced by
 * its own plain-English top block — and the rest of the working set as
 * PORTHOLES down the right, each a ~20-line window centred on that file's
 * newest edit. When an edit lands (the flow feed, ~5s): that file's panel
 * flashes in the terminal-red heat language and rises; the hero scrolls
 * itself to the edited lines and they glow. The room exists so she can read
 * code AS IT'S BEING WRITTEN and learn which parts of the codebase carry
 * which behavior.
 *
 * FOLLOW vs READ, the one behavior that makes or breaks it: following is on
 * by default (the hero swaps to whatever was just written), and any scroll or
 * click of hers PAUSES it — reading beats following, always. A quiet pill
 * shows the state; one tap resumes. Clicking a porthole promotes that file to
 * hero and pauses, because clicking is her saying "I'm reading this one now".
 *
 * All standing parts, composed: terrain payload (who wrote what, whole
 * history), flow feed (the live edge, with the written text — how the hero
 * knows where to scroll), terrain file endpoint (content + the file's own
 * summary). Ordering/locating logic is pure in workshopMath.ts, tested.
 *
 * Prompt that produced it: "a UI where i can open all the code in panels that
 * something has been writing on … highlight the panels that were last
 * touched … the last edited code will be on the left … i want to be able to
 * start reading the code as it's being created/modified and start
 * understanding what parts of the code actually affect this UI".
 */

const PORTHOLE_CAP = 6;

const fileKey = (f: { repo: string; path: string }): string => `${f.repo}:${f.path}`;

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/** "2h" → "2h ago", "now" → "just now" — the map's own phrasing. */
function agoPhrase(unixSeconds: number | null): string | null {
  if (unixSeconds === null) return null;
  const age = relativeAge(unixSeconds);
  return age === 'now' ? 'just now' : `${age} ago`;
}

/** The hero: the whole file, its own plain-English introduction above the
 * code, and the newest edit's lines glowing — scrolled to when they land. */
function HeroPanel({
  file,
  flashing,
  onReading,
}: {
  file: WorkingFile;
  flashing: boolean;
  /** She scrolled or clicked in the code — reading beats following. */
  onReading: () => void;
}) {
  const { data, isLoading } = useTerrainFile(file.repo, file.path);
  const content = data?.content ?? null;

  const lines = useMemo(() => (content !== null ? content.split('\n') : []), [content]);
  const range = useMemo(
    () => (content !== null && file.event?.snippet ? findSnippetRange(content, file.event.snippet) : null),
    [content, file.event],
  );

  // Carry her to the edit when a new one lands (or when the file first
  // opens with one). Keyed on the event id, so a poll that brings nothing
  // new never re-scrolls a page she's reading.
  const hotRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (range !== null) hotRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [file.event?.id, range]);

  return (
    <section
      className={[styles.hero, flashing ? styles.flashing : ''].filter(Boolean).join(' ')}
      aria-label={`${file.path} — reading`}
    >
      <header className={styles.heroHead}>
        <span className={styles.heroFile}>{file.path.split('/').pop()}</span>
        <span className={styles.heroPath}>
          {file.repo}/{file.path}
        </span>
        <span className={styles.heroAge}>{agoPhrase(file.last) ?? ''}</span>
      </header>
      {data?.summary ? (
        // The file introducing itself — the plain-English layer, surfaced
        // exactly where she's learning what this code carries.
        <div className={styles.summary}>
          {data.summary.split('\n\n').map((para, i) => (
            <p key={i} className={styles.summaryPara}>
              {para}
            </p>
          ))}
        </div>
      ) : null}
      <div
        className={styles.heroCode}
        onWheel={onReading}
        onPointerDown={onReading}
      >
        {isLoading ? <div className={styles.note}>Reading the file…</div> : null}
        {data?.binary ? <div className={styles.note}>Binary file — nothing to read.</div> : null}
        {lines.map((line, i) => {
          const hot = range !== null && i >= range.start && i <= range.end;
          return (
            <div
              key={i}
              ref={hot && i === range.start ? hotRef : undefined}
              className={[styles.line, hot ? styles.lineHot : ''].filter(Boolean).join(' ')}
            >
              <span className={styles.lineNo}>{i + 1}</span>
              <span className={styles.lineText}>{line === '' ? ' ' : line}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** A porthole: ~20 lines of one working file, centred on its newest edit —
 * glanceable. Tap to promote it to hero (which also pauses following). */
function PortholePanel({
  file,
  flashing,
  onPromote,
}: {
  file: WorkingFile;
  flashing: boolean;
  onPromote: () => void;
}) {
  const { data } = useTerrainFile(file.repo, file.path);
  const content = data?.content ?? null;
  const lines = useMemo(() => (content !== null ? content.split('\n') : []), [content]);
  const range = useMemo(
    () => (content !== null && file.event?.snippet ? findSnippetRange(content, file.event.snippet) : null),
    [content, file.event],
  );
  const window_ = portholeWindow(lines.length, range);

  return (
    <button
      type="button"
      className={[styles.porthole, flashing ? styles.flashing : ''].filter(Boolean).join(' ')}
      onClick={onPromote}
      title="Read this one — it becomes the big panel"
    >
      <span className={styles.portholeHead}>
        <span className={styles.portholeFile}>{file.path.split('/').pop()}</span>
        {file.creates > 0 ? <span className={styles.newChip}>new</span> : null}
        <span className={styles.portholeAge}>{agoPhrase(file.last) ?? ''}</span>
      </span>
      <span className={styles.portholeCode}>
        {lines.slice(window_.start, window_.end + 1).map((line, i) => {
          const n = window_.start + i;
          const hot = range !== null && n >= range.start && n <= range.end;
          return (
            <span key={n} className={[styles.line, hot ? styles.lineHot : ''].filter(Boolean).join(' ')}>
              <span className={styles.lineNo}>{n + 1}</span>
              <span className={styles.lineText}>{line === '' ? ' ' : line}</span>
            </span>
          );
        })}
      </span>
    </button>
  );
}

export function WorkshopPage({ agent }: { agent?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const visible = usePageVisible();

  // Same live gate as the map: poll fast while anything runs and she's looking.
  const [anyRunning, setAnyRunning] = useState(false);
  const { data } = useTerrain(anyRunning && visible, 350);
  useEffect(() => {
    if (data) setAnyRunning((data.sessions ?? []).some((s) => s.running));
  }, [data]);
  const flowData = useFlow(visible).data;

  const agentEvents = useMemo(
    () => (agent ? (flowData?.events ?? []).filter((e) => e.conv === agent) : []),
    [flowData, agent],
  );
  const workingSet = useMemo(
    () => (agent ? agentWorkingSet(data, agent, agentEvents) : []),
    [data, agent, agentEvents],
  );

  // The desk chips: running agents first, then by recency.
  const agents = useMemo(() => {
    const sessions = [...(data?.sessions ?? [])].filter((s) => s.open !== false);
    sessions.sort((a, b) =>
      a.running !== b.running ? (a.running ? -1 : 1) : (b.last ?? '').localeCompare(a.last ?? ''),
    );
    return sessions.slice(0, 12);
  }, [data]);

  // Follow vs read. Following on = the hero is always the newest-touched
  // file; her scroll/click pauses it; a porthole click promotes AND pauses.
  const [follow, setFollow] = useState(true);
  const [heroKey, setHeroKey] = useState<string | null>(null);
  useEffect(() => {
    if (follow && workingSet.length > 0) setHeroKey(fileKey(workingSet[0]));
  }, [follow, workingSet]);
  const hero = workingSet.find((f) => fileKey(f) === heroKey) ?? workingSet[0] ?? null;

  // A new event on a file: flash its panel and refetch its content, so the
  // code on screen is the code that includes the edit being flashed.
  const seenEvents = useRef(new Map<string, string>());
  const [flashKeys, setFlashKeys] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const fresh: string[] = [];
    for (const f of workingSet) {
      if (!f.event) continue;
      const key = fileKey(f);
      if (seenEvents.current.get(key) === f.event.id) continue;
      const isFirstSight = !seenEvents.current.has(key);
      seenEvents.current.set(key, f.event.id);
      if (isFirstSight) continue; // opening the room isn't news
      fresh.push(key);
      void queryClient.invalidateQueries({ queryKey: ['terrain-file', f.repo, f.path] });
    }
    if (fresh.length === 0) return;
    setFlashKeys((cur) => new Set([...cur, ...fresh]));
    const timer = window.setTimeout(() => {
      setFlashKeys((cur) => {
        const next = new Set(cur);
        for (const k of fresh) next.delete(k);
        return next;
      });
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [workingSet, queryClient]);

  const [showAll, setShowAll] = useState(false);
  const portholes = workingSet.filter((f) => hero === null || fileKey(f) !== fileKey(hero));
  const shown = showAll ? portholes : portholes.slice(0, PORTHOLE_CAP);
  const hidden = portholes.length - shown.length;

  const pickAgent = (id: string) =>
    void navigate({ to: '/terrain/workshop', search: { agent: id } });

  return (
    <section className={styles.view} aria-label="The workshop — code being written">
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.title}>Workshop</h2>
          <p className={styles.sub}>An agent&rsquo;s desk — every file it&rsquo;s writing, open at once.</p>
        </div>
        <Link to="/terrain/files" className={styles.back} aria-label="Back to the terrain map">
          ← Terrain
        </Link>
      </header>

      <div className={styles.chips} role="group" aria-label="Whose desk">
        {agents.map((s) => (
          <button
            key={s.id}
            type="button"
            className={[styles.chip, s.id === agent ? styles.chipOn : ''].filter(Boolean).join(' ')}
            aria-pressed={s.id === agent}
            onClick={() => pickAgent(s.id)}
          >
            {s.running ? <span className={styles.chipDot} aria-label="working now" /> : null}
            {s.title}
          </button>
        ))}
      </div>

      {!agent ? <p className={styles.note}>Pick an agent to stand at its desk.</p> : null}
      {agent && data && workingSet.length === 0 ? (
        <p className={styles.note}>A clean desk — this agent hasn&rsquo;t written any files yet.</p>
      ) : null}

      {hero ? (
        <div className={styles.body}>
          <div className={styles.heroCol}>
            {/* The follow state, worn quietly. Reading beats following; this
                is how she gets following back. */}
            <button
              type="button"
              className={[styles.followPill, follow ? styles.followOn : ''].filter(Boolean).join(' ')}
              aria-pressed={follow}
              onClick={() => setFollow((f) => !f)}
            >
              {follow ? 'following the pen' : 'paused — tap to follow'}
            </button>
            <HeroPanel
              file={hero}
              flashing={flashKeys.has(fileKey(hero))}
              onReading={() => setFollow(false)}
            />
          </div>
          <div className={styles.sideCol}>
            {shown.map((f) => (
              <PortholePanel
                key={fileKey(f)}
                file={f}
                flashing={flashKeys.has(fileKey(f))}
                onPromote={() => {
                  setHeroKey(fileKey(f));
                  setFollow(false);
                }}
              />
            ))}
            {hidden > 0 ? (
              <button type="button" className={styles.moreBtn} onClick={() => setShowAll(true)}>
                +{hidden} more {hidden === 1 ? 'file' : 'files'}
              </button>
            ) : null}
            {showAll && portholes.length > PORTHOLE_CAP ? (
              <button type="button" className={styles.moreBtn} onClick={() => setShowAll(false)}>
                fewer
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
