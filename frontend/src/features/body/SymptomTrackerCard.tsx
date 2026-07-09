import { useEffect, useRef, useState } from 'react';
import { CollapsibleCard } from './CollapsibleCard';
import { DayEditor } from './DayEditor';
import { DotGrid } from './DotGrid';
import { SymptomDefinitionsEditor } from './SymptomDefinitionsEditor';
import type { BodyHealthDay, SymptomDefinitions } from './types';
import styles from './SymptomTrackerCard.module.css';

export interface SymptomTrackerCardProps {
  days: BodyHealthDay[];
  definitions: SymptomDefinitions | undefined;
  onLogSymptoms: (date: string, symptoms: Record<string, number>) => void;
  onSetFoodNotes: (date: string, foods: string[]) => void;
  onSaveDefinitions: (definitions: SymptomDefinitions) => void;
}

/**
 * Symptom Tracker card — dot grid + per-day editor + 0–3 definitions
 * (overview.js + health.js). Tapping a day's dot highlights the column and
 * opens the day editor; tapping the same column again closes it. The most
 * recent day starts highlighted (without opening the editor), matching the
 * old auto-select.
 */
export function SymptomTrackerCard({
  days,
  definitions,
  onLogSymptoms,
  onSetFoodNotes,
  onSaveDefinitions,
}: SymptomTrackerCardProps) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [scrollNonce, setScrollNonce] = useState(0);

  // Auto-select (highlight only) the most recent day once data arrives.
  const autoSelected = useRef(false);
  useEffect(() => {
    if (autoSelected.current || !days.length) return;
    autoSelected.current = true;
    setSelectedDate(days[days.length - 1].date);
  }, [days]);

  function selectDay(date: string) {
    if (selectedDate === date) {
      // Same column tapped again — deselect and close the editor.
      setSelectedDate(null);
      setEditingDate(null);
      return;
    }
    setSelectedDate(date);
    setEditingDate(date);
  }

  function toggleNoseSpray(date: string, currentlyUsed: boolean) {
    onLogSymptoms(date, { nose_spray: currentlyUsed ? 0 : 1 });
  }

  function saveDay(date: string, symptoms: Record<string, number>, foodNotes: string) {
    onLogSymptoms(date, symptoms);
    onSetFoodNotes(
      date,
      foodNotes
        .split(';')
        .map((f) => f.trim())
        .filter(Boolean),
    );
    setEditingDate(null);
  }

  const editingDay = editingDate ? days.find((d) => d.date === editingDate) || null : null;

  return (
    <CollapsibleCard
      cardKey="symptoms"
      title="Symptom Tracker"
      defaultOpen
      onToggle={(open) => {
        if (open) setScrollNonce((n) => n + 1);
      }}
    >
      <div className={styles.hint}>Tap any day to edit its symptoms and food.</div>
      <DotGrid
        days={days}
        definitions={definitions}
        selectedDate={selectedDate}
        onSelectDay={selectDay}
        onToggleNoseSpray={toggleNoseSpray}
        scrollNonce={scrollNonce}
      />
      {editingDay ? (
        <DayEditor
          key={editingDay.date}
          day={editingDay}
          definitions={definitions}
          onClose={() => setEditingDate(null)}
          onSave={saveDay}
        />
      ) : null}
      <SymptomDefinitionsEditor definitions={definitions} onSave={onSaveDefinitions} />
    </CollapsibleCard>
  );
}
