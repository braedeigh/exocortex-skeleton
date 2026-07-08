import { useSyncExternalStore } from 'react';
import {
  subscribe,
  getEntriesSnapshot,
  getActiveSnapshot,
  registerFrameWindow,
  unregisterFrameWindow,
} from './frameStore';
import styles from './FrameHost.module.css';

/**
 * Renders every iframe "view" ever visited (legacy tabs + journal/research/
 * settings/files), absolutely positioned under the router's <Outlet/>, only
 * one visible at a time. Never unmounted once mounted — see frameStore.ts.
 */
export function FrameHost() {
  const entries = useSyncExternalStore(subscribe, getEntriesSnapshot);
  const active = useSyncExternalStore(subscribe, getActiveSnapshot);

  return (
    <div className={styles.host}>
      {entries.map((entry) => (
        <iframe
          key={entry.key}
          title={entry.title}
          src={entry.src}
          className={styles.frame}
          style={{ display: entry.key === active ? 'block' : 'none' }}
          ref={(el) => {
            if (el?.contentWindow) {
              registerFrameWindow(entry.key, el.contentWindow);
            } else {
              unregisterFrameWindow(entry.key);
            }
          }}
        />
      ))}
    </div>
  );
}
