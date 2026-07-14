import { describe, expect, it } from 'vitest';
import { EMPTY_EDITOR_FILTERS, filterEditorTodos, flattenAllTodos } from './editorHelpers';
import type { EditorFilters } from './editorHelpers';
import type { TodoItem, TodoSection } from './types';

const TODAY = '2026-07-08';

function item(id: string, overrides: Partial<TodoItem> = {}): TodoItem {
  return { id, text: `Task ${id}`, done: false, ...overrides };
}

function sections(): TodoSection[] {
  return [
    {
      name: 'Now',
      manual_order: false,
      items: [
        item('a', { text: 'Call the pharmacy', theme: 'health', notes: 'ask about refills' }),
        item('b', { text: 'Snoozed thing', snoozed_until: '2026-07-12' }),
      ],
    },
    {
      name: 'Up Next',
      manual_order: false,
      items: [item('c', { text: 'Waiting thing', after_date: '2026-07-20' })],
    },
    { name: 'Later', manual_order: false, items: [item('d')] },
    { name: 'Someday', manual_order: false, items: [item('e', { status: 'waiting' })] },
    { name: 'Done', manual_order: false, items: [item('f', { done: true })] },
  ];
}

function filters(overrides: Partial<EditorFilters> = {}): EditorFilters {
  return { ...EMPTY_EDITOR_FILTERS, ...overrides };
}

describe('flattenAllTodos', () => {
  it('flattens every section in order and labels each entry with its section', () => {
    const flat = flattenAllTodos(sections(), TODAY);
    expect(flat.map((e) => e.item.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(flat.map((e) => e.section)).toEqual(['Now', 'Now', 'Up Next', 'Later', 'Someday', 'Done']);
  });
  it('flags snoozed and waiting items instead of hiding them', () => {
    const flat = flattenAllTodos(sections(), TODAY);
    const byId = new Map(flat.map((e) => [e.item.id, e]));
    expect(byId.get('b')).toMatchObject({ snoozed: true, waiting: false });
    expect(byId.get('c')).toMatchObject({ snoozed: false, waiting: true });
    expect(byId.get('a')).toMatchObject({ snoozed: false, waiting: false });
  });
});

describe('filterEditorTodos', () => {
  it('"All" (empty section filter) means the four ladder sections, not Done', () => {
    const out = filterEditorTodos(flattenAllTodos(sections(), TODAY), filters());
    expect(out.map((e) => e.item.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('the Done chip shows only the Done section', () => {
    const out = filterEditorTodos(flattenAllTodos(sections(), TODAY), filters({ section: 'Done' }));
    expect(out.map((e) => e.item.id)).toEqual(['f']);
  });
  it('a ladder chip narrows to that one section', () => {
    const out = filterEditorTodos(flattenAllTodos(sections(), TODAY), filters({ section: 'Now' }));
    expect(out.map((e) => e.item.id)).toEqual(['a', 'b']);
  });
  it('keeps snoozed and waiting items visible', () => {
    const out = filterEditorTodos(flattenAllTodos(sections(), TODAY), filters());
    const ids = out.map((e) => e.item.id);
    expect(ids).toContain('b');
    expect(ids).toContain('c');
  });
  it('search matches text case-insensitively', () => {
    const out = filterEditorTodos(flattenAllTodos(sections(), TODAY), filters({ search: 'PHARMACY' }));
    expect(out.map((e) => e.item.id)).toEqual(['a']);
  });
  it('search matches notes too', () => {
    const out = filterEditorTodos(flattenAllTodos(sections(), TODAY), filters({ search: 'refills' }));
    expect(out.map((e) => e.item.id)).toEqual(['a']);
  });
  it('filters by focus theme', () => {
    const out = filterEditorTodos(flattenAllTodos(sections(), TODAY), filters({ theme: 'health' }));
    expect(out.map((e) => e.item.id)).toEqual(['a']);
  });
  it('__none__ theme matches only untagged items', () => {
    const out = filterEditorTodos(flattenAllTodos(sections(), TODAY), filters({ theme: '__none__' }));
    expect(out.map((e) => e.item.id)).toEqual(['b', 'c', 'd', 'e']);
  });
  it('filters by status', () => {
    const flat = flattenAllTodos(sections(), TODAY);
    expect(filterEditorTodos(flat, filters({ status: 'waiting' })).map((e) => e.item.id)).toEqual(['e']);
  });
  it('combines section + search filters', () => {
    const out = filterEditorTodos(
      flattenAllTodos(sections(), TODAY),
      filters({ section: 'Now', search: 'snoozed' }),
    );
    expect(out.map((e) => e.item.id)).toEqual(['b']);
  });
  it('returns nothing when the combo matches nothing', () => {
    const out = filterEditorTodos(
      flattenAllTodos(sections(), TODAY),
      filters({ section: 'Later', theme: 'health' }),
    );
    expect(out).toEqual([]);
  });
});
