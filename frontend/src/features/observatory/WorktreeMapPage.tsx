/**
 * WorktreeMapPage.tsx — /observatory/worktrees: which agents are working in
 * which copy of the code, right now.
 *
 * What this is, in plain English: every checkout on the machine — the main app
 * code, the vault, each agent's own worktree — drawn as a plot, with the
 * sessions that touched it as rings inside. It's Terrain's vocabulary moved to
 * a different question ("where is everyone standing?" instead of "which files
 * are hot?"), so nothing here has to be learned twice:
 *
 *   - an agent is a ring in the app's --accent purple, with a fainter halo;
 *   - a RUNNING agent's ring breathes; one WAITING on her (unread, asking, or
 *     blocked at the gate) sends an orange sonar ping, the roster's own orange;
 *   - EMBER is what it edited, GOLD is what it ran, faint ash is what it only
 *     looked at — the same two fires as the map's file dots, same hexes
 *     (imported from terrainCanvas.ts), shown here as the bar under each ring;
 *   - recency is opacity: rings that did something in the last two minutes
 *     burn full, the last ten minutes a step down, older ones sink back, the
 *     way out-of-print orbs dim on the map.
 *
 * Two agents writing in the same tree inside ten minutes raise an orange flag
 * on that plot: that's the collision separate worktrees exist to prevent.
 *
 * Under the plots, every swarm (sessions that message each other) is drawn
 * as a network — SwarmNetwork.tsx, the same rings joined by green lines.
 *
 * Tap a ring to open it under its plot: the session's own roster card (the
 * same SessionLane card, so tapping it opens the conversation), what it did in
 * THIS tree — the files it edited, its latest calls here — and the other
 * trees it's working in, each a tap away.
 *
 * Touches: worktreeMapApi.ts (the data), worktreeMapMath.ts (recency, size,
 * footprint, collisions — tested), swarmApi.ts + SwarmNetwork.tsx (the
 * swarm networks), api.ts + SessionLane.tsx (the session
 * card), readReceipts.ts + sessionLocation.ts (unread, and where a session
 * opens), ../terrain/terrainCanvas.ts (the heat hexes), NightCrewPage.module.css
 * (page chrome), WorktreeMapPage.module.css, routes/worktree_map.py (server).
 *
 * Prompt that produced it: "i want to be able to see which agents are working
 * in which tree in a visual UI" — "in the observatory … i'll want to click
 * into it and be able to identify agents and click into them to see how
 * they're working … reference the terrain UI for colors and signals and make
 * it analogous."
 */
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type CSSProperties } from 'react';
import { closeConversation, useSessionRoster, type SessionMeta } from './api';
import pageStyles from './NightCrewPage.module.css';
import { isUnread, openedMap, setConversationRead } from './readReceipts';
import { SessionLane } from './SessionLane';
import { sessionLocation } from './sessionLocation';
import styles from './WorktreeMapPage.module.css';
import { ClosedSwarmsToggle, SwarmNetwork, SwarmNetworkKey } from './SwarmNetwork';
import { shownSwarms, useClosedSwarmsShown, useSwarms } from './swarmApi';
import { useWorktreeMap, type Tree, type TreeAgent } from './worktreeMapApi';
import { footprint, orbRadius, orderTrees, recencyOf, treeName, treesOf, writersNow } from './worktreeMapMath';
import { useTerrain } from '../terrain/api';
import { EMBER_HOT, GOLD_HOT } from '../terrain/terrainCanvas';

// The windows she can look back over — a few taps, not a slider.
const WINDOWS: { seconds: number; label: string }[] = [
  { seconds: 600, label: '10 min' },
  { seconds: 3600, label: '1 hour' },
  { seconds: 6 * 3600, label: '6 hours' },
  { seconds: 86400, label: 'Today' },
];

// Terrain's two fires, handed to the stylesheet as variables so the CSS never
// carries its own copy of the hexes.
const HEAT_VARS = { '--wt-ember': EMBER_HOT, '--wt-gold': GOLD_HOT } as CSSProperties;

/** What a ring says about its session — the roster's own state, as motion. */
type Signal = 'running' | 'waiting' | 'still';

function signalOf(session: SessionMeta | undefined, opened: Record<string, string>): Signal {
  if (!session) return 'still';
  // Running beats waiting, as on the map: an agent mid-turn isn't asking yet.
  if (session.running) return 'running';
  if (session.awaiting_input || session.awaiting_approval) return 'waiting';
  if (isUnread(session.last_at, opened[session.id])) return 'waiting';
  return 'still';
}

function ago(stamp: string | null, nowMs: number): string {
  const at = stamp ? Date.parse(stamp) : NaN;
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((nowMs - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function clock(stamp: string): string {
  const at = new Date(stamp);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function WorktreeMapPage() {
  const navigate = useNavigate();
  const [windowSeconds, setWindowSeconds] = useState(3600);
  // Selection is a (tree, session) pair: the same session can stand in two
  // trees, and the detail under each plot is about that tree only.
  const [selected, setSelected] = useState<{ tree: string; conv: string } | null>(null);
  const [, bump] = useState(0);
  const { data, error } = useWorktreeMap(windowSeconds);
  const { data: allSwarms } = useSwarms();
  // Closed swarms (every member finished) only when the shared switch says so.
  const showClosed = useClosedSwarmsShown();
  const swarms = allSwarms ? shownSwarms(allSwarms, showClosed) : undefined;
  const closedCount = (allSwarms ?? []).filter((s) => s.closed).length;
  const { data: roster, refetch: refetchRoster } = useSessionRoster(true);
  const anyRunning = (roster?.sessions ?? []).some((s) => s.running);
  const { data: terrain } = useTerrain(anyRunning, 350);
  const opened = openedMap();
  const nowMs = Date.now();

  const sessionsById = useMemo(
    () => new Map((roster?.sessions ?? []).map((s) => [s.id, s] as const)),
    [roster],
  );
  const trees = useMemo(() => orderTrees(data?.trees ?? []), [data]);
  const occupied = trees.filter((t) => t.agents.length > 0);
  const empty = trees.filter((t) => t.agents.length === 0);

  const open = (convId: string) => void navigate(sessionLocation(convId));
  const toggle = (tree: string, conv: string) =>
    setSelected((cur) => (cur && cur.tree === tree && cur.conv === conv ? null : { tree, conv }));

  return (
    <div className={pageStyles.page} style={HEAT_VARS}>
      <div className={[pageStyles.inner, styles.inner].join(' ')}>
        <div className={pageStyles.header}>
          <button type="button" className={pageStyles.back} onClick={() => void navigate({ to: '/observatory' })}>
            &larr; Observatory
          </button>
          <h1 className={pageStyles.title}>Worktrees</h1>
        </div>
        <p className={styles.blurb}>
          Every copy of the code on this machine, and the sessions working in each — read from what they actually did,
          not what they say. Tap a ring to see how it&rsquo;s working.
        </p>

        {/* The window: how far back "working here" reaches. */}
        <div className={styles.windows} role="radiogroup" aria-label="How far back">
          {WINDOWS.map((w) => (
            <button
              key={w.seconds}
              type="button"
              role="radio"
              aria-checked={windowSeconds === w.seconds}
              className={[styles.windowChip, windowSeconds === w.seconds ? styles.windowChipOn : ''].join(' ')}
              onClick={() => setWindowSeconds(w.seconds)}
            >
              {w.label}
            </button>
          ))}
        </div>

        <Legend />

        {error ? <p className={styles.note}>Couldn&rsquo;t load the worktrees.</p> : null}
        {!data && !error ? <p className={styles.note}>Looking…</p> : null}

        <div className={styles.plots}>
          {occupied.map((tree) => (
            <Plot
              key={tree.path}
              tree={tree}
              nowMs={nowMs}
              sessionsById={sessionsById}
              opened={opened}
              selectedConv={selected?.tree === tree.path ? selected.conv : null}
              onSelect={(conv) => toggle(tree.path, conv)}
            >
              {selected?.tree === tree.path
                ? (() => {
                    const agent = tree.agents.find((a) => a.conv === selected.conv);
                    if (!agent) return null;
                    const session = sessionsById.get(agent.conv);
                    return (
                      <AgentDetail
                        agent={agent}
                        tree={tree}
                        others={treesOf(agent.conv, trees).filter((t) => t.path !== tree.path)}
                        nowMs={nowMs}
                        onJump={(path) => setSelected({ tree: path, conv: agent.conv })}
                        onOpen={open}
                      >
                        {session ? (
                          <SessionLane
                            bare
                            laneKey={`worktree-${agent.conv}`}
                            heading="Session"
                            blurb=""
                            sessions={[session]}
                            terrain={terrain}
                            opened={opened}
                            onOpen={open}
                            onSetRead={(convId, read) => {
                              setConversationRead(convId, read);
                              bump((n) => n + 1);
                            }}
                            onRename={(s) => open(s.id)}
                            onChanged={() => void refetchRoster()}
                            onClose={(convId) => void closeConversation(convId).then(() => refetchRoster())}
                          />
                        ) : null}
                      </AgentDetail>
                    );
                  })()
                : null}
            </Plot>
          ))}
        </div>

        {/* The swarms: sessions that talk to each other, drawn as networks —
            purple rings joined by green lines where they've messaged. Tap a
            ring to open that session, a swarm's name for its own page. */}
        {(swarms && swarms.length > 0) || closedCount > 0 ? (
          <section className={styles.swarms}>
            <h2 className={styles.h2}>Who&rsquo;s talking to whom</h2>
            <SwarmNetworkKey />
            <ClosedSwarmsToggle closedCount={closedCount} />
            {(swarms ?? []).map((swarm) => (
              <div key={swarm.id} className={styles.swarm}>
                <button
                  type="button"
                  className={styles.swarmName}
                  onClick={() =>
                    void navigate({ to: '/observatory/swarm/$swarmId', params: { swarmId: String(swarm.id) } })
                  }
                >
                  {swarm.name} &rarr;
                </button>
                <SwarmNetwork
                  swarm={swarm}
                  onOpen={open}
                  helperWorking={!!(swarm.helper_conv && sessionsById.get(swarm.helper_conv)?.running)}
                />
              </div>
            ))}
          </section>
        ) : null}

        {/* Nobody's here: shown small, as the fallow ground. A copy nobody has
            touched in a while is usually one that can be merged or cleared. */}
        {empty.length > 0 ? (
          <section className={styles.fallow}>
            <h2 className={styles.h2}>Nobody here in this window</h2>
            <ul className={styles.fallowList}>
              {empty.map((tree) => (
                <li key={tree.path} className={styles.fallowRow} title={tree.path}>
                  <span className={styles.fallowName}>{treeName(tree)}</span>
                  <span className={styles.fallowMeta}>
                    <TreeFacts tree={tree} nowMs={nowMs} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** The key to the drawing — the same words Terrain's guide uses. */
function Legend() {
  return (
    <div className={styles.legend}>
      <span className={styles.legendItem}>
        <svg width="22" height="22" aria-hidden="true">
          <circle cx="11" cy="11" r="7" className={styles.orbRing} />
        </svg>
        agent
      </span>
      <span className={styles.legendItem}>
        <svg width="22" height="22" aria-hidden="true" className={styles.running}>
          <circle cx="11" cy="11" r="7" className={styles.orbRing} />
        </svg>
        breathing = running
      </span>
      <span className={styles.legendItem}>
        <span className={styles.legendPing} aria-hidden="true" />
        orange = waiting on you
      </span>
      <span className={styles.legendItem}>
        <span className={[styles.swatch, styles.swatchEmber].join(' ')} aria-hidden="true" />
        edited
      </span>
      <span className={styles.legendItem}>
        <span className={[styles.swatch, styles.swatchGold].join(' ')} aria-hidden="true" />
        ran
      </span>
      <span className={styles.legendItem}>
        <span className={[styles.swatch, styles.swatchAsh].join(' ')} aria-hidden="true" />
        only looked
      </span>
    </div>
  );
}

/** Branch, distance from main, uncommitted files, last commit — git's facts. */
function TreeFacts({ tree, nowMs }: { tree: Tree; nowMs: number }) {
  const bits: string[] = [];
  if (tree.missing) bits.push('folder gone');
  if (tree.branch && !tree.main) bits.push(tree.branch);
  if (tree.main) bits.push(`${tree.repo} · ${tree.branch ?? 'detached'}`);
  if (tree.ahead !== null && tree.behind !== null && !tree.main)
    bits.push(`${tree.ahead} ahead · ${tree.behind} behind ${tree.main_branch ?? 'main'}`);
  if (tree.dirty) bits.push(`${tree.dirty} uncommitted`);
  if (tree.last_commit_at) bits.push(`last commit ${ago(tree.last_commit_at, nowMs)}`);
  return <>{bits.join(' · ')}</>;
}

function Plot({
  tree,
  nowMs,
  sessionsById,
  opened,
  selectedConv,
  onSelect,
  children,
}: {
  tree: Tree;
  nowMs: number;
  sessionsById: Map<string, SessionMeta>;
  opened: Record<string, string>;
  selectedConv: string | null;
  onSelect: (conv: string) => void;
  children: React.ReactNode;
}) {
  const writers = writersNow(tree, nowMs);
  const colliding = writers.length >= 2;
  return (
    <section className={[styles.plot, colliding ? styles.plotColliding : ''].join(' ')}>
      <header className={styles.plotHead} title={tree.path}>
        <span className={styles.plotName}>{treeName(tree)}</span>
        <span className={styles.plotTag}>{tree.main ? 'main checkout' : 'copy'}</span>
        {colliding ? <span className={styles.plotFlag}>{writers.length} writing here now</span> : null}
      </header>
      <div className={styles.plotFacts}>
        <TreeFacts tree={tree} nowMs={nowMs} />
      </div>
      <div className={styles.field}>
        {tree.agents.map((agent) => (
          <Orb
            key={agent.conv}
            agent={agent}
            signal={signalOf(sessionsById.get(agent.conv), opened)}
            nowMs={nowMs}
            selected={selectedConv === agent.conv}
            onClick={() => onSelect(agent.conv)}
          />
        ))}
      </div>
      {children}
    </section>
  );
}

/** One agent as Terrain draws it: an accent ring and halo, breathing if
 * running, pinging orange if waiting, dimmed by recency — with its footprint
 * (ember / gold / ash) as a bar underneath. */
function Orb({
  agent,
  signal,
  nowMs,
  selected,
  onClick,
}: {
  agent: TreeAgent;
  signal: Signal;
  nowMs: number;
  selected: boolean;
  onClick: () => void;
}) {
  const r = orbRadius(agent);
  const size = (r + 10) * 2;
  const share = footprint(agent);
  const recency = recencyOf(agent.last_at, nowMs);
  return (
    <button
      type="button"
      className={[styles.orb, styles[`recency_${recency}`], selected ? styles.orbSelected : ''].join(' ')}
      onClick={onClick}
      aria-pressed={selected}
      title={`${agent.title} — ${agent.edited} edits, ${agent.ran} commands, ${agent.looked} reads here`}
    >
      <svg width={size} height={size} className={signal === 'running' ? styles.running : undefined} aria-hidden="true">
        {signal === 'waiting' ? <circle cx={size / 2} cy={size / 2} r={r} className={styles.sonar} /> : null}
        <circle cx={size / 2} cy={size / 2} r={r} className={styles.orbRing} />
        <circle cx={size / 2} cy={size / 2} r={r + 4} className={styles.orbHalo} />
      </svg>
      <span className={styles.bar} aria-hidden="true">
        <span className={styles.barEmber} style={{ flexGrow: share.edited }} />
        <span className={styles.barGold} style={{ flexGrow: share.ran }} />
        <span className={styles.barAsh} style={{ flexGrow: share.looked }} />
      </span>
      <span className={styles.orbName}>{agent.title}</span>
      <span className={styles.orbWhen}>{ago(agent.last_at, nowMs)}</span>
    </button>
  );
}

/** How a session is working in this tree: its card, its counts, the files it
 * edited, its latest calls here, and where else it's working. */
function AgentDetail({
  agent,
  tree,
  others,
  nowMs,
  onJump,
  onOpen,
  children,
}: {
  agent: TreeAgent;
  tree: Tree;
  others: Tree[];
  nowMs: number;
  onJump: (path: string) => void;
  onOpen: (conv: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.detail}>
      {/* The roster card when the session is still on the roster; a plain
          open button when it isn't (archived, or a helper). */}
      {children ?? (
        <button type="button" className={styles.openBtn} onClick={() => onOpen(agent.conv)}>
          Open {agent.title} &rarr;
        </button>
      )}

      <p className={styles.detailCounts}>
        In <strong>{treeName(tree)}</strong>
        {agent.home ? ' (where it started)' : ''}: <span className={styles.ember}>{agent.edited} edits</span> ·{' '}
        <span className={styles.gold}>{agent.ran} commands</span> · {agent.looked} reads · last {ago(agent.last_at, nowMs)}
      </p>

      {agent.files.length > 0 ? (
        <>
          <h3 className={styles.h3}>Files it edited here</h3>
          <ul className={styles.files}>
            {agent.files.map((f) => (
              <li key={f.path} className={styles.fileRow}>
                <span className={styles.fileDot} style={{ opacity: Math.min(1, 0.45 + f.edits * 0.12) }} />
                <code className={styles.filePath}>{f.path}</code>
                <span className={styles.fileEdits}>×{f.edits}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3 className={styles.h3}>Latest here</h3>
      <ul className={styles.feed}>
        {agent.recent.map((call, i) => (
          <li key={`${call.at}-${i}`} className={styles.feedRow}>
            <span className={styles.feedTime}>{clock(call.at)}</span>
            <span className={[styles.feedKind, styles[`kind_${call.kind}`]].join(' ')}>{call.tool}</span>
            <code className={styles.feedWhat} title={call.what}>
              {call.what}
            </code>
          </li>
        ))}
      </ul>

      {others.length > 0 ? (
        <>
          <h3 className={styles.h3}>Also working in</h3>
          <div className={styles.others}>
            {others.map((t) => (
              <button key={t.path} type="button" className={styles.otherChip} onClick={() => onJump(t.path)}>
                {treeName(t)}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
