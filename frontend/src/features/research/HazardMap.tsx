/**
 * HazardMap.tsx — the hazard map, on TablesPage.tsx behind "hazard map": every
 * hazard her tables can hold, arranged into families she decides. Contaminant
 * → heavy metal → lead, or however she wants it.
 *
 * Drawn as an indented list (tableMath.mapLines). A hazard with two parents is
 * drawn under both — DDE under Pesticide and under Persistent organic
 * pollutant — because that is what the map says. Tapping a line opens it for
 * editing: rename it, change which families it belongs to (tap a family to
 * add or remove it; ones that would make a loop aren't offered), give it a
 * member, or remove it (the server refuses while any number uses it).
 *
 * Grids group their columns by this map, so rearranging it rearranges every
 * table at once; no number moves. Writes go through useTablesMutations; the
 * server (routes/research_tables.py → hazardstore.py) refuses loops and
 * duplicate names with a message that lands as a toast.
 */

import { useState } from 'react';
import { hazardAndBelow, mapLines } from './tableMath';
import type { Hazard } from './types';
import { useHazards, type useTablesMutations } from './useTablesData';
import pageStyles from './ResearchPage.module.css';
import claimStyles from './ClaimsPage.module.css';
import styles from './TablesPage.module.css';

type Mutations = ReturnType<typeof useTablesMutations>;

export function HazardMap({ mutations }: { mutations: Mutations }) {
  const query = useHazards();
  const hazards = query.data?.hazards ?? [];
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  if (query.isLoading) return <div className={pageStyles.loading}>Loading&hellip;</div>;

  return (
    <div className={`${claimStyles.claimCard} ${styles.map}`}>
      <div className={claimStyles.valueLine}>
        Every grid groups its columns by this map. A hazard can belong to more than one family; rearranging moves no numbers.
      </div>

      {/* An empty map offers the starter families: contaminant → heavy metal, pesticide, persistent pollutant. */}
      {hazards.length === 0 ? (
        <div className={styles.formButtons}>
          <span className={claimStyles.emptyNote}>The map is empty.</span>
          <button
            type="button"
            className={pageStyles.primaryBtn}
            disabled={mutations.seedHazards.isPending}
            onClick={() => mutations.seedHazards.mutate()}
          >
            Plant the starter map
          </button>
        </div>
      ) : null}
      {mapLines(hazards).map((line) => (
        <div key={line.key}>
          <button
            type="button"
            className={`${styles.mapLine} ${openKey === line.key ? styles.mapLineOpen : ''}`}
            style={{ paddingLeft: 14 + line.depth * 22 }}
            onClick={() => setOpenKey(openKey === line.key ? null : line.key)}
          >
            <span className={styles.mapName}>
              {line.depth ? '└ ' : ''}
              {line.hazard.name}
            </span>
            {line.hazard.names.length ? <span className={styles.cellSub}>also: {line.hazard.names.join(', ')}</span> : null}
            {line.hazard.parents.length > 1 ? <span className={styles.cellSub}>in {line.hazard.parents.length} families</span> : null}
            {line.hazard.measure_count ? <span className={styles.more}>{line.hazard.measure_count}</span> : null}
          </button>
          {openKey === line.key ? (
            <HazardEditor hazard={line.hazard} hazards={hazards} mutations={mutations} onDone={() => setOpenKey(null)} />
          ) : null}
        </div>
      ))}

      {/* A new family at the top of the map. Members are added from a family's own line. */}
      <div className={styles.addRow}>
        <input
          className={pageStyles.input}
          value={newName}
          placeholder="new top-level family, e.g. Allergen"
          onChange={(event) => setNewName(event.target.value)}
        />
        <button
          type="button"
          className={pageStyles.primaryBtn}
          disabled={!newName.trim() || mutations.addHazard.isPending}
          onClick={() => mutations.addHazard.mutate({ name: newName.trim(), parents: [] }, { onSuccess: () => setNewName('') })}
        >
          Add
        </button>
      </div>
    </div>
  );
}

/** One hazard opened for editing: name, families, a new member, removal. */
function HazardEditor({
  hazard,
  hazards,
  mutations,
  onDone,
}: {
  hazard: Hazard;
  hazards: Hazard[];
  mutations: Mutations;
  onDone: () => void;
}) {
  const [name, setName] = useState(hazard.name);
  const [member, setMember] = useState('');
  const [confirming, setConfirming] = useState(false);
  // A hazard can't join a family that is already one of its own members.
  const below = hazardAndBelow(hazards, hazard.id);
  const families = hazards
    .filter((other) => !below.has(other.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const toggleParent = (id: number) => {
    const parents = hazard.parents.includes(id) ? hazard.parents.filter((p) => p !== id) : [...hazard.parents, id];
    mutations.updateHazard.mutate({ id: hazard.id, parents });
  };

  return (
    <div className={styles.editor}>
      <div className={styles.addRow}>
        <input className={pageStyles.input} value={name} onChange={(event) => setName(event.target.value)} aria-label="Name" />
        <button
          type="button"
          className={pageStyles.outlineBtn}
          disabled={!name.trim() || name.trim() === hazard.name}
          onClick={() => mutations.updateHazard.mutate({ id: hazard.id, name: name.trim() })}
        >
          Rename
        </button>
      </div>

      <div className={styles.fieldLabel}>Belongs to</div>
      <div className={claimStyles.pillRow}>
        {families.map((family) => (
          <button
            type="button"
            key={family.id}
            className={`${pageStyles.chip} ${hazard.parents.includes(family.id) ? pageStyles.chipActive : ''}`}
            onClick={() => toggleParent(family.id)}
          >
            {family.name}
          </button>
        ))}
      </div>

      <div className={styles.addRow}>
        <input
          className={pageStyles.input}
          value={member}
          placeholder={`a new kind of ${hazard.name.toLowerCase()}`}
          onChange={(event) => setMember(event.target.value)}
        />
        <button
          type="button"
          className={pageStyles.outlineBtn}
          disabled={!member.trim()}
          onClick={() => mutations.addHazard.mutate({ name: member.trim(), parents: [hazard.id] }, { onSuccess: () => setMember('') })}
        >
          Add member
        </button>
      </div>

      {/* Removing is destructive, so it asks once more. */}
      <div className={styles.formButtons}>
        {confirming ? (
          <>
            <button
              type="button"
              className={`${pageStyles.chip} ${pageStyles.chipSure}`}
              onClick={() => mutations.deleteHazard.mutate(hazard.id, { onSuccess: onDone })}
            >
              remove {hazard.name}?
            </button>
            <button type="button" className={pageStyles.chip} onClick={() => setConfirming(false)}>
              keep it
            </button>
          </>
        ) : (
          <button
            type="button"
            className={`${pageStyles.chip} ${pageStyles.chipDanger}`}
            disabled={hazard.measure_count > 0}
            title={hazard.measure_count ? 'Numbers use this hazard; it stays while they do.' : undefined}
            onClick={() => setConfirming(true)}
          >
            remove from map
          </button>
        )}
      </div>
    </div>
  );
}
