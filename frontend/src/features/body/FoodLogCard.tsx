import { useEffect, useRef, useState } from 'react';
import { CollapsibleCard } from './CollapsibleCard';
import {
  canExpandFoodLog,
  foodBadgeColor,
  foodDayLabel,
  foodItemsForDate,
  foodLogDates,
  removeFoodItem,
  replaceFoodItem,
} from './foodLogHelpers';
import type { PushToastOptions } from './useBodyData';
import type { BodyHealthDay, FoodGuide, SafetyTag } from './types';
import styles from './FoodLogCard.module.css';

export interface FoodLogCardProps {
  healthData: BodyHealthDay[];
  serverDate: string;
  safetyTags: Record<string, SafetyTag> | undefined;
  foodGuide: FoodGuide | undefined;
  onSetFood: (date: string, foods: string[]) => void;
  onAddFood: (food: string) => void;
  pushToast: (message: string, opts?: PushToastOptions) => void;
}

/**
 * Food Log card — port of food.js renderFoodLog. Today gets a full card with
 * an add box; past days are compact one-liners, each expandable (one at a
 * time) into the same editable list via its Edit toggle. Deleting an item is
 * two-step (× → Sure?) and undoable via toast.
 */
export function FoodLogCard({
  healthData,
  serverDate,
  safetyTags,
  foodGuide,
  onSetFood,
  onAddFood,
  pushToast,
}: FoodLogCardProps) {
  const [daysBack, setDaysBack] = useState(3);
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [addValue, setAddValue] = useState('');
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  useEffect(() => {
    if (editingIdx !== null) editInputRef.current?.focus();
  }, [editingIdx]);

  const earliest = healthData.length ? healthData[0].date : serverDate;
  const dates = foodLogDates(serverDate, daysBack, earliest);
  const pastDates = dates.filter((d) => d !== serverDate);
  const canExpand = canExpandFoodLog(dates, earliest);
  const canCollapse = daysBack > 3;

  const badge = (item: string) => {
    const color = foodBadgeColor(item, safetyTags, foodGuide);
    return color ? <span className={styles.badge} style={{ background: color }} /> : null;
  };

  function toggleDayEdit(date: string) {
    setEditingDate((cur) => (cur === date ? null : date));
    setEditingIdx(null);
    setConfirmKey(null);
  }

  function startItemEdit(idx: number, current: string) {
    setEditingIdx(idx);
    setEditValue(current);
  }

  function saveItemEdit(date: string, idx: number) {
    const foods = foodItemsForDate(healthData, date);
    onSetFood(date, replaceFoodItem(foods, idx, editValue));
    setEditingIdx(null);
  }

  function deleteItem(date: string, idx: number) {
    const key = `${date}:${idx}`;
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmKey !== key) {
      // First tap arms the ×; it disarms after 3s.
      setConfirmKey(key);
      confirmTimer.current = setTimeout(() => setConfirmKey(null), 3000);
      return;
    }
    setConfirmKey(null);
    const foods = foodItemsForDate(healthData, date);
    const removed = foods[idx];
    onSetFood(date, removeFoodItem(foods, idx));
    pushToast(`Removed "${removed}"`, {
      tone: 'info',
      actionLabel: 'Undo',
      onAction: () => onSetFood(date, foods),
    });
  }

  function submitAdd() {
    const food = addValue.trim();
    if (!food) return;
    onAddFood(food);
    setAddValue('');
  }

  const renderEditableItems = (date: string, foods: string[]) => {
    if (!foods.length) return <div className={styles.emptyDay}>No food logged</div>;
    return foods.map((item, idx) => {
      if (editingIdx === idx) {
        return (
          <div className={styles.itemEditing} key={idx}>
            <input
              ref={editInputRef}
              type="text"
              className={styles.itemInput}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveItemEdit(date, idx);
                if (e.key === 'Escape') setEditingIdx(null);
              }}
            />
            <button
              type="button"
              className={styles.itemSave}
              title="Save"
              aria-label="Save"
              onClick={() => saveItemEdit(date, idx)}
            >
              &#10003;
            </button>
            <button
              type="button"
              className={styles.itemDel}
              title="Cancel"
              aria-label="Cancel"
              onClick={() => setEditingIdx(null)}
            >
              &times;
            </button>
          </div>
        );
      }
      const key = `${date}:${idx}`;
      return (
        <div className={styles.item} key={idx}>
          <button type="button" className={styles.itemText} onClick={() => startItemEdit(idx, item)}>
            {badge(item)}
            {item}
          </button>
          <button
            type="button"
            className={`${styles.itemDel} ${confirmKey === key ? styles.itemDelSure : ''}`}
            title={confirmKey === key ? 'Confirm delete' : 'Delete'}
            aria-label={confirmKey === key ? 'Confirm delete' : 'Delete'}
            onClick={() => deleteItem(date, idx)}
          >
            {confirmKey === key ? 'Sure?' : <>&times;</>}
          </button>
        </div>
      );
    });
  };

  const todayFoods = foodItemsForDate(healthData, serverDate);
  const todayEditing = editingDate === serverDate;

  return (
    <CollapsibleCard cardKey="foodlog" title="Food Log">
      {canExpand || canCollapse ? (
        <div className={styles.moreRow}>
          {canExpand ? (
            <button type="button" className={styles.moreBtn} onClick={() => setDaysBack((n) => n + 7)}>
              &#8593; Show earlier days
            </button>
          ) : null}
          {canCollapse ? (
            <button type="button" className={styles.moreBtn} onClick={() => setDaysBack(3)}>
              &#8595; Hide earlier days
            </button>
          ) : null}
        </div>
      ) : null}

      {pastDates.length ? (
        <div className={styles.pastCard}>
          {pastDates.map((date) => {
            const foods = foodItemsForDate(healthData, date);
            const label = foodDayLabel(date);
            if (editingDate === date) {
              return (
                <div className={styles.pastEditing} key={date}>
                  <div className={styles.pastEditHead}>
                    <span className={styles.pastLabel}>{label}</span>
                    <button type="button" className={styles.dayEditBtn} onClick={() => toggleDayEdit(date)}>
                      Done
                    </button>
                  </div>
                  {renderEditableItems(date, foods)}
                </div>
              );
            }
            return (
              <div className={styles.pastRow} key={date}>
                <span className={styles.pastLabel}>{label}</span>
                <span className={styles.pastFoods}>
                  {foods.length ? (
                    foods.map((item, i) => (
                      <span key={i}>
                        {badge(item)}
                        {item}
                        {i < foods.length - 1 ? <span className={styles.comma}>, </span> : null}
                      </span>
                    ))
                  ) : (
                    <span className={styles.emptyDash}>&mdash;</span>
                  )}
                </span>
                <button
                  type="button"
                  className={styles.dayEditBtn}
                  title="Edit this day's food log"
                  onClick={() => toggleDayEdit(date)}
                >
                  Edit
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className={styles.todayCard}>
        <div className={styles.todayHead}>
          <span className={styles.todayLabel}>Today</span>
          {todayFoods.length ? (
            <button type="button" className={styles.dayEditBtn} onClick={() => toggleDayEdit(serverDate)}>
              {todayEditing ? 'Done' : 'Edit'}
            </button>
          ) : null}
        </div>
        {todayEditing ? (
          renderEditableItems(serverDate, todayFoods)
        ) : (
          todayFoods.map((item, i) => (
            <div className={styles.item} key={i}>
              <span className={styles.itemTextStatic}>
                {badge(item)}
                {item}
              </span>
            </div>
          ))
        )}
        <div className={styles.addRow}>
          <input
            type="text"
            className={styles.addInput}
            placeholder="What did you eat..."
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitAdd();
            }}
          />
          <button type="button" className={styles.addBtn} onClick={submitAdd}>
            Add
          </button>
        </div>
      </div>
    </CollapsibleCard>
  );
}
