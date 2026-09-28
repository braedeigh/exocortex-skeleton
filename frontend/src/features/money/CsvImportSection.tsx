import { useRef, useState } from 'react';
import { Button } from '../../ui';
import { Section } from './Section';
import {
  addKnownCategory,
  buildSelections,
  deriveLearnRules,
  isUncategorized,
  setRowCategory,
  setRowInclude,
  summarizeCsvRows,
  truncateDesc,
} from './csvImport';
import { useCsvActions, useCsvFiles } from './useMoneyData';
import type { PushOptions } from './useMoneyData';
import type { CsvRow } from './types';
import styles from './money.module.css';

export interface CsvImportSectionProps {
  push: (message: string, opts?: PushOptions) => number;
}

/** "Import from CSV" — upload a bank CSV from this device or pick one already
 * in data/bank_csvs/, preview with include-toggles + category mapping, learn
 * merchant rules on import (renderCsvImport / _renderCsvPreview / confirmCsvImport). */
export function CsvImportSection({ push }: CsvImportSectionProps) {
  const filesQuery = useCsvFiles();
  const csv = useCsvActions((m) => push(m));

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<CsvRow[] | null>(null);
  const [knownCategories, setKnownCategories] = useState<string[]>([]);
  const [learnRules, setLearnRules] = useState(true);

  const files = filesQuery.data?.files ?? [];
  const fileInput = useRef<HTMLInputElement>(null);

  async function loadFile(filename: string) {
    try {
      const data = await csv.parse(filename);
      setSelected(filename);
      setRows(data.rows || []);
      setKnownCategories(data.categories || []);
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

  function newCategory(rowIdx: number) {
    // window.prompt kept for parity with the old "+ new category" flow.
    const name = window.prompt('New category name:', '');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    setKnownCategories((cur) => addKnownCategory(cur, trimmed));
    setRows((cur) => (cur ? setRowCategory(cur, rowIdx, trimmed) : cur));
  }

  function cancel() {
    setRows(null);
    setSelected(null);
  }

  async function confirmImport() {
    if (!rows) return;
    const selections = buildSelections(rows);
    const learn = learnRules ? deriveLearnRules(rows) : [];
    try {
      const data = await csv.import(selections, learn);
      push(
        `Imported ${data.added} expenses. Learned ${data.rules_learned} new merchant rules. Added ${data.categories_added} new budget categories.`,
        { tone: 'info' },
      );
      setRows(null);
      setSelected(null);
    } catch {
      // "Import failed" already toasted
    }
  }

  const summary = rows ? summarizeCsvRows(rows) : null;

  return (
    <Section
      summary={<span>Import from CSV</span>}
      open={open || rows !== null}
      onToggle={setOpen}
    >
      {rows && summary ? (
        <>
          <div className={styles.csvMeta}>
            <b>{selected}</b> &mdash; {rows.length} rows, {summary.includedCount} selected ($
            {summary.includedTotal.toFixed(2)})
            {summary.uncategorizedIncluded > 0 ? (
              <span className={styles.red} style={{ marginLeft: 8 }}>
                ⚠ {summary.uncategorizedIncluded} uncategorized in selection
              </span>
            ) : null}
          </div>
          <div className={styles.csvScroll}>
            <table className={styles.csvTable}>
              <thead>
                <tr>
                  <th>Inc.</th>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Amount</th>
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => {
                  const isExpense = r.amount < 0;
                  const warn = r.include && isUncategorized(r.category);
                  const rowClass = [warn ? styles.csvRowWarn : '', !r.include ? styles.csvRowDim : '']
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <tr key={idx} className={rowClass || undefined}>
                      <td>
                        <label className={styles.includeLabel}>
                          <input
                            type="checkbox"
                            checked={r.include}
                            aria-label={`Include ${r.desc}`}
                            onChange={(e) => setRows((cur) => (cur ? setRowInclude(cur, idx, e.target.checked) : cur))}
                          />
                        </label>
                      </td>
                      <td className={styles.smallText} style={{ whiteSpace: 'nowrap' }}>
                        {r.date}
                      </td>
                      <td className={styles.csvDesc}>
                        {truncateDesc(r.desc)}
                        {r.already_imported ? <span className={styles.dupTag}>already imported</span> : null}
                      </td>
                      <td className={styles.csvAmount} style={{ color: isExpense ? 'var(--text)' : 'var(--green)' }}>
                        {isExpense ? '' : '+'}${Math.abs(r.amount).toFixed(2)}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <select
                          className={styles.csvSelect}
                          value={r.category || ''}
                          aria-label="Category"
                          onChange={(e) => setRows((cur) => (cur ? setRowCategory(cur, idx, e.target.value) : cur))}
                        >
                          <option value="">— Uncategorized —</option>
                          {knownCategories.map((c) => (
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
                          onClick={() => newCategory(idx)}
                        >
                          +
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={styles.csvFoot}>
            <label className={styles.learnLabel}>
              <input type="checkbox" checked={learnRules} onChange={(e) => setLearnRules(e.target.checked)} />
              Save category assignments as new rules (so future imports auto-categorize)
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
