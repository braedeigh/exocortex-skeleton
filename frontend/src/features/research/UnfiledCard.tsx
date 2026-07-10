/**
 * UnfiledCard.tsx — entries with no topics: nothing captured can hide. The
 * ✨ File button fires the filer cricket (a tmux Claude session that tags
 * them); Edit mode turns every topic into a toggle chip on each row — the
 * manual filing door.
 */

import { useState } from 'react';
import { Card, summaryAction } from './Card';
import { EntryRow } from './EntryRow';
import { unfiledEntries } from './helpers';
import { useResearchCtx } from './ResearchContext';
import styles from './ResearchPage.module.css';

export function UnfiledCard() {
  const { state, actions } = useResearchCtx();
  const [editing, setEditing] = useState(false);
  const entries = unfiledEntries(state.entries);

  return (
    <Card
      cardId="research-unfiled"
      defaultOpen={false}
      title="Unfiled"
      count={entries.length}
      extras={
        <>
          {entries.length ? (
            <button
              type="button"
              className={styles.cardEditBtn}
              title="A cricket reads these and tags them into topics"
              onClick={summaryAction(() => actions.fileUnfiled())}
            >
              &#10024; File
            </button>
          ) : null}
          <button type="button" className={styles.cardEditBtn} onClick={summaryAction(() => setEditing((v) => !v))}>
            {editing ? 'Done' : 'Edit'}
          </button>
        </>
      }
    >
      {entries.length ? (
        entries.map((e) => <EntryRow key={e.id} entry={e} editing={editing} />)
      ) : (
        <div className={styles.emptyNote}>Nothing unfiled.</div>
      )}
    </Card>
  );
}
