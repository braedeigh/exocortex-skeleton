/**
 * types.ts — shapes for GET /api/travel/data and the trips.json /
 * travel_templates.json stores (routes/travel.py).
 */

export type TripStatus = 'planning' | 'packing' | 'away' | 'home';

/** '' = not yet reckoned with; the rest are the unpack verdicts. */
export type ReturnedState = '' | 'home' | 'left' | 'lost';

/** Where a list entry points: the archivals catalog, the active-inventory
 * consumables loop (identity by name — no ids in that store), or free text. */
export type ItemSource = 'archival' | 'active' | 'text';

export interface TripItem {
  id: string;
  name: string;
  source: ItemSource;
  ref_id: string;
  category: string;
  notes: string;
  packed: boolean;
  returned: ReturnedState;
}

export interface Trip {
  id: string;
  name: string;
  destination: string;
  /** ISO dates or '' when unset. */
  start: string;
  end: string;
  status: TripStatus;
  notes: string;
  items: TripItem[];
  created_at: string;
}

export interface TemplateItem {
  name: string;
  source: ItemSource;
  ref_id: string;
  category: string;
}

export interface TravelTemplate {
  id: string;
  name: string;
  items: TemplateItem[];
}

/** A pickable thing for the add-item search — archival or active item. */
export interface SourceItem {
  id: string;
  name: string;
  category: string;
  /** First archival photo filename ('' when none) — served at /archivals/<photo>. */
  photo: string;
}

export interface TravelData {
  trips: Trip[];
  templates: TravelTemplate[];
  sources: {
    archivals: SourceItem[];
    active: SourceItem[];
  };
}
