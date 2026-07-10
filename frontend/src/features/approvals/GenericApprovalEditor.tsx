/**
 * GenericApprovalEditor — fallback for kinds without a registered editor
 * (port of pending.js's #change-modal). Renders each payload field as an
 * input (bucket → dropdown, numbers → numeric input) and approves through
 * the SERVER-side POST /api/pending/approve, which merges the edits over the
 * staged payload, commits via routes/pending.py::_commit, and dequeues in
 * one atomic step. No undo (legacy parity — the server commit path offers
 * none).
 */
import { useState } from 'react';
import { Button } from '../../ui';
import { approvePendingServerSide } from './api';
import { BUCKETS, collectGenericPayload, genericFieldsFromPayload } from './genericApproval';
import { payloadRecord } from './shared';
import type { ApprovalEditorProps } from './types';
import styles from './ApprovalEditors.module.css';

export function GenericApprovalEditor({ change, busy, onApprove, onDeny }: ApprovalEditorProps) {
  const [fields] = useState(() => genericFieldsFromPayload(payloadRecord(change)));
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.initial])),
  );

  function submit() {
    const payload = collectGenericPayload(fields, values);
    onApprove({
      final: payload,
      toastMessage: 'Change applied',
      dequeue: false, // /api/pending/approve commits AND dequeues server-side
      commit: async () => {
        await approvePendingServerSide(change.id, payload);
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
      {change.summary ? <p className={styles.summary}>{change.summary}</p> : null}

      {fields.map((f) => (
        <div key={f.key} className={styles.field}>
          <label className={styles.label} htmlFor={`ap-generic-${f.key}`}>
            {f.label}
          </label>
          {f.kind === 'bucket' ? (
            <select
              id={`ap-generic-${f.key}`}
              className={styles.select}
              value={values[f.key]}
              onChange={(e) => setValues((cur) => ({ ...cur, [f.key]: e.target.value }))}
            >
              {BUCKETS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`ap-generic-${f.key}`}
              className={styles.input}
              type={f.kind === 'number' ? 'number' : 'text'}
              value={values[f.key]}
              onChange={(e) => setValues((cur) => ({ ...cur, [f.key]: e.target.value }))}
            />
          )}
        </div>
      ))}

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
