/**
 * ComingUpCard — the To-dos page's view of Coming up: dated events and topics
 * the Keeper wakes knowing about, soonest first, with how far off each one is.
 *
 * Card = the view; the title-line "+" = add; tapping a row = edit it in a
 * modal (the house pattern). Everything she adds here is marked as hers and
 * needs no approval. Items a Keeper proposed show a small "keeper" tag once
 * she's approved them. A ⏰ means a System reminder will go into the Keeper's
 * chat at its set time; clearing an item (confirmed first) stops it for good.
 *
 * Shows the items inside their lead window, then — under "Later" — the rest,
 * so something set months ahead can still be found and edited.
 *
 * Touches: comingUpApi.ts (routes/coming_up.py), CollapsibleCard (open/closed
 * remembered), ui/Sheet (the edit modal).
 *
 * Prompt: "I want to inject for my keeper to tell me about events when they're
 * coming up ... Or maybe it would prompt me to talk about certain topics at
 * certain times" / "I want times".
 */
import { useState } from 'react';
import { Button, IconButton, Sheet } from '../../ui';
import { CollapsibleCard } from '../body/CollapsibleCard';
import { useComingUp, useComingUpActions, type ComingUpDraft, type ComingUpItem } from './comingUpApi';
import styles from './ComingUpCard.module.css';

const EMPTY: ComingUpDraft = {
  kind: 'event', title: '', note: '', date: '', time: '', end_date: '', remind_at: '', lead_days: 14,
};

// "2026-10-17" + "10:00" → "Sat Oct 17, 10:00 AM" — read as local calendar
// parts, never as a UTC timestamp, so the day can't slide.
function whenText(it: Pick<ComingUpItem, 'date' | 'time' | 'end_date'>): string {
  const day = (d: string) => {
    const [y, m, dd] = d.split('-').map(Number);
    return new Date(y, m - 1, dd).toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
    });
  };
  let text = it.date ? day(it.date) : '';
  if (it.end_date && it.end_date !== it.date) text += `–${day(it.end_date)}`;
  if (it.time) {
    const [h, mi] = it.time.split(':').map(Number);
    text += `, ${new Date(2000, 0, 1, h, mi).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  return text;
}

export function ComingUpCard() {
  const { data } = useComingUp();
  const [editing, setEditing] = useState<ComingUpItem | 'new' | null>(null);
  const near = data?.near ?? [];
  const later = (data?.items ?? []).filter((it) => !it.near);

  return (
    <div className={styles.wrap}>
      <CollapsibleCard
        cardKey="todos-coming-up"
        title={near.length ? `⏰ Coming up · ${near.length}` : '⏰ Coming up'}
        defaultOpen
        titleExtra={
          <IconButton
            aria-label="Add something coming up"
            className={styles.addBtn}
            onClick={(e) => {
              e.preventDefault(); // a button inside <summary> must not also toggle the card
              setEditing('new');
            }}
          >
            +
          </IconButton>
        }
      >
        {near.length === 0 ? <p className={styles.empty}>Nothing in the next while.</p> : null}
        {near.map((it) => (
          <Row key={it.id} item={it} label={it.when ?? ''} onOpen={() => setEditing(it)} />
        ))}
        {later.length ? (
          <>
            <div className={styles.subhead}>Later</div>
            {later.map((it) => (
              <Row key={it.id} item={it} label={whenText(it)} onOpen={() => setEditing(it)} />
            ))}
          </>
        ) : null}
      </CollapsibleCard>
      {editing ? (
        <ComingUpForm item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}

function Row({ item, label, onOpen }: { item: ComingUpItem; label: string; onOpen: () => void }) {
  const pinging = Boolean(item.remind_at) && item.status === 'pending';
  return (
    <button type="button" className={styles.row} onClick={onOpen} data-track="coming-up-open">
      <span className={styles.when}>{label}</span>
      <span className={styles.title}>
        {item.kind === 'topic' ? 'Bring up: ' : ''}
        {item.title}
      </span>
      {pinging ? (
        <span className={styles.ping} title={`System reminder at ${item.remind_at}`} aria-label="Has a reminder">
          ⏰
        </span>
      ) : null}
      {item.created_by === 'keeper' ? <span className={styles.byKeeper}>keeper</span> : null}
    </button>
  );
}

function ComingUpForm({ item, onClose }: { item: ComingUpItem | null; onClose: () => void }) {
  const { add, edit, dismiss } = useComingUpActions();
  const [draft, setDraft] = useState<ComingUpDraft>(() => (item ? { ...EMPTY, ...item } : EMPTY));
  // The reminder is two inputs in the form, one field on the item.
  const [remindDate, setRemindDate] = useState(() => draft.remind_at.split(' ')[0] ?? '');
  const [remindTime, setRemindTime] = useState(() => draft.remind_at.split(' ')[1] ?? '');
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<ComingUpDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const busy = add.isPending || edit.isPending || dismiss.isPending;

  const save = () => {
    const remind_at = remindDate && remindTime ? `${remindDate} ${remindTime}` : '';
    const payload = { ...draft, remind_at };
    const done = { onSuccess: onClose, onError: (e: Error) => setError(e.message) };
    if (item) edit.mutate({ id: item.id, draft: payload }, done);
    else add.mutate(payload, done);
  };

  return (
    <Sheet
      open
      title={item ? 'Coming up' : 'Add to Coming up'}
      onClose={onClose}
      footer={
        <div className={styles.footer}>
          {item ? (
            confirmClear ? (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => dismiss.mutate(item.id, { onSuccess: onClose })}
              >
                Clear it for good
              </Button>
            ) : (
              <Button variant="secondary" disabled={busy} onClick={() => setConfirmClear(true)}>
                Clear…
              </Button>
            )
          ) : null}
          <Button disabled={busy || !draft.title.trim() || !draft.date} onClick={save}>
            Save
          </Button>
        </div>
      }
    >
      <div className={styles.form}>
        <div className={styles.kinds} role="group" aria-label="What kind">
          {(['event', 'topic'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={[styles.kindBtn, draft.kind === k ? styles.kindOn : ''].join(' ')}
              aria-pressed={draft.kind === k}
              onClick={() => set({ kind: k })}
            >
              {k === 'event' ? 'Event' : 'Topic to bring up'}
            </button>
          ))}
        </div>
        <label className={styles.field}>
          What
          <input value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <div className={styles.pair}>
          <label className={styles.field}>
            Day
            <input type="date" value={draft.date} onChange={(e) => set({ date: e.target.value })} />
          </label>
          <label className={styles.field}>
            Time (optional)
            <input type="time" value={draft.time} onChange={(e) => set({ time: e.target.value })} />
          </label>
        </div>
        {draft.kind === 'event' ? (
          <label className={styles.field}>
            Last day, if it runs longer
            <input type="date" value={draft.end_date} min={draft.date || undefined}
              onChange={(e) => set({ end_date: e.target.value })} />
          </label>
        ) : null}
        <div className={styles.pair}>
          <label className={styles.field}>
            Remind the Keeper on
            <input type="date" value={remindDate} onChange={(e) => setRemindDate(e.target.value)} />
          </label>
          <label className={styles.field}>
            at
            <input type="time" value={remindTime} onChange={(e) => setRemindTime(e.target.value)} />
          </label>
        </div>
        <p className={styles.hint}>
          {draft.kind === 'topic'
            ? 'Leave the reminder empty and it goes in at the topic’s own time.'
            : 'Leave it empty for no ping — it still shows in the Keeper’s morning list.'}
        </p>
        <label className={styles.field}>
          Show it this many days ahead
          <input type="number" min={0} max={365} value={draft.lead_days}
            onChange={(e) => set({ lead_days: Number(e.target.value) })} />
        </label>
        <label className={styles.field}>
          Note
          <textarea rows={3} value={draft.note} onChange={(e) => set({ note: e.target.value })} />
        </label>
        {item?.created_by === 'keeper' ? <p className={styles.hint}>Added by the keeper.</p> : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </div>
    </Sheet>
  );
}
