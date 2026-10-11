/**
 * The sandbox's lessons — each one a concept you can only learn by writing.
 *
 * Every lesson is *visible SQL loaded into the editor*, never a hidden action.
 * The whole point is reading what's about to happen, running it, and seeing
 * what came back — so nothing here does anything you can't see and edit first.
 *
 * `watch` is the thing to actually look at in the output. Several of these
 * deliberately produce ERRORS: a rejected INSERT is the lesson, not a failure,
 * and the sandbox returns errors as results with the statement attached.
 *
 * Ordered roughly by difficulty. `needsReset` marks a lesson that expects a
 * clean database, so the UI can offer to clear first.
 *
 * Prompt that produced this file: "a sandbox with all the options selectable
 * and the outputs and stuff."
 */

export interface Lesson {
  key: string;
  title: string;
  /** One line: what this teaches. */
  teaches: string;
  /** What to look at in the output once it's run. */
  watch: string;
  needsReset?: boolean;
  sql: string;
}

export const LESSONS: Lesson[] = [
  {
    key: 'create',
    title: '1. Make some tables',
    teaches: 'CREATE TABLE, column types, and a foreign key linking one table to another.',
    watch: 'The schema panel on the left fills in as soon as this runs.',
    needsReset: true,
    sql: `CREATE TABLE people (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  email TEXT UNIQUE,
  age   INTEGER CHECK (age >= 0)
);

CREATE TABLE pets (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  species   TEXT NOT NULL,
  owner_id  INTEGER REFERENCES people(id)
);

INSERT INTO people (name, email, age) VALUES
  ('Ada',  'ada@example.com',  36),
  ('Blue', 'blue@example.com', 29),
  ('Cy',   'cy@example.com',   41);

INSERT INTO pets (name, species, owner_id) VALUES
  ('Moss',   'cat', 1),
  ('Pepper', 'dog', 1),
  ('Juno',   'cat', 2);

SELECT * FROM people;`,
  },
  {
    key: 'constraints',
    title: '2. The table says no',
    teaches: 'NOT NULL, UNIQUE and CHECK are promises the database enforces for you.',
    watch: 'Three of these four fail. Read the error text — it names the exact constraint.',
    sql: `-- NOT NULL: name is required
INSERT INTO people (name, email) VALUES (NULL, 'nobody@example.com');

-- UNIQUE: that email is already taken
INSERT INTO people (name, email) VALUES ('Ada again', 'ada@example.com');

-- CHECK: age >= 0 was part of the table definition
INSERT INTO people (name, email, age) VALUES ('Ghost', 'ghost@example.com', -5);

-- this one is fine
INSERT INTO people (name, email, age) VALUES ('Del', 'del@example.com', 22);

SELECT * FROM people;`,
  },
  {
    key: 'transaction',
    title: '3. All of it, or none of it',
    teaches: 'A transaction groups statements so a later failure undoes the earlier ones.',
    watch: "The INSERT succeeds, the next fails, then ROLLBACK erases BOTH. Count the rows after.",
    sql: `SELECT COUNT(*) AS before FROM people;

BEGIN;
INSERT INTO people (name, email) VALUES ('Temp One', 'temp1@example.com');
INSERT INTO people (name, email) VALUES ('Temp Two', 'ada@example.com');  -- duplicate email
ROLLBACK;

-- Temp One is gone too, even though its INSERT worked.
SELECT COUNT(*) AS after FROM people;`,
  },
  {
    key: 'fk',
    title: '4. The foreign key refuses',
    teaches: "A foreign key stops you orphaning rows — you can't delete a person who has pets.",
    watch: 'The DELETE fails with FOREIGN KEY constraint failed. Ada still has Moss and Pepper.',
    sql: `-- Ada (id 1) owns two pets, so this is refused:
DELETE FROM people WHERE id = 1;

-- Cy (id 3) owns none, so this works:
DELETE FROM people WHERE id = 3;

SELECT p.name AS person, COUNT(pet.id) AS pets
FROM people p
LEFT JOIN pets pet ON pet.owner_id = p.id
GROUP BY p.id;`,
  },
  {
    key: 'joins',
    title: '5. INNER vs LEFT',
    teaches: 'INNER keeps only matches; LEFT keeps every row on the left and fills gaps with NULL.',
    watch: 'The pet with no owner vanishes from the first result and appears in the second.',
    sql: `INSERT INTO pets (name, species, owner_id) VALUES ('Stray', 'cat', NULL);

-- INNER: Stray disappears, because there's no person to match
SELECT pets.name AS pet, people.name AS owner
FROM pets JOIN people ON people.id = pets.owner_id;

-- LEFT: Stray stays, with NULL where the owner would be
SELECT pets.name AS pet, people.name AS owner
FROM pets LEFT JOIN people ON people.id = pets.owner_id;`,
  },
  {
    key: 'nulls',
    title: '6. NULL is not a value',
    teaches: "NULL means unknown, so it's never equal to anything — not even itself.",
    watch: "is_null_equal_to_null comes back NULL, not 1. And COUNT(email) < COUNT(*).",
    sql: `SELECT NULL = NULL          AS is_null_equal_to_null,
       NULL IS NULL       AS is_null_is_null,
       1 = NULL           AS one_equals_null;

-- So this finds NOTHING, even though pets with no owner exist:
SELECT COUNT(*) AS wrong_way FROM pets WHERE owner_id = NULL;

-- This is how you actually ask:
SELECT COUNT(*) AS right_way FROM pets WHERE owner_id IS NULL;

-- COUNT(*) counts rows; COUNT(column) skips NULLs in that column:
SELECT COUNT(*) AS all_rows, COUNT(email) AS rows_with_email FROM people;`,
  },
  {
    key: 'upsert',
    title: '7. Insert, or update if it exists',
    teaches: 'ON CONFLICT DO UPDATE — the "upsert". This is what habitstore.rebuild() uses.',
    watch: "Ada's age changes instead of a second Ada being created, or the insert erroring.",
    sql: `SELECT name, age FROM people WHERE email = 'ada@example.com';

INSERT INTO people (name, email, age)
VALUES ('Ada', 'ada@example.com', 37)
ON CONFLICT (email) DO UPDATE SET age = excluded.age;

-- Still one Ada, now aged 37. 'excluded' means "the row I tried to insert".
SELECT name, age FROM people WHERE email = 'ada@example.com';
SELECT COUNT(*) AS how_many_adas FROM people WHERE name LIKE 'Ada%';`,
  },
  {
    key: 'footgun',
    title: '8. UPDATE without WHERE',
    teaches: 'The classic disaster, on data that does not matter.',
    watch: 'changed: every row. This is why the real console is read-only.',
    sql: `SELECT name, age FROM people;

-- No WHERE clause. This hits EVERY row.
UPDATE people SET age = 999;

SELECT name, age FROM people;

-- No undo. Unless you were in a transaction — which is the point of lesson 3.`,
  },
  {
    key: 'index',
    title: '9. Make it slow, then fast',
    teaches: 'What an index actually does, on enough rows to feel it.',
    watch: 'Run "Fill with 200k rows" first. Compare the two ms timings and the two plans.',
    sql: `-- Needs the 'big' table — hit "Fill with 200k rows" above first.

EXPLAIN QUERY PLAN SELECT * FROM big WHERE category = 'cat-7';
SELECT COUNT(*) FROM big WHERE category = 'cat-7';

CREATE INDEX idx_big_category ON big (category);

-- Same query. Look at the plan and the milliseconds now.
EXPLAIN QUERY PLAN SELECT * FROM big WHERE category = 'cat-7';
SELECT COUNT(*) FROM big WHERE category = 'cat-7';`,
  },
];
