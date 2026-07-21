/** Shapes returned by routes/keeper.py — see build_tree() and the file endpoints. */

export interface KeeperFile {
  /** Vault-relative path, e.g. "people/sage.md". */
  path: string;
  /** File stem (no directory, no .md) — what the tree rows show. */
  name: string;
  /** Top-level folder, or "Core" for vault-root files. */
  group: string;
  mtime: number;
}

export interface KeeperTreeResponse {
  files: KeeperFile[];
}

export interface KeeperFileResponse {
  path: string;
  content: string;
}

export interface KeeperSaveResponse {
  ok: boolean;
}

/** DELETE hands back content + group so the client can offer Undo and bump
 * the user into the deleted file's folder. */
export interface KeeperDeleteResponse {
  ok: boolean;
  path: string;
  group: string;
  content: string;
}

export interface KeeperRestoreResponse {
  ok: boolean;
  path: string;
}
