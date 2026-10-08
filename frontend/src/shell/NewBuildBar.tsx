/**
 * NewBuildBar.tsx — the strip that says a newer version of the page is ready.
 *
 * It sits across the very top of the window (routes/__root.tsx), above the
 * tabs, and takes its own row so it never covers anything. It appears only
 * when the server holds a newer build than the one this page is running
 * (newBuild.ts decides). Reload loads it. The × puts the strip away until a
 * still newer build arrives.
 *
 * It never reloads by itself: a reload throws away whatever is half typed in
 * a chat box, so that is hers to choose.
 */
import { useState } from 'react';
import { useNewerBuild } from './newBuild';
import styles from './NewBuildBar.module.css';

export function NewBuildBar({ enabled }: { enabled: boolean }) {
  const newer = useNewerBuild(enabled);
  // The build she waved away. A later build has a different name, so the
  // strip returns for it.
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!newer || newer === dismissed) return null;

  return (
    <div className={styles.bar} role="status">
      <span className={styles.text}>A newer version is ready.</span>
      <button type="button" className={styles.reload} onClick={() => window.location.reload()}>
        Reload
      </button>
      <button
        type="button"
        className={styles.dismiss}
        aria-label="Not now"
        title="Not now"
        onClick={() => setDismissed(newer)}
      >
        ×
      </button>
    </div>
  );
}
