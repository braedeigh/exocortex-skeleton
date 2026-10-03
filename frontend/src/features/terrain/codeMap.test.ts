import { describe, expect, it } from 'vitest';
import { indexMap, levelView, type CodeMapData, type MapBox } from './codeMap';

/** A box with only what the walk reads filled in. */
function box(id: string, parent: string | null, links: [string, string][] = []): MapBox {
  return {
    id,
    name: id,
    kind: parent ? 'module' : 'project',
    parent,
    order: null,
    description: '',
    sources: [],
    links: links.map(([kind, to]) => ({ kind, to, reason: `${id} ${kind} ${to}` })),
    written: null,
    stale: false,
    broken: false,
    problems: [],
  };
}

// shop → api (auth, routes), db (schema, queries), web.
// routes.calls → queries; auth.reads → schema; web.calls → routes;
// routes.depends-on → auth (inside api); queries.reads → schema (inside db).
const shop: CodeMapData = {
  key: 'shop/system',
  repo: 'shop',
  repo_name: 'Shop',
  name: 'Shop',
  root: 'shop',
  problems: [],
  link_kinds: [],
  boxes: [
    box('shop', null),
    box('api', 'shop'),
    box('api.auth', 'api', [['reads', 'db.schema']]),
    box('api.routes', 'api', [
      ['calls', 'db.queries'],
      ['depends-on', 'api.auth'],
    ]),
    box('db', 'shop'),
    box('db.schema', 'db'),
    box('db.queries', 'db', [['reads', 'db.schema']]),
    box('web', 'shop', [['calls', 'api.routes']]),
  ],
};

const arrows = (edges: { from: string; to: string; kind: string; links: unknown[] }[]) =>
  edges.map((e) => `${e.from} ${e.kind} ${e.to} ×${e.links.length}`).sort();

describe('levelView', () => {
  it('lifts deep links to the top boxes and hides links inside one box', () => {
    const level = levelView(indexMap(shop), 'shop');
    expect(level.nodes.map((n) => [n.box.id, n.outside, n.parts])).toEqual([
      ['api', false, 2],
      ['db', false, 2],
      ['web', false, 0],
    ]);
    // routes→auth and queries→schema each stay inside one box: not drawn here.
    expect(arrows(level.edges)).toEqual(['api calls db ×1', 'api reads db ×1', 'web calls api ×1']);
  });

  it('opens a box into its parts with the boxes they link to faded outside', () => {
    const level = levelView(indexMap(shop), 'api');
    expect(level.nodes.map((n) => [n.box.id, n.outside])).toEqual([
      ['api.auth', false],
      ['api.routes', false],
      ['db', true],
      ['web', true],
    ]);
    expect(arrows(level.edges)).toEqual([
      'api.auth reads db ×1',
      'api.routes calls db ×1',
      'api.routes depends-on api.auth ×1',
      'web calls api.routes ×1',
    ]);
  });
});
