import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, SyntheticEvent } from 'react';
import { ToastStack } from '../../ui';
import { useToasts } from '../journal/useJournalData';
import { readCardOpen, writeCardOpen } from '../ideas/cardState';
import { ideasMdBlock } from '../ideas/ideasDoc';
import { useBuildMutations, useBuildQueue } from './useBuildData';
import type { BuildCard, BuildPriority, BuildStatus, LegacySection } from './api';
import styles from './BuildPage.module.css';

/**
 * /build — the build queue, one card per item.
 *
 * Two stacks, because the queue is mid-split (see routes/buildtodo.py). On top:
 * real records, each its own dated card, filterable by status, editable in
 * place. Below, collapsed: the pre-split dev_todo.md rendered read-only as
 * `## ` section cards — same parse the Ideas tab uses on IDEAS.md. The old file
 * is still the personas' backlog, so it's shown, not silently hidden, and it's
 * marked as the thing that's draining rather than the thing to add to.
 *
 * Card open/closed state persists under the shared `mapCardOpen:*` keys, so it
 * behaves like every other collapsible card in the app.
 *
 * Prompt: "any future ones are their own dated cards and get backed up in the
 * db" — hence the add box files a card, and the legacy half is read-only.
 */

const PRIORITY_LABEL: Record<BuildPriority, string> = {
  red: '🔴 Now',
  orange: '🟠 Soon',
  yellow: '🟡 Queued',
};

const STATUS_TABS: { key: BuildStatus | 'all'; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'dropped', label: 'Dropped' },
  { key: 'all', label: 'All' },
];

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

/** Tags typed as free text, normalized to the slugs the server accepts. An
 * unslugifiable scrap drops out rather than failing the whole save. */
function parseTags(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(/[,\s]+/)) {
    const slug = piece
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

export function BuildPage() {
  const isPublic = isPublicMode();
  const queueQuery = useBuildQueue(!isPublic);
  const { toasts, push, dismiss } = useToasts();
  const { add, update, remove } = useBuildMutations(push, (_card, undo) => {
    push('Card deleted', { tone: 'info', actionLabel: 'Undo', onAction: undo });
  });

  const [filter, setFilter] = useState<BuildStatus | 'all'>('open');
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editTags, setEditTags] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- add box ---
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newPriority, setNewPriority] = useState<BuildPriority | ''>('');
  const titleRef = useRef<HTMLInputElement>(null);
  const editBodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  useEffect(() => {
    if (adding) titleRef.current?.focus();
  }, [adding]);

  useEffect(() => {
    const ta = editBodyRef.current;
    if (ta) autosize(ta);
  }, [editingId]);

  const cards = queueQuery.data?.cards;
  const legacy = queueQuery.data?.legacy;

  const shown = useMemo(
    () => (cards ?? []).filter((c) => filter === 'all' || c.status === filter),
    [cards, filter],
  );
  const counts = useMemo(() => {
    const by: Record<string, number> = { all: cards?.length ?? 0 };
    for (const c of cards ?? []) by[c.status] = (by[c.status] ?? 0) + 1;
    return by;
  }, [cards]);

  // The legacy file's two piles: still-live sections first, the ✅ SHIPPED
  // history behind its own collapsed card so it stops padding the list.
  const legacyLive = useMemo(() => (legacy ?? []).filter((s) => !s.shipped), [legacy]);
  const legacyDone = useMemo(() => (legacy ?? []).filter((s) => s.shipped), [legacy]);

  function cardOpen(key: string, fallback: boolean): boolean {
    return openCards[key] ?? readCardOpen(key, fallback);
  }

  function onCardToggle(key: string, e: SyntheticEvent<HTMLDetailsElement>) {
    const open = e.currentTarget.open;
    setOpenCards((cur) => (cur[key] === open ? cur : { ...cur, [key]: open }));
    writeCardOpen(key, open);
  }

  function submitAdd() {
    const title = newTitle.trim();
    if (!title) return;
    add({
      title,
      body: newBody.trim(),
      priority: newPriority || null,
    });
    setNewTitle('');
    setNewBody('');
    setNewPriority('');
    setAdding(false);
  }

  function onTitleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitAdd();
    } else if (e.key === 'Escape') {
      setAdding(false);
    }
  }

  function startEdit(card: BuildCard) {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmDeleteId(null);
    setEditingId(card.id);
    setEditTitle(card.title);
    setEditBody(card.body);
    setEditTags(card.tags.join(' '));
  }

  function saveEdit(card: BuildCard) {
    const title = editTitle.trim();
    if (!title) return;
    update(card.id, { title, body: editBody.trim(), tags: parseTags(editTags) });
    setEditingId(null);
  }

  // Two-step delete, same as the idea rows: the × arms, a second tap inside
  // 3s commits. Shipping or dropping is a status change, not this.
  function requestDelete(id: string) {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmDeleteId === id) {
      setConfirmDeleteId(null);
      remove(id);
      return;
    }
    setConfirmDeleteId(id);
    confirmTimer.current = setTimeout(() => setConfirmDeleteId(null), 3000);
  }

  function cyclePriority(card: BuildCard) {
    const ladder: (BuildPriority | null)[] = [null, 'red', 'orange', 'yellow'];
    const next = ladder[(ladder.indexOf(card.priority) + 1) % ladder.length];
    update(card.id, { priority: next });
  }

  if (isPublic) {
    return (
      <div className={styles.page}>
        <div className={styles.publicStub}>The build queue isn&rsquo;t available here.</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={`${styles.sectionTitle} ${styles.firstTitle}`}>Build queue</div>
      <div className={styles.hint}>
        One card per item, each dated when it was filed and stored in the database.
      </div>

      <div className={styles.filterRow}>
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`${styles.filterBtn} ${filter === t.key ? styles.filterOn : ''}`}
            onClick={() => setFilter(t.key)}
          >
            {t.label}
            {counts[t.key] ? <span className={styles.filterCount}>{counts[t.key]}</span> : null}
          </button>
        ))}
      </div>

      {adding ? (
        <div className={styles.addBox}>
          <input
            ref={titleRef}
            className={styles.addTitle}
            value={newTitle}
            placeholder="What needs building?"
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={onTitleKeyDown}
          />
          <textarea
            className={styles.addBody}
            value={newBody}
            placeholder="The spec — why, what it touches, how you'll know it's done (optional)"
            onChange={(e) => setNewBody(e.target.value)}
            onInput={(e) => autosize(e.currentTarget)}
          />
          <div className={styles.addFooter}>
            <select
              className={styles.select}
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value as BuildPriority | '')}
            >
              <option value="">No priority</option>
              {(Object.keys(PRIORITY_LABEL) as BuildPriority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
            <div className={styles.addActions}>
              <button type="button" className={styles.ghostBtn} onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={submitAdd}
                disabled={!newTitle.trim()}
              >
                File it
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button type="button" className={styles.addOpener} onClick={() => setAdding(true)}>
          + New build card
        </button>
      )}

      {queueQuery.isLoading ? (
        <div className={styles.empty}>Loading&hellip;</div>
      ) : queueQuery.isError && !queueQuery.data ? (
        // Only when there's nothing cached — a failed poll must not blank the
        // queue while good data is on screen.
        <div className={styles.empty}>Failed to load the build queue.</div>
      ) : shown.length === 0 ? (
        <div className={styles.empty}>
          {filter === 'open' ? 'Nothing open. Everything new lands here as its own card.' : 'Nothing here.'}
        </div>
      ) : (
        shown.map((card) => {
          const key = `build-${card.id}`;
          const editing = editingId === card.id;
          return (
            <details
              key={card.id}
              className={`${styles.card} ${card.status !== 'open' ? styles.cardClosed : ''}`}
              open={editing || cardOpen(key, false)}
              onToggle={(e) => onCardToggle(key, e)}
            >
              <summary className={styles.cardSummary}>
                <span className={styles.arrow}>&#9654;</span>
                {card.priority ? (
                  <span className={styles.dot} title={PRIORITY_LABEL[card.priority]}>
                    {PRIORITY_LABEL[card.priority].split(' ')[0]}
                  </span>
                ) : null}
                <span className={styles.cardTitle}>{card.title}</span>
                <span className={styles.cardDate}>{card.created}</span>
              </summary>

              {editing ? (
                <div className={styles.editBox}>
                  <input
                    className={styles.addTitle}
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                  />
                  <textarea
                    ref={editBodyRef}
                    className={styles.addBody}
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    onInput={(e) => autosize(e.currentTarget)}
                  />
                  <input
                    className={styles.tagInput}
                    value={editTags}
                    placeholder="tags, space or comma separated"
                    onChange={(e) => setEditTags(e.target.value)}
                  />
                  <div className={styles.addActions}>
                    <button type="button" className={styles.ghostBtn} onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={styles.primaryBtn}
                      onClick={() => saveEdit(card)}
                      disabled={!editTitle.trim()}
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {card.body ? (
                    <div
                      className={styles.body}
                      dangerouslySetInnerHTML={{ __html: ideasMdBlock(card.body) }}
                    />
                  ) : (
                    <div className={styles.emptyRow}>No spec yet</div>
                  )}

                  {card.tags.length ? (
                    <div className={styles.tagRow}>
                      {card.tags.map((t) => (
                        <span key={t} className={styles.tag}>
                          {t}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  <div className={styles.actionRow}>
                    {card.author ? <span className={styles.author}>{card.author}</span> : null}
                    <span className={styles.spacer} />
                    <button type="button" className={styles.act} onClick={() => cyclePriority(card)}>
                      {card.priority ? PRIORITY_LABEL[card.priority].split(' ')[0] : '○'}
                    </button>
                    <button type="button" className={styles.act} onClick={() => startEdit(card)}>
                      Edit
                    </button>
                    {card.status === 'open' ? (
                      <>
                        <button
                          type="button"
                          className={styles.act}
                          onClick={() => update(card.id, { status: 'dropped' })}
                        >
                          Drop
                        </button>
                        <button
                          type="button"
                          className={`${styles.act} ${styles.actShip}`}
                          onClick={() => update(card.id, { status: 'shipped' })}
                        >
                          Shipped
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={styles.act}
                        onClick={() => update(card.id, { status: 'open' })}
                      >
                        Reopen
                      </button>
                    )}
                    <button
                      type="button"
                      className={`${styles.act} ${confirmDeleteId === card.id ? styles.actSure : styles.actX}`}
                      onClick={() => requestDelete(card.id)}
                      aria-label="Delete card"
                    >
                      {confirmDeleteId === card.id ? 'Sure?' : '×'}
                    </button>
                  </div>
                </>
              )}
            </details>
          );
        })
      )}

      {/* --- The pre-split backlog ---------------------------------------- */}
      {legacy && legacy.length ? (
        <>
          <div className={styles.sectionTitle}>Before the split</div>
          <div className={styles.hint}>
            The old <code>dev_todo.md</code>, read-only — {legacyLive.length} still live. It drains as items
            ship; new work goes in a card above.
          </div>
          {legacyLive.map((s) => (
            <LegacyCard key={s.id} section={s} open={cardOpen(s.id, false)} onToggle={onCardToggle} />
          ))}
          {legacyDone.length ? (
            <details
              className={styles.card}
              open={cardOpen('build-legacy-shipped', false)}
              onToggle={(e) => onCardToggle('build-legacy-shipped', e)}
            >
              <summary className={styles.cardSummary}>
                <span className={styles.arrow}>&#9654;</span>
                <span className={styles.cardTitle}>Already shipped</span>
                <span className={styles.cardDate}>{legacyDone.length}</span>
              </summary>
              {legacyDone.map((s) => (
                <LegacyCard key={s.id} section={s} open={cardOpen(s.id, false)} onToggle={onCardToggle} nested />
              ))}
            </details>
          ) : null}
        </>
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function LegacyCard({
  section,
  open,
  onToggle,
  nested = false,
}: {
  section: LegacySection;
  open: boolean;
  onToggle: (key: string, e: SyntheticEvent<HTMLDetailsElement>) => void;
  nested?: boolean;
}) {
  const html = useMemo(() => ideasMdBlock(section.body), [section.body]);
  return (
    <details
      className={`${styles.card} ${styles.legacyCard} ${nested ? styles.nested : ''}`}
      open={open}
      onToggle={(e) => onToggle(section.id, e)}
    >
      <summary className={styles.cardSummary}>
        <span className={styles.arrow}>&#9654;</span>
        <span className={styles.cardTitle}>{section.title}</span>
        {section.created ? <span className={styles.cardDate}>{section.created}</span> : null}
      </summary>
      <div className={styles.body} dangerouslySetInnerHTML={{ __html: html }} />
    </details>
  );
}
