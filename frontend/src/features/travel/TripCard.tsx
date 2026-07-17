/**
 * TripCard — one trip as a collapsible section: status chip + progress in
 * the summary line; inside, the lifecycle button (planning → packing → away
 * → home), the packing list, and the add-item bar.
 *
 * The list has two modes keyed off trip.status:
 *  - planning/packing: each row is a big packed-checkbox — the suitcase pass.
 *  - away/home: packed rows grow a Home/Left/Lost segmented control — the
 *    unpack reckoning. Unpacked rows just say "not packed".
 */
import { useState } from 'react';
import { Checkbox } from '../../ui';
import { AddItemBar } from './AddItemBar';
import {
  NEXT_STATUS_LABEL,
  STATUS_LABEL,
  dateRange,
  nextStatus,
  progressLine,
} from './travelHelpers';
import type { ReturnedState, TravelData, Trip, TripItem } from './types';
import styles from './travel.module.css';

const STATUS_CHIP_CLASS: Record<Trip['status'], string> = {
  planning: styles.statusPlanning,
  packing: styles.statusPacking,
  away: styles.statusAway,
  home: styles.statusHome,
};

export interface TripCardProps {
  data: TravelData;
  trip: Trip;
  defaultOpen: boolean;
  onUpdateTrip: (patch: { status?: Trip['status'] }) => void;
  onEditTrip: () => void;
  onRemoveTrip: () => void;
  onAddItem: (payload: {
    name: string;
    source: 'archival' | 'active' | 'text';
    ref_id: string;
    category: string;
  }) => void;
  onUpdateItem: (itemId: string, patch: { packed?: boolean; returned?: ReturnedState }) => void;
  onRemoveItem: (itemId: string) => void;
  onApplyTemplate: (templateId: string) => void;
  onSaveAsTemplate: () => void;
  onDuplicate: (name: string) => void;
}

function ItemRow({
  item,
  reckoning,
  onUpdate,
  onRemove,
}: {
  item: TripItem;
  reckoning: boolean;
  onUpdate: (patch: { packed?: boolean; returned?: ReturnedState }) => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const srcChip =
    item.source === 'archival' ? 'stuff' : item.source === 'active' ? 'consumable' : null;

  function setReturned(state: ReturnedState) {
    // Tapping the active verdict again un-sets it (back to unresolved).
    onUpdate({ returned: item.returned === state ? '' : state });
  }

  return (
    <li className={`${styles.itemRow} ${item.packed ? styles.itemPacked : ''}`}>
      {reckoning ? (
        <>
          <span className={styles.itemCheck}>
            <span className={styles.itemName}>{item.name}</span>
            {srcChip ? <span className={styles.srcChip}>{srcChip}</span> : null}
            {item.category ? <span className={styles.itemMeta}>{item.category}</span> : null}
            {item.notes ? <div className={styles.itemNotes}>{item.notes}</div> : null}
          </span>
          {item.packed ? (
            <span className={styles.reckonGroup}>
              <button
                type="button"
                className={`${styles.reckonBtn} ${styles.reckonHome}`}
                aria-pressed={item.returned === 'home'}
                onClick={() => setReturned('home')}
              >
                Home
              </button>
              <button
                type="button"
                className={`${styles.reckonBtn} ${styles.reckonLeft}`}
                aria-pressed={item.returned === 'left'}
                onClick={() => setReturned('left')}
              >
                Left
              </button>
              <button
                type="button"
                className={`${styles.reckonBtn} ${styles.reckonLost}`}
                aria-pressed={item.returned === 'lost'}
                onClick={() => setReturned('lost')}
              >
                Lost
              </button>
            </span>
          ) : (
            <span className={styles.notPacked}>not packed</span>
          )}
        </>
      ) : (
        <Checkbox
          className={styles.itemCheck}
          checked={item.packed}
          onChange={(e) => onUpdate({ packed: e.target.checked })}
        >
          <span className={styles.itemName}>{item.name}</span>
          {srcChip ? <span className={styles.srcChip}>{srcChip}</span> : null}
          {item.category ? <span className={styles.itemMeta}>{item.category}</span> : null}
          {item.notes ? <div className={styles.itemNotes}>{item.notes}</div> : null}
        </Checkbox>
      )}
      <button
        type="button"
        className={styles.removeBtn}
        aria-label={confirming ? `Really remove ${item.name}?` : `Remove ${item.name}`}
        onClick={() => {
          if (confirming) onRemove();
          else {
            setConfirming(true);
            setTimeout(() => setConfirming(false), 2500);
          }
        }}
      >
        {confirming ? <span className={styles.removeConfirm}>Sure?</span> : '×'}
      </button>
    </li>
  );
}

export function TripCard({
  data,
  trip,
  defaultOpen,
  onUpdateTrip,
  onEditTrip,
  onRemoveTrip,
  onAddItem,
  onUpdateItem,
  onRemoveItem,
  onApplyTemplate,
  onSaveAsTemplate,
  onDuplicate,
}: TripCardProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const reckoning = trip.status === 'away' || trip.status === 'home';
  const advance = nextStatus(trip.status);
  const dates = dateRange(trip);
  const unresolved =
    trip.status === 'home' && trip.items.some((i) => i.packed && i.returned === '');

  return (
    <details className={styles.section} open={defaultOpen}>
      <summary className={styles.summary}>
        {trip.name}
        {dates ? <span className={styles.tripDates}>{dates}</span> : null}
        <span className={`${styles.statusChip} ${STATUS_CHIP_CLASS[trip.status]}`}>
          {STATUS_LABEL[trip.status]}
        </span>
        <span className={styles.progressText}>{progressLine(trip)}</span>
      </summary>
      <div className={styles.sectionBody}>
        <div className={styles.tripMetaRow}>
          {trip.destination ? (
            <span className={styles.tripDestination}>{trip.destination}</span>
          ) : (
            <span className={styles.tripDestination} />
          )}
          {advance ? (
            <button
              type="button"
              className={styles.advanceBtn}
              onClick={() => onUpdateTrip({ status: advance })}
            >
              {NEXT_STATUS_LABEL[trip.status]}
            </button>
          ) : null}
          <button type="button" className={styles.ghostBtn} onClick={onEditTrip}>
            Edit
          </button>
          <button
            type="button"
            className={styles.dangerBtn}
            onClick={() => {
              if (confirmingDelete) onRemoveTrip();
              else {
                setConfirmingDelete(true);
                setTimeout(() => setConfirmingDelete(false), 2500);
              }
            }}
          >
            {confirmingDelete ? 'Sure?' : 'Delete'}
          </button>
        </div>

        {trip.notes ? <div className={styles.tripNotes}>{trip.notes}</div> : null}

        {reckoning && trip.items.length > 0 ? (
          <div className={styles.reckonHint}>
            {unresolved
              ? 'Unpack pass — mark each packed item Home, Left (on purpose), or Lost.'
              : trip.status === 'away'
                ? 'While away — mark anything you already know stayed behind.'
                : 'All reckoned with. ✓'}
          </div>
        ) : null}

        {trip.items.length === 0 ? (
          <div className={styles.emptyText}>Nothing on the list yet.</div>
        ) : (
          <ul className={styles.itemList}>
            {trip.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                reckoning={reckoning}
                onUpdate={(patch) => onUpdateItem(item.id, patch)}
                onRemove={() => onRemoveItem(item.id)}
              />
            ))}
          </ul>
        )}

        {trip.status !== 'home' ? (
          <AddItemBar data={data} trip={trip} onAdd={onAddItem} onDuplicate={onDuplicate} />
        ) : null}

        <div className={styles.tripMetaRow}>
          {data.templates.length > 0 && trip.status !== 'home' ? (
            <select
              className={styles.formInput}
              value=""
              aria-label="Apply a template"
              onChange={(e) => {
                if (e.target.value) onApplyTemplate(e.target.value);
                e.target.value = '';
              }}
            >
              <option value="">Apply template…</option>
              {data.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.items.length})
                </option>
              ))}
            </select>
          ) : null}
          {trip.items.length > 0 ? (
            <button type="button" className={styles.ghostBtn} onClick={onSaveAsTemplate}>
              Save as template
            </button>
          ) : null}
        </div>
      </div>
    </details>
  );
}
