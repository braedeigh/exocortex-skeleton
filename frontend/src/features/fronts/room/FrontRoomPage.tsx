/**
 * FrontRoomPage.tsx — one front, as a room. Everything on the front gathered
 * into panels you can drag and resize; where you leave them is remembered per
 * front (/api/fronts/layout/<front>).
 *
 * Which panels a room offers depends on what the front actually carries — a
 * front with no buy-list items doesn't get an empty buy-list window. That's
 * why the panel set is derived from the overview counts rather than being a
 * fixed list: living space is 34 to-dos and 18 purchases (operational), health
 * is to-dos plus threads and research (reflective), and hanging the same six
 * windows on both would leave one of them full of "nothing here".
 *
 * Prompt that produced it: "i want to imagine it from a headspace of, what do
 * I need to do and what is priority and orienting myself within one frame when
 * i'm in a room."
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { FRONT_EMOJI } from '../useFronts';
import { useFrontsOverview } from '../frontsOverview';
import { useTodayData } from '../../todos/useTodayData';
import { RoomCanvas, type RoomPanelDef } from './RoomCanvas';
import { BuyListPanel, InventoryPanel, PanelLink, TodosPanel, useBuyCount, useTodoCount } from './panels';
import { SessionsPanel } from './SessionsPanel';
import { useFrontSessions } from './useFrontSessions';
import { resolveLayout, type RoomLayout } from './roomLayout';
import { useRoomLayoutSaver, useSavedRoomLayout } from './useRoomLayout';
import styles from './FrontRoomPage.module.css';

export function FrontRoomPage({ frontId }: { frontId: string }) {
  const overview = useFrontsOverview();
  const saved = useSavedRoomLayout(frontId);
  const { commit, reset, setBaseline, error } = useRoomLayoutSaver(frontId);
  const today = useTodayData();
  const serverDate = today.data?.server_date || '';

  const todoCount = useTodoCount(frontId);
  const buyCount = useBuyCount(frontId);
  const sessions = useFrontSessions(frontId);
  const sessionCount = sessions.data?.sessions.length;

  const entry = overview.data?.fronts.find((f) => f.id === frontId);
  const sources = entry?.sources;
  const frontName = entry?.name || frontId;

  // The panel set follows the data: a window only exists if the front has
  // something to put in it. To-dos lead — that's the pinned corner slot the
  // default layout gives to the first panel.
  const panels = useMemo<RoomPanelDef[]>(() => {
    const defs: RoomPanelDef[] = [];
    // To-dos lead, so the default arrangement hands them the tall left column —
    // the "pinned in the corner" slot. Everything else stacks to their right.
    if (!sources || sources.todos > 0) {
      defs.push({
        key: 'todos',
        title: 'To do',
        badge: todoCount ?? undefined,
        render: () => (
          <>
            <TodosPanel frontId={frontId} serverDate={serverDate} />
            <PanelLink to="/todos" label="Open the to-do list" />
          </>
        ),
      });
    }
    // Sessions get a window even at zero: unlike the other panels this one is
    // how work STARTS, so an empty state reading "start one and it stays here"
    // is doing a job. Hiding it would make the room read-only.
    defs.push({
      key: 'sessions',
      title: 'Sessions',
      badge: sessionCount || undefined,
      render: () => <SessionsPanel frontId={frontId} frontName={frontName} />,
    });
    if (sources && sources.buy_list > 0) {
      defs.push({
        key: 'buy',
        title: 'To buy',
        badge: buyCount ?? undefined,
        render: () => (
          <>
            <BuyListPanel frontId={frontId} />
            <PanelLink to="/inventory" label="Open the buy list" />
          </>
        ),
      });
      defs.push({
        key: 'inventory',
        title: 'In use',
        render: () => (
          <>
            <InventoryPanel />
            <PanelLink to="/inventory" label="Open inventory" />
          </>
        ),
      });
    }
    return defs;
  }, [sources, frontId, frontName, serverDate, todoCount, buyCount, sessionCount]);

  const panelKeys = useMemo(() => panels.map((p) => p.key), [panels]);

  const [layout, setLayout] = useState<RoomLayout | null>(null);

  // Seed once the saved arrangement has landed. resolveLayout fills in any
  // panel the save predates and drops boxes for panels that no longer exist,
  // so adding furniture later never leaves a hole or a ghost.
  useEffect(() => {
    if (saved.isLoading || panelKeys.length === 0) return;
    const resolved = resolveLayout(panelKeys, saved.data?.panels);
    setLayout(resolved);
    setBaseline(saved.data?.panels && Object.keys(saved.data.panels).length ? resolved : ({} as RoomLayout));
  }, [saved.isLoading, saved.data, panelKeys, setBaseline]);

  if (overview.isLoading || saved.isLoading) {
    return <div className={styles.state}>Opening the room…</div>;
  }
  if (!entry) {
    return (
      <div className={styles.state}>
        No front called “{frontId}”. <Link to="/fronts">Back to fronts</Link>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headLeft}>
          <Link to="/fronts" className={styles.back}>
            ← Fronts
          </Link>
          <h1 className={styles.title}>
            <span aria-hidden="true">{FRONT_EMOJI[entry.id] || '🏷️'}</span> {entry.name}
          </h1>
          <p className={styles.count}>
            {entry.total} thing{entry.total === 1 ? '' : 's'} on this front
          </p>
        </div>
        <button
          type="button"
          className={styles.reset}
          onClick={() => {
            setLayout(resolveLayout(panelKeys, undefined));
            void reset();
          }}
        >
          Reset arrangement
        </button>
      </header>

      {error && <p className={styles.error}>{error}</p>}

      {panels.length === 0 ? (
        <div className={styles.state}>Nothing on this front yet.</div>
      ) : layout ? (
        <RoomCanvas
          panels={panels}
          layout={layout}
          onLayoutChange={setLayout}
          onLayoutCommit={commit}
        />
      ) : null}
    </div>
  );
}
