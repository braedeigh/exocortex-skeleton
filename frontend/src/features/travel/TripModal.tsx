/**
 * TripModal — create/edit a trip (name, destination, dates, notes). On
 * create it also offers the saved templates as checkboxes, so a new trip can
 * start from "always pack" instead of an empty list.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox } from '../../ui';
import { Modal } from '../inventory/Modal';
import type { TravelTemplate, Trip } from './types';
import styles from './travel.module.css';

export interface TripDraft {
  name: string;
  destination: string;
  start: string;
  end: string;
  notes: string;
  template_ids: string[];
}

export interface TripModalProps {
  /** null = closed; 'new' = create; a Trip = edit that trip. */
  target: 'new' | Trip | null;
  templates: TravelTemplate[];
  onClose: () => void;
  onSave: (draft: TripDraft) => void;
}

export function TripModal({ target, templates, onClose, onSave }: TripModalProps) {
  const [draft, setDraft] = useState<TripDraft>({
    name: '',
    destination: '',
    start: '',
    end: '',
    notes: '',
    template_ids: [],
  });
  const openedFor = useRef<TripModalProps['target']>(null);

  useEffect(() => {
    if (target && openedFor.current !== target) {
      openedFor.current = target;
      setDraft(
        target === 'new'
          ? { name: '', destination: '', start: '', end: '', notes: '', template_ids: [] }
          : {
              name: target.name,
              destination: target.destination,
              start: target.start,
              end: target.end,
              notes: target.notes,
              template_ids: [],
            },
      );
    }
    if (!target) openedFor.current = null;
  }, [target]);

  const isNew = target === 'new';
  const set = (patch: Partial<TripDraft>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <Modal open={target !== null} onClose={onClose} editor aria-label={isNew ? 'New trip' : 'Edit trip'}>
      <h3 className={styles.modalTitle}>{isNew ? 'New trip' : 'Edit trip'}</h3>
      <div className={styles.formGrid}>
        <label className={styles.formLabel}>
          Name
          <input
            className={styles.formInput}
            type="text"
            value={draft.name}
            placeholder="Denver with Allison"
            onChange={(e) => set({ name: e.target.value })}
            autoFocus
          />
        </label>
        <label className={styles.formLabel}>
          Destination
          <input
            className={styles.formInput}
            type="text"
            value={draft.destination}
            placeholder="Denver, CO"
            onChange={(e) => set({ destination: e.target.value })}
          />
        </label>
        <div className={styles.formDatesRow}>
          <label className={styles.formLabel}>
            Leaving
            <input
              className={styles.formInput}
              type="date"
              value={draft.start}
              onChange={(e) => set({ start: e.target.value })}
            />
          </label>
          <label className={styles.formLabel}>
            Back
            <input
              className={styles.formInput}
              type="date"
              value={draft.end}
              onChange={(e) => set({ end: e.target.value })}
            />
          </label>
        </div>
        <label className={styles.formLabel}>
          Notes
          <textarea
            className={styles.formTextarea}
            value={draft.notes}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </label>
        {isNew && templates.length > 0 ? (
          <div>
            <div className={styles.templatePickLabel}>Start from</div>
            {templates.map((t) => (
              <Checkbox
                key={t.id}
                checked={draft.template_ids.includes(t.id)}
                onChange={(e) =>
                  set({
                    template_ids: e.target.checked
                      ? [...draft.template_ids, t.id]
                      : draft.template_ids.filter((id) => id !== t.id),
                  })
                }
              >
                {t.name} <span className={styles.templateCount}>({t.items.length} items)</span>
              </Checkbox>
            ))}
          </div>
        ) : null}
      </div>
      <div className={styles.modalButtons}>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={!draft.name.trim()}
          onClick={() => {
            onSave(draft);
            onClose();
          }}
        >
          {isNew ? 'Create trip' : 'Save'}
        </Button>
      </div>
    </Modal>
  );
}
