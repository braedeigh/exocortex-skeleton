/**
 * FoodApprovalEditor — approval editor for kind "food" (port of
 * static/js/approvals/food.js). Mirrors the native food log: a date + a
 * semicolon-separated food_notes textarea, committing through the native
 * POST /api/food/set. Undo re-POSTs the date's previous notes, captured from
 * the /api/data/today snapshot BEFORE the overwrite (the React stand-in for
 * the legacy `window.D.health_data` read).
 */
import { useRef, useState } from 'react';
import { Button } from '../../ui';
import { setFood } from './api';
import { buildFoodSet, foodDraftFromPayload, prevFoodNotes } from './foodApproval';
import type { FoodDraft } from './foodApproval';
import { useTodaySnapshot } from './hooks';
import { payloadRecord } from './shared';
import type { ApprovalEditorProps } from './types';
import styles from './ApprovalEditors.module.css';

export function FoodApprovalEditor({ change, busy, onApprove, onDeny }: ApprovalEditorProps) {
  const snapshot = useTodaySnapshot();
  const [draft, setDraft] = useState<FoodDraft>(() => foodDraftFromPayload(payloadRecord(change)));
  const [error, setError] = useState('');
  const dateRef = useRef<HTMLInputElement>(null);

  function submit() {
    const built = buildFoodSet(draft);
    if (!built.ok) {
      setError(built.error);
      dateRef.current?.focus();
      return;
    }
    const { date, food_notes } = built.value;
    // Capture the previous value now — before /api/food/set overwrites it.
    const prev = prevFoodNotes(snapshot.data?.health_data, date);
    onApprove({
      final: { date, food_notes },
      toastMessage: `Logged food for ${date}`,
      commit: async () => {
        await setFood(date, food_notes);
        return {
          run: async () => {
            await setFood(date, prev);
          },
        };
      },
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor="ap-food-date">
          Date
        </label>
        <input
          id="ap-food-date"
          ref={dateRef}
          className={styles.input}
          type="date"
          value={draft.date}
          onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="ap-food-notes">
          Food eaten <span className={styles.optional}>(separate items with ;)</span>
        </label>
        <textarea
          id="ap-food-notes"
          className={styles.textarea}
          rows={4}
          value={draft.foodNotes}
          onChange={(e) => setDraft((d) => ({ ...d, foodNotes: e.target.value }))}
        />
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}

      <div className={styles.actions}>
        <Button variant="secondary" type="button" disabled={busy} onClick={onDeny}>
          Deny
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          Approve
        </Button>
      </div>
    </form>
  );
}
