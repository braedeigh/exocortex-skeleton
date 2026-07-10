/**
 * types.ts — payload of GET /api/vscode/status, verified against
 * server.py vscode_status() (VSCODE_MEMORY_THRESHOLD_MB block).
 */

export interface TopProcess {
  name: string;
  mb: number;
}

export interface VscodeStatus {
  running: boolean;
  available_mb: number;
  total_mb: number;
  threshold_mb: number;
  ok_to_start: boolean;
  /** Only populated when ok_to_start is false — top 5 by RSS. */
  top_processes: TopProcess[];
}
