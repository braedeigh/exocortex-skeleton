/**
 * A ladder of queries over the owner's own habit data, ordered so each one adds
 * exactly one idea to the last: filter → join → group → having → case →
 * window function. Clicking one loads it into the editor to be run and edited.
 *
 * They run against real rows on purpose. A tutorial over invented `employees`
 * and `departments` teaches the syntax and none of the intuition; "which of my
 * habits actually stuck" is a question worth the effort of learning to ask.
 *
 * Prompt that produced this file: "example queries she can click that
 * demonstrate JOIN, GROUP BY, and window functions over her own habits."
 */

export interface SqlExample {
  title: string;
  /** The one new idea this query introduces, in plain English. */
  teaches: string;
  sql: string;
}

export const EXAMPLES: SqlExample[] = [
  {
    title: 'Every habit',
    teaches: 'SELECT picks columns, ORDER BY arranges rows. The rectangle you start from.',
    sql: `SELECT id, name, section, active\nFROM habits\nORDER BY name;`,
  },
  {
    title: 'Only the current ones',
    teaches: 'WHERE filters rows — the rectangle gets shorter, never wider.',
    sql: `SELECT name, section, started_on\nFROM habits\nWHERE active = 1\nORDER BY section, name;`,
  },
  {
    title: 'How often you did each one',
    teaches: 'JOIN glues two tables together; GROUP BY collapses many rows into one per habit.',
    sql: `SELECT h.name, h.section, COUNT(*) AS times_done\nFROM habits h\nJOIN habit_entries e ON e.habit_id = h.id\nWHERE e.status = 'done'\nGROUP BY h.id\nORDER BY times_done DESC;`,
  },
  {
    title: 'The history that was unreachable',
    teaches: 'The 132 completions belonging to habits whose line left HABITS.md.',
    sql: `SELECT h.name,\n       COUNT(*)      AS days,\n       MIN(e.date)   AS first_done,\n       MAX(e.date)   AS last_done\nFROM habits h\nJOIN habit_entries e ON e.habit_id = h.id\nWHERE h.active = 0 AND e.status = 'done'\nGROUP BY h.id\nORDER BY days DESC;`,
  },
  {
    title: 'Actual adherence',
    teaches: 'HAVING filters the GROUPS (after counting), where WHERE filters rows (before).',
    sql: `SELECT h.name,\n       SUM(e.status = 'done')   AS done,\n       SUM(e.status = 'missed') AS missed,\n       ROUND(100.0 * SUM(e.status = 'done') / COUNT(*), 1) AS pct\nFROM habits h\nJOIN habit_entries e ON e.habit_id = h.id\nWHERE h.active = 1\nGROUP BY h.id\nHAVING COUNT(*) >= 10\nORDER BY pct DESC;`,
  },
  {
    title: 'Fact vs. deduction',
    teaches: "How much of the above is what the log SAID ('logged') and how much was inferred.",
    sql: `SELECT source, status, COUNT(*) AS entries\nFROM habit_entries\nGROUP BY source, status\nORDER BY source, status;`,
  },
  {
    title: 'Every name a habit has worn',
    teaches: 'Concatenation with || , and <> for "not equal" — finding rows that disagree.',
    sql: `SELECT h.name, a.alias\nFROM habits h\nJOIN habit_aliases a ON a.habit_id = h.id\nWHERE a.alias <> h.section || '|' || h.name\nORDER BY h.name;`,
  },
  {
    title: 'Before and after the job',
    teaches: 'CASE WHEN builds a column that does not exist in the table.',
    sql: `SELECT CASE WHEN e.date < '2026-07-01'\n            THEN 'before July' ELSE 'July onward' END AS era,\n       COUNT(DISTINCT e.habit_id) AS habits,\n       SUM(e.status = 'done')     AS done\nFROM habit_entries e\nGROUP BY era;`,
  },
  {
    title: 'Longest streaks',
    teaches:
      'The classic trick: number the days, subtract the row number from the date, and every unbroken run lands on the same value.',
    sql: `WITH runs AS (\n  SELECT habit_id, date,\n         DATE(date, '-' || ROW_NUMBER() OVER (\n           PARTITION BY habit_id ORDER BY date) || ' days') AS island\n  FROM habit_entries\n  WHERE status = 'done'\n)\nSELECT h.name,\n       COUNT(*)    AS streak_days,\n       MIN(r.date) AS started,\n       MAX(r.date) AS ended\nFROM runs r\nJOIN habits h ON h.id = r.habit_id\nGROUP BY r.habit_id, r.island\nORDER BY streak_days DESC\nLIMIT 15;`,
  },
  {
    title: 'Watch the index work',
    teaches:
      'SEARCH … USING INDEX means it jumped straight there. SCAN means it read every row. Try it on a column with no index.',
    sql: `EXPLAIN QUERY PLAN\nSELECT * FROM habit_entries WHERE date = '2026-07-15';`,
  },
  {
    title: 'The other 50 collections',
    teaches: 'The blob side of the same database — one row per collection, JSON in a text column.',
    sql: `SELECT name, LENGTH(data) AS bytes, updated_at\nFROM docs\nORDER BY bytes DESC\nLIMIT 20;`,
  },
];
