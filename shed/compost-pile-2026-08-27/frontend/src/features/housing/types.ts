/**
 * types.ts — housing-search tracker data shapes.
 *
 * Mirrors routes/housing.py: a single store (housing.json) holding place
 * entries plus one free-text notes blob. All entry fields are plain strings;
 * `status` is one of the ladder values (see statusLadder.ts).
 */

export interface HousingEntry {
  id: string;
  name: string;
  link: string;
  rent: string;
  size: string;
  area: string;
  status: string;
  avail: string;
  notes: string;
}

export interface HousingStore {
  entries: HousingEntry[];
  notes: string;
}

/**
 * GET /api/data/housing response. The payload also carries _common_data(),
 * dev_notes/idea_notes and tab_todos, but this feature only consumes the
 * `housing` key. In public view mode the housing stream is *hidden*
 * (public_config.py has no rule for it), so the key is absent entirely —
 * consumers must tolerate `undefined`.
 */
export interface HousingResponse {
  housing?: HousingStore;
}

/** Everything editable on a place — an entry minus its id. */
export type PlaceFields = Omit<HousingEntry, 'id'>;

export const EMPTY_FIELDS: PlaceFields = {
  name: '',
  link: '',
  rent: '',
  size: '',
  area: '',
  status: 'found',
  avail: '',
  notes: '',
};

/** Prefill for the inline-edit form — coalesces any missing legacy fields. */
export function fieldsFromEntry(e: HousingEntry): PlaceFields {
  return {
    name: e.name ?? '',
    link: e.link ?? '',
    rent: e.rent ?? '',
    size: e.size ?? '',
    area: e.area ?? '',
    status: e.status ?? 'found',
    avail: e.avail ?? '',
    notes: e.notes ?? '',
  };
}
