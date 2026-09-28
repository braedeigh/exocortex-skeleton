/**
 * CsvImportSection.tsx — the Money page's "Import from CSV" card: bring in a
 * bank statement and identify what each line is before it becomes expenses.
 *
 * Upload a Bank of America CSV (or pick one already in data/bank_csvs/), and
 * the preview lists every transaction split by month. Each row works like a
 * line on the Kitchen's receipt scanner (kitchen/ReceiptImportModal.tsx):
 * the raw bank text and amount on top, then "What is it?" (a name, guessed
 * from the line or remembered from last time) and a category. Naming or
 * categorizing one row fills in its merchant's other rows. An included row is
 * tinted orange until she confirms it (tap it, or change anything on it);
 * "Approve all" confirms the rest. Import writes the expenses with their names
 * and learns merchant→name and merchant→category rules for next time.
 *
 * Row logic lives in csvImport.ts, the merchant reader in statementMerchant.ts,
 * the server side in routes/money.py (/api/csv/*).
 * Prompt: "i want to be able to identify things from a statement similar to
 * how i identify objects from the receipt scanner."
 */
import { useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { Button } from '../../ui';
import { Section } from './Section';
import {
  addKnownCategory,
  buildSelections,
  confirmAll,
  confirmRow,
  countConfirmed,
  deriveLearnLabels,
  deriveLearnRules,
  groupByMonth,
  identifyRow,
  isRefund,
  needsConfirming,
  prepareRows,
  setRowInclude,
  summarizeCsvRows,
} from './csvImport';
import { useCsvActions, useCsvFiles } from './useMoneyData';
import type { PushOptions } from './useMoneyData';
import type { CsvRow } from './types';
import styles from './money.module.css';

export interface CsvImportSectionProps {
  push: (message: string, opts?: PushOptions) => number;
}

const NAMES_LIST_ID = 'statement-known-names';

function dollars(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function CsvImportSection({ push }: CsvImportSectionProps) {
  const filesQuery = useCsvFiles();
  const csv = useCsvActions((m) => push(m));

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<CsvRow[] | null>(null);
  const [knownCategories, setKnownCategories] = useState<string[]>([]);
  const [knownNames, setKnownNames] = useState<string[]>([]);
  const [learnRules, setLearnRules] = useState(true);

  const files = filesQuery.data?.files ?? [];
  const fileInput = useRef<HTMLInputElement>(null);

  async function loadFile(filename: string) {
    try {
      const data = await csv.parse(filename);
      setSelected(filename);
      setRows(prepareRows(data.rows || []));
      setKnownCategories(data.categories || []);
      setKnownNames(data.titles || []);
      setOpen(true);
    } catch {
      // "Parse failed" already toasted
    }
  }

  // Upload a CSV from this device and open it straight into the preview.
  // Prompt: "make it such that i can upload a csv"
  async function uploadFile(file: File) {
    try {
      const data = await csv.upload(file);
      await loadFile(data.filename);
    } catch {
      // the server's reason is already toasted
    }
  }

  const uploadButton = (
    <div className={styles.csvUpload}>
      <input
        ref={fileInput}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void uploadFile(file);
        }}
      />
      <Button variant="secondary" disabled={csv.uploading} onClick={() => fileInput.current?.click()}>
        {csv.uploading ? 'Uploading…' : 'Upload a CSV'}
      </Button>
    </div>
  );

  function edit(update: (cur: CsvRow[]) => CsvRow[]) {
    setRows((cur) => (cur ? update(cur) : cur));
  }

  function newCategory(rowIdx: number) {
    // window.prompt kept for parity with the old "+ new category" flow.
    const name = window.prompt('New category name:', '');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    setKnownCategories((cur) => addKnownCategory(cur, trimmed));
    edit((cur) => identifyRow(cur, rowIdx, { category: trimmed }));
  }

  function cancel() {
    setRows(null);
    setSelected(null);
  }

  async function confirmImport() {
    if (!rows) return;
    const selections = buildSelections(rows);
    const learnCategories = learnRules ? deriveLearnRules(rows) : [];
    const learnLabels = learnRules ? deriveLearnLabels(rows) : [];
    try {
      const data = await csv.import(selections, learnCategories, learnLabels);
      push(
        `Imported ${data.added} expenses. Learned ${data.labels_learned} merchant names and ${data.rules_learned} category rules. Added ${data.categories_added} new budget categories.`,
        { tone: 'info' },
      );
      setRows(null);
      setSelected(null);
    } catch {
      // "Import failed" already toasted
    }
  }

  const summary = rows ? summarizeCsvRows(rows) : null;
  const progress = rows ? countConfirmed(rows) : null;

  return (
    <Section
      summary={<span>Import from CSV</span>}
      open={open || rows !== null}
      onToggle={setOpen}
    >
      {rows && summary && progress ? (
        <>
          <div className={styles.csvMeta}>
            <b>{selected}</b> &mdash; {rows.length} rows, {summary.includedCount} selected
            {summary.uncategorizedIncluded > 0 ? (
              <span className={styles.red} style={{ marginLeft: 8 }}>
                ⚠ {summary.uncategorizedIncluded} uncategorized in selection
              </span>
            ) : null}
          </div>

          {/* Confirmation progress — the receipt scanner's orange/green line. */}
          <div className={styles.stmtProgress}>
            <div className={progress.allConfirmed ? styles.stmtProgressDone : styles.stmtProgressWaiting}>
              {progress.allConfirmed
                ? `✓ All ${progress.total} confirmed — ready to import`
                : `${progress.confirmed} / ${progress.total} confirmed — tap a row to confirm it, or name it`}
            </div>
            <Button variant="secondary" disabled={progress.allConfirmed} onClick={() => edit(confirmAll)}>
              {progress.allConfirmed ? '✓ All confirmed' : 'Approve all'}
            </Button>
          </div>

          <datalist id={NAMES_LIST_ID}>
            {knownNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>

          <div className={styles.csvScroll}>
            {groupByMonth(rows).map((month) => (
              <section key={month.key || 'undated'} aria-label={month.label}>
                <div className={styles.stmtMonth}>
                  <span className={styles.stmtMonthName}>{month.label}</span>
                  <span className={styles.stmtMonthTotals}>
                    {dollars(month.moneyOut)} out
                    {month.moneyIn > 0 ? <> · <span className={styles.stmtIn}>{dollars(month.moneyIn)} in</span></> : null}
                  </span>
                </div>
                {month.rows.map(({ row, index }) => (
                  <StatementRow
                    key={index}
                    row={row}
                    categories={knownCategories}
                    onConfirm={() => edit((cur) => confirmRow(cur, index))}
                    onInclude={(include) => edit((cur) => setRowInclude(cur, index, include))}
                    onIdentify={(patch) => edit((cur) => identifyRow(cur, index, patch))}
                    onNewCategory={() => newCategory(index)}
                  />
                ))}
              </section>
            ))}
          </div>
          <div className={styles.csvFoot}>
            <label className={styles.learnLabel}>
              <input type="checkbox" checked={learnRules} onChange={(e) => setLearnRules(e.target.checked)} />
              Remember names and categories (so future statements arrive identified)
            </label>
            <Button variant="secondary" onClick={cancel}>
              Cancel
            </Button>
            <Button onClick={confirmImport}>Import {summary.includedCount} expenses</Button>
          </div>
        </>
      ) : files.length === 0 ? (
        <>
          {uploadButton}
          <div className={styles.emptyNote} style={{ fontSize: 13 }}>
            No CSVs yet. Upload a Bank of America CSV export to import it.
          </div>
        </>
      ) : (
        <>
          {uploadButton}
          <div className={styles.smallText} style={{ marginBottom: 8 }}>
            Or pick one you've uploaded before:
          </div>
          {files.map((f) => (
            <button type="button" className={styles.fileBtn} key={f} onClick={() => loadFile(f)}>
              {f}
            </button>
          ))}
        </>
      )}
    </Section>
  );
}

interface StatementRowProps {
  row: CsvRow;
  categories: string[];
  onConfirm: () => void;
  onInclude: (include: boolean) => void;
  onIdentify: (patch: { title?: string; category?: string }) => void;
  onNewCategory: () => void;
}

/** One transaction: tap anywhere on it to confirm; the fields below identify
 * it (and don't count as a tap on the row). */
function StatementRow({ row, categories, onConfirm, onInclude, onIdentify, onNewCategory }: StatementRowProps) {
  // A refund shows as "−$x" in the plain colour: it takes that much off spending.
  // Only real money in gets the green "+".
  const refund = isRefund(row);
  const moneyIn = row.amount > 0 && !refund;
  const waiting = needsConfirming(row);
  const rowClass = [styles.stmtRow, waiting ? styles.stmtRowWaiting : '', row.include ? '' : styles.stmtRowOff]
    .filter(Boolean)
    .join(' ');
  const stop = (e: SyntheticEvent) => e.stopPropagation();

  return (
    <div
      className={rowClass}
      role="button"
      tabIndex={0}
      onClick={onConfirm}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onConfirm();
      }}
    >
      <div className={styles.stmtTop}>
        <label className={styles.includeLabel} onClick={stop}>
          <input
            type="checkbox"
            checked={row.include}
            aria-label={`Include ${row.desc}`}
            onChange={(e) => onInclude(e.target.checked)}
          />
        </label>
        <div className={styles.stmtRaw}>
          <div className={styles.stmtDesc}>{row.desc}</div>
          <div className={styles.stmtMeta}>
            {row.date}
            {row.already_imported ? <span className={styles.dupTag}>already imported</span> : null}
            {refund ? <span className={styles.dupTag}>refund</span> : null}
            {waiting ? <span className={styles.stmtTapHint}> · tap to confirm</span> : null}
          </div>
        </div>
        <div className={moneyIn ? `${styles.stmtAmount} ${styles.stmtIn}` : styles.stmtAmount}>
          {moneyIn ? '+' : refund ? '−' : ''}
          {dollars(Math.abs(row.amount))}
        </div>
      </div>
      <div className={styles.stmtFields} onClick={stop} onKeyDown={stop} role="presentation">
        <input
          type="text"
          className={styles.stmtName}
          value={row.title || ''}
          placeholder="What is it?"
          list={NAMES_LIST_ID}
          aria-label={`What is ${row.desc}?`}
          onChange={(e) => onIdentify({ title: e.target.value })}
        />
        <select
          className={`${styles.csvSelect} ${styles.stmtSelect}`}
          value={row.category || ''}
          aria-label={`Category for ${row.desc}`}
          onChange={(e) => onIdentify({ category: e.target.value })}
        >
          <option value="">— Uncategorized —</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.plusBtn}
          title="New category"
          aria-label="New category"
          onClick={onNewCategory}
        >
          +
        </button>
      </div>
    </div>
  );
}
