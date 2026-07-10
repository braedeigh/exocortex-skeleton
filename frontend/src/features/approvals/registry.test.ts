import { describe, expect, it } from 'vitest';
import { getApprovalEditor, registerApprovalEditor, registeredApprovalKinds } from './registry';
import './builtinEditors';
import type { ApprovalEditorEntry } from './types';

describe('approval editor registry', () => {
  it('ships an editor for every kind the legacy files registered', () => {
    // window._approvalEditors covered: life_todo/todo (pending.js), food
    // (approvals/food.js), symptoms (approvals/long-covid.js), contact
    // (approvals/contacts.js).
    for (const kind of ['todo', 'life_todo', 'food', 'symptoms', 'contact']) {
      expect(getApprovalEditor(kind), kind).toBeDefined();
    }
    expect(getApprovalEditor('todo')?.title).toBe('Approve to-do?');
  });

  it('is undefined for unregistered kinds — the host falls back to the generic editor', () => {
    expect(getApprovalEditor('life_remove')).toBeUndefined();
    expect(getApprovalEditor('mystery')).toBeUndefined();
  });

  it('lets future kinds register their own editor', () => {
    const entry: ApprovalEditorEntry = { title: 'Approve widget?', Editor: () => null };
    registerApprovalEditor('widget', entry);
    expect(getApprovalEditor('widget')).toBe(entry);
    expect(registeredApprovalKinds()).toContain('widget');
  });
});
