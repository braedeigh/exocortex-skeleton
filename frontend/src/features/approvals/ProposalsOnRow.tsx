/**
 * ProposalsOnRow — an agent's open proposals, shown on its session's card
 * in the Observatory roster.
 *
 * What it does: reads the shared 3s /api/pending poll, keeps the entries
 * whose `conv` is this card's conversation, and draws each as one slim line
 * under the card's title: WHO (eyebrow), WHAT (the stager's one-line
 * summary), WHERE-FROM (a citation chip per ref), and a single **Open ↗**.
 * There is deliberately no Approve or Deny here — a decision is made in the
 * room, where the proposal's whole face (the editable form, the note as it
 * will land) is visible. The roster only says that someone is waiting on
 * her and what about. Nothing here hides or snoozes: a proposal stays on
 * the row until it's decided.
 *
 * `ProposalBadge` is the small `✦ n` mark for the title line, so a card
 * says "waiting on you" even when the panel is below the fold.
 *
 * Cut by the owner, 2026-08-27: "put it on the row. no quick approve for
 * this. no push notifications. don't think i want to be able to hide it."
 */
import { Link } from '@tanstack/react-router';
import type { MouseEvent } from 'react';
import { usePendingQueue } from './hooks';
import { itemsForConv } from './openConvs';
import { getApprovalEditor } from './registry';
import type { PendingChange } from './types';
import { agentLabel, refTarget } from '../todos/provenance';
import { payloadRecord } from './shared';
import styles from './ProposalsOnRow.module.css';
import './builtinEditors';

function refsOf(change: PendingChange): string[] {
  const p = payloadRecord(change);
  const direct = Array.isArray(p.refs) ? p.refs : [];
  const note = p.agent_note && typeof p.agent_note === 'object' && !Array.isArray(p.agent_note)
    ? (p.agent_note as Record<string, unknown>).refs
    : undefined;
  const nested = Array.isArray(note) ? note : [];
  const out: string[] = [];
  for (const r of [...direct, ...nested]) {
    if (typeof r === 'string' && r && !out.includes(r)) out.push(r);
  }
  return out;
}

function stop(e: MouseEvent) {
  e.stopPropagation();
}

function RefChip({ r }: { r: string }) {
  const t = refTarget(r);
  if (t.kind === 'route') {
    return (
      <Link to={t.to} search={t.search ?? {}} className={styles.ref} onClick={stop}>
        ↗ {t.label}
      </Link>
    );
  }
  if (t.kind === 'external') {
    return (
      <a href={t.href} target="_blank" rel="noreferrer" className={styles.ref} onClick={stop}>
        ↗ {t.label}
      </a>
    );
  }
  return <span className={styles.refText}>{t.label}</span>;
}

export function useProposalsFor(convId: string): PendingChange[] {
  const { data } = usePendingQueue();
  return itemsForConv(data?.pending ?? [], convId);
}

export function ProposalBadge({ convId }: { convId: string }) {
  const n = useProposalsFor(convId).length;
  if (!n) return null;
  return (
    <span className={styles.badge} title={`${n} proposal${n === 1 ? '' : 's'} waiting on you`}>
      ✦ {n}
    </span>
  );
}

export function ProposalsOnRow({ convId, onOpen }: { convId: string; onOpen: (convId: string) => void }) {
  const items = useProposalsFor(convId);
  if (!items.length) return null;
  return (
    <div className={styles.panel} onClick={stop}>
      {items.map((c) => {
        const who = c.by ? agentLabel(c.by) : 'This agent';
        const title = getApprovalEditor(c.kind)?.title ?? 'Approve change?';
        // The stager's summary already reads "<agent> proposes …" — don't say
        // the agent twice. Fall back to the sheet title for hand-written
        // queue entries that carry none.
        const what = (c.summary || '').replace(/^\S+\s+(proposes|wants to)\s+/i, '') || title;
        const refs = refsOf(c);
        return (
          <div key={c.id} className={styles.row}>
            <div className={styles.text}>
              <span className={styles.eyebrow}>✦ {who} proposes</span>
              <span className={styles.what}>{what}</span>
              {refs.length ? (
                <span className={styles.refs}>
                  {refs.map((r) => (
                    <RefChip key={r} r={r} />
                  ))}
                </span>
              ) : null}
            </div>
            <button type="button" className={styles.openBtn} onClick={() => onOpen(convId)}>
              Open ↗
            </button>
          </div>
        );
      })}
    </div>
  );
}
