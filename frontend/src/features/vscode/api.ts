/**
 * api.ts — feature-local endpoint helpers over the shared client.
 * Endpoints verified against templates/vscode_launcher.html + server.py:
 *   GET  /api/vscode/status  (polled at 1s, but only while starting)
 *   POST /api/vscode/start   (409 {error:"insufficient memory"} when low RAM)
 *   POST /api/vscode/stop
 * Both POSTs are bodyless, matching the old fetch(..., {method:"POST"}).
 */

import { api } from '../../api/client';
import type { VscodeStatus } from './types';

export function getVscodeStatus(signal?: AbortSignal): Promise<VscodeStatus> {
  return api.get('/api/vscode/status', signal);
}

export function startVscode(): Promise<{ ok: boolean }> {
  return api.post('/api/vscode/start');
}

export function stopVscode(): Promise<{ ok: boolean }> {
  return api.post('/api/vscode/stop');
}
