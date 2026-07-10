/**
 * ContactApprovalEditor — approval editor for kind "contact" (port of
 * static/js/approvals/contacts.js). Mirrors the native contact log: name,
 * method, date, plus the cricket's display-only "From journal" reason,
 * committing through the native POST /api/contacts/log. Undo removes the
 * history entry via POST /api/contacts/history/remove.
 */
import { useRef, useState } from 'react';
import { Button } from '../../ui';
import { logContact, removeContactHistory } from './api';
import {
  CONTACT_METHODS,
  buildContactLog,
  contactDraftFromPayload,
} from './contactApproval';
import type { ContactDraft } from './contactApproval';
import { asString, payloadRecord, todayISO } from './shared';
import type { ApprovalEditorProps } from './types';
import styles from './ApprovalEditors.module.css';

export function ContactApprovalEditor({ change, busy, onApprove, onDeny }: ApprovalEditorProps) {
  const payload = payloadRecord(change);
  const [draft, setDraft] = useState<ContactDraft>(() =>
    contactDraftFromPayload(payload, todayISO()),
  );
  const [error, setError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const reason = asString(payload.reason);

  function submit() {
    const built = buildContactLog(draft);
    if (!built.ok) {
      setError(built.error);
      nameRef.current?.focus();
      return;
    }
    const { name, method, date } = built.value;
    onApprove({
      final: { name, method, date },
      toastMessage: `Logged contact with ${name}`,
      commit: async () => {
        await logContact(name, method, date);
        return {
          run: async () => {
            await removeContactHistory(name, date, method);
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
        <label className={styles.label} htmlFor="ap-contact-name">
          Name
        </label>
        <input
          id="ap-contact-name"
          ref={nameRef}
          className={styles.input}
          type="text"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ap-contact-method">
            Method
          </label>
          <select
            id="ap-contact-method"
            className={styles.select}
            value={draft.method}
            onChange={(e) => setDraft((d) => ({ ...d, method: e.target.value }))}
          >
            {CONTACT_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ap-contact-date">
            Date
          </label>
          <input
            id="ap-contact-date"
            className={styles.input}
            type="date"
            value={draft.date}
            onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
          />
        </div>
      </div>

      {reason ? (
        <div className={styles.field}>
          <span className={styles.label}>From journal</span>
          <div className={styles.reason}>{reason}</div>
        </div>
      ) : null}

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
