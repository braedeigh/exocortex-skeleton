import { TerrainRoomHeader } from '../TerrainRoomHeader';
import { useAppsMap, type AppParts, type Crossing, type PortPage } from './api';
import styles from './AppsRoom.module.css';

/**
 * AppsRoom.tsx — the Terrain's Apps room (/terrain/apps): the site as the
 * apps it is cut into, one column each, and where they still reach into each
 * other.
 *
 * Each column lists what the app is made of (apps.json + projects.json): the
 * pages it holds, then its routes, modules, page folders and tables, folded
 * shut because some run long. Under them, in red, its crossings — every place
 * its code uses another app's (appboundaries.py). A crossing the baseline
 * doesn't know yet is marked "new": that's what the ratchet test is about to
 * fail on. The Based Foods column is the port checklist: each kitchen page
 * here, and whether Based Foods already has it, still needs it, or it stays
 * here as an exocortex extra. Core, shared by all, sits at the end. Read-only.
 *
 * Reads GET /api/apps (routes/apps.py). Design: docs/apps.md.
 *
 * Prompt that produced it: "a map plus a ratcheting test that shows and
 * shrinks the tangle between them".
 */

const PART_LABELS: Array<[keyof AppParts, string]> = [
  ['routes', 'Routes'],
  ['modules', 'Modules'],
  ['frontend', 'Page folders'],
  ['scripts', 'Scripts'],
  ['tables', 'Tables'],
];

/** How each page on the Based Foods checklist is marked: its label and its colour. */
const PORT_STATUS: Record<PortPage['status'], { label: string; className: string }> = {
  'to-port': { label: 'to port', className: styles.toPort },
  'in-based-foods': { label: 'in Based Foods', className: styles.ported },
  'exocortex-only': { label: 'stays here', className: styles.staysHere },
};

/** One kind of part, shut by default, with its count on the fold. */
function PartList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <details className={styles.part}>
      <summary className={styles.partHead}>
        {label} <span className={styles.count}>{items.length}</span>
      </summary>
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </details>
  );
}

/** One app's crossings out, in red. */
function Crossings({ crossings, names }: { crossings: Crossing[]; names: Record<string, string> }) {
  if (crossings.length === 0) return <p className={styles.clean}>Reaches into no other app.</p>;
  return (
    <details className={styles.part} open={crossings.some((c) => !c.known)}>
      <summary className={`${styles.partHead} ${styles.crossHead}`}>
        Crossings out <span className={styles.count}>{crossings.length}</span>
      </summary>
      <ul className={styles.list}>
        {crossings.map((c) => (
          <li key={`${c.kind} ${c.from} ${c.to}`} className={styles.cross}>
            {c.known ? null : <span className={styles.newMark}>new</span>}
            <span className={styles.kind}>{c.kind}</span> {c.from} → {c.to}{' '}
            <span className={styles.toApp}>({names[c.to_app] ?? c.to_app})</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function AppsRoom() {
  const { data, isError } = useAppsMap();
  const names: Record<string, string> = Object.fromEntries((data?.apps ?? []).map((a) => [a.id, a.name]));
  if (data) names[data.based_foods.id] = data.based_foods.name;
  const out = (appId: string) => (data?.crossings ?? []).filter((c) => c.from_app === appId);
  const total = data?.crossings.length ?? 0;
  const fresh = data?.crossings.filter((c) => !c.known).length ?? 0;

  return (
    <div className={styles.view}>
      <TerrainRoomHeader
        title="Apps"
        sub={
          data
            ? `${data.apps.length} apps · ${total} crossings between them${fresh ? ` · ${fresh} new` : ''}`
            : 'The site as separate apps, and where they still reach into each other.'
        }
      />
      {isError ? <p className={styles.error}>Couldn&rsquo;t load the apps map.</p> : null}
      {data ? (
        <div className={styles.columns}>
          {data.apps.map((app) => (
            <section key={app.id} className={styles.column}>
              <h3 className={styles.name}>
                <span aria-hidden="true">{app.glyph}</span> {app.name}
              </h3>
              <p className={styles.projects}>{app.projects.join(' · ')}</p>
              <PartList label="Pages" items={[...app.pages, ...app.borrows.map((page) => `${page} (borrowed)`)]} />
              {PART_LABELS.map(([kind, label]) => (
                <PartList key={kind} label={label} items={app[kind]} />
              ))}
              <Crossings crossings={out(app.id)} names={names} />
            </section>
          ))}
          <section className={styles.column}>
            <h3 className={styles.name}>
              <span aria-hidden="true">{data.based_foods.glyph}</span> {data.based_foods.name}
            </h3>
            <p className={styles.projects}>Its own app. These pages here, and whether each moves there:</p>
            <ul className={styles.list}>
              {data.based_foods.pages.map((page) => (
                <li key={page.path} className={styles.port}>
                  <span className={PORT_STATUS[page.status].className}>{PORT_STATUS[page.status].label}</span>{' '}
                  {page.path}
                  <span className={styles.note}>{page.note}</span>
                </li>
              ))}
            </ul>
            {PART_LABELS.map(([kind, label]) => (
              <PartList key={kind} label={label} items={data.based_foods[kind]} />
            ))}
            <Crossings crossings={out(data.based_foods.id)} names={names} />
          </section>
          <section className={styles.column}>
            <h3 className={styles.name}>Core — shared by every app</h3>
            <PartList label="Pages" items={data.shared.pages} />
            {PART_LABELS.map(([kind, label]) => (
              <PartList key={kind} label={label} items={data.shared[kind]} />
            ))}
          </section>
        </div>
      ) : null}
    </div>
  );
}
