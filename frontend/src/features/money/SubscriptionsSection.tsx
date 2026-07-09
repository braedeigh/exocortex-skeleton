import { useRef, useState } from 'react';
import { Button, IconButton } from '../../ui';
import { Section } from './Section';
import {
  daysUntil,
  formatMoney,
  ordinal,
  renewalUrgency,
  sortSubscriptions,
  subscriptionsMonthlyTotal,
} from './moneyMath';
import { useConfirmDelete } from './useDeleteFlow';
import type { AddSubscriptionPayload } from './api';
import type { Subscription } from './types';
import styles from './money.module.css';

export interface SubscriptionsSectionProps {
  subscriptions: Subscription[];
  masked: boolean;
  onUpdateField: (name: string, patch: Record<string, string | number | null>) => void;
  onRemove: (sub: Subscription) => void;
  onAdd: (payload: AddSubscriptionPayload) => Promise<unknown>;
  onAutoDetect: () => Promise<{ added: number; skipped: number }>;
  push: (message: string, opts?: { tone?: 'error' | 'info' }) => void;
}

/** Display-name inline edit — saves on blur when changed (doesn't change
 * what the row matches in transactions). */
function NameCell({ sub, onUpdateField }: { sub: Subscription; onUpdateField: SubscriptionsSectionProps['onUpdateField'] }) {
  const label = sub.display_name || sub.name;
  return (
    <>
      <input
        type="text"
        className={styles.nameInput}
        defaultValue={label}
        title="Edit how this shows here (doesn't change what it matches in transactions)"
        aria-label={`Display name for ${sub.name}`}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== label) onUpdateField(sub.name, { display_name: v });
        }}
      />
      {label !== sub.name ? (
        <span className={styles.idBadge} title={`Matches transactions as "${sub.name}"`}>
          {' '}
          ({sub.name})
        </span>
      ) : null}
      {sub.cancel_url ? (
        <a
          className={styles.cancelLink}
          href={sub.cancel_url}
          target="_blank"
          rel="noopener noreferrer"
          title="Cancel page"
        >
          ↗
        </a>
      ) : null}
    </>
  );
}

/** Bill-day editor with live ordinal hint; saves on blur when changed. */
function BillDayCell({ sub, onUpdateField }: { sub: Subscription; onUpdateField: SubscriptionsSectionProps['onUpdateField'] }) {
  const orig = sub.bill_day ?? '';
  const [draft, setDraft] = useState(String(orig));
  return (
    <>
      <input
        type="number"
        min={1}
        max={31}
        className={styles.billDayInput}
        value={draft}
        placeholder="—"
        title="Day of month this bill occurs on"
        aria-label={`Bill day for ${sub.display_name || sub.name}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== String(orig)) onUpdateField(sub.name, { bill_day: draft === '' ? '' : draft });
        }}
      />
      <span className={styles.ordinalHint}>{draft ? ordinal(draft) : ''}</span>
    </>
  );
}

function RenewalCell({ sub }: { sub: Subscription }) {
  const days = daysUntil(sub.next_renewal);
  const urgency = renewalUrgency(days);
  if (urgency === 'none') return <span className={styles.mutedText}>—</span>;
  if (urgency === 'far') return <span className={styles.renewFar}>{sub.next_renewal}</span>;
  const cls = urgency === 'soon' ? styles.renewSoon : styles.renewUpcoming;
  return (
    <span className={cls}>
      {sub.next_renewal} ({days}d)
    </span>
  );
}

/** Subscriptions table + auto-detect + add form (renderSubscriptions & co). */
export function SubscriptionsSection({
  subscriptions,
  masked,
  onUpdateField,
  onRemove,
  onAdd,
  onAutoDetect,
  push,
}: SubscriptionsSectionProps) {
  const { confirmKey, tap } = useConfirmDelete();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState('monthly');
  const [nextRenewal, setNextRenewal] = useState('');
  const [cancelUrl, setCancelUrl] = useState('');

  const items = sortSubscriptions(subscriptions);
  const monthlyTotal = subscriptionsMonthlyTotal(items);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) {
      nameRef.current?.focus();
      return;
    }
    try {
      await onAdd({
        name: trimmed,
        amount: amount || 0,
        frequency,
        next_renewal: nextRenewal,
        cancel_url: cancelUrl.trim(),
      });
      setName('');
      setAmount('');
      setNextRenewal('');
      setCancelUrl('');
    } catch {
      // failure already toasted by the mutation's onError
    }
  }

  async function autoDetect() {
    try {
      const data = await onAutoDetect();
      push(
        `Added ${data.added} subscription(s). Skipped ${data.skipped} (not recurring across months, or already tracked).`,
        { tone: 'info' },
      );
    } catch {
      // failure already toasted
    }
  }

  return (
    <Section
      defaultOpen
      summary={
        <span>
          Subscriptions ({items.length}) &mdash; {formatMoney(monthlyTotal, masked)}/mo equiv
        </span>
      }
    >
      {items.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Cost</th>
                <th>Bill day</th>
                <th>Next renewal</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.name}>
                  <td className={styles.nowrap}>
                    <NameCell sub={s} onUpdateField={onUpdateField} />
                  </td>
                  <td className={styles.nowrap} style={{ fontSize: 13 }}>
                    {formatMoney(s.amount, masked)}
                    {s.frequency === 'yearly' ? '/yr' : '/mo'}
                  </td>
                  <td className={styles.nowrap}>
                    <BillDayCell key={`${s.name}:${s.bill_day ?? ''}`} sub={s} onUpdateField={onUpdateField} />
                  </td>
                  <td className={styles.nowrap} style={{ fontSize: 13 }}>
                    <RenewalCell sub={s} />
                  </td>
                  <td className={styles.tdComments}>{s.notes || ''}</td>
                  <td className={styles.tdRight}>
                    <IconButton
                      aria-label={confirmKey === s.name ? 'Confirm remove subscription' : `Remove ${s.display_name || s.name}`}
                      title="Remove"
                      danger={confirmKey === s.name}
                      onClick={() => tap(s.name, () => onRemove(s))}
                    >
                      {confirmKey === s.name ? <span className={styles.sureBtn}>Sure?</span> : <>&times;</>}
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={styles.emptyNote}>No subscriptions tracked yet.</div>
      )}

      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
        <button type="button" className={styles.outlineBtn} onClick={autoDetect}>
          Auto-detect from expenses
        </button>
        <span className={styles.hintText}>
          Scans expenses categorized as "Subscriptions" — recurring charges (2+ months) get added.
        </span>
      </div>

      <div className={`${styles.formRow} ${styles.formRowTop}`}>
        <input
          ref={nameRef}
          type="text"
          placeholder="Subscription name"
          aria-label="Subscription name"
          className={`${styles.input} ${styles.grow}`}
          style={{ minWidth: 140 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="number"
          step="0.01"
          inputMode="decimal"
          placeholder="$ amount"
          aria-label="Amount"
          className={`${styles.input} ${styles.wAmount}`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <select
          aria-label="Frequency"
          className={styles.select}
          value={frequency}
          onChange={(e) => setFrequency(e.target.value)}
        >
          <option value="monthly">monthly</option>
          <option value="yearly">yearly</option>
        </select>
        <input
          type="date"
          aria-label="Next renewal"
          className={styles.input}
          value={nextRenewal}
          onChange={(e) => setNextRenewal(e.target.value)}
        />
        <input
          type="url"
          placeholder="cancel URL (optional)"
          aria-label="Cancel URL"
          className={`${styles.input} ${styles.grow}`}
          value={cancelUrl}
          onChange={(e) => setCancelUrl(e.target.value)}
        />
        <Button onClick={add}>Add</Button>
      </div>
    </Section>
  );
}
