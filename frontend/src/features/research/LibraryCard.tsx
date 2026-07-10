/**
 * LibraryCard.tsx — read-only listing of the research/*.md corpus (the full
 * write-ups behind the entries), plus the import-open-questions flow. Import
 * never runs blind: dry-run first, inline preview of the per-topic plan,
 * then confirm (replacing the old native confirm()).
 */

import { useState } from 'react';
import type { ImportPlanItem } from './api';
import { Card } from './Card';
import { plural } from './helpers';
import { useResearchCtx } from './ResearchContext';
import styles from './ResearchPage.module.css';

export function LibraryCard() {
  const { mutations, push, actions } = useResearchCtx();
  const { library } = useResearchCtx();
  const [plan, setPlan] = useState<{ items: ImportPlanItem[]; total: number } | null>(null);

  function previewImport() {
    mutations.importQuestions.mutate(true, {
      onSuccess: (body) => {
        const total = body.total ?? 0;
        if (!total) {
          push('No new open questions found in the note files.', { tone: 'info' });
          return;
        }
        setPlan({ items: body.plan ?? [], total });
      },
    });
  }

  function confirmImport() {
    mutations.importQuestions.mutate(false, {
      onSuccess: () => {
        push(`Imported ${plan?.total ?? 0} ${plural(plan?.total ?? 0, 'question', 'questions')}.`, { tone: 'info' });
        setPlan(null);
      },
    });
  }

  return (
    <Card
      cardId="research-library"
      defaultOpen
      title="Library"
      count={
        <>
          {library.length} {plural(library.length, 'file', 'files')} &mdash; the full write-ups behind the entries
        </>
      }
    >
      {library.length ? (
        library.map((f) => (
          <div key={f.path} className={styles.fileRow}>
            <button type="button" className={styles.fileBtn} onClick={() => actions.openLibraryFile(f.path)}>
              <span className={styles.grow}>
                <span className={styles.fileTitle}>{f.title}</span>
                <span className={styles.filePath}>{f.path}</span>
              </span>
              <span className={styles.fileDate}>{f.mtime}</span>
            </button>
          </div>
        ))
      ) : (
        <div className={styles.emptyNote}>No files in the research folder.</div>
      )}

      {library.length ? (
        <div className={styles.importRow}>
          {plan ? (
            <div className={styles.importPlan}>
              <div>
                Found {plan.total} open {plural(plan.total, 'question', 'questions')} to import:
              </div>
              {plan.items.map((p) => (
                <div key={p.file} className={styles.importPlanLine}>
                  &bull; {p.topic}: {p.questions.length}
                </div>
              ))}
              <div>Each file becomes (or reuses) a topic.</div>
              <div className={styles.importActions}>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  disabled={mutations.importQuestions.isPending}
                  onClick={confirmImport}
                >
                  Import
                </button>
                <button type="button" className={styles.outlineBtn} onClick={() => setPlan(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={styles.outlineBtn}
              disabled={mutations.importQuestions.isPending}
              onClick={previewImport}
            >
              &#8615; Import open questions from these files
            </button>
          )}
        </div>
      ) : null}
    </Card>
  );
}
