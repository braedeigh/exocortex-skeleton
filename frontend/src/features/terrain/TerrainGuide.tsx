import type { ReactElement, ReactNode } from 'react';
import { AGENT_PURPLE, THREAD_TEAL } from './terrainCanvas';
import { FILE_TYPES, OTHER_FILE_TYPE } from './fileTypes';
import styles from './TerrainGuide.module.css';

/**
 * TerrainGuide — the map's own explainer, docked beside it.
 *
 * The "? Guide" chip in the top bar opens this as a column down the right
 * side of the page; the map shrinks to the left of it and keeps working, so
 * a reader can try each thing as they read about it (TerrainPage.module.css
 * `.guideOpen` is what moves the map over). On a phone it takes the whole
 * width instead, and × brings the map back.
 *
 * What's in it, top to bottom: what the shapes are, what the colours mean
 * (including the Types view's file-type swatches, drawn from the same table
 * the dots are painted from, so they can't drift), what the lines and rings
 * mean, how to move around, what a tap does, and what each control on the
 * bars is for. A public visitor gets one more section: what the public site
 * keeps private.
 *
 * Every sentence here describes the map as it is drawn today. If a layer
 * changes, change its line here in the same commit — a guide that lies is
 * worse than no guide (the same rule the code notes follow).
 *
 * Prompt that produced it: "i need a better key and like, a description of
 * how to interact with the map on the public site ... i'm imagining like a
 * question mark or something describing what is going on that opens a split
 * screen on the left or right and describes the files and shows what you can
 * do to interact with the map."
 */

/** The fires' hot ends, as the dots wear them (terrainCanvas.ts). Copied
 * rather than imported because the engine keeps them as ramps, not points. */
const EMBER_RED = '#f14c4c';
const GOLD = '#ffd700';
const CREATED_GREEN = '#22c55e';
const WRITE_CORE_GREEN = '#15803d';
const ASH = '#6b6b70';

/** How many named file types the key lists before "Other" — the ones a map
 * of this app is mostly made of. */
const TYPE_ROWS = 12;

/** A small drawing for one legend row. Each is a hand-sized SVG in the row's
 * own language: a dot, a ring, a line, a box, a spiral, a square of water. */
function Mark({ kind, color }: { kind: string; color?: string }): ReactElement {
  const box = { width: 40, height: 28, viewBox: '0 0 40 28', 'aria-hidden': true } as const;
  switch (kind) {
    case 'dot':
      return (
        <svg {...box}>
          <circle cx="20" cy="14" r="7" fill={color} />
        </svg>
      );
    case 'dotCore':
      return (
        <svg {...box}>
          <circle cx="20" cy="14" r="7" fill={ASH} />
          <circle cx="20" cy="14" r="3" fill={color} />
        </svg>
      );
    case 'ring':
      return (
        <svg {...box}>
          <circle cx="20" cy="14" r="6" fill={ASH} />
          <circle cx="20" cy="14" r="10" fill="none" stroke={color} strokeWidth="2" />
        </svg>
      );
    case 'orb':
      return (
        <svg {...box}>
          <circle cx="20" cy="14" r="8" fill="none" stroke={color} strokeWidth="2" />
          <circle cx="20" cy="14" r="12" fill="none" stroke={color} strokeWidth="1" opacity="0.4" />
        </svg>
      );
    case 'folder':
      return (
        <svg {...box}>
          <path d="M4 9h10l3 3h19v12H4z" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );
    case 'coil':
      return (
        <svg {...box}>
          <path
            d="M20 14 m0 0 a2 2 0 0 1 2 2 a4 4 0 0 1 -6 2 a6 6 0 0 1 4 -10 a8 8 0 0 1 8 8 a10 10 0 0 1 -14 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      );
    case 'table':
      return (
        <svg {...box}>
          <rect x="8" y="4" width="24" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <rect x="8" y="4" width="24" height="5" fill="var(--evening, #4f6ee8)" opacity="0.8" />
          <path d="M16 9v15 M24 9v15" stroke="currentColor" strokeWidth="1" opacity="0.5" />
        </svg>
      );
    case 'pond':
      return (
        <svg {...box}>
          <rect x="9" y="3" width="22" height="22" rx="3" fill={EMBER_RED} opacity="0.25" />
          <path d="M12 21v-6 M16 21v-11 M20 21v-4 M24 21v-9 M28 21v-2" stroke={EMBER_RED} strokeWidth="2.5" />
        </svg>
      );
    case 'line':
      return (
        <svg {...box}>
          <path d="M4 14h32" stroke={color} strokeWidth="2" />
        </svg>
      );
    case 'dashed':
      return (
        <svg {...box}>
          <path d="M4 14h32" stroke={color} strokeWidth="2" strokeDasharray="5 4" />
        </svg>
      );
    case 'bowed':
      return (
        <svg {...box}>
          <path d="M4 20 Q20 0 36 20" fill="none" stroke={color} strokeWidth="2" />
        </svg>
      );
    default:
      return <svg {...box} />;
  }
}

function Row({ mark, children }: { mark: ReactElement; children: ReactNode }): ReactElement {
  return (
    <li className={styles.row}>
      <span className={styles.mark}>{mark}</span>
      <span className={styles.rowText}>{children}</span>
    </li>
  );
}

export function TerrainGuide({
  open,
  visitor,
  onClose,
}: {
  open: boolean;
  /** A public visitor gets the "what stays private" section. */
  visitor: boolean;
  onClose: () => void;
}): ReactElement | null {
  if (!open) return null;
  const typeRows = [...FILE_TYPES.slice(0, TYPE_ROWS), OTHER_FILE_TYPE];
  return (
    <aside className={styles.panel} aria-label="Guide to the map">
      <div className={styles.header}>
        <h2 className={styles.title}>Reading the map</h2>
        <button type="button" className={styles.close} aria-label="Close the guide" onClick={onClose}>
          &#215;
        </button>
      </div>
      <div className={styles.body}>
        <p className={styles.lead}>
          This is a live map of one person&rsquo;s software and the AI agents working on
          it. Every dot is a file. The two territories are the app&rsquo;s code and a
          private vault of notes and data. The boxes in the corridor between them are the
          database&rsquo;s tables. The rings that drift among the dots are agent sessions,
          tethered to the files they touched. It redraws itself as the work happens.
        </p>

        <h3 className={styles.heading}>The shapes</h3>
        <ul className={styles.list}>
          <Row mark={<Mark kind="dot" color={ASH} />}>
            <b>A file.</b> Bigger means hotter: edited or run more recently.
          </Row>
          <Row mark={<Mark kind="folder" />}>
            <b>A folder.</b> Hollow, never filled. The two heaviest outlines are the
            territories themselves: <b>App code</b> and <b>Personal vault</b>.
          </Row>
          <Row mark={<Mark kind="coil" />}>
            <b>A coil.</b> A folder of many dated files (uploads, chat logs, daily pages)
            wound into a spiral, newest at the centre. Its caption says how many are shown.
          </Row>
          <Row mark={<Mark kind="table" />}>
            <b>A database table.</b> One stripe per column; taller means more rows (twice
            as tall is about four times the rows). Tables that join each other share a
            shelf, named after them. A dashed outline is an empty table.
          </Row>
          <Row mark={<Mark kind="orb" color={AGENT_PURPLE} />}>
            <b>An agent session.</b> A running one ripples. One that has news since it
            was last opened sends a slow orange ping. It is named only if it worked in
            the last hour.
          </Row>
          <Row mark={<Mark kind="pond" />}>
            <b>The pond.</b> The journal&rsquo;s cards folded into one square of water,
            a column per day. Hover or tap it to see the last month card by card.
          </Row>
        </ul>

        <h3 className={styles.heading}>The colours</h3>
        <ul className={styles.list}>
          <Row mark={<Mark kind="dot" color={EMBER_RED} />}>
            <b>Ember red:</b> edited recently. Fully red now, fading out to the far end
            of the <b>Heat</b> slider.
          </Row>
          <Row mark={<Mark kind="dot" color={GOLD} />}>
            <b>Gold:</b> this code ran recently, on the <b>Active</b> slider&rsquo;s
            window. Only Python files can go gold; the sensor only sees those. Edited
            and run together blends to orange.
          </Row>
          <Row mark={<Mark kind="dot" color={ASH} />}>
            <b>Ash:</b> nothing recent.
          </Row>
          <Row mark={<Mark kind="dot" color={CREATED_GREEN} />}>
            <b>Green:</b> created in the last day.
          </Row>
          <Row mark={<Mark kind="dotCore" color={WRITE_CORE_GREEN} />}>
            <b>Deep-green centre:</b> an agent wrote this file within the last day.
          </Row>
        </ul>
        <p className={styles.note}>
          Switch on <b>Types</b> and the dots wear their file type instead:
        </p>
        <ul className={styles.swatches}>
          {typeRows.map((t) => (
            <li key={t.label} className={styles.swatchRow}>
              <span className={styles.swatch} style={{ background: t.color }} />
              <span>{t.label}</span>
            </li>
          ))}
        </ul>

        <h3 className={styles.heading}>The lines and rings</h3>
        <ul className={styles.list}>
          <Row mark={<Mark kind="line" color="currentColor" />}>
            <b>Grey line:</b> a folder holding a file.
          </Row>
          <Row mark={<Mark kind="dashed" color={AGENT_PURPLE} />}>
            <b>Dashed purple:</b> an agent tethered to a file it touched.
          </Row>
          <Row mark={<Mark kind="line" color="var(--evening, #4f6ee8)" />}>
            <b>Blue:</b> one table pointing at another (a foreign key), with a dot at the
            end it points to.
          </Row>
          <Row mark={<Mark kind="bowed" color={THREAD_TEAL} />}>
            <b>Teal thread:</b> data flowing from the file that writes it to a file that
            reads it. Threads appear when you hover or select one of their ends.
          </Row>
          <Row mark={<Mark kind="ring" color="#ffffff" />}>
            <b>White ring:</b> an agent read this file.
          </Row>
          <Row mark={<Mark kind="ring" color={AGENT_PURPLE} />}>
            <b>Purple ring:</b> an agent wrote or created it.
          </Row>
        </ul>

        <h3 className={styles.heading}>Moving around</h3>
        <ul className={styles.plain}>
          <li>Drag empty space to pan. Scroll or pinch to zoom.</li>
          <li>Drag a dot and it stays where you put it. A <b>release</b> chip appears to let the physics have it back.</li>
          <li>Hover a dot to name it and light its folders, threads, tables and agents. Everything else dims.</li>
          <li>
            Press <kbd>/</kbd> or use <b>Find a file</b> to search by name. Matches light up and
            the list opens the file.
          </li>
          <li><kbd>Esc</kbd> closes whatever is open.</li>
        </ul>

        <h3 className={styles.heading}>Tapping things</h3>
        <ul className={styles.plain}>
          <li>
            <b>A file</b> opens its code over the map, with an <b>edits</b> toggle that
            paints each line red by when it was last changed, a <b>ran</b> toggle that
            paints functions gold by when they last ran, and a <b>&#8599;</b> that opens
            the file in its own tab.
          </li>
          <li>
            <b>A table</b>, once, lights its joins and ropes to the code that touches it.
            Tap it again for a window with the table&rsquo;s description, columns, joins
            and code on one side and its rows on the other: search, sort, filter, hide
            columns, tap a column name for its profile, tap a row to read it whole, and
            see the SQL behind the view.
          </li>
          <li><b>An agent</b> spotlights its footprint: every file it touched, captioned.</li>
          <li><b>A coil&rsquo;s centre</b> widens its window: a month, three, six, then all.</li>
          <li><b>Empty space</b> clears any spotlight or selection.</li>
        </ul>

        <h3 className={styles.heading}>The controls</h3>
        <ul className={styles.plain}>
          <li><b>App code / Personal vault</b> show or hide a territory.</li>
          <li><b>Files</b> keeps only the hottest N files. Tables, coils and search hits are never cut.</li>
          <li><b>Dates</b> hides files not touched inside the range. Nothing moves.</li>
          <li><b>&#8635;</b> refetches the map; the number beside it is how old what you see is.</li>
          <li>
            <b>1 day / 1 week / 1 month / 1 year</b> set the Heat window. <b>Dynamic</b>
            lets the two windows breathe in turn, until you touch a slider.
          </li>
          <li><b>Heat</b> is how far back red reaches. <b>Active</b> is how far back gold reaches; the pill switches the gold halo on and off.</li>
          <li>
            <b>Working ▾</b> chooses which sessions are drawn (worked this hour, open, or
            all), the slider beside it picks a slice of them newest-first,
            <b> Agents · N</b> lists them, and <b>Hide</b> takes them all off the map.
          </li>
          <li>The key in the corner shows the current red ramp, or the file-type swatches under Types.</li>
        </ul>

        {visitor ? (
          <>
            <h3 className={styles.heading}>On the public site</h3>
            <p className={styles.note}>
              This is a mirror of the owner&rsquo;s live map. The app&rsquo;s code opens
              and reads in full. The vault&rsquo;s files are on the map but their text stays
              private. The database&rsquo;s tables all show their shape and row counts;
              the tables about the owner&rsquo;s own life show their values as blocks.
              Sessions that aren&rsquo;t coding sessions keep their activity but not their
              names. Some of the owner&rsquo;s tools (notes, scheduling, the other rooms)
              aren&rsquo;t on this copy.
            </p>
          </>
        ) : null}
      </div>
    </aside>
  );
}
