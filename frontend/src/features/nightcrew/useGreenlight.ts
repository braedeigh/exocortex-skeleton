import { useState } from 'react';

/**
 * useGreenlight — the moon button's brain, shared by every dev-notes surface.
 *
 * Plain English: tapping the moon on a dev note marks it as work for the night
 * crew. This holds the "which notes are lit" state and talks to the server, so
 * the two places that draw dev notes (the journal's DevNotesPanel and the
 * shared NotesPanel every other tab uses) behave identically instead of
 * drifting apart.
 *
 * IT REPORTS REFUSALS. She's allowed to light the wrong note — the real guard
 * is tools/nightcrew/triage.py, and a tap it won't accept has to say so on the
 * spot. Waiting a whole night to find out nothing happened is the one failure
 * this hook exists to prevent.
 *
 * Optimistic on the way out, reverted if the request fails: the lit state is
 * cheap and wrong-for-a-moment costs nothing, but a moon that silently didn't
 * stick would mean a note she thinks is queued and isn't.
 *
 * THIS HOOK ONLY HOLDS THE TAPS MADE ON THIS PAGE-LOAD. The durable state is
 * the `night` flag on the note itself (dev_notes.json), which every notes
 * fetch already carries — so callers pass it to `isOn` as the fallback, and a
 * reload shows the moons that were already lit instead of forgetting them.
 *
 * Touches: routes/nightcrew.py (POST .../greenlight), DevNotesPanel.tsx,
 * todos/NotesPanel.tsx.
 */
export interface GateState {
  on: boolean;
  /** Set only when she lit a note the gate refuses; shown under the note. */
  reason: string;
}

export function useGreenlight(onError?: (message: string) => void) {
  const [gate, setGate] = useState<Record<string, GateState>>({});

  function toggle(id: string, on: boolean) {
    setGate((g) => ({ ...g, [id]: { on, reason: '' } }));
    fetch(`/api/nightcrew/notes/${id}/greenlight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ night: on }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('greenlight failed'))))
      .then((res) => {
        setGate((g) => ({ ...g, [id]: { on, reason: on && !res.eligible ? res.reason : '' } }));
      })
      .catch(() => {
        setGate((g) => ({ ...g, [id]: { on: !on, reason: '' } }));
        onError?.("Couldn't reach the night crew");
      });
  }

  return {
    gate,
    toggle,
    /** `fallback` is the note's persisted `night` flag — the truth on a fresh
     * page-load, overridden only once she taps on this one. */
    isOn: (id: string, fallback = false) => (id in gate ? gate[id].on === true : fallback),
    reasonFor: (id: string) => gate[id]?.reason || '',
  };
}
