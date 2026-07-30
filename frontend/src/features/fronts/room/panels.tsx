/**
 * panels.tsx — the furniture a room can hold. Each panel is a small read-only
 * view of ONE front's slice of a surface: to-dos on this front, buy-list items
 * on this front, and so on. They deliberately aren't the full feature pages —
 * a whole TodosPage inside a 300px window would be a page in a box, with its
 * own header, filters and add-bar fighting for room. These are the content
 * only; the full page is a click away.
 *
 * Every panel reads through the feature's existing React Query hook, so a room
 * with three panels open costs the same polling as the tab it came from —
 * shared query keys de-duplicate the fetch.
 *
 * Panels that filter by front do it with the SAME predicate the to-do page's
 * chips use (todoHelpers.focusMatch), so a room can never disagree with the
 * tab about what's on a front.
 */
import { Link } from '@tanstack/react-router';
import { useTodayData } from '../../todos/useTodayData';
import { focusMatch, isDoneSection, isOverdue, itemFronts } from '../../todos/todoHelpers';
import { isFrosted, type TodoItem, type TodoSection } from '../../todos/types';
import { useInventoryData } from '../../inventory/useInventoryData';
import { asList } from '../../inventory/inventoryHelpers';
import type { ActiveItem, BuyItem } from '../../inventory/types';
import styles from './panels.module.css';

function Empty({ children }: { children: string }) {
  return <p className={styles.empty}>{children}</p>;
}

/** Ladder rungs in the order the to-do page shows them. */
const RUNGS = ['Now', 'Up Next', 'Later', 'Someday'];

function rungRank(name: string): number {
  const i = RUNGS.findIndex((r) => r.toLowerCase() === name.toLowerCase());
  return i === -1 ? RUNGS.length : i;
}

/**
 * To-dos on this front, grouped by ladder rung. This is the panel meant for
 * the pinned corner: the ladder is the only priority signal the data actually
 * carries (due dates are set on well under a tenth of items), so the rung
 * headings are the honest ordering rather than an invented one.
 */
export function TodosPanel({ frontId, serverDate }: { frontId: string; serverDate: string }) {
  const { data, isLoading } = useTodayData();
  if (isLoading) return <Empty>Loading…</Empty>;

  const stream = data?.todos;
  if (!stream || isFrosted(stream)) return <Empty>Nothing to show.</Empty>;

  const groups = (stream as TodoSection[])
    .filter((s) => !isDoneSection(s.name))
    .map((s) => ({
      name: s.name,
      items: s.items.filter((it) => !it.done && focusMatch(it, frontId)),
    }))
    .filter((g) => g.items.length > 0)
    .sort((a, b) => rungRank(a.name) - rungRank(b.name));

  if (groups.length === 0) return <Empty>Nothing on this front.</Empty>;

  return (
    <div className={styles.groups}>
      {groups.map((group) => (
        <div key={group.name}>
          <h3 className={styles.rung}>
            {group.name}
            <span className={styles.rungCount}>{group.items.length}</span>
          </h3>
          <ul className={styles.list}>
            {group.items.map((item: TodoItem) => (
              <li key={item.id} className={styles.row}>
                <span className={styles.rowText}>{item.text}</span>
                {isOverdue(item.due_by, serverDate) && <span className={styles.due}>overdue</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * Buy-list items on this front. For a front like living space mid-move these
 * are the same project as the to-dos — "get a shelf for dishes" is a to-do and
 * "buy a blender" is a buy-list item and they are one errand — which is the
 * whole reason a room shows them side by side instead of two tabs apart.
 */
export function BuyListPanel({ frontId }: { frontId: string }) {
  const { data, isLoading } = useInventoryData();
  if (isLoading) return <Empty>Loading…</Empty>;

  const items = asList<BuyItem>(data?.buy_list).filter((item) =>
    (item.fronts || []).includes(frontId),
  );
  if (items.length === 0) return <Empty>Nothing to buy on this front.</Empty>;

  // High priority first; everything else keeps the list's own order.
  const ordered = [...items].sort(
    (a, b) => Number(b.priority === 'high') - Number(a.priority === 'high'),
  );

  return (
    <ul className={styles.list}>
      {ordered.map((item, i) => (
        <li key={`${item.name}-${i}`} className={styles.row}>
          <span className={styles.rowText}>{item.name}</span>
          {item.priority === 'high' && <span className={styles.due}>high</span>}
          {item.cost && <span className={styles.meta}>{item.cost}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Active consumables. No front tags on these, so the panel shows the whole
 * loop — it's here because "what am I already running" is context for "what
 * should I buy", not because it filters.
 */
export function InventoryPanel() {
  const { data, isLoading } = useInventoryData();
  if (isLoading) return <Empty>Loading…</Empty>;

  const items = asList<ActiveItem>(data?.active_inventory).filter(
    (item) => item.status !== 'finished',
  );
  if (items.length === 0) return <Empty>Nothing in use.</Empty>;

  return (
    <ul className={styles.list}>
      {items.map((item, i) => (
        <li key={`${item.name}-${i}`} className={styles.row}>
          <span className={styles.rowText}>{item.name}</span>
          {item.status === 'running_low' && <span className={styles.due}>low</span>}
        </li>
      ))}
    </ul>
  );
}

/** The full-tab escape hatch every panel offers in its footer. */
export function PanelLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className={styles.link}>
      {label} →
    </Link>
  );
}

/** Count of live to-dos on a front — the badge in the panel header. */
export function useTodoCount(frontId: string): number | null {
  const { data } = useTodayData();
  const stream = data?.todos;
  if (!stream || isFrosted(stream)) return null;
  return (stream as TodoSection[])
    .filter((s) => !isDoneSection(s.name))
    .reduce((n, s) => n + s.items.filter((it) => !it.done && focusMatch(it, frontId)).length, 0);
}

/** Count of buy-list items on a front. */
export function useBuyCount(frontId: string): number | null {
  const { data } = useInventoryData();
  if (!data) return null;
  return asList<BuyItem>(data.buy_list).filter((item) => (item.fronts || []).includes(frontId))
    .length;
}

export { itemFronts };
