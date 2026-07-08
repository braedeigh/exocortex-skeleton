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
 * Legacy `/tab/<name>` pages (templates/index.html) render their own internal
 * tab selector + public header — redundant now that TopTabs is the shell's
 * nav. Appending `embed=spa` lets index.html's inline script hide that chrome
 * (see the `.spa-embed` rule in static/css/style.css) while leaving direct
 * visits and `/classic` untouched. Preserves any existing query params (e.g.
 * `?item=`).
 */
function withEmbedSpa(src: string): string {
  if (!src.startsWith('/tab/')) return src;
  const [path, query] = src.split('?');
  const params = new URLSearchParams(query);
  params.set('embed', 'spa');
  return `${path}?${params.toString()}`;
}

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
          src={withEmbedSpa(entry.src)}
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
