/**
 * codeMap.ts — the Map room's walking logic: given one codebase map (every
 * box, each with its parent and its links), work out what one LEVEL of it
 * shows.
 *
 * A level is the inside of one box (the "focus"): its parts, drawn as boxes,
 * plus — faded around them — any box OUTSIDE the focus that one of the parts
 * links to. A link in the files can join any two boxes at any depth; on
 * screen it is LIFTED to the boxes that are visible: a link from a part's
 * part is drawn from the part, and a link to a box deep inside a neighbour is
 * drawn to the neighbour. Links that start and end inside the same visible
 * box vanish at this level (they're drawn when you open that box), and so do
 * links with neither end inside the focus.
 *
 * Pure functions, no React — TerrainMapView.tsx draws what these return,
 * codeMapLayout.ts places it, routes/terrain_map.py serves the data.
 */

/** One box as the server sends it (codemap.py `read_box`, checked by `load`). */
export interface MapBox {
  id: string;
  name: string;
  kind: string;
  parent: string | null;
  order: number | null;
  description: string;
  sources: { path: string; exists: boolean }[];
  links: MapLink[];
  written: string | null;
  stale: boolean;
  broken: boolean;
  problems: string[];
}

export interface MapLink {
  kind: string;
  to: string;
  reason: string;
}

/** One whole map: GET /api/observatory/terrain/maps/<repo>/<name>. */
export interface CodeMapData {
  key: string;
  repo: string;
  repo_name: string;
  name: string;
  root: string | null;
  boxes: MapBox[];
  problems: string[];
  link_kinds: string[];
}

/** One line of the map switch: GET /api/observatory/terrain/maps. */
export interface MapSummary {
  key: string;
  name: string;
  repo: string;
  repo_name: string;
  boxes?: number;
  stale?: number;
  broken?: number;
  problems?: number;
  error?: string;
}

/** A link written in the files, with both ends named. */
export interface FullLink extends MapLink {
  from: string;
}

export interface MapIndex {
  root: string | null;
  byId: Map<string, MapBox>;
  /** Each box's parts, in reading order (`order` first, then by name). */
  children: Map<string, MapBox[]>;
  outgoing: Map<string, FullLink[]>;
  incoming: Map<string, FullLink[]>;
  links: FullLink[];
}

/** Index a map once, so every walk below is a lookup. */
export function indexMap(data: CodeMapData): MapIndex {
  const byId = new Map(data.boxes.map((box) => [box.id, box]));
  const children = new Map<string, MapBox[]>();
  const outgoing = new Map<string, FullLink[]>();
  const incoming = new Map<string, FullLink[]>();
  const links: FullLink[] = [];
  for (const box of data.boxes) {
    if (box.parent) {
      const siblings = children.get(box.parent) ?? [];
      siblings.push(box);
      children.set(box.parent, siblings);
    }
    for (const link of box.links) {
      if (!byId.has(link.to)) continue;
      const full = { ...link, from: box.id };
      links.push(full);
      outgoing.set(box.id, [...(outgoing.get(box.id) ?? []), full]);
      incoming.set(link.to, [...(incoming.get(link.to) ?? []), full]);
    }
  }
  // Reading order: boxes given an `order` come first, by it; the rest by name.
  for (const parts of children.values()) {
    parts.sort(
      (a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
        a.name.localeCompare(b.name),
    );
  }
  return { root: data.root, byId, children, outgoing, incoming, links };
}

/** A box and every box it sits inside, the box itself first, the top last. */
export function ancestors(index: MapIndex, id: string): string[] {
  const chain: string[] = [];
  let at: string | null | undefined = id;
  while (at && !chain.includes(at)) {
    chain.push(at);
    at = index.byId.get(at)?.parent;
  }
  return chain;
}

/** Every box below this one, at any depth. */
export function descendantCount(index: MapIndex, id: string): number {
  return (index.children.get(id) ?? []).reduce((sum, part) => sum + 1 + descendantCount(index, part.id), 0);
}

export interface LevelNode {
  box: MapBox;
  /** A box outside the focus, shown faded because a part links to it. */
  outside: boolean;
  parts: number;
}

export interface LevelEdge {
  /** `from>to>kind` — one drawn arrow per pair and kind. */
  id: string;
  from: string;
  to: string;
  kind: string;
  /** The links in the files this one arrow stands for. */
  links: FullLink[];
}

export interface Level {
  focus: string;
  nodes: LevelNode[];
  edges: LevelEdge[];
}

/**
 * What one level shows: the focus's parts, the outside boxes they link to,
 * and every link lifted to those boxes.
 */
export function levelView(index: MapIndex, focus: string): Level {
  const focusChain = new Set(ancestors(index, focus));
  const inside = new Set((index.children.get(focus) ?? []).map((box) => box.id));

  // Where a box shows at this level: as the part of the focus that holds it,
  // or — outside the focus — as the box beside one of the focus's ancestors
  // that holds it. Null when it can't show (the focus itself, or one of its
  // ancestors, which are the frame rather than a box in it).
  const placed = (id: string): { at: string; outside: boolean } | null => {
    if (focusChain.has(id)) return null;
    const chain = ancestors(index, id);
    for (const at of chain) {
      const parent = index.byId.get(at)?.parent;
      if (parent === focus) return { at, outside: false };
      if (parent && focusChain.has(parent)) return { at, outside: true };
    }
    return null;
  };

  const edges = new Map<string, LevelEdge>();
  const outside = new Set<string>();
  for (const link of index.links) {
    const from = placed(link.from);
    const to = placed(link.to);
    if (!from || !to || from.at === to.at) continue;
    if (from.outside && to.outside) continue;
    if (from.outside) outside.add(from.at);
    if (to.outside) outside.add(to.at);
    const id = `${from.at}>${to.at}>${link.kind}`;
    const edge = edges.get(id) ?? { id, from: from.at, to: to.at, kind: link.kind, links: [] };
    edge.links.push(link);
    edges.set(id, edge);
  }

  const node = (id: string, isOutside: boolean): LevelNode => ({
    box: index.byId.get(id)!,
    outside: isOutside,
    parts: index.children.get(id)?.length ?? 0,
  });
  return {
    focus,
    nodes: [...[...inside].map((id) => node(id, false)), ...[...outside].sort().map((id) => node(id, true))],
    edges: [...edges.values()],
  };
}

/** The box a link should land on when followed: its own level, selected. */
export function levelOf(index: MapIndex, id: string): string {
  return index.byId.get(id)?.parent ?? index.root ?? id;
}

/** A name cut to fit a box, with an ellipsis when it had to be cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
