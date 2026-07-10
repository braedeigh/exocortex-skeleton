/**
 * features/approvals — the pending-change approval flow (React port of
 * static/js/pending.js + static/js/approvals/*). Mount <ApprovalsHost /> once
 * at the shell root, inside the shared QueryClientProvider; see the contract
 * comment on ApprovalsHost.
 */
export { ApprovalsHost, ApprovalsHost as default } from './ApprovalsHost';
export type { ApprovalsHostProps, ApprovalsToast } from './ApprovalsHost';

export { getApprovalEditor, registerApprovalEditor, registeredApprovalKinds } from './registry';
export type {
  ApprovalCommitPlan,
  ApprovalEditorEntry,
  ApprovalEditorProps,
  ApprovalUndo,
  PendingChange,
  PendingQueue,
} from './types';
