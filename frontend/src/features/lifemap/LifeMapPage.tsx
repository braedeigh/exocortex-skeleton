import { useState, type ReactNode } from 'react';
import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { companionToPrompt } from '../todos/reminderMath';
import { ActivityCard } from './ActivityCard';
import { ContactCalendar } from './ContactsCard';
import { ContactsManagePanel } from './ContactsManagePanel';
import { CompanionModal, ConfirmModal, EditorModal } from './EditorModal';
import { HabitConfigPanel } from './HabitConfigPanel';
import type { HabitConfigTarget } from './HabitConfigPanel';
import { HabitEditPanel } from './HabitEditPanel';
import { HabitTrackerCard } from './HabitTrackerCard';
import { MapCard } from './MapCard';
import { ReminderManagerPanel } from './ReminderManagerPanel';
import {
  useActivityActions,
  useContactActions,
  useHabitTrackerActions,
  useMapData,
  useReminderRegistryActions,
  useToasts,
} from './useMapData';
import styles from './LifeMapPage.module.css';

type PanelKind = 'habits' | 'reminders' | 'contacts' | null;

interface ConfirmState {
  text: ReactNode;
  action: () => void;
}

interface CompanionState {
  srcLabel: string;
  compLabel: string;
  compType: string;
  date: string;
}

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && !!window.VIEW_MODE && window.VIEW_MODE !== 'authed';
}

/**
 * Life Map tab — React port of index.html #tab-map: three collapsible cards
 * (Habit Tracker, Activity, Keep in Touch), the shared editor modal
 * (habit edit / manage reminders / manage contacts), the delete-confirm
 * modal and the companion-reminder prompt.
 */
export function LifeMapPage() {
  const { data, isLoading, isError, error } = useMapData();
  const { toasts, push, dismiss } = useToasts();
  const activityActions = useActivityActions(push);
  const contactActions = useContactActions(push);
  const habitActions = useHabitTrackerActions(push);
  const reminderRegistry = useReminderRegistryActions(push);
  const isPublic = isPublicMode();

  // Only one editor modal at a time (core.js closeActiveEditor invariant).
  const [panel, setPanel] = useState<PanelKind>(null);
  // Habit config ("New habit" / "Edit habit") overlays whichever panel is
  // open; closing it drops back to the edit panel if that's still active.
  const [habitConfig, setHabitConfig] = useState<HabitConfigTarget | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [companion, setCompanion] = useState<CompanionState | null>(null);

  function askConfirm(text: ReactNode, action: () => void) {
    setConfirm({ text, action });
  }

  if (isLoading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading&hellip;</div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>
          Failed to load: {error instanceof Error ? error.message : 'unknown error'}
        </div>
      </div>
    );
  }

  const contacts = data.contacts || [];
  const reminders = data.reminders || [];

  /** Quick-log from the Activity card. Grocery has its own subsystem; a
   * registry reminder may have a companion ("did you also …?"). */
  function quickLog(date: string, type: string) {
    activityActions.logActivity(date, type);
    const comp = companionToPrompt(reminders, data!.activity_log || [], type, date);
    if (comp) {
      const src = reminders.find((r) => r.type === type);
      setCompanion({
        srcLabel: `${src?.emoji ? `${src.emoji} ` : ''}${src?.label || type}`,
        compLabel: `${comp.emoji ? `${comp.emoji} ` : ''}${comp.label}`,
        compType: comp.type,
        date,
      });
    }
  }

  function moveContact(name: string, dir: -1 | 1) {
    const i = contacts.findIndex((c) => c.name === name);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= contacts.length) return;
    const order = contacts.map((c) => c.name);
    [order[i], order[j]] = [order[j], order[i]];
    contactActions.reorder(order);
  }

  function confirmDeleteHabit(habit: string) {
    askConfirm(
      <>
        Remove <b>{habit}</b>?
      </>,
      () => habitActions.remove(habit),
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <MapCard
          cardKey="habit"
          title="Habit Tracker"
          defaultOpen
          editLabel={panel === 'habits' ? 'Done' : 'Edit'}
          onEdit={() => setPanel((p) => (p === 'habits' ? null : 'habits'))}
        >
          <HabitTrackerCard
            data={data}
            actions={habitActions}
            onConfirm={askConfirm}
            onOpenConfig={(section, item) => setHabitConfig({ section, item })}
          />
        </MapCard>

        <MapCard
          cardKey="activity"
          title="Activity"
          editLabel={!isPublic ? 'Manage reminders' : undefined}
          onEdit={!isPublic ? () => setPanel((p) => (p === 'reminders' ? null : 'reminders')) : undefined}
        >
          <ActivityCard
            data={data}
            isPublic={isPublic}
            onLogActivity={quickLog}
            onLogTrip={activityActions.logTrip}
            onLogRun={activityActions.logRun}
            onConfirm={askConfirm}
            onRemoveActivity={activityActions.removeActivity}
            onRemoveTrip={activityActions.removeTrip}
            onRemoveRun={activityActions.removeRun}
          />
        </MapCard>

        {!isPublic ? (
          <MapCard cardKey="contacts" title="Keep in Touch" editLabel="Manage" onEdit={() => setPanel('contacts')}>
            <ContactCalendar
              contacts={contacts}
              serverDate={data.server_date}
              onLog={contactActions.log}
              onConfirm={askConfirm}
              onRemoveHistory={contactActions.removeHistory}
            />
          </MapCard>
        ) : null}
      </div>

      {/* --- Shared editor modal: one editor at a time --- */}
      {habitConfig ? (
        <EditorModal title={habitConfig.item ? 'Edit habit' : 'New habit'} onClose={() => setHabitConfig(null)}>
          <HabitConfigPanel
            data={data}
            target={habitConfig}
            onSave={(p) => habitActions.configure(p)}
            onDelete={(name) => habitActions.configure({ name, remove: true })}
            onClose={() => setHabitConfig(null)}
          />
        </EditorModal>
      ) : panel === 'habits' ? (
        <EditorModal title="Edit habits" onClose={() => setPanel(null)}>
          <HabitEditPanel
            data={data}
            actions={habitActions}
            onConfirmDelete={confirmDeleteHabit}
            onOpenConfig={(section, item) => setHabitConfig({ section, item })}
          />
        </EditorModal>
      ) : panel === 'reminders' ? (
        <EditorModal title="Manage reminders" onClose={() => setPanel(null)}>
          <ReminderManagerPanel
            reminders={reminders}
            onSave={async (rows) => {
              await reminderRegistry.save(rows);
              setPanel(null);
            }}
            onCancel={() => setPanel(null)}
          />
        </EditorModal>
      ) : panel === 'contacts' ? (
        <EditorModal title="Manage contacts" onClose={() => setPanel(null)}>
          <ContactsManagePanel
            contacts={contacts}
            onLog={(name, method) => contactActions.log(name, method, data.server_date)}
            onMove={moveContact}
            onUpdateThreshold={contactActions.updateThreshold}
            onRemove={contactActions.remove}
            onAdd={contactActions.add}
          />
        </EditorModal>
      ) : null}

      {/* Two-step delete confirmation */}
      <ConfirmModal
        text={confirm ? confirm.text : null}
        onConfirm={() => {
          confirm?.action();
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />

      {/* Companion prompt ("logged sheets — did you also do eye masks?") */}
      <CompanionModal
        text={
          companion ? (
            <>
              Logged <b>{companion.srcLabel}</b>. Did you also do <b>{companion.compLabel}</b>?
            </>
          ) : null
        }
        onYes={() => {
          if (companion) activityActions.logActivity(companion.date, companion.compType);
          setCompanion(null);
        }}
        onNo={() => setCompanion(null)}
      />

      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {!isPublic ? <NotesPill tab="map" onError={push} /> : null}
    </div>
  );
}
