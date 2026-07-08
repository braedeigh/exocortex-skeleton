import { Link } from '@tanstack/react-router';
import styles from './TabBar.module.css';

interface TabDef {
  label: string;
  icon: string;
  to: string;
}

// Only /todos is a native route so far; the rest ride the /legacy/$tab
// strangler bridge until they're ported off Flask.
const TABS: TabDef[] = [
  { label: 'Today', icon: '☀', to: '/legacy/today' },
  { label: 'Todos', icon: '✓', to: '/todos' },
  { label: 'Kitchen', icon: '🍳', to: '/legacy/kitchen' },
  { label: 'More', icon: '⋯', to: '/legacy/more' },
];

/** Bottom tab bar — touch-first, 44px+ targets, fixed under the active route. */
export function TabBar() {
  return (
    <nav className={styles.bar} aria-label="Primary">
      {TABS.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          className={styles.tab}
          activeProps={{ className: styles.active }}
          activeOptions={{ exact: false }}
        >
          <span className={styles.icon} aria-hidden="true">
            {tab.icon}
          </span>
          <span>{tab.label}</span>
        </Link>
      ))}
    </nav>
  );
}
