/**
 * Keeper endpoints (routes/keeper.py). Local to this feature — same precedent
 * as the journal keeping its threads fetchers in-feature: hoist to
 * src/api/endpoints.ts only if another feature ever needs them.
 */
import { api } from '../../api/client';
import type {
  KeeperDeleteResponse,
  KeeperFileResponse,
  KeeperRestoreResponse,
  KeeperSaveResponse,
  KeeperTreeResponse,
} from './types';

/** GET /api/keeper/tree — every browsable .md file in the vault, flat. */
export function getKeeperTree(signal?: AbortSignal): Promise<KeeperTreeResponse> {
  return api.get('/api/keeper/tree', signal);
}

/** GET /api/keeper/file?path=… — one file's content. */
export function getKeeperFile(path: string, signal?: AbortSignal): Promise<KeeperFileResponse> {
  return api.get(`/api/keeper/file?path=${encodeURIComponent(path)}`, signal);
}

/** POST /api/keeper/file — save (existing files only; this tab never creates). */
export function saveKeeperFile(path: string, content: string): Promise<KeeperSaveResponse> {
  return api.post('/api/keeper/file', { path, content });
}

/** DELETE /api/keeper/file?path=… — returns the content for one-shot undo. */
export function deleteKeeperFile(path: string): Promise<KeeperDeleteResponse> {
  return api.delete(`/api/keeper/file?path=${encodeURIComponent(path)}`);
}

/** POST /api/keeper/file/restore — undo of a delete, right after, from content
 * the server just handed out. */
export function restoreKeeperFile(path: string, content: string): Promise<KeeperRestoreResponse> {
  return api.post('/api/keeper/file/restore', { path, content });
}
