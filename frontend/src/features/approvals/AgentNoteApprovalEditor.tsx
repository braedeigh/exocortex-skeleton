/**
 * AgentNoteApprovalEditor — approval editor for kind "agent_note": an agent
 * wants to pin a short, cited note to an existing to-do. Shows the target
 * to-do's text, the note exactly as it will appear (AgentNotes, with the
 * citation chips), and lets the owner shorten the wording before approving —
 * the refs are the agent's evidence and stay as staged. Commits server-side
 * through POST /api/pending/approve (routes/pending.py::_commit_agent_note),
 * which re-validates the cap and the citation rule.
 */
import { useState } from 'react';
import { Button } from '../../ui';
import { AgentNotes } from '../todos/AgentNotes';
import { approvePendingServerSide } from './api';
import { payloadRecord, asString } from './shared';
import type { ApprovalEditorProps } from './types';
import styles from './ApprovalEditors.module.css';

export function AgentNoteApprovalEditor({ change, busy, onApprove, onDeny }: ApprovalEditorProps) {
  const payload = payloadRecord(change);
  const by = asString(payload.by) || change.by || 'agent';
  const refs = Array.isArray(payload.refs) ? payload.refs.filter((r): r is string => typeof r === 'string') : [];
  const [text, setText] = useState(asString(payload.text));
  const [error, setError] = useState('');

  function submit() {
    const t = text.trim();
    if (!t) {
      setError('The note is empty');
      return;
    }
    onApprove({
      final: { id: asString(payload.id), by, text: t, refs },
      toastMessage: `Noted on “${asString(payload.item_text) || 'to-do'}”`,
      dequeue: false,
      commit: async () => {
        await approvePendingServerSide(change.id, { text: t });
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
      <div className={styles.field}>
        <span className={styles.label}>As it will appear</span>
        <AgentNotes notes={[{ by, at: change.created || '', text: text.trim() || '…', refs }]} />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="ap-agent-note-text">
          Wording (yours to trim)
        </label>
        <textarea
          id="ap-agent-note-text"
          className={styles.textarea}
          rows={3}
          maxLength={240}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className={styles.hint}>{text.trim().length}/240</div>
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
