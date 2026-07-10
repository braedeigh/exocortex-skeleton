/**
 * QuestionsCard.tsx — the open-questions roll-up ("the edge of what's
 * known"). Pink rows are waiting on an answer; a question whose Claude
 * answer landed but hasn't been reviewed carries the orange "new answer"
 * beacon chip (the row itself never goes orange — that color belongs to
 * Claude's answer rows).
 */

import { Card } from './Card';
import { answerState, openQuestions, questionTint } from './helpers';
import { useResearchCtx } from './ResearchContext';
import { DeepButton } from './Pills';
import styles from './ResearchPage.module.css';

export function QuestionsCard() {
  const { state, byId, mutations, actions } = useResearchCtx();
  const qs = openQuestions(state.entries);

  return (
    <Card
      cardId="research-questions"
      defaultOpen
      title="Open questions"
      count={<>{qs.length} &mdash; the edge of what&rsquo;s known</>}
    >
      {qs.length ? (
        qs.map((e) => (
          <div
            key={e.id}
            className={`${styles.qRow} ${questionTint(e, state.entries) === 'pink' ? styles.tintPink : styles.tintPurple}`}
          >
            <div className={styles.grow}>
              <div className={styles.entryHead}>
                <span className={styles.qText}>{e.text}</span>
                {answerState(e, state.entries) === 'fresh' ? (
                  <span className={`${styles.chip} ${styles.chipStatic} ${styles.chipOrange}`}>&#9679; new answer</span>
                ) : null}
              </div>
              {(e.topics ?? []).length ? (
                <div className={styles.tagRow}>
                  {(e.topics ?? []).flatMap((tid) =>
                    byId[tid]
                      ? [
                          <span key={tid} className={`${styles.chip} ${styles.chipStatic}`}>
                            {byId[tid].name}
                          </span>,
                        ]
                      : [],
                  )}
                </div>
              ) : null}
            </div>
            <button type="button" className={styles.primaryBtn} onClick={() => actions.startAnswer(e.id)}>
              Answer&hellip;
            </button>
            <button
              type="button"
              className={styles.outlineBtn}
              title="Mark answered without writing an answer"
              onClick={() => mutations.editEntry.mutate({ id: e.id, status: 'answered' })}
            >
              &#10003; Done
            </button>
            <DeepButton entry={e} />
          </div>
        ))
      ) : (
        <div className={styles.emptyNote}>None open &#10003;</div>
      )}
    </Card>
  );
}
