/**
 * api.ts — the build-queue endpoints (routes/buildtodo.py).
 *
 * One GET returns both halves of the queue: `cards`, the real records kept in
 * SQLite, and `legacy`, the old dev_todo.md's `## ` sections parsed read-only.
 * Everything else acts on cards only — the markdown file is not written from
 * here (see the route module for why it isn't migrated).
 */
import { api } from '../../api/client';

export type BuildStatus = 'open' | 'shipped' | 'dropped';
export type BuildPriority = 'red' | 'orange' | 'yellow';

export interface BuildCard {
  /** `YYYY-MM-DD.<4 hex>` — the mint date is on the id's face. */
  id: string;
  title: string;
  body: string;
  status: BuildStatus;
  /** null when nobody has put a read on the urgency. */
  priority: BuildPriority | null;
  author: string;
  /** 'YYYY-MM-DD'. Empty for a record written before the field existed. */
  created: string;
  updated: string;
  tags: string[];
}

/** A `## ` section of the pre-split dev_todo.md. Read-only: `id` is a
 * positional `legacy:<n>`, not something the server can be asked to change. */
export interface LegacySection {
  id: string;
  title: string;
  body: string;
  author: string;
  created: string;
  /** The heading says SHIPPED/FIXED/✅ — a display hint read off the prose. */
  shipped: boolean;
}

export interface BuildQueue {
  cards: BuildCard[];
  legacy: LegacySection[];
}

export interface NewBuildCard {
  title: string;
  body?: string;
  author?: string;
  priority?: BuildPriority | null;
  tags?: string[];
}

/** Fields to change. Anything omitted is left alone — the server treats an
 * absent key as "don't touch", not "clear". */
export interface BuildCardPatch {
  title?: string;
  body?: string;
  status?: BuildStatus;
  priority?: BuildPriority | null;
  author?: string;
  tags?: string[];
}

export function getBuildQueue(signal?: AbortSignal): Promise<BuildQueue> {
  return api.get('/api/buildtodo', signal);
}

export function addBuildCard(card: NewBuildCard): Promise<BuildCard> {
  return api.post('/api/buildtodo/add', card);
}

export function updateBuildCard(id: string, patch: BuildCardPatch): Promise<BuildCard> {
  return api.post('/api/buildtodo/update', { id, ...patch });
}

/** Hard delete — shipping or dropping is a status change, this is for the
 * mis-filed ones. The removed card comes back so an undo can re-add it. */
export function removeBuildCard(id: string): Promise<{ ok: true; card: BuildCard }> {
  return api.post('/api/buildtodo/remove', { id });
}

/** Undo of remove: the whole card back, id and created intact. */
export function restoreBuildCard(card: BuildCard): Promise<BuildCard> {
  return api.post('/api/buildtodo/restore', { card });
}
