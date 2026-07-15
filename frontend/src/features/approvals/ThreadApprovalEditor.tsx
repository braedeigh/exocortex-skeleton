/**
 * ThreadApprovalEditor — one component serving all three thread kinds
 * (threads-architecture.md §4, §8 step 4), branching on `change.kind`.
 *
 * All three commit like GenericApprovalEditor: server-side POST
 * /api/pending/approve (routes/pending.py::_commit shells to the `thread`
 * CLI — the only writer of thread files), `dequeue: false` since that same
 * call commits AND dequeues. No undo — the server is the writer.
 *
 * Evidence renders ABOVE the controls, always: "she rules on the material,
 * not the cricket's opinion of the material" (§4). thread_open is the only
 * kind with editable fields in v1 — thread_link and thread_retire are
 * read-only review, approved or denied as proposed.
 */
import { useState } from 'react';
import { Button } from '../../ui';
import { FRONT_EMOJI, useFronts } from '../fronts/useFronts';
import { useThreads } from '../journal/useJournalData';
import { approvePendingServerSide } from './api';
import { asString, payloadRecord } from './shared';
import {
  cardsFromPayload,
  evidenceFromPayload,
  lastCardLabel,
  linkChangeRows,
  linkRowLabel,
  threadNameForSlug,
  threadOpenDraftFromPayload,
  threadOpenPayloadFromDraft,
  toggleOrdered,
} from './threadApproval';
import type { ThreadEvidenceItem, ThreadOpenDraft } from './threadApproval';
import type { ApprovalCommitPlan, ApprovalEditorProps, JsonValue, PendingChange } from './types';
import styles from './ApprovalEditors.module.css';

interface KindEditorProps {
  change: PendingChange;
  payload: Record<string, JsonValue>;
  busy: boolean;
  onApprove: (plan: ApprovalCommitPlan) => void;
  onDeny: () => void;
}

/** Evidence quotes + rationale, above the controls — shared by all three
 * kinds. Renders nothing when both are empty (thread_retire's evidence is
 * optional). */
function EvidenceBlock({
  evidence,
  rationale,
  proposer,
}: {
  evidence: ThreadEvidenceItem[];
  rationale: string;
  proposer: string;
}) {
  if (!evidence.length && !rationale) return null;
  return (
    <>
      {evidence.length ? (
        <div className={styles.evidence}>
          {evidence.map((e, i) => (
            <div key={`${e.card}-${i}`} className={styles.evidenceItem}>
              <p className={styles.evidenceQuote}>&ldquo;{e.quote}&rdquo;</p>
              <p className={styles.evidenceDate}>
                {e.date}
                {e.card ? ` · ${e.card}` : ''}
              </p>
            </div>
          ))}
        </div>
      ) : null}
      {rationale ? (
        <p className={styles.rationale}>
          {proposer ? `${proposer}: ` : ''}
          {rationale}
        </p>
      ) : null}
    </>
  );
}

export function ThreadApprovalEditor({ change, busy, onApprove, onDeny }: ApprovalEditorProps) {
  const payload = payloadRecord(change);
  const props: KindEditorProps = { change, payload, busy, onApprove, onDeny };

  if (change.kind === 'thread_link') return <ThreadLinkEditor {...props} />;
  if (change.kind === 'thread_retire') return <ThreadRetireEditor {...props} />;
  return <ThreadOpenEditor {...props} />;
}

// ── thread_open ──────────────────────────────────────────────────────────

function ThreadOpenEditor({ change, payload, busy, onApprove, onDeny }: KindEditorProps) {
  const [draft, setDraft] = useState<ThreadOpenDraft>(() => threadOpenDraftFromPayload(payload));
  const [error, setError] = useState('');
  const frontsQuery = useFronts();
  const fronts = frontsQuery.data ?? [];
  const threadsQuery = useThreads();
  const threads = threadsQuery.data?.threads ?? [];

  const evidence = evidenceFromPayload(payload);
  const cards = cardsFromPayload(payload);
  const rationale = asString(payload.rationale);
  const proposer = asString(payload.proposer);

  function set<K extends keyof ThreadOpenDraft>(key: K, value: ThreadOpenDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function submit() {
    if (draft.fronts.length === 0) {
      setError('At least one front is required — nothing is homeless.');
      return;
    }
    setError('');
    const finalPayload = threadOpenPayloadFromDraft(draft, payload);
    onApprove({
      final: finalPayload,
      toastMessage: `New thread “${draft.name.trim() || draft.slug}”`,
      dequeue: false, // /api/pending/approve commits AND dequeues server-side
      commit: () => approvePendingServerSide(change.id, finalPayload).then(() => null),
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <EvidenceBlock evidence={evidence} rationale={rationale} proposer={proposer} />

      <div className={styles.field}>
        <label className={styles.label} htmlFor="ap-thread-name">
          Name
        </label>
        <input
          id="ap-thread-name"
          className={styles.input}
          type="text"
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Slug</span>
        <div className={styles.readonlyValue}>{draft.slug}</div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="ap-thread-aliases">
          Aliases <span className={styles.optional}>(comma-separated)</span>
        </label>
        <input
          id="ap-thread-aliases"
          className={styles.input}
          type="text"
          value={draft.aliasesText}
          onChange={(e) => set('aliasesText', e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Kind</span>
        <div className={styles.chips}>
          {(['standing', 'arc'] as const).map((k) => (
            <button
              type="button"
              key={k}
              className={`${styles.chip} ${draft.kind === k ? styles.active : ''}`}
              onClick={() => set('kind', k)}
            >
              {k === 'standing' ? 'Standing' : 'Arc'}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Fronts</span>
        <div className={styles.chips}>
          {fronts.map((f) => {
            const idx = draft.fronts.indexOf(f.id);
            return (
              <button
                type="button"
                key={f.id}
                className={`${styles.chip} ${idx >= 0 ? styles.active : ''}`}
                onClick={() => set('fronts', toggleOrdered(draft.fronts, f.id))}
              >
                {FRONT_EMOJI[f.id] || '🏷️'} {f.name}
                {idx === 0 ? ' · primary' : ''}
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>
          Parents <span className={styles.optional}>(optional)</span>
        </span>
        <div className={styles.chips}>
          {threads.map((t) => {
            const idx = draft.parents.indexOf(t.id);
            return (
              <button
                type="button"
                key={t.id}
                className={`${styles.chip} ${idx >= 0 ? styles.active : ''}`}
                onClick={() => set('parents', toggleOrdered(draft.parents, t.id))}
              >
                {t.name}
                {idx === 0 ? ' · primary' : ''}
              </button>
            );
          })}
        </div>
      </div>

      {cards.length ? (
        <div className={styles.field}>
          <span className={styles.label}>Starter cards</span>
          <div className={styles.cardsList}>
            {cards.map((c, i) => (
              <div key={i} className={styles.cardItem}>
                <p className={styles.cardHeading}>{c.section}</p>
                <p className={styles.cardText}>{c.text}</p>
              </div>
            ))}
          </div>
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

// ── thread_link ──────────────────────────────────────────────────────────

function ThreadLinkEditor({ change, payload, busy, onApprove, onDeny }: KindEditorProps) {
  const threadsQuery = useThreads();
  const threads = threadsQuery.data?.threads ?? [];
  const slug = asString(payload.slug);
  const name = threadNameForSlug(threads, slug);
  const evidence = evidenceFromPayload(payload);
  const rationale = asString(payload.rationale);
  const rows = linkChangeRows(payload);

  function submit() {
    onApprove({
      final: payload,
      toastMessage: `Rewired thread “${name}”`,
      dequeue: false,
      commit: () => approvePendingServerSide(change.id, payload).then(() => null),
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <EvidenceBlock evidence={evidence} rationale={rationale} proposer="" />

      <div className={styles.field}>
        <span className={styles.label}>Thread</span>
        <div className={styles.readonlyValue}>
          {name} <span className={styles.optional}>({slug})</span>
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Proposed changes</span>
        <div className={styles.chips}>
          {rows.map((row, i) => (
            <span
              key={`${row.op}-${row.what}-${row.id}-${i}`}
              className={`${styles.chip} ${row.op === 'add' ? styles.chipAdd : styles.chipRemove}`}
            >
              {linkRowLabel(row)}
            </span>
          ))}
        </div>
      </div>

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

// ── thread_retire ────────────────────────────────────────────────────────

function ThreadRetireEditor({ change, payload, busy, onApprove, onDeny }: KindEditorProps) {
  const threadsQuery = useThreads();
  const threads = threadsQuery.data?.threads ?? [];
  const slug = asString(payload.slug);
  const name = threadNameForSlug(threads, slug);
  const evidence = evidenceFromPayload(payload);
  const reason = asString(payload.reason);
  const lastCard = lastCardLabel(asString(payload.last_card_date));

  function submit() {
    onApprove({
      final: payload,
      toastMessage: `Retired thread “${name}”`,
      dequeue: false,
      commit: () => approvePendingServerSide(change.id, payload).then(() => null),
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <EvidenceBlock evidence={evidence} rationale="" proposer="" />

      <div className={styles.field}>
        <span className={styles.label}>Thread</span>
        <div className={styles.readonlyValue}>
          {name} <span className={styles.optional}>({slug})</span>
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Reason</span>
        <div className={styles.readonlyValue}>{reason}</div>
      </div>

      {lastCard ? <p className={styles.rationale}>{lastCard}</p> : null}

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
