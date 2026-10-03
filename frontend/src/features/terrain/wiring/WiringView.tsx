import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useWiringGraph, useWiringNeighbors, type WiringFile } from './api';
import {
  BANK_W,
  FOCUS_L,
  FOCUS_R,
  IN_X,
  OUT_X,
  ROW_H,
  STAGE_W,
  baseName,
  edgeWeight,
  layoutBank,
  ribbonPath,
  strokeFor,
} from './wiringMath';
import { TerrainRoomHeader } from '../TerrainRoomHeader';
import styles from './WiringView.module.css';

/**
 * WiringView — the codebase's own wiring, drawn as a place.
 *
 * The creek does this for DATA (code files on the left bank, vault
 * collections on the right, ribbons between). This is the same idiom aimed at
 * CODE, and the geometry had to change to get there: the creek is bipartite
 * because a file and a collection are different kinds of thing, but in a code
 * graph every file is both a source and a destination — `store.py` has 214
 * edges coming in and 17 going out, so a two-bank layout would have to stand
 * it on both banks at once. So the banks are kept and re-aimed at ONE FILE:
 * what flows in on the left, the file in the middle, what flows out on the
 * right. Click any row and it becomes the middle.
 *
 * ONE QUESTION: "what CAN reach what" — the static import graph
 * (codegraph.py), complete for Python and TypeScript both, true whether or
 * not anything ever runs. The ribbons carry the actual symbol names, so an
 * edge reads "server.py takes read, mutate and DATA_DIR from store.py"
 * rather than just pointing. An edge the runtime sensor has actually seen
 * used is marked; its absence proves nothing.
 *
 * "Where did THIS go" — the trace, one captured action in order with the
 * clock running — used to be this room's second mode. It lives in the creek
 * now (Journey mode, creek/TraceStage.tsx), because a trace is mostly a
 * story about data moving, and that's the creek's river.
 *
 * All arithmetic lives in wiringMath.ts and is tested there; this file places
 * DOM rows at computed coordinates over one SVG underlay carrying the ribbons
 * — the creek's own layering, and the pond's before it.
 *
 * Prompt that produced it: "I want it to be in a UI like on creek. I don't
 * think creek is quite what I wanted it to be."
 */
export function WiringView() {
  const [focus, setFocus] = useState<{ repo: string; path: string } | null>(null);
  const [filter, setFilter] = useState('');

  const graph = useWiringGraph();
  const neighbors = useWiringNeighbors(focus?.repo ?? null, focus?.path ?? null);

  const files = graph.data?.files ?? [];
  const matches = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const ranked = [...files].sort((a, b) => b.in_degree - a.in_degree || a.path.localeCompare(b.path));
    if (!q) return ranked.slice(0, 40);
    return ranked.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 40);
  }, [files, filter]);

  return (
    <div className={styles.view}>
      <div className={styles.head}>
      <TerrainRoomHeader title="Wiring" sub="Which files can reach which — the import graph, both languages.">
        <Link to="/terrain/creek" className={styles.back} title="Where did this go — the trace lives in the creek now">
          Journey → creek
        </Link>
      </TerrainRoomHeader>
      </div>

      {(
        <div className={styles.body}>
          <aside className={styles.sidebar}>
            <input
              className={styles.search}
              placeholder="find a file…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <p className={styles.note}>
              {graph.data
                ? `${graph.data.counts.files} files · ${graph.data.counts.edges} edges`
                : 'reading the graph…'}
            </p>
            <ul className={styles.fileList}>
              {matches.map((f) => (
                <li key={`${f.repo} ${f.path}`}>
                  <button
                    type="button"
                    className={
                      focus?.path === f.path && focus?.repo === f.repo
                        ? styles.fileBtnActive
                        : styles.fileBtn
                    }
                    onClick={() => setFocus({ repo: f.repo, path: f.path })}
                    title={f.path}
                  >
                    <span className={styles.fileName}>{baseName(f.path)}</span>
                    <span className={styles.fileDegrees}>
                      {f.in_degree}↓ {f.out_degree}↑
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <main className={styles.stageWrap}>
            {focus ? (
              <FocusStage
                focus={focus}
                data={neighbors.data}
                loading={neighbors.isLoading}
                onFocus={setFocus}
                fileIndex={files}
              />
            ) : (
              <EmptyStage graph={graph.data} onFocus={setFocus} />
            )}
          </main>
        </div>
      )}
    </div>
  );
}

/** Before anything is focused: the hubs, as a way in. Landing on an empty
 * stage with a search box is a worse first move than landing on "here is what
 * everything else depends on". */
function EmptyStage({
  graph,
  onFocus,
}: {
  graph: { files: WiringFile[] } | undefined;
  onFocus: (f: { repo: string; path: string }) => void;
}) {
  const hubs = useMemo(
    () =>
      [...(graph?.files ?? [])]
        .sort((a, b) => b.in_degree - a.in_degree)
        .slice(0, 12),
    [graph],
  );
  if (!graph) return <p className={styles.empty}>reading the graph…</p>;
  return (
    <div className={styles.hubs}>
      <h2 className={styles.hubsTitle}>What everything else leans on</h2>
      <p className={styles.note}>Pick one to see what flows through it.</p>
      <ul className={styles.hubList}>
        {hubs.map((f) => (
          <li key={`${f.repo} ${f.path}`}>
            <button
              type="button"
              className={styles.hubBtn}
              onClick={() => onFocus({ repo: f.repo, path: f.path })}
            >
              <span className={styles.hubName}>{f.path}</span>
              <span className={styles.hubCount}>{f.in_degree} depend on it</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The two banks and the file between them. */
function FocusStage({
  focus,
  data,
  loading,
  onFocus,
  fileIndex,
}: {
  focus: { repo: string; path: string };
  data: ReturnType<typeof useWiringNeighbors>['data'];
  loading: boolean;
  onFocus: (f: { repo: string; path: string }) => void;
  fileIndex: WiringFile[];
}) {
  const incoming = data?.imported_by ?? [];
  const outgoing = data?.imports ?? [];
  const inBank = layoutBank(incoming, (e) => `${e.repo} ${e.src}`);
  const outBank = layoutBank(outgoing, (e) => `${e.dst_repo} ${e.dst}`);
  const height = Math.max(inBank.height, outBank.height, ROW_H) + 24;
  const focusCy = height / 2;
  const maxIn = Math.max(1, ...incoming.map((e) => edgeWeight(e.symbols)));
  const maxOut = Math.max(1, ...outgoing.map((e) => edgeWeight(e.symbols)));
  const self = fileIndex.find((f) => f.path === focus.path && f.repo === focus.repo);

  if (loading) return <p className={styles.empty}>reading…</p>;

  return (
    <div className={styles.stage} style={{ width: STAGE_W, height }}>
      <svg className={styles.underlay} width={STAGE_W} height={height} aria-hidden="true">
        {inBank.rows.map((row) => (
          <path
            key={`in ${row.key}`}
            className={styles.ribbonIn}
            d={ribbonPath(IN_X, row.cy, FOCUS_L, focusCy)}
            strokeWidth={strokeFor(edgeWeight(row.item.symbols), maxIn)}
            fill="none"
          />
        ))}
        {outBank.rows.map((row) => (
          <path
            key={`out ${row.key}`}
            className={styles.ribbonOut}
            d={ribbonPath(FOCUS_R, focusCy, OUT_X, row.cy)}
            strokeWidth={strokeFor(edgeWeight(row.item.symbols), maxOut)}
            fill="none"
          />
        ))}
      </svg>

      {inBank.rows.map((row) => (
        <button
          key={row.key}
          type="button"
          className={styles.bankRow}
          style={{ left: 0, top: row.y, width: BANK_W, height: ROW_H }}
          onClick={() => onFocus({ repo: row.item.repo, path: row.item.src })}
          title={`${row.item.src} → ${focus.path}\n${row.item.symbols.join(', ')}`}
        >
          <span className={styles.rowName}>{baseName(row.item.src)}</span>
          <span className={styles.rowSyms}>{row.item.symbols.slice(0, 3).join(' ') || '—'}</span>
        </button>
      ))}

      <div
        className={styles.focusCard}
        style={{ left: FOCUS_L, top: focusCy - 40, height: 80 }}
      >
        <span className={styles.focusPath}>{focus.path}</span>
        <span className={styles.focusMeta}>
          {self ? `${self.lang} · ${self.lines} lines · ` : ''}
          {incoming.length} in · {outgoing.length} out
        </span>
        {self?.parse_error ? (
          <span className={styles.focusError}>unparsed: {self.parse_error}</span>
        ) : null}
      </div>

      {outBank.rows.map((row) => (
        <button
          key={row.key}
          type="button"
          className={styles.bankRow}
          style={{ left: OUT_X, top: row.y, width: BANK_W, height: ROW_H }}
          onClick={() =>
            row.item.dst_repo
              ? onFocus({ repo: row.item.dst_repo, path: row.item.dst })
              : undefined
          }
          disabled={!row.item.dst_repo}
          title={`${focus.path} → ${row.item.dst}\n${row.item.symbols.join(', ')}`}
        >
          <span className={row.item.dst_repo ? styles.rowName : styles.rowNamePkg}>
            {row.item.dst_repo ? baseName(row.item.dst) : row.item.dst}
          </span>
          <span className={styles.rowSyms}>{row.item.symbols.slice(0, 3).join(' ') || '—'}</span>
        </button>
      ))}
    </div>
  );
}

/** One captured request as a waterfall, plus any continuation in another
 * process as its own panel below. */
