import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import { api } from '../../api/client';
import {
  ancestors,
  clip,
  descendantCount,
  indexMap,
  levelOf,
  levelView,
  type CodeMapData,
  type FullLink,
  type Level,
  type LevelNode,
  type MapBox,
  type MapIndex,
  type MapSummary,
} from './codeMap';
import { FileCodeWindow } from './FileCodeWindow';
import { BOX_HEIGHT, BOX_WIDTH, layoutLevel, midpoint, roundedPath, type Placed } from './codeMapLayout';
import { TerrainRoomHeader } from './TerrainRoomHeader';
import styles from './TerrainMapView.module.css';

/**
 * TerrainMapView — the Map room: a codebase drawn as boxes and named arrows,
 * one level at a time. The top level is the whole project; tapping a box that
 * has parts opens it, and the boxes its parts link to stay faded around the
 * edge. Esc (or the browser's back) goes up a level. The side panel says what
 * the selected box is — or, with nothing selected, the box you're inside —
 * its source files, its parts, and every link in and out with its reason. On
 * a phone the panel is a sheet that slides up from the bottom.
 *
 * The legend is also a set of switches: tapping a link kind hides its arrows
 * on every level (and remembers it on this device), for a level too dense to
 * read whole. A source file in the panel opens in the code window Files uses
 * (FileCodeWindow), over this room only.
 *
 * The boxes are markdown files kept in the repo they describe, or in the data
 * folder for a repo that doesn't carry its own (docs/codemap.md); routes/terrain_map.py serves them, codeMap.ts works out
 * what one level shows, codeMapLayout.ts places it. A box whose files changed
 * since its words were written wears "stale"; one whose files are gone wears
 * "broken".
 *
 * Where you are (which map, which box you're inside) lives in the address —
 * the route owns it and hands it down — so a refresh keeps your place and
 * the back button walks up the levels. What's selected is local.
 *
 * A visitor (the public mirror, or logged out) gets the maps the owner opened
 * and a header that says what they are looking at; the hallway of other rooms
 * is the owner's (TerrainRoomHeader). `card` is the room inside an <iframe> on
 * the portfolio page: no header, one line naming the map and one door out to
 * the full room, no legend, and the side panel only once a box is tapped.
 *
 * Prompt that produced it: "I like calling the entire thing terrain. New thing
 * is just map. I want to see basedfoods and the observatory" — after
 * screenshots of a zoomable architecture map: click a box to open its parts,
 * named links (depends on, calls, reads, writes, hosts, implements, generates,
 * composes), a side panel with the description, sources and links.
 */

/** Each link kind's colour and dash, shared by the arrows and the legend. */
const KIND_STYLE: Record<string, { color: string; dash?: string }> = {
  'depends-on': { color: '#8b8fa3' },
  calls: { color: '#4f8fea' },
  reads: { color: '#2fa37a', dash: '3 4' },
  writes: { color: '#e0625a' },
  hosts: { color: '#16a6bb', dash: '9 4' },
  implements: { color: '#8a6ee8', dash: '6 4' },
  generates: { color: '#d19a1f' },
  composes: { color: '#c561c9', dash: '2 5' },
};
const kindStyle = (kind: string) => KIND_STYLE[kind] ?? KIND_STYLE['depends-on'];

// Remember which link kinds are switched off, on this device: read once when
// the room opens, written on every change. A private-mode browser that
// refuses storage just starts with every kind shown.
const HIDDEN_KINDS_KEY = 'terrain-map-hidden-kinds';
function readHiddenKinds(): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(HIDDEN_KINDS_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((kind): kind is string => typeof kind === 'string') : []);
  } catch {
    return new Set();
  }
}
function saveHiddenKinds(kinds: ReadonlySet<string>) {
  try {
    localStorage.setItem(HIDDEN_KINDS_KEY, JSON.stringify([...kinds]));
  } catch {
    /* not remembered, still applied */
  }
}

export interface MapPlace {
  map?: string;
  at?: string;
}

/** What the room says it is, to someone who has never seen the app. */
const VISITOR_SUB =
  'How one part of this app is built, drawn as boxes and arrows: the agent orchestration, or the journal memory. ' +
  'Each box is a part, written up in plain words. Each arrow says how one part uses another. ' +
  'Tap a box with parts to open it; Esc goes up.';

export function TerrainMapView({
  mapKey,
  at,
  onGo,
  card = false,
}: MapPlace & { mapKey?: string; onGo: (next: MapPlace) => void; card?: boolean }) {
  const visitor = typeof window !== 'undefined' && window.VIEW_MODE === 'public';
  // The maps on this machine, then the chosen one whole.
  const list = useQuery({
    queryKey: ['terrain-maps'],
    queryFn: ({ signal }) => api.get<{ maps: MapSummary[] }>('/api/observatory/terrain/maps', signal),
  });
  const maps = list.data?.maps ?? [];
  const current = maps.find((m) => m.key === mapKey) ?? maps.find((m) => !m.error);
  const key = current?.key;
  const map = useQuery({
    queryKey: ['terrain-map', key],
    enabled: Boolean(key),
    queryFn: ({ signal }) => api.get<CodeMapData>(`/api/observatory/terrain/maps/${key}`, signal),
  });
  const index = useMemo(() => (map.data ? indexMap(map.data) : null), [map.data]);

  // The level on screen: the box we're inside (the address's `at` when it
  // names a box with parts, else the top), and what it shows.
  const root = index?.root ?? null;
  const focus = index && at && index.children.has(at) ? at : root;
  // Two views of the level: `fullLevel` with every link, which the legend
  // counts from so a hidden kind stays there to switch back on, and `level`,
  // what is drawn, without the kinds switched off.
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<string>>(readHiddenKinds);
  const fullLevel = useMemo(() => (index && focus ? levelView(index, focus) : null), [index, focus]);
  const level = useMemo(
    () => (index && focus && hiddenKinds.size > 0 ? levelView(index, focus, hiddenKinds) : fullLevel),
    [index, focus, hiddenKinds, fullLevel],
  );
  const setHidden = useCallback((next: ReadonlySet<string>) => {
    saveHiddenKinds(next);
    setHiddenKinds(next);
  }, []);

  // The source file open in the code window, if any. It belongs to the map
  // it was opened from, so switching codebase closes it without an effect.
  const [openFile, setOpenFile] = useState<{ map: string; path: string } | null>(null);
  const openPath = openFile && openFile.map === key ? openFile.path : null;

  // Selection belongs to the level it was made on, so walking away clears it
  // without an effect, and a jump can land already selected.
  const [selection, setSelection] = useState<{ focus: string; id: string } | null>(null);
  const selected = selection && selection.focus === focus ? selection.id : null;
  const [hovered, setHovered] = useState<string | null>(null);

  const go = useCallback(
    (nextAt: string | null) => onGo({ map: key, at: nextAt && nextAt !== root ? nextAt : undefined }),
    [onGo, key, root],
  );

  // Following a box from anywhere — a link in the panel, a faded outside box:
  // one with parts opens; any other is shown selected on its own level.
  const jumpTo = useCallback(
    (id: string) => {
      if (!index) return;
      if (index.children.has(id)) {
        setSelection(null);
        go(id);
        return;
      }
      const home = levelOf(index, id);
      setSelection({ focus: home, id });
      go(home);
    },
    [index, go],
  );

  // Esc steps back: first out of a selection, then up a level. While the
  // code window is up Esc is its own (it closes the file), not a step here.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !index || !focus || openPath) return;
      if (selected) setSelection(null);
      else if (focus !== root) go(index.byId.get(focus)?.parent ?? null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [index, focus, root, selected, go, openPath]);

  // The sheet (phone only) opens by itself when a box is chosen.
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => setSheetOpen(Boolean(selected)), [selected]);

  const panelBox = index ? index.byId.get(selected ?? focus ?? '') ?? null : null;

  return (
    <div className={`${styles.view} ${card ? styles.cardView : ''}`}>
      {card ? (
        <div className={styles.cardHead}>
          {/* The map's own name is the first crumb just below, so the head does not
              repeat it (the portfolio card read "Observatory · a map of the code"
              directly over "Observatory"). */}
          <span className={styles.cardTitle}>A map of the code</span>
          <a
            className={styles.cardOpen}
            href={key ? `/terrain/map?map=${encodeURIComponent(key)}` : '/terrain/map'}
            target="_top"
            rel="noopener"
          >
            Open the Map <span aria-hidden="true">&#8599;</span>
          </a>
        </div>
      ) : (
      <TerrainRoomHeader
        title="Map"
        sub={visitor ? VISITOR_SUB : 'A codebase as boxes and named arrows. Tap a box with parts to open it; Esc goes up.'}
      >
        {maps.length > 1 && (
          <div className={styles.switch} role="tablist" aria-label="Which codebase">
            {maps.map((m) => (
              <button
                key={m.key}
                type="button"
                role="tab"
                aria-selected={m.key === key}
                className={`${styles.switchButton} ${m.key === key ? styles.switchOn : ''}`}
                onClick={() => {
                  setSelection(null);
                  onGo({ map: m.key });
                }}
              >
                {m.name}
                {(m.stale ?? 0) + (m.broken ?? 0) > 0 && (
                  <span className={styles.switchNote}>
                    {m.broken ? ` · ${m.broken} broken` : ''}
                    {m.stale ? ` · ${m.stale} stale` : ''}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </TerrainRoomHeader>
      )}

      {list.isLoading || (key && map.isLoading) ? (
        <p className={styles.note}>Reading the maps…</p>
      ) : list.isError || map.isError ? (
        <p className={styles.note}>The map didn’t load. {String((list.error ?? map.error) as Error)}</p>
      ) : !current ? (
        <p className={styles.note}>
          No maps yet. A map is a folder of markdown files at <code>docs/map/&lt;name&gt;/</code> inside a repo — the app’s
          own, or a build’s — or in the data folder. The format is in <code>docs/codemap.md</code>.
        </p>
      ) : index && focus && level && fullLevel ? (
        <>
          <Crumbs index={index} focus={focus} onGo={go} level={level} fullLevel={fullLevel} hidden={hiddenKinds} onHidden={setHidden} />
          <div className={styles.body}>
            <Canvas
              level={level}
              index={index}
              selected={selected}
              hovered={hovered}
              onHover={setHovered}
              openWhole={card}
              onTap={(node) => {
                if (node.outside) jumpTo(node.box.id);
                else if (node.parts > 0) {
                  setSelection(null);
                  go(node.box.id);
                } else setSelection(selected === node.box.id ? null : { focus, id: node.box.id });
              }}
            />
            {/* In the card the panel waits for a tap: a small frame is all
                canvas until a box is chosen, then its words slide up. */}
            {panelBox && (!card || selected) && (
              <aside
                className={`${styles.panel} ${sheetOpen ? styles.panelOpen : ''}`}
                aria-label={`About ${panelBox.name}`}
              >
                <button
                  type="button"
                  className={styles.sheetHandle}
                  aria-expanded={sheetOpen}
                  onClick={() => setSheetOpen((open) => !open)}
                >
                  <span className={styles.sheetGrip} aria-hidden="true" />
                  <span className={styles.sheetTitle}>{panelBox.name}</span>
                  <span aria-hidden="true">{sheetOpen ? '⌄' : '⌃'}</span>
                </button>
                <BoxPanel
                  box={panelBox}
                  index={index}
                  isFocus={panelBox.id === focus}
                  onJump={jumpTo}
                  onClose={selected ? () => setSelection(null) : undefined}
                  onOpenFile={key ? (path) => setOpenFile({ map: key, path }) : undefined}
                  mapProblems={panelBox.id === root ? map.data?.problems ?? [] : []}
                />
              </aside>
            )}
          </div>
        </>
      ) : null}

      {/* The file pane: read a box's source file without leaving the map
          (FileCodeWindow). It covers this room's whole area and nothing
          outside it; × or Esc comes back to the level as it was. Its layer
          sits above the phone's bottom sheet, which would otherwise stay on
          top of the code. */}
      {openPath && (
        <div className={styles.fileLayer}>
          <FileCodeWindow repo={map.data?.repo ?? null} path={openPath} onClose={() => setOpenFile(null)} />
        </div>
      )}
    </div>
  );
}

/** Where you are: the boxes you're inside, each a step back up, then the
 *  counts and the legend of the link kinds at this level. Each legend entry
 *  is a switch: tap a kind to hide its arrows, tap again to bring them back. */
function Crumbs({
  index,
  focus,
  level,
  fullLevel,
  hidden,
  onHidden,
  onGo,
}: {
  index: MapIndex;
  focus: string;
  /** What is drawn — the counts line describes this. */
  level: Level;
  /** The level with nothing hidden — the legend lists its kinds. */
  fullLevel: Level;
  hidden: ReadonlySet<string>;
  onHidden: (next: ReadonlySet<string>) => void;
  onGo: (at: string) => void;
}) {
  const trail = ancestors(index, focus).reverse();
  const kinds = new Map<string, number>();
  for (const edge of fullLevel.edges) kinds.set(edge.kind, (kinds.get(edge.kind) ?? 0) + edge.links.length);
  const hiddenHere = [...kinds.keys()].filter((kind) => hidden.has(kind));
  const toggle = (kind: string) => {
    const next = new Set(hidden);
    if (!next.delete(kind)) next.add(kind);
    onHidden(next);
  };
  const insideCount = level.nodes.filter((n) => !n.outside).length;
  const outsideCount = level.nodes.length - insideCount;
  return (
    <div className={styles.crumbBar}>
      <nav className={styles.crumbs} aria-label="Levels">
        {trail.map((id, i) => (
          <span key={id} className={styles.crumbStep}>
            {i > 0 && <span className={styles.crumbSep} aria-hidden="true">›</span>}
            <button
              type="button"
              className={styles.crumb}
              aria-current={id === focus ? 'location' : undefined}
              onClick={() => onGo(id)}
            >
              {index.byId.get(id)?.name ?? id}
            </button>
          </span>
        ))}
      </nav>
      <p className={styles.counts}>
        {insideCount} {insideCount === 1 ? 'box' : 'boxes'}
        {outsideCount > 0 && ` · ${outsideCount} outside`} · {level.edges.length}{' '}
        {level.edges.length === 1 ? 'arrow' : 'arrows'}
        {hiddenHere.length > 0 && ` · ${fullLevel.edges.length - level.edges.length} hidden`}
      </p>
      {kinds.size > 0 && (
        <ul className={styles.legend} aria-label="Link kinds at this level — tap one to hide or show its arrows">
          {[...kinds].map(([kind, count]) => (
            <li key={kind}>
              <button
                type="button"
                className={`${styles.legendItem} ${hidden.has(kind) ? styles.legendOff : ''}`}
                aria-pressed={!hidden.has(kind)}
                title={hidden.has(kind) ? `Show ${kind} arrows` : `Hide ${kind} arrows`}
                onClick={() => toggle(kind)}
              >
                <svg width="26" height="8" aria-hidden="true">
                  <line
                    x1="1"
                    y1="4"
                    x2="25"
                    y2="4"
                    stroke={kindStyle(kind).color}
                    strokeWidth="2.5"
                    strokeDasharray={kindStyle(kind).dash}
                  />
                </svg>
                <span className={styles.legendName}>{kind}</span> {count}
              </button>
            </li>
          ))}
          {hiddenHere.length > 0 && (
            <li>
              <button type="button" className={styles.legendAll} onClick={() => onHidden(new Set())}>
                Show all
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** The drawing: one level laid out, pannable and zoomable. */
function Canvas({
  level,
  index,
  selected,
  hovered,
  onHover,
  onTap,
  openWhole = false,
}: {
  level: Level;
  index: MapIndex;
  selected: string | null;
  hovered: string | null;
  onHover: (id: string | null) => void;
  onTap: (node: LevelNode) => void;
  /** Open each level zoomed out to all of it (the card), not at reading size. */
  openWhole?: boolean;
}) {
  // Lay the level out whenever it changes. The last layout stays up until
  // the new one is ready, so opening a box never flashes an empty canvas.
  const [placed, setPlaced] = useState<{ level: Level; placed: Placed } | null>(null);
  useEffect(() => {
    let alive = true;
    layoutLevel(level)
      .then((result) => alive && setPlaced({ level, placed: result }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [level]);

  // Pan and zoom, d3-zoom on the svg moving one group. Double-tap zoom is off:
  // a tap on a box means "open" and must never also zoom.
  const svgRef = useRef<SVGSVGElement>(null);
  const groupRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  useEffect(() => {
    if (!svgRef.current) return;
    const behaviour = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 2.5])
      .on('zoom', (event) => groupRef.current?.setAttribute('transform', event.transform.toString()));
    select(svgRef.current).call(behaviour).on('dblclick.zoom', null);
    zoomRef.current = behaviour;
  }, []);

  // Two ways to frame a level. A new level OPENS at reading size: never so
  // small that text falls under the 12px floor (scale 0.85 keeps 14px names
  // at ~12px), so a level bigger than the canvas opens on its top middle —
  // where the boxes that use the others sit — and is panned from there. The
  // Fit button shows the WHOLE level, however small that makes it: it is the
  // overview she asked for by pressing it ("the fit function on the map
  // doesn't zoom out to the entire map"). The card opens whole too, because
  // its frame is far smaller than any level.
  const frame = useCallback(
    (whole: boolean) => {
      const svg = svgRef.current;
      if (!svg || !zoomRef.current || !placed) return;
      const { width, height } = svg.getBoundingClientRect();
      const pad = whole ? 12 : 0;
      const all = Math.min(1.2, (width - pad * 2) / placed.placed.width, (height - pad * 2) / placed.placed.height);
      const scale = whole ? Math.max(0.1, all) : Math.max(0.85, all);
      const x = (width - placed.placed.width * scale) / 2;
      const y = Math.max(pad, (height - placed.placed.height * scale) / 2);
      select(svg).call(zoomRef.current.transform, zoomIdentity.translate(x, y).scale(scale));
    },
    [placed],
  );
  const fit = useCallback(() => frame(true), [frame]);
  useEffect(() => frame(openWhole), [frame, openWhole]);

  // What lights up: the hovered box (or else the selected one) and every
  // arrow touching it, with the boxes at their other ends. A hover only
  // counts while its box is on screen — the box just tapped open is gone,
  // and the pointer never "left" it.
  const shown = placed?.level ?? level;
  const active = hovered && shown.nodes.some((node) => node.box.id === hovered) ? hovered : selected;
  const touching = new Set<string>();
  if (active) {
    for (const edge of shown.edges) {
      if (edge.from === active || edge.to === active) touching.add(edge.from).add(edge.to);
    }
  }

  return (
    <div className={styles.canvasWrap}>
      <svg ref={svgRef} className={styles.canvas} role="group" aria-label="Map level">
        <defs>
          {Object.entries(KIND_STYLE).map(([kind, style]) => (
            <marker
              key={kind}
              id={`codemap-arrow-${kind}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="8"
              markerHeight="8"
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <path d="M0,1 L10,5 L0,9 z" fill={style.color} />
            </marker>
          ))}
        </defs>
        <g ref={groupRef}>
          {placed &&
            shown.edges.map((edge) => {
              const route = placed.placed.edges.get(edge.id);
              if (!route) return null;
              const style = kindStyle(edge.kind);
              const lit = active ? edge.from === active || edge.to === active : null;
              const badge = edge.links.length > 1 ? midpoint(route.points) : null;
              return (
                <g key={edge.id} className={lit === false ? styles.dim : undefined}>
                  <path
                    d={roundedPath(route.points)}
                    fill="none"
                    stroke={style.color}
                    strokeWidth={lit ? 2.5 : 1.6}
                    strokeDasharray={style.dash}
                    markerEnd={`url(#codemap-arrow-${KIND_STYLE[edge.kind] ? edge.kind : 'depends-on'})`}
                  >
                    <title>{edge.links.map((l) => `${l.kind}: ${l.reason}`).join('\n')}</title>
                  </path>
                  {badge && (
                    <g transform={`translate(${badge.x},${badge.y})`}>
                      <circle r="10" className={styles.badge} stroke={style.color} />
                      <text className={styles.badgeText} textAnchor="middle" dy="4">
                        {edge.links.length}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          {placed &&
            shown.nodes.map((node) => {
              const at = placed.placed.boxes.get(node.box.id);
              if (!at) return null;
              return (
                <BoxShape
                  key={node.box.id}
                  node={node}
                  x={at.x}
                  y={at.y}
                  parentName={node.outside ? index.byId.get(node.box.parent ?? '')?.name : undefined}
                  selected={node.box.id === selected}
                  dim={Boolean(active) && node.box.id !== active && !touching.has(node.box.id)}
                  onHover={onHover}
                  onTap={() => onTap(node)}
                />
              );
            })}
        </g>
      </svg>
      <button type="button" className={styles.fit} onClick={fit} aria-label="Fit the level to the screen">
        Fit
      </button>
    </div>
  );
}

/** One box on the canvas: its kind, its name, its state, and its parts. */
function BoxShape({
  node,
  x,
  y,
  parentName,
  selected,
  dim,
  onHover,
  onTap,
}: {
  node: LevelNode;
  x: number;
  y: number;
  parentName?: string;
  selected: boolean;
  dim: boolean;
  onHover: (id: string | null) => void;
  onTap: () => void;
}) {
  const { box, outside, parts } = node;
  const state = box.broken ? 'broken' : box.stale ? 'stale' : null;
  const label = outside ? `outside · ${parentName ?? ''}` : box.kind;
  const action = outside ? 'go to' : parts > 0 ? 'open' : 'select';
  return (
    <g
      transform={`translate(${x},${y})`}
      className={`${styles.box} ${outside ? styles.boxOutside : ''} ${selected ? styles.boxSelected : ''} ${dim ? styles.dim : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${box.name}, ${box.kind}${parts ? `, ${parts} parts` : ''}${state ? `, ${state}` : ''} — ${action}`}
      onClick={onTap}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onTap();
        }
      }}
      onPointerEnter={(event) => event.pointerType === 'mouse' && onHover(box.id)}
      onPointerLeave={(event) => event.pointerType === 'mouse' && onHover(null)}
    >
      <rect width={BOX_WIDTH} height={BOX_HEIGHT} rx="10" className={styles.boxRect} />
      <text x="12" y="20" className={styles.boxKind}>
        {clip(label.toUpperCase(), 22)}
      </text>
      {state && (
        <text x={BOX_WIDTH - 12} y="20" textAnchor="end" className={box.broken ? styles.boxBroken : styles.boxStale}>
          {state}
        </text>
      )}
      <text x="12" y="42" className={styles.boxName}>
        {clip(box.name, 24)}
      </text>
      {parts > 0 && (
        <text x="12" y="62" className={styles.boxParts}>
          {parts} {parts === 1 ? 'part' : 'parts'} ›
        </text>
      )}
      <title>{box.description.split('\n')[0]}</title>
    </g>
  );
}

/** The side panel: one box in words — what it is, its files, its parts, and
 *  every link in and out with its reason, each a way to go there. */
function BoxPanel({
  box,
  index,
  isFocus,
  onJump,
  onClose,
  onOpenFile,
  mapProblems,
}: {
  box: MapBox;
  index: MapIndex;
  isFocus: boolean;
  onJump: (id: string) => void;
  onClose?: () => void;
  /** Open one source file in the code window. */
  onOpenFile?: (path: string) => void;
  mapProblems: string[];
}) {
  const parts = index.children.get(box.id) ?? [];
  const outgoing = index.outgoing.get(box.id) ?? [];
  const incoming = index.incoming.get(box.id) ?? [];
  const name = (id: string) => index.byId.get(id)?.name ?? id;
  return (
    <div className={styles.panelBody}>
      <div className={styles.panelTop}>
        <span className={styles.chip}>{box.kind}</span>
        <span className={`${styles.chip} ${box.broken ? styles.chipBroken : box.stale ? styles.chipStale : styles.chipReady}`}>
          {box.broken ? 'broken' : box.stale ? 'stale' : 'ready'}
        </span>
        {onClose && (
          <button type="button" className={styles.close} onClick={onClose} aria-label="Clear the selection">
            ×
          </button>
        )}
      </div>
      <h2 className={styles.panelName}>{box.name}</h2>
      <p className={styles.panelId}>
        {box.id}
        {box.written && ` · written ${box.written}`}
      </p>
      {box.stale && !box.broken && (
        <p className={styles.warn}>Its files changed after these words were written; they may have drifted.</p>
      )}
      <Description text={box.description} />
      {!isFocus && parts.length > 0 && (
        <button type="button" className={styles.open} onClick={() => onJump(box.id)}>
          Open — {parts.length} {parts.length === 1 ? 'part' : 'parts'}
        </button>
      )}

      {[...mapProblems, ...box.problems].length > 0 && (
        <Section title={`Problems (${mapProblems.length + box.problems.length})`}>
          <ul className={styles.plain}>
            {[...mapProblems, ...box.problems].map((problem) => (
              <li key={problem} className={styles.problem}>
                {problem}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {box.sources.length > 0 && (
        <Section title="Sources">
          <ul className={styles.plain}>
            {box.sources.map((source) => (
              // A file that exists opens in the code window; a folder, or a
              // source that's gone, is only named.
              <li key={source.path} className={source.exists ? styles.source : styles.sourceGone}>
                {source.exists && !source.folder && onOpenFile ? (
                  <button type="button" className={styles.sourceOpen} onClick={() => onOpenFile(source.path)}>
                    {source.path}
                  </button>
                ) : (
                  <>
                    {source.path}
                    {!source.exists && ' — gone'}
                  </>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {parts.length > 0 && (
        <Section title={`Parts (${parts.length}${descendantCount(index, box.id) > parts.length ? `, ${descendantCount(index, box.id)} in all` : ''})`}>
          <ul className={styles.plain}>
            {parts.map((part) => (
              <li key={part.id}>
                <button type="button" className={styles.row} onClick={() => onJump(part.id)}>
                  <span>{part.name}</span>
                  {(part.broken || part.stale) && (
                    <span className={part.broken ? styles.boxBrokenText : styles.boxStaleText}>
                      {part.broken ? 'broken' : 'stale'}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Outgoing (${outgoing.length})`}>
        <LinkList links={outgoing} other={(link) => link.to} word="to" name={name} onJump={onJump} />
      </Section>
      <Section title={`Incoming (${incoming.length})`}>
        <LinkList links={incoming} other={(link) => link.from} word="from" name={name} onJump={onJump} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

/** Links one way, each: its kind in its colour, the box at the other end (a
 *  way to go there), and the one-line reason. */
function LinkList({
  links,
  other,
  word,
  name,
  onJump,
}: {
  links: FullLink[];
  other: (link: FullLink) => string;
  word: string;
  name: (id: string) => string;
  onJump: (id: string) => void;
}) {
  if (links.length === 0) return <p className={styles.none}>None.</p>;
  return (
    <ul className={styles.plain}>
      {links.map((link, i) => (
        <li key={`${link.from}-${link.to}-${link.kind}-${i}`}>
          <button type="button" className={styles.linkRow} onClick={() => onJump(other(link))}>
            <span className={styles.linkHead}>
              <span style={{ color: kindStyle(link.kind).color }} className={styles.linkKind}>
                {link.kind}
              </span>{' '}
              <span className={styles.linkWord}>{word}</span> <span className={styles.linkTarget}>{name(other(link))}</span>
            </span>
            <span className={styles.linkReason}>{link.reason}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A box's words: paragraphs split on blank lines, `code` spans kept. */
function Description({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <div className={styles.description}>
      {text.split(/\n\s*\n/).map((paragraph, i) => (
        <p key={i}>
          {paragraph.split('`').map((piece, j) => (j % 2 === 1 ? <code key={j}>{piece}</code> : piece))}
        </p>
      ))}
    </div>
  );
}
