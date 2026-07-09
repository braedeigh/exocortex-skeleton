// types.ts — shapes for the People tab, matching what routes/entities.py's
// people_roster() serializes (see /api/people/roster).

/** A person's newest non-empty structured-entry note. */
export interface RosterLastNote {
  date: string; // 'YYYY-MM-DD'
  note: string;
}

/** One person in the roster — the lightweight Person projection the old
 * people.js consumed. `dates` is every structured entry date, ascending. */
export interface RosterPerson {
  id: string;
  name: string;
  tags: string[];
  blurb: string;
  dates: string[]; // 'YYYY-MM-DD', sorted ascending
  last_note: RosterLastNote | null;
}

export interface PeopleRosterResponse {
  people: RosterPerson[];
}

export type SortMode = 'recent' | 'most' | 'alpha';

/** Recency bins used when sorting by 'recent'. */
export type TierKey = 'week' | 'month' | 'earlier' | 'quiet' | 'none';
