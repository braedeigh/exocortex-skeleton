/**
 * "Priority notes" sticky — freeform textarea saved on blur, with the old
 * unsaved / saving… / saved / save failed status flow (inventory.js
 * renderPriorityNotes/savePriorityNotes). The server text never clobbers the
 * textarea while it's focused or dirty (the old renderer skipped re-rendering
 * mid-typing).
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { INVENTORY_QUERY_KEY, savePriorityNotes } from './api';
import type { InventoryData } from './types';
import styles from './inventory.module.css';

export interface PriorityNotesCardProps {
  serverText: string;
}

export function PriorityNotesCard({ serverText }: PriorityNotesCardProps) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(serverText);
  const [status, setStatus] = useState('');
  const dirtyRef = useRef(false);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current && !dirtyRef.current) setText(serverText);
  }, [serverText]);

  async function save(value: string) {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    setStatus('saving…');
    try {
      await savePriorityNotes(value);
      // Update the cache so the next poll doesn't blow away the new text.
      queryClient.setQueryData<InventoryData>(INVENTORY_QUERY_KEY, (d) =>
        d ? { ...d, priority_notes: value } : d,
      );
      setStatus('saved');
      setTimeout(() => setStatus((s) => (s === 'saved' ? '' : s)), 1500);
    } catch {
      setStatus('save failed');
    }
  }

  return (
    <div className={styles.priorityCard}>
      <div className={styles.priorityHead}>
        <div className={styles.priorityLabel}>Priority notes</div>
        <span className={styles.priorityStatus}>{status}</span>
      </div>
      <textarea
        className={styles.priorityInput}
        placeholder="What you want to buy over other things — running thoughts, savings goals, what to skip..."
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          dirtyRef.current = true;
          setStatus('unsaved');
        }}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={(e) => {
          focusedRef.current = false;
          void save(e.target.value);
        }}
      />
    </div>
  );
}
