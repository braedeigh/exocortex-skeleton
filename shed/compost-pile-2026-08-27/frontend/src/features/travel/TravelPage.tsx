/**
 * /travel — trips with packing lists drawn from real inventory (archivals +
 * consumables) plus free text. Current trips up top (soonest first), past
 * trips and templates in collapsed sections below. Fully usable without the
 * Keeper — but since everything lives in trips.json via the store, a chat
 * session can draft or edit the same lists.
 */
import { useState } from 'react';
import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { useToasts } from '../journal/useJournalData';
import { PromptDialog } from '../inventory/Modal';
import type { PromptState } from '../inventory/Modal';
import { TripCard } from './TripCard';
import { TripModal } from './TripModal';
import type { TripDraft } from './TripModal';
import { splitTrips } from './travelHelpers';
import { useTravelActions, useTravelData } from './useTravelData';
import type { Trip } from './types';
import styles from './travel.module.css';

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

export function TravelPage() {
  const { data, isLoading, isError, error } = useTravelData();
  const { toasts, push, dismiss } = useToasts();
  const actions = useTravelActions(push);
  const isPublic = isPublicMode();

  const [modalTarget, setModalTarget] = useState<'new' | Trip | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);

  if (isError && !data) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>
          Failed to load: {error instanceof Error ? error.message : 'unknown error'}
        </div>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading&hellip;</div>
      </div>
    );
  }

  const { current, past } = splitTrips(data.trips);

  function saveTrip(draft: TripDraft) {
    if (modalTarget === 'new') {
      actions.addTrip(draft);
    } else if (modalTarget) {
      actions.updateTrip({ id: modalTarget.id, ...draft });
    }
  }

  function renderTrip(trip: Trip, defaultOpen: boolean) {
    return (
      <TripCard
        key={trip.id}
        data={data!}
        trip={trip}
        defaultOpen={defaultOpen}
        onUpdateTrip={(patch) => actions.updateTrip({ id: trip.id, ...patch })}
        onEditTrip={() => setModalTarget(trip)}
        onRemoveTrip={() => actions.removeTrip(trip.id)}
        onAddItem={(payload) => actions.addItem({ trip_id: trip.id, ...payload })}
        onUpdateItem={(itemId, patch) =>
          actions.updateItem({ trip_id: trip.id, item_id: itemId, ...patch })
        }
        onRemoveItem={(itemId) => actions.removeItem(trip.id, itemId)}
        onApplyTemplate={(templateId) => actions.applyTemplate(trip.id, templateId)}
        onSaveAsTemplate={() =>
          setPrompt({
            message: `Save "${trip.name}" as a template — name it:`,
            initial: trip.name,
            onSave: (value) => {
              const name = value.trim();
              if (name) actions.templateFromTrip(trip.id, name);
            },
          })
        }
        onDuplicate={(name) => push(`"${name}" is already on the list`)}
      />
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <h2 className={styles.pageTitle}>Travel</h2>
        <button type="button" className={styles.newTripBtn} onClick={() => setModalTarget('new')}>
          + New trip
        </button>
      </div>

      {current.length === 0 && past.length === 0 ? (
        <div className={styles.emptyText}>
          No trips yet — start one and pack it from your own stuff.
        </div>
      ) : null}

      {current.map((trip) => renderTrip(trip, current.length === 1))}

      {past.length > 0 ? (
        <details className={styles.section}>
          <summary className={styles.summary}>Past trips ({past.length})</summary>
          <div className={styles.sectionBody}>{past.map((trip) => renderTrip(trip, false))}</div>
        </details>
      ) : null}

      {data.templates.length > 0 ? (
        <details className={styles.section}>
          <summary className={styles.summary}>Templates ({data.templates.length})</summary>
          <div className={styles.sectionBody}>
            {data.templates.map((t) => (
              <TemplateRow
                key={t.id}
                name={t.name}
                count={t.items.length}
                onRemove={() => actions.removeTemplate(t.id)}
              />
            ))}
          </div>
        </details>
      ) : null}

      <TripModal
        target={modalTarget}
        templates={data.templates}
        onClose={() => setModalTarget(null)}
        onSave={saveTrip}
      />
      <PromptDialog state={prompt} onClose={() => setPrompt(null)} />

      <ToastStack toasts={toasts} onDismiss={dismiss} />
      {!isPublic ? <NotesPill tab="travel" onError={push} /> : null}
    </div>
  );
}

function TemplateRow({
  name,
  count,
  onRemove,
}: {
  name: string;
  count: number;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className={styles.templateRow}>
      <span className={styles.templateName}>{name}</span>
      <span className={styles.templateCount}>{count} items</span>
      <button
        type="button"
        className={styles.removeBtn}
        aria-label={confirming ? `Really delete template ${name}?` : `Delete template ${name}`}
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
    </div>
  );
}
