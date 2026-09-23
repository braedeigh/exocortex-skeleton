/**
 * CoilHoverCard — rest the mouse on a coil's centre (or tap it with a finger)
 * and a card says what the coil is showing, and lets her choose the sizes it
 * opens to.
 *
 * Top half, read-only: the folder and its repo, how much of it is out ("53 of
 * 685") and how far back that reaches, and where each dot's moment comes from
 * — the filename, or when she last edited it — since those make two different
 * coils out of the same shape (coilFolders.ts explains the difference).
 *
 * Bottom half, the steps: one chip per size the coil can open to. A pull on
 * the curve at the coil's tip widens it to the next one on; a tap on its centre
 * collapses it to the first. Save writes them to her terrain_coils.json
 * (routes/terrain.py `_set_coil_windows`) and fetches the map again. A visitor
 * gets the top half only — the save route is owner-only.
 *
 * A FINGER CAN'T HOVER, so on touch the first tap on a centre opens this card
 * instead of collapsing the coil, and the card carries a Collapse button — the
 * same "first tap picks it out, the next acts" the orbs and tables already use.
 * With a mouse, the click collapses and the card comes from hover.
 *
 * The show/hide timing lives in useCoilCard.ts. Placement is the agent card's
 * (agentHoverPlacement.ts), which is why the width here must match that file.
 *
 * Wired up by TerrainPage.tsx, fed by terrainCanvas.ts (`onHoverCoil`,
 * `screenAnchorOf`).
 *
 * Prompt that produced it: "maybe i can hover over it for a popup to edit the
 * display information here" → "i want the hover popup to show both read only
 * details and setting the coil steps."
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { TERRAIN_KEY } from './api';
import { hoverCardPlacement } from './agentHoverPlacement';
import type { CoilCardState } from './useCoilCard';
import { coilWindowLabel, type CoilView } from './coilFolders';
import styles from './CoilHoverCard.module.css';

/** The sizes offered as chips. A step she has in her file that isn't one of
 * these still shows, beside them. */
const PRESET_STEPS: readonly (number | null)[] = [7, 14, 31, 92, 183, 365, null];

/** A size as a comparable number — "everything" is the widest. */
function reach(days: number | null): number {
  return days === null ? Infinity : days;
}

interface Props {
  card: CoilCardState | null;
  coil: CoilView | undefined;
  /** A visitor sees the details and nothing to save. */
  readOnly: boolean;
  onEngage: (inside: boolean) => void;
  onCollapse: () => void;
  onClose: () => void;
}

export function CoilHoverCard({ card, coil, readOnly, onEngage, onCollapse, onClose }: Props) {
  const queryClient = useQueryClient();
  const [steps, setSteps] = useState<(number | null)[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start from the coil's own steps each time the card opens on a coil.
  const savedKey = coil ? coil.windows.map(String).join(',') : '';
  useEffect(() => {
    setSteps(coil ? [...coil.windows] : []);
    setError(null);
  }, [coil?.folderId, savedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!card || !coil) return null;

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const { left, top } = hoverCardPlacement(card.anchor, viewport);
  const folderName = coil.prefix.replace(/\/$/, '').split('/').pop() ?? coil.prefix;
  const reachesBack =
    coil.oldestShownAt === null
      ? null
      : new Date(coil.oldestShownAt * 1000).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });

  // The chips: every preset, plus any size already in her file that isn't one.
  const chips = [...PRESET_STEPS, ...coil.windows.filter((w) => !PRESET_STEPS.includes(w))].sort(
    (a, b) => reach(a) - reach(b),
  );
  const sorted = [...steps].sort((a, b) => reach(a) - reach(b));
  const changed = sorted.map(String).join(',') !== savedKey;

  const toggle = (step: number | null) => {
    setSteps((now) => (now.includes(step) ? now.filter((s) => s !== step) : [...now, step]));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.post('/api/observatory/terrain/coils/windows', {
        repo: coil.repoId,
        prefix: coil.prefix,
        windows: sorted,
      });
      await queryClient.invalidateQueries({ queryKey: TERRAIN_KEY });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className={styles.card}
      style={{ left, top }}
      onPointerEnter={() => onEngage(true)}
      onPointerLeave={() => onEngage(false)}
      role="dialog"
      aria-label={`Coil: ${folderName}`}
    >
      <div className={styles.head}>
        <div>
          <div className={styles.title}>{folderName}</div>
          <div className={styles.path}>
            {coil.repoId} · {coil.prefix}
          </div>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <dl className={styles.facts}>
        <dt>Showing</dt>
        <dd>
          {coil.shown} of {coil.total} · open to {coilWindowLabel(coil.windowDays)}
        </dd>
        {reachesBack && (
          <>
            <dt>Back to</dt>
            <dd>{reachesBack}</dd>
          </>
        )}
        <dt>Dated by</dt>
        <dd>{coil.time === 'stamp' ? 'the date in each filename' : 'when you last edited it'}</dd>
      </dl>

      {card.pinned && (
        <button type="button" className={styles.action} onClick={onCollapse}>
          Collapse to {coilWindowLabel(coil.collapseTo)}
        </button>
      )}

      {!readOnly && (
        <div className={styles.steps}>
          <div className={styles.stepsLabel}>
            Sizes it opens to — pull the tip to widen, tap the centre to collapse
          </div>
          <div className={styles.chips}>
            {chips.map((step) => (
              <button
                key={String(step)}
                type="button"
                className={steps.includes(step) ? `${styles.chip} ${styles.chipOn}` : styles.chip}
                aria-pressed={steps.includes(step)}
                onClick={() => toggle(step)}
              >
                {coilWindowLabel(step)}
              </button>
            ))}
          </div>
          <div className={styles.saveRow}>
            {error && <span className={styles.error}>{error}</span>}
            <button
              type="button"
              className={styles.action}
              disabled={!changed || steps.length === 0 || saving}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save sizes'}
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
