/**
 * LifePatchApprovalEditor — approval editor for kind "life_patch": an agent
 * proposes changing a few scheduling/placement fields on an existing to-do
 * (bucket, due_by, due_time, snoozed_until, after_date, duration_min —
 * never the text or the owner's notes; todo_provenance.PATCH_FIELDS). Shows
 * the target to-do, one input per proposed field (editable — what she
 * approves is what lands), and the agent's `why` with its citations, which
 * commits as an agent note on the item. Commits server-side through
 * POST /api/pending/approve (routes/pending.py::_commit_life_patch).
 */
import { useState } from 'react';
import { Button } from '../../ui';
import { AgentNotes } from '../todos/AgentNotes';
import { approvePendingServerSide } from './api';
import { BUCKETS } from './todoApproval';
import { asString, payloadRecord } from './shared';
import type { ApprovalEditorProps } from './types';
import type { JsonValue } from './types';
import styles from './ApprovalEditors.module.css';

const LABELS: Record<string, string> = {
  bucket: 'List',
  due_by: 'Due date',
  due_time: 'Due time',
  snoozed_until: 'Snoozed until',
  after_date: 'Do after',
  duration_min: 'Duration (min)',
};

export function LifePatchApprovalEditor({ change, busy, onApprove, onDeny }: ApprovalEditorProps) {
  const payload = payloadRecord(change);
  const staged = (payload.fields && typeof payload.fields === 'object' && !Array.isArray(payload.fields)
    ? (payload.fields as Record<string, JsonValue>)
    : {}) as Record<string, JsonValue>;
  const [fields, setFields] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(staged).map(([k, v]) => [k, v == null ? '' : String(v)])),
  );
  const by = asString(payload.by) || change.by || 'agent';
  const why = asString(payload.why);
  const refs = Array.isArray(payload.refs) ? payload.refs.filter((r): r is string => typeof r === 'string') : [];

  function submit() {
    onApprove({
      final: { id: asString(payload.id), fields },
      toastMessage: `Changed “${asString(payload.item_text) || 'to-do'}”`,
      dequeue: false,
      commit: async () => {
        await approvePendingServerSide(change.id, { fields });
        return null;
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
        <span className={styles.label}>On the to-do</span>
        <p className={styles.summary}>{asString(payload.item_text) || asString(payload.id)}</p>
      </div>
      {Object.keys(fields).map((k) => (
        <div key={k} className={styles.field}>
          <label className={styles.label} htmlFor={`ap-patch-${k}`}>
            {LABELS[k] ?? k}
          </label>
          {k === 'bucket' ? (
            <select
              id={`ap-patch-${k}`}
              className={styles.select}
              value={fields[k]}
              onChange={(e) => setFields((cur) => ({ ...cur, [k]: e.target.value }))}
            >
              {BUCKETS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`ap-patch-${k}`}
              className={styles.input}
              type={k.endsWith('date') || k === 'due_by' || k === 'snoozed_until' ? 'date' : k === 'due_time' ? 'time' : 'text'}
              value={fields[k]}
              onChange={(e) => setFields((cur) => ({ ...cur, [k]: e.target.value }))}
            />
          )}
        </div>
      ))}
      {why ? (
        <div className={styles.field}>
          <span className={styles.label}>Why (kept on the item as an agent note)</span>
          <AgentNotes notes={[{ by, at: change.created || '', text: why, refs }]} />
        </div>
      ) : null}
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
