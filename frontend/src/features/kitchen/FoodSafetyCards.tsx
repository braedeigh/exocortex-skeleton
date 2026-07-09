/**
 * FoodSafetyCards.tsx — the safety chip clouds ("Food sensitivities") and the
 * "Triage foods" list. Ports of kitchen.js's _renderSafetyCloud/reTagFood/
 * renderFoodTriage. In the old app these rendered on the BODY tab (the data
 * lives in kitchen.json); exported here so the Body-tab port can mount them.
 */
import { useRef, useState } from 'react';
import { setSafetyTag } from './api';
import { capitalize } from './catalogHelpers';
import { daysAgoLabel } from './historyHelpers';
import { useDismiss } from '../../shell/useDismiss';
import styles from './kitchen.module.css';

export type SafetyCloudTag = 'safe' | 'suspect' | 'inflammatory';

const TAG_META: Record<SafetyCloudTag, { color: string; bg: string; border: string; label: string }> = {
  safe: { color: 'var(--green)', bg: 'rgba(58,158,140,0.10)', border: 'rgba(58,158,140,0.35)', label: '✓ Safe' },
  suspect: { color: 'var(--orange)', bg: 'rgba(212,140,68,0.10)', border: 'rgba(212,140,68,0.35)', label: '⚠ Suspect' },
  inflammatory: { color: '#c2185b', bg: 'rgba(194,24,91,0.10)', border: 'rgba(194,24,91,0.35)', label: '🔥 Inflammatory' },
};

export interface FoodSafetyCloudsProps {
  safetyTags: Record<string, string>;
  editing: boolean;
  onError: (message: string) => void;
  /** invalidate the owning query after a re-tag */
  invalidate: () => void;
}

function MoveMenu({ current, onPick, onClose }: { current: SafetyCloudTag; onPick: (tag: SafetyCloudTag) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, ref);
  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        marginTop: 4,
        zIndex: 50,
        background: 'var(--card-bg)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 4,
        boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      {(Object.keys(TAG_META) as SafetyCloudTag[])
        .filter((t) => t !== current)
        .map((t) => (
          <button
            key={t}
            type="button"
            style={{
              textAlign: 'left',
              padding: '8px 12px',
              fontSize: 12,
              border: 'none',
              background: 'none',
              color: TAG_META[t].color,
              cursor: 'pointer',
              borderRadius: 4,
              whiteSpace: 'nowrap',
              fontWeight: 600,
              minHeight: 40,
            }}
            onClick={(e) => {
              e.stopPropagation();
              onPick(t);
            }}
          >
            {TAG_META[t].label}
          </button>
        ))}
    </div>
  );
}

/** Three chip clouds (Safe / Suspect / Inflammatory) with edit-mode drag
 * between clouds, a ⇅ move menu, and × to clear the tag. */
export function FoodSafetyClouds({ safetyTags, editing, onError, invalidate }: FoodSafetyCloudsProps) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const dragName = useRef<string | null>(null);
  const [dragOverTag, setDragOverTag] = useState<SafetyCloudTag | null>(null);

  async function reTag(name: string, tag: string) {
    setMenuFor(null);
    try {
      await setSafetyTag(name, tag);
    } catch (e) {
      onError(`Couldn't save tag: ${e instanceof Error ? e.message : e}`);
    }
    invalidate();
  }

  function cloud(tag: SafetyCloudTag, empty: string) {
    const items = Object.entries(safetyTags)
      .filter(([, t]) => t === tag)
      .map(([n]) => n)
      .sort();
    const meta = TAG_META[tag];
    return (
      <div
        style={{
          minHeight: editing ? 38 : undefined,
          border: editing ? '1px dashed var(--border)' : undefined,
          outline: dragOverTag === tag ? '2px dashed var(--accent)' : undefined,
          outlineOffset: -2,
          borderRadius: 8,
          padding: editing ? '2px 8px' : undefined,
        }}
        onDragOver={
          editing
            ? (e) => {
                e.preventDefault();
                setDragOverTag(tag);
              }
            : undefined
        }
        onDragLeave={editing ? () => setDragOverTag(null) : undefined}
        onDrop={
          editing
            ? (e) => {
                e.preventDefault();
                setDragOverTag(null);
                const name = dragName.current || e.dataTransfer.getData('text/plain');
                if (name) void reTag(name, tag);
              }
            : undefined
        }
      >
        {items.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, padding: '6px 0' }}>
            {items.map((name) => (
              <span
                key={name}
                draggable={editing}
                onDragStart={(e) => {
                  dragName.current = name;
                  e.dataTransfer.effectAllowed = 'move';
                  try {
                    e.dataTransfer.setData('text/plain', name);
                  } catch {
                    // some browsers restrict setData
                  }
                }}
                onDragEnd={() => {
                  dragName.current = null;
                  setDragOverTag(null);
                }}
                style={{
                  position: 'relative',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '8px 10px',
                  border: `1px solid ${meta.border}`,
                  borderRadius: 14,
                  background: meta.bg,
                  color: meta.color,
                  fontSize: 13,
                  margin: 3,
                  cursor: editing ? 'grab' : undefined,
                  minHeight: editing ? 40 : undefined,
                }}
              >
                {capitalize(name)}
                {editing ? (
                  <>
                    <button
                      type="button"
                      title="Move to another list"
                      style={{ background: 'none', border: 'none', color: meta.color, opacity: 0.65, fontSize: 14, cursor: 'pointer', lineHeight: 1, padding: '4px 6px', minWidth: 32, minHeight: 32 }}
                      onClick={() => setMenuFor(menuFor === `${tag}:${name}` ? null : `${tag}:${name}`)}
                    >
                      &#8645;
                    </button>
                    <button
                      type="button"
                      title="Clear tag"
                      style={{ background: 'none', border: 'none', color: meta.color, opacity: 0.65, fontSize: 15, cursor: 'pointer', lineHeight: 1, padding: '4px 6px', minWidth: 32, minHeight: 32 }}
                      onClick={() => void reTag(name, '')}
                    >
                      &times;
                    </button>
                    {menuFor === `${tag}:${name}` ? (
                      <MoveMenu current={tag} onPick={(t) => void reTag(name, t)} onClose={() => setMenuFor(null)} />
                    ) : null}
                  </>
                ) : null}
              </span>
            ))}
          </div>
        ) : (
          <div className={styles.muted13} style={{ padding: '8px 0', fontStyle: 'italic' }}>
            {empty}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--green)', margin: '8px 0 2px' }}>Confirmed safe</div>
      {cloud('safe', 'No foods marked safe yet. Triage a food as ✓ Safe, or drag one here in Edit.')}
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--orange)', margin: '14px 0 2px' }}>Suspect</div>
      {cloud('suspect', 'No suspect foods flagged. Triage a food as ⚠ Suspect, or drag one here in Edit.')}
      <div style={{ fontSize: 13, fontWeight: 600, color: '#c2185b', margin: '14px 0 2px' }}>Inflammatory</div>
      {cloud('inflammatory', 'No inflammatory foods flagged. Triage a food as 🔥 Inflammatory, or drag one here in Edit.')}
    </>
  );
}

export interface FoodTriageCardProps {
  knownItems: Record<string, string>;
  safetyTags: Record<string, string>;
  purchaseCounts: Record<string, number>;
  lastBought: Record<string, string>;
  onError: (message: string) => void;
  invalidate: () => void;
}

/** "Triage foods" — untagged catalog items, most-bought first, with one-tap
 * Safe / Suspect / Inflammatory buttons. */
export function FoodTriageCard({ knownItems, safetyTags, purchaseCounts, lastBought, onError, invalidate }: FoodTriageCardProps) {
  const items = Object.keys(knownItems)
    .filter((name) => !safetyTags[name])
    .map((name) => {
      const lb = lastBought[name] || null;
      const days = lb ? Math.round((Date.now() - new Date(lb + 'T12:00:00').getTime()) / 86400000) : null;
      return { name, count: purchaseCounts[name] || 0, daysSince: days };
    })
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));

  async function mark(name: string, tag: SafetyCloudTag) {
    try {
      await setSafetyTag(name, tag);
    } catch (e) {
      onError(`Couldn't save tag: ${e instanceof Error ? e.message : e}`);
    }
    invalidate();
  }

  if (!items.length) {
    return (
      <div style={{ color: 'var(--green)', fontSize: 13, padding: '8px 0', fontStyle: 'italic' }}>
        🎉 Every food in your catalog is tagged. Nice triage work.
      </div>
    );
  }

  return (
    <>
      <div className={styles.muted12} style={{ marginBottom: 10 }}>
        {items.length} food{items.length === 1 ? '' : 's'} waiting to be triaged. Tap{' '}
        <b style={{ color: 'var(--green)' }}>✓ Safe</b> when you&apos;ve confirmed it doesn&apos;t bother you,{' '}
        <b style={{ color: 'var(--orange)' }}>⚠ Suspect</b> when you think it might,{' '}
        <b style={{ color: '#c2185b' }}>🔥 Inflammatory</b> for known inflammatory triggers. Most-bought items first.
      </div>
      <div style={{ maxHeight: '60vh', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: '4px 12px' }}>
        {items.map((it) => {
          const meta: string[] = [];
          if (it.count) meta.push(`bought ${it.count}×`);
          if (it.daysSince != null) meta.push(daysAgoLabel(it.daysSince));
          return (
            <div key={it.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 4px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <span style={{ flex: 1, fontSize: 14, minWidth: 120 }}>
                {capitalize(it.name)}
                {meta.length ? <span className={styles.muted12} style={{ marginLeft: 8 }}>{meta.join(' · ')}</span> : null}
              </span>
              <button
                type="button"
                title="Mark confirmed safe"
                style={{ padding: '5px 12px', border: '1px solid var(--green)', background: 'none', color: 'var(--green)', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 40 }}
                onClick={() => void mark(it.name, 'safe')}
              >
                &#10003; Safe
              </button>
              <button
                type="button"
                title="Mark suspect"
                style={{ padding: '5px 12px', border: '1px solid var(--orange)', background: 'none', color: 'var(--orange)', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 40 }}
                onClick={() => void mark(it.name, 'suspect')}
              >
                &#9888; Suspect
              </button>
              <button
                type="button"
                title="Mark known inflammatory"
                style={{ padding: '5px 12px', border: '1px solid #c2185b', background: 'none', color: '#c2185b', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 40 }}
                onClick={() => void mark(it.name, 'inflammatory')}
              >
                &#128293; Inflammatory
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
