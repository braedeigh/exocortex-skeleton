/**
 * HelperContextPage.tsx — what one helper is working from, and her standing
 * rules for it.
 *
 * What this is, in plain English: a helper's chat (a swarm's, a room's, the
 * Linear helper's) is ROLLING — every turn starts fresh from one document
 * written just before it (helper_chat.py). This page shows that document,
 * part by part, exactly as the model reads it:
 *   - the doc (its job, how its view is shaped, where to look things up);
 *   - her standing rules;
 *   - its open watches;
 *   - her last messages to it, each with its reply;
 *   - one entry per active session (summary, files edited, files read);
 *   - for the Linear helper, the latest Linear news.
 * It opens on what the helper's LAST turn was handed. A button builds it as
 * it would be handed this minute — the server takes several seconds over
 * that, which is why it isn't the first thing shown.
 *
 * One part is hers to edit: the standing rules, a small markdown file per
 * helper where every line starting "- " is a rule. Each rule is a row with an
 * Edit and a Delete button, and "Add a rule" sits under the list; the whole
 * file in one text box is folded away beneath, for her other lines. Everything else is rebuilt each turn from the
 * transcript, the summaries, the tool-call log and the code, so an edit to it
 * would be gone by the next turn — it is shown, not edited.
 *
 * Touches: swarmApi.ts (useHelperContext, changeHelperRule, saveHelperRules),
 * routes/swarms.py (the three endpoints), routes/observatory_.context.$convId.tsx (the route),
 * sessionLocation.ts, HelperContextPage.module.css, SwarmPage.module.css (the
 * sections), NightCrewPage.module.css (the page chrome). Reached from the
 * "context" button in a helper's chat and from its swarm's page.
 *
 * Prompt that produced it: "i want maybe some kind of option to edit the
 * rolling context directly or at least see what is in the rolling context for
 * a room helper" · "the standing rules is the part that should be edited" ·
 * "I want edit buttons for the rules"
 */
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import styles from './HelperContextPage.module.css';
import pageStyles from './NightCrewPage.module.css';
import { sessionLocation } from './sessionLocation';
import swarmStyles from './SwarmPage.module.css';
import {
  changeHelperRule,
  fetchHelperContext,
  saveHelperRules,
  useHelperContext,
  type HelperContext,
} from './swarmApi';

/** A size she can weigh: characters, and a token count that is only a rough
 * guess (characters ÷ 4 — the server doesn't count tokens for a seed). */
function sizeOf(characters: number): string {
  return `${characters.toLocaleString()} characters, roughly ${Math.round(characters / 4).toLocaleString()} tokens`;
}

export function HelperContextPage({ convId }: { convId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // false: what its last turn was handed. true: built this minute.
  const [asOfNow, setAsOfNow] = useState(false);
  const { data, error, isFetching } = useHelperContext(convId, asOfNow);
  // The last-turn view, kept in hand while a fresh build is on its way so
  // the rules box never empties under her.
  const lastTurn = queryClient.getQueryData<HelperContext>(['helper-context', convId, false]);
  const shown = data ?? lastTurn;

  // Her edit of the rules file. null means she hasn't touched the box, so it
  // shows the file; `loaded` is the file text her edit started from, which
  // the server checks before it overwrites anything.
  const [draft, setDraft] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const fileText = loaded ?? shown?.rules.text ?? '';
  const boxText = draft ?? fileText;

  // Put fresh rules into both views of this helper, so switching between
  // "last turn" and "now" never shows the file as it was before a save.
  const rememberRules = (rules: HelperContext['rules']) => {
    for (const now of [false, true]) {
      queryClient.setQueryData<HelperContext>(['helper-context', convId, now], (old) =>
        old ? { ...old, rules } : old,
      );
    }
  };

  // Save the rules file. A refusal because the file changed (the helper
  // added a rule meanwhile) keeps her text in the box and loads the file as
  // it is now beneath it, so she can carry the new rule over and save again.
  const save = () => {
    setSaving(true);
    saveHelperRules(convId, boxText, fileText).then(
      ({ rules }) => {
        rememberRules(rules);
        setDraft(null);
        setLoaded(null);
        setSaving(false);
        setNote('Saved. The helper is handed these at the start of its next turn.');
      },
      (err: unknown) => {
        setSaving(false);
        if (err instanceof ApiError && err.status === 409) {
          void fetchHelperContext(convId, false).then((fresh) => {
            rememberRules(fresh.rules);
            setLoaded(fresh.rules.text);
          });
          setNote(
            'Not saved: the helper changed this file while you were editing. Its rules as they are now are listed above. Add what you want to keep to the box, then save again — that will replace the file with what is in the box.',
          );
        } else {
          setNote('Couldn’t save that — try again.');
        }
      },
    );
  };

  // One rule being changed with its buttons: which row is open for editing
  // (0 = the "add a rule" box, null = none) and the words in its box.
  const [editing, setEditing] = useState<number | null>(null);
  const [words, setWords] = useState('');
  const closeRow = () => {
    setEditing(null);
    setWords('');
  };

  // Change one rule. The server is told what the page was showing for that
  // rule; a refusal because the rules changed meanwhile loads them as they
  // are now and leaves her words in the box to try again.
  const changeRule = (change: Parameters<typeof changeHelperRule>[1]) => {
    setSaving(true);
    changeHelperRule(convId, change).then(
      ({ rules }) => {
        rememberRules(rules);
        // The whole-file box starts again from the file as it now is.
        setDraft(null);
        setLoaded(null);
        setSaving(false);
        closeRow();
        setNote('Saved. The helper is handed these at the start of its next turn.');
      },
      (err: unknown) => {
        setSaving(false);
        if (err instanceof ApiError && err.status === 409) {
          void fetchHelperContext(convId, false).then((fresh) => rememberRules(fresh.rules));
          closeRow();
          setNote('Not changed: the helper changed the rules while you were looking. Here they are now — try again.');
        } else {
          setNote('Couldn’t save that — try again.');
        }
      },
    );
  };

  const total = shown?.seed?.parts.reduce((sum, part) => sum + part.text.length, 0) ?? 0;
  const building = asOfNow && isFetching;

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.inner}>
        <div className={pageStyles.header}>
          <button type="button" className={pageStyles.back} onClick={() => void navigate(sessionLocation(convId))}>
            &larr; Its chat
          </button>
          <h1 className={pageStyles.title}>{shown ? shown.title : 'Helper'}</h1>
        </div>

        {error && !shown ? <p className={swarmStyles.empty}>Couldn&rsquo;t load this — it may not be a helper.</p> : null}
        {shown ? (
          <>
            <p className={swarmStyles.muted}>
              This helper&rsquo;s chat is rolling: every turn starts fresh from one document, written just before the
              turn. Your standing rules are the part you can edit. The rest is rebuilt each turn from the chat, the
              session summaries and the tool-call log, so it is shown here, not edited.
            </p>

            {/* Her standing rules: one row per rule, each with its buttons. */}
            <section className={swarmStyles.section}>
              <h2 className={swarmStyles.h2}>Your standing rules</h2>
              <p className={swarmStyles.note}>
                Handed to the helper at the start of every turn. The helper adds one when you tell it something meant
                to last.
              </p>
              {shown.rules.rules.length === 0 ? <p className={swarmStyles.muted}>No rules yet.</p> : null}
              <ol className={styles.ruleList}>
                {shown.rules.rules.map((rule, index) => {
                  const number = index + 1;
                  return (
                    <li key={`${number}-${rule}`} className={styles.rule}>
                      {editing === number ? (
                        <>
                          <textarea
                            className={styles.ruleBox}
                            value={words}
                            aria-label={`Rule ${number}`}
                            autoFocus
                            onChange={(e) => setWords(e.target.value)}
                          />
                          <div className={styles.row}>
                            <button
                              type="button"
                              className={swarmStyles.button}
                              disabled={saving || !words.trim() || words.trim() === rule}
                              onClick={() => changeRule({ action: 'edit', number, was: rule, words })}
                            >
                              Save
                            </button>
                            <button type="button" className={swarmStyles.button} onClick={closeRow}>
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span className={styles.ruleText}>{rule}</span>
                          <div className={styles.row}>
                            <button
                              type="button"
                              className={swarmStyles.button}
                              onClick={() => {
                                setEditing(number);
                                setWords(rule);
                                setNote('');
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className={`${swarmStyles.button} ${styles.danger}`}
                              disabled={saving}
                              onClick={() => {
                                if (window.confirm(`Delete this rule?\n\n${rule}`)) {
                                  changeRule({ action: 'drop', number, was: rule });
                                }
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  );
                })}
              </ol>

              {/* Adding one: a box that opens under the list. */}
              {editing === 0 ? (
                <div className={styles.rule}>
                  <textarea
                    className={styles.ruleBox}
                    value={words}
                    aria-label="A new rule"
                    placeholder="Your words — saved with today's date"
                    autoFocus
                    onChange={(e) => setWords(e.target.value)}
                  />
                  <div className={styles.row}>
                    <button
                      type="button"
                      className={swarmStyles.button}
                      disabled={saving || !words.trim()}
                      onClick={() => changeRule({ action: 'add', words })}
                    >
                      Add
                    </button>
                    <button type="button" className={swarmStyles.button} onClick={closeRow}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className={styles.row}>
                  <button
                    type="button"
                    className={swarmStyles.button}
                    onClick={() => {
                      setEditing(0);
                      setWords('');
                      setNote('');
                    }}
                  >
                    + Add a rule
                  </button>
                </div>
              )}
              {note ? <p className={swarmStyles.note}>{note}</p> : null}

              {/* The whole file, folded away: for the lines that aren't rules. */}
              <details className={swarmStyles.run}>
                <summary className={swarmStyles.runHead}>
                  <span className={styles.partTitle}>Edit the whole file</span>
                </summary>
                <div className={styles.wholeFile}>
                  <p className={swarmStyles.note}>
                    Each line starting with &ldquo;- &rdquo; is one rule. Other lines are yours to write and are not
                    handed to the helper.
                  </p>
                  <textarea
                    className={styles.rules}
                    value={boxText}
                    aria-label="The whole rules file"
                    spellCheck={false}
                    onChange={(e) => {
                      if (loaded === null) setLoaded(fileText);
                      setDraft(e.target.value);
                      setNote('');
                    }}
                  />
                  <div className={styles.row}>
                    <button
                      type="button"
                      className={swarmStyles.button}
                      onClick={save}
                      disabled={saving || draft === null || draft === fileText}
                    >
                      Save the file
                    </button>
                    {draft !== null && draft !== fileText ? (
                      <button
                        type="button"
                        className={swarmStyles.button}
                        onClick={() => {
                          setDraft(null);
                          setLoaded(null);
                          setNote('');
                        }}
                      >
                        Undo my edits
                      </button>
                    ) : null}
                  </div>
                  <p className={swarmStyles.note}>
                    {shown.rules.exists ? 'File: ' : 'Not written yet — saving creates it at '}
                    <span className={styles.path}>{shown.rules.path}</span>
                  </p>
                </div>
              </details>
            </section>

            {/* The document itself, part by part, as the model reads it. */}
            <section className={swarmStyles.section}>
              <h2 className={swarmStyles.h2}>
                {shown.seed?.now ? 'What it would be handed now' : 'What its last turn was handed'}
              </h2>
              <div className={styles.row}>
                <button
                  type="button"
                  className={swarmStyles.button}
                  onClick={() => {
                    if (asOfNow) void queryClient.invalidateQueries({ queryKey: ['helper-context', convId, true] });
                    setAsOfNow(true);
                  }}
                  disabled={building}
                >
                  {building ? 'Building…' : asOfNow ? 'Build it again' : 'Build it as it would be now'}
                </button>
                {asOfNow ? (
                  <button type="button" className={swarmStyles.button} onClick={() => setAsOfNow(false)}>
                    Back to its last turn
                  </button>
                ) : null}
              </div>
              {building ? (
                <p className={swarmStyles.note}>
                  Reading every session&rsquo;s summary and files — this takes several seconds.
                </p>
              ) : null}
              {asOfNow && error ? <p className={swarmStyles.error}>Couldn&rsquo;t build it — try again.</p> : null}
              {shown.seed ? (
                <>
                  <p className={swarmStyles.note}>
                    {shown.seed.now ? 'Built ' : 'Written '}
                    {shown.seed.at.slice(0, 16).replace('T', ' ')}
                    {shown.seed.now ? ' — nothing was sent to the helper' : ', when its last turn started'} ·{' '}
                    {sizeOf(total)} · replays at most {shown.exchanges_kept} of your messages.
                  </p>
                  {shown.seed.parts.map((part) => (
                    <details key={part.key} className={swarmStyles.run}>
                      <summary className={swarmStyles.runHead}>
                        <span className={styles.partTitle}>{part.title}</span>
                        <span className={styles.partSize}>{part.text.length.toLocaleString()} characters</span>
                      </summary>
                      <pre className={`${swarmStyles.pre} ${styles.partText}`}>{part.text}</pre>
                    </details>
                  ))}
                </>
              ) : (
                <p className={swarmStyles.muted}>
                  This helper hasn&rsquo;t had a turn yet, so nothing has been handed to it. Build it as it would be
                  now to see what its first turn would start from.
                </p>
              )}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
