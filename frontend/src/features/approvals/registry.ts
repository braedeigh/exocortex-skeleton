/**
 * registry.ts — kind → approval editor. The React port of the legacy
 * `window._approvalEditors` registry: each change kind registers the editor
 * that MIRRORS its native form, and kinds without one fall back to the
 * generic field editor (handled by ApprovalsHost).
 *
 * Future change-kinds: build an editor component satisfying
 * ApprovalEditorProps and call registerApprovalEditor('<kind>', { title,
 * Editor }) before ApprovalsHost renders (module scope of a file imported by
 * builtinEditors.ts, or anywhere in app bootstrap).
 */
import type { ApprovalEditorEntry } from './types';

const registry = new Map<string, ApprovalEditorEntry>();

export function registerApprovalEditor(kind: string, entry: ApprovalEditorEntry): void {
  registry.set(kind, entry);
}

export function getApprovalEditor(kind: string): ApprovalEditorEntry | undefined {
  return registry.get(kind);
}

/** Registered kinds, mostly for tests/diagnostics. */
export function registeredApprovalKinds(): string[] {
  return [...registry.keys()];
}
