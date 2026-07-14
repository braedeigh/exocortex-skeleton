import { useRef, useState } from 'react';
import { Button, IconButton } from '../../ui';
import { Section } from './Section';
import { dollars, recentTaxLog, setAsideSummary } from './moneyMath';
import { useConfirmDelete } from './useDeleteFlow';
import type { LogTaxPayload } from './api';
import type { Expense, TaxSetasideEntry } from './types';
import styles from './money.module.css';

export interface SetAsideSectionProps {
  expenses: Expense[];
  taxSetaside: TaxSetasideEntry[];
  todayStr: string;
  onLogTax: (payload: LogTaxPayload) => void;
  onRemoveTax: (entry: TaxSetasideEntry) => void;
}

/** "Set Aside — Saved + Tax" (renderSetAside): savings-transfer + 25% tax
 * obligation tiles, Vidala paycheck line, tax set-aside log. Auth-only, so
 * amounts print unmasked like the old card. */
export function SetAsideSection({ expenses, taxSetaside, todayStr, onLogTax, onRemoveTax }: SetAsideSectionProps) {
  const { confirmKey, tap } = useConfirmDelete();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayStr);
  const [notes, setNotes] = useState('');
  const amountRef = useRef<HTMLInputElement>(null);

  const s = setAsideSummary(expenses, taxSetaside);
  const owes = s.taxBalance > 0;
  const taxLog = recentTaxLog(taxSetaside);

  function submit() {
    if (!amount) {
      amountRef.current?.focus();
      return;
    }
    onLogTax({ amount, date: date || todayStr, notes: notes.trim() });
    setAmount('');
    setNotes('');
  }

  function onEnter(e: React.KeyboardEvent) {
    if (e.key === 'Enter') submit();
  }

  return (
    <Section defaultOpen summary={<span>Set Aside &mdash; Saved + Tax</span>}>
      <div className={styles.tileGrid}>
        <div className={`${styles.tile} ${styles.tileGreen}`}>
          <div className={styles.tileLabel}>Saved (transfers)</div>
          <div className={`${styles.tileValue} ${styles.green}`}>{dollars(s.savingsTotal)}</div>
          <div className={styles.tileSub}>
            {s.savings.length} transfer{s.savings.length === 1 ? '' : 's'} logged
          </div>
        </div>

        <div className={`${styles.tile} ${styles.tileRed}`}>
          <div className={styles.tileLabel}>Tax obligation (25%)</div>
          <div className={`${styles.tileValue} ${owes ? styles.red : styles.green}`}>
            {owes ? `Owe ${dollars(s.taxBalance)}` : `Ahead ${dollars(Math.abs(s.taxBalance))}`}
          </div>
          <div className={styles.tileSub}>
            {dollars(s.taxOwed)} owed &middot; {dollars(s.taxAside)} set aside
          </div>
        </div>
      </div>

      <div className={styles.smallText} style={{ marginBottom: 6 }}>
        Vidala paychecks detected: <b>{s.vidalaPaychecks.length}</b> totaling <b>{dollars(s.vidalaTotal)}</b>
        {s.vidalaPaychecks.length === 0 ? (
          <span className={styles.yellow}> &mdash; none yet (CSV import income marked Vidala will appear here)</span>
        ) : null}
      </div>

      <div className={styles.formRowTop}>
        <div className={styles.miniLabel} style={{ marginBottom: 6 }}>
          Log tax setaside
        </div>
        <div className={styles.formRow}>
          <input
            ref={amountRef}
            type="number"
            step="0.01"
            inputMode="decimal"
            placeholder="$ moved to tax savings"
            aria-label="Amount moved to tax savings"
            className={styles.input}
            style={{ width: 180 }}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={onEnter}
          />
          <input
            type="date"
            aria-label="Date"
            className={styles.input}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <input
            type="text"
            placeholder="notes (optional)"
            aria-label="Notes"
            className={`${styles.input} ${styles.grow}`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onKeyDown={onEnter}
          />
          <Button onClick={submit}>Log</Button>
        </div>

        {taxLog.length ? (
          <table className={styles.table} style={{ marginTop: 10 }}>
            <tbody>
              {taxLog.map((t) => (
                <tr key={t.id}>
                  <td className={styles.tdDate} style={{ fontSize: 12 }}>
                    {t.date || ''}
                  </td>
                  <td className={styles.tdAmount} style={{ fontSize: 12 }}>
                    <b>{dollars(t.amount)}</b>
                  </td>
                  <td className={styles.tdComments} style={{ fontSize: 12 }}>
                    {t.notes || ''}
                  </td>
                  <td className={styles.tdRight}>
                    <IconButton
                      aria-label={confirmKey === t.id ? 'Confirm remove setaside entry' : 'Remove setaside entry'}
                      title="Remove"
                      danger={confirmKey === t.id}
                      onClick={() => tap(t.id, () => onRemoveTax(t))}
                    >
                      {confirmKey === t.id ? <span className={styles.sureBtn}>Sure?</span> : <>&times;</>}
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </Section>
  );
}
