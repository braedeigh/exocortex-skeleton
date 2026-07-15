/**
 * builtinEditors.ts — registers the shipped per-kind approval editors
 * (the React port of each static/js/approvals/*.js file self-registering
 * into window._approvalEditors). Imported for its side effects by
 * ApprovalsHost. Titles are the legacy modal titles.
 */
import { ContactApprovalEditor } from './ContactApprovalEditor';
import { FoodApprovalEditor } from './FoodApprovalEditor';
import { SymptomsApprovalEditor } from './SymptomsApprovalEditor';
import { ThreadApprovalEditor } from './ThreadApprovalEditor';
import { TodoApprovalEditor } from './TodoApprovalEditor';
import { registerApprovalEditor } from './registry';

registerApprovalEditor('todo', { title: 'Approve to-do?', Editor: TodoApprovalEditor });
registerApprovalEditor('life_todo', { title: 'Approve to-do?', Editor: TodoApprovalEditor });
registerApprovalEditor('food', { title: 'Log food? ✍️', Editor: FoodApprovalEditor });
registerApprovalEditor('symptoms', { title: 'Log symptoms? ✍️', Editor: SymptomsApprovalEditor });
registerApprovalEditor('contact', { title: 'Log contact? ✍️', Editor: ContactApprovalEditor });
registerApprovalEditor('thread_open', { title: 'New thread? 🧵', Editor: ThreadApprovalEditor });
registerApprovalEditor('thread_link', { title: 'Rewire thread? 🧵', Editor: ThreadApprovalEditor });
registerApprovalEditor('thread_retire', { title: 'Retire thread? 🧵', Editor: ThreadApprovalEditor });
