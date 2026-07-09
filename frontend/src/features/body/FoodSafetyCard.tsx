import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { CollapsibleCard } from './CollapsibleCard';
import { displayName, taggedFoods } from './triageHelpers';
import type { PushToastOptions } from './useBodyData';
import type { SafetyTag } from './types';
import styles from './FoodSafetyCard.module.css';

export interface FoodSafetyCardProps {
  safetyTags: Record<string, SafetyTag> | undefined;
  onTag: (name: string, tag: SafetyTag | '') => void;
  pushToast: (message: string, opts?: PushToastOptions) => void;
}

const CLOUDS: Array<{ tag: SafetyTag; heading: string; headingClass: string; empty: string }> = [
  {
    tag: 'safe',
    heading: 'Confirmed safe',
    headingClass: 'headSafe',
    empty: 'No foods marked safe yet. Triage a food as ✓ Safe, or drag one here in Edit.',
  },
  {
    tag: 'suspect',
    heading: 'Suspect',
    headingClass: 'headSuspect',
    empty: 'No suspect foods flagged. Triage a food as ⚠ Suspect, or drag one here in Edit.',
  },
  {
    tag: 'inflammatory',
    heading: 'Inflammatory',
    headingClass: 'headInflammatory',
    empty: 'No inflammatory foods flagged. Triage a food as 🔥 Inflammatory, or drag one here in Edit.',
  },
];

const MOVE_TARGETS: Array<{ tag: SafetyTag; label: string; className: string }> = [
  { tag: 'safe', label: '✓ Safe', className: 'menuSafe' },
  { tag: 'suspect', label: '⚠ Suspect', className: 'menuSuspect' },
  { tag: 'inflammatory', label: '🔥 Inflammatory', className: 'menuInflammatory' },
];

/**
 * Food sensitivities card — port of the kitchen.js safety chip clouds
 * (renderSafeFoods/renderSuspectFoods/renderInflammatoryFoods +
 * toggleFoodSafetyEdit). View mode is plain chips; Edit mode adds per-chip
 * ⇅ move menus, × clear (undoable via toast), and drag-between-clouds.
 */
export function FoodSafetyCard({ safetyTags, onTag, pushToast }: FoodSafetyCardProps) {
  const [editing, setEditing] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dragName, setDragName] = useState<string | null>(null);
  const [dragOverTag, setDragOverTag] = useState<SafetyTag | null>(null);
  const menuRef = useRef<HTMLSpanElement>(null);

  // Dismiss the move menu on any outside click.
  useEffect(() => {
    if (!menuFor) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current || !menuRef.current.contains(e.target as Node)) setMenuFor(null);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuFor]);

  function reTag(name: string, from: SafetyTag, to: SafetyTag | '') {
    setMenuFor(null);
    if (to === from) return;
    onTag(name, to);
    if (to === '') {
      pushToast(`Cleared tag on "${displayName(name)}"`, {
        tone: 'info',
        actionLabel: 'Undo',
        onAction: () => onTag(name, from),
      });
    }
  }

  function handleDrop(e: DragEvent, tag: SafetyTag) {
    e.preventDefault();
    setDragOverTag(null);
    const name = dragName || e.dataTransfer.getData('text/plain');
    if (!name) return;
    const from = (safetyTags || {})[name.toLowerCase()];
    if (from) reTag(name, from, tag);
    setDragName(null);
  }

  const editBtn = (
    <button
      type="button"
      className={styles.editBtn}
      onClick={(e) => {
        // Lives inside <summary> — don't let the tap also collapse the card.
        e.preventDefault();
        e.stopPropagation();
        setEditing((v) => !v);
        setMenuFor(null);
      }}
    >
      {editing ? 'Done' : 'Edit'}
    </button>
  );

  return (
    <CollapsibleCard cardKey="foodsafety" title="Food sensitivities" titleExtra={editBtn}>
      {CLOUDS.map(({ tag, heading, headingClass, empty }) => {
        const items = taggedFoods(safetyTags, tag);
        return (
          <div key={tag}>
            <div className={`${styles.heading} ${styles[headingClass]}`}>{heading}</div>
            <div
              className={[
                styles.cloud,
                editing ? styles.cloudEditing : '',
                dragOverTag === tag ? styles.cloudDragOver : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onDragOver={
                editing
                  ? (e) => {
                      e.preventDefault();
                      setDragOverTag(tag);
                    }
                  : undefined
              }
              onDragLeave={editing ? () => setDragOverTag(null) : undefined}
              onDrop={editing ? (e) => handleDrop(e, tag) : undefined}
            >
              {items.length ? (
                <div className={styles.chips}>
                  {items.map((name) => {
                    const menuKey = `${tag}:${name}`;
                    return (
                      <span
                        key={name}
                        className={`${styles.chip} ${styles[`chip_${tag}`]}`}
                        draggable={editing}
                        onDragStart={(e) => {
                          setDragName(name);
                          e.dataTransfer.effectAllowed = 'move';
                          try {
                            e.dataTransfer.setData('text/plain', name);
                          } catch {
                            // some browsers refuse setData mid-drag — state carries it
                          }
                        }}
                        onDragEnd={() => {
                          setDragName(null);
                          setDragOverTag(null);
                        }}
                        ref={menuFor === menuKey ? menuRef : undefined}
                      >
                        {displayName(name)}
                        {editing ? (
                          <>
                            <button
                              type="button"
                              className={styles.chipBtn}
                              title="Move to another list"
                              aria-label={`Move ${name} to another list`}
                              onClick={() => setMenuFor((cur) => (cur === menuKey ? null : menuKey))}
                            >
                              &#8645;
                            </button>
                            <button
                              type="button"
                              className={styles.chipBtn}
                              title="Clear tag"
                              aria-label={`Clear tag on ${name}`}
                              onClick={() => reTag(name, tag, '')}
                            >
                              &times;
                            </button>
                            {menuFor === menuKey ? (
                              <span className={styles.moveMenu}>
                                {MOVE_TARGETS.filter((t) => t.tag !== tag).map((t) => (
                                  <button
                                    key={t.tag}
                                    type="button"
                                    className={`${styles.moveMenuBtn} ${styles[t.className]}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      reTag(name, tag, t.tag);
                                    }}
                                  >
                                    {t.label}
                                  </button>
                                ))}
                              </span>
                            ) : null}
                          </>
                        ) : null}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.empty}>{empty}</div>
              )}
            </div>
          </div>
        );
      })}
    </CollapsibleCard>
  );
}
