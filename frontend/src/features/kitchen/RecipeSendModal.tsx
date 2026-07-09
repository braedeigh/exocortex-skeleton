import { useState } from 'react';
import { recipeToGrocery } from './api';
import { Modal } from './Modal';
import {
  allGroupsValid,
  buildSendRows,
  initialPicks,
  recipeMemberLabel,
} from './recipeHelpers';
import type { KitchenData, Recipe } from './types';
import styles from './kitchen.module.css';

export interface RecipeSendModalProps {
  recipe: Recipe;
  data: KitchenData;
  onClose: () => void;
  onSent: (summary: string) => void;
  onError: (message: string) => void;
}

/** Port of the send-to-grocery picker — choice-group member chips (pick N)
 * plus checkboxes for the other ingredients; needed items are pre-checked. */
export function RecipeSendModal({ recipe, data, onClose, onSent, onError }: RecipeSendModalProps) {
  const existing = new Set((data.kitchen_list || []).map((i) => i.name.toLowerCase()));
  const groups = recipe.choice_groups || [];
  const rows = buildSendRows(recipe, existing);

  const [picks, setPicks] = useState<Record<string, Set<string>>>(() => initialPicks(recipe));
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(rows.map((r) => [r.name, r.defaultChecked])),
  );

  function toggleMember(gid: string, member: string, pickN: number) {
    setPicks((cur) => {
      const set = new Set(cur[gid] || []);
      if (set.has(member)) {
        set.delete(member);
      } else {
        if (pickN === 1) set.clear();
        set.add(member);
      }
      return { ...cur, [gid]: set };
    });
  }

  const groupsValid = allGroupsValid(groups, picks);
  const sendDisabled = groups.length > 0 && !groupsValid;

  async function send() {
    const skip = rows.filter((r) => !checked[r.name]).map((r) => r.name);
    const picksOut: Record<string, string[]> = {};
    Object.entries(picks).forEach(([gid, set]) => {
      picksOut[gid] = Array.from(set);
    });
    try {
      const res = await recipeToGrocery(recipe.id, skip, picksOut);
      if (res?.error) {
        onError(res.error);
        return;
      }
      const parts = [`Added ${res.added} item${res.added === 1 ? '' : 's'}`];
      if (res.skipped_already_on_list) parts.push(`${res.skipped_already_on_list} already on list`);
      if (res.skipped_unchecked) parts.push(`${res.skipped_unchecked} unchecked`);
      if (res.skipped_na) parts.push(`${res.skipped_na} N/A`);
      if (res.skipped_unpicked) parts.push(`${res.skipped_unpicked} not picked`);
      onSent(parts.join(' · '));
      onClose();
    } catch (e) {
      onError(`Send failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <Modal
      title="Send to grocery list"
      onClose={onClose}
      size="wide"
      footer={
        <>
          <button type="button" className={styles.mutedBtn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.greenBtn}
            style={{ marginLeft: 'auto', opacity: sendDisabled ? 0.5 : 1, cursor: sendDisabled ? 'not-allowed' : 'pointer' }}
            disabled={sendDisabled}
            onClick={() => void send()}
          >
            Add to list
          </button>
        </>
      }
    >
      <div className={styles.muted12} style={{ marginBottom: 10 }}>
        {groups.length
          ? 'Pick from each group below. Other ingredients are toggleable.'
          : "Uncheck anything you don't need to buy."}
      </div>

      {groups.map((g) => {
        const gid = String(g.id ?? '');
        const selected = picks[gid] || new Set<string>();
        const pickN = Number(g.pick_n) || 1;
        const isValid = selected.size === pickN;
        const counter =
          pickN === 1 ? (selected.size ? '1 selected' : 'pick 1') : `${selected.size} of ${pickN} selected`;
        return (
          <div key={gid} style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{g.name || 'Pick'}</div>
              <div style={{ fontSize: 12, color: isValid ? 'var(--green)' : 'var(--text-muted)', fontWeight: 600 }}>
                {counter}
              </div>
            </div>
            <div className={styles.chipWrap} style={{ marginBottom: 0 }}>
              {(g.members || []).map((m) => {
                const isSel = selected.has(m);
                return (
                  <button
                    key={m}
                    type="button"
                    className={`${styles.chip} ${isSel ? styles.chipActive : ''}`}
                    style={isSel ? { fontWeight: 700, opacity: 1, borderColor: 'var(--accent)' } : undefined}
                    onClick={() => toggleMember(gid, m, pickN)}
                  >
                    {recipeMemberLabel(recipe, m)}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {rows.length ? (
        <div style={groups.length ? { borderTop: '1px dashed var(--border)', paddingTop: 10, marginTop: 6 } : undefined}>
          {groups.length ? <div className={styles.muted12} style={{ marginBottom: 6 }}>Other ingredients</div> : null}
          {rows.map((r) => (
            <label
              key={r.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 0',
                borderBottom: '1px solid var(--border)',
                cursor: 'pointer',
                opacity: r.onList || r.usuallyHave ? 0.6 : 1,
                minHeight: 44,
              }}
            >
              <input
                type="checkbox"
                checked={!!checked[r.name]}
                style={{ margin: 0, cursor: 'pointer', width: 20, height: 20 }}
                onChange={(e) => setChecked((cur) => ({ ...cur, [r.name]: e.target.checked }))}
              />
              <span style={{ flex: 1, fontSize: 13 }}>
                {r.qty ? (
                  <>
                    {r.name} — <span style={{ color: 'var(--text-muted)' }}>{r.qty}</span>
                  </>
                ) : (
                  r.name
                )}
                {r.note ? <span className={styles.muted12}> ({r.note})</span> : null}
                {r.onList ? (
                  <span className={styles.muted12}> — already on list</span>
                ) : r.usuallyHave ? (
                  <span className={styles.muted12}> — usually have</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}
