import { useEffect, useRef } from 'react';
import type { SyntheticEvent } from 'react';
import { groupLabel, matchesQuery } from './tree';
import type { KeeperGroup } from './tree';
import styles from './FileTree.module.css';

export interface FileTreeProps {
  groups: KeeperGroup[];
  /** Live search text — rows that don't match are hidden, groups with no
   * matches disappear entirely (legacy .hidden / .no-match). */
  query: string;
  currentPath: string | null;
  isGroupOpen: (group: string) => boolean;
  onToggleGroup: (group: string, open: boolean) => void;
  onOpenFile: (path: string) => void;
  /** Group to flash + scroll into view after a delete ("bump into folder"). */
  bumpGroup: string | null;
  /** Mobile drawer state (no visual effect on desktop). */
  drawerOpen: boolean;
}

/** Sidebar: collapsible groups with counts, remembered open-state, search
 * filtering, and the post-delete bump flash. Port of keeper.html renderTree. */
export function FileTree({
  groups,
  query,
  currentPath,
  isGroupOpen,
  onToggleGroup,
  onOpenFile,
  bumpGroup,
  drawerOpen,
}: FileTreeProps) {
  const groupRefs = useRef<Record<string, HTMLDetailsElement | null>>({});

  // Post-delete bump: scroll the deleted file's folder into view (the flash
  // itself is the .bump class below, cleared by the parent after 1.2s).
  useEffect(() => {
    if (!bumpGroup) return;
    groupRefs.current[bumpGroup]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [bumpGroup]);

  const filtering = query.trim() !== '';

  return (
    <nav className={`${styles.sidebar} ${drawerOpen ? styles.open : ''}`} aria-label="Memory files">
      {groups.map(({ group, files }) => {
        const visible = filtering ? files.filter((f) => matchesQuery(f, query)) : files;
        if (filtering && visible.length === 0) return null;
        const open = isGroupOpen(group);
        const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
          const next = e.currentTarget.open;
          if (next !== open) onToggleGroup(group, next);
        };
        return (
          <details
            key={group}
            ref={(el) => {
              groupRefs.current[group] = el;
            }}
            className={`${styles.group} ${bumpGroup === group ? styles.bump : ''}`}
            open={open}
            onToggle={onToggle}
          >
            <summary className={styles.summary}>
              <span className={styles.chev} aria-hidden="true">
                &#9654;
              </span>
              {groupLabel(group)}
              <span className={styles.count}>{files.length}</span>
            </summary>
            {visible.map((f) => (
              <button
                key={f.path}
                type="button"
                className={`${styles.fileRow} ${f.path === currentPath ? styles.active : ''}`}
                onClick={() => onOpenFile(f.path)}
              >
                {f.name}
              </button>
            ))}
          </details>
        );
      })}
    </nav>
  );
}
