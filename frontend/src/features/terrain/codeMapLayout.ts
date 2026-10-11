/**
 * codeMapLayout.ts — places one level of a codebase map (codeMap.ts
 * `levelView`) on the page: boxes in layers top to bottom, arrows routed
 * between them around the boxes.
 *
 * The placing is elkjs's "layered" algorithm — the standard way to draw a
 * graph whose arrows mostly run one way (who uses whom): boxes that use come
 * above the boxes they use, arrows bend at right angles, and crossings are
 * kept few. Terrain's file map uses a force simulation instead, which suits a
 * tree of thousands of files but scatters a dozen boxes with named arrows.
 *
 * Async because elk is: it returns a promise even when run in the page.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { Level } from './codeMap';

/** Every box is the same size, so a level reads as a grid of equals. */
export const BOX_WIDTH = 208;
export const BOX_HEIGHT = 72;

export interface PlacedBox {
  id: string;
  x: number;
  y: number;
}

export interface PlacedEdge {
  id: string;
  /** The route as points, start to end, ready to draw as one line. */
  points: { x: number; y: number }[];
}

export interface Placed {
  width: number;
  height: number;
  boxes: Map<string, PlacedBox>;
  edges: Map<string, PlacedEdge>;
}

const elk = new ELK();

/** Lay out one level. Resolves to every box's corner and every arrow's route. */
export async function layoutLevel(level: Level): Promise<Placed> {
  const input: ElkNode = {
    id: 'level',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '32',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.spacing.edgeEdge': '8',
      'elk.layered.spacing.edgeNodeBetweenLayers': '20',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.padding': '[top=24,left=24,bottom=24,right=24]',
    },
    children: level.nodes.map((node) => ({ id: node.box.id, width: BOX_WIDTH, height: BOX_HEIGHT })),
    edges: level.edges.map((edge) => ({ id: edge.id, sources: [edge.from], targets: [edge.to] })),
  };
  const graph = await elk.layout(input);

  const boxes = new Map<string, PlacedBox>();
  for (const child of graph.children ?? []) {
    boxes.set(child.id, { id: child.id, x: child.x ?? 0, y: child.y ?? 0 });
  }
  const edges = new Map<string, PlacedEdge>();
  for (const edge of graph.edges ?? []) {
    const section = edge.sections?.[0];
    if (!section) continue;
    edges.set(edge.id, {
      id: edge.id,
      points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint],
    });
  }
  return { width: graph.width ?? 0, height: graph.height ?? 0, boxes, edges };
}

/**
 * An arrow's route as an SVG path, with its right-angle corners rounded a
 * little so a bundle of parallel arrows reads as lines, not a circuit board.
 */
export function roundedPath(points: { x: number; y: number }[], radius = 8): string {
  if (points.length === 0) return '';
  let path = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const here = points[i];
    const next = points[i + 1];
    const into = Math.min(radius, Math.hypot(here.x - prev.x, here.y - prev.y) / 2);
    const out = Math.min(radius, Math.hypot(next.x - here.x, next.y - here.y) / 2);
    const before = towards(here, prev, into);
    const after = towards(here, next, out);
    path += ` L${before.x},${before.y} Q${here.x},${here.y} ${after.x},${after.y}`;
  }
  const last = points[points.length - 1];
  return `${path} L${last.x},${last.y}`;
}

/** The point `distance` along the way from `from` towards `to`. */
function towards(from: { x: number; y: number }, to: { x: number; y: number }, distance: number) {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: from.x + ((to.x - from.x) / length) * distance, y: from.y + ((to.y - from.y) / length) * distance };
}

/** The halfway point along a route, where an arrow's count badge sits. */
export function midpoint(points: { x: number; y: number }[]): { x: number; y: number } {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let remaining = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]) return towards(points[i], points[i + 1], remaining);
    remaining -= lengths[i];
  }
  return points[points.length - 1] ?? { x: 0, y: 0 };
}
