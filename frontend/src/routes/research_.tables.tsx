import { createFileRoute, redirect } from '@tanstack/react-router';
import { TablesPage, type TablesSearch } from '../features/research/TablesPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /research/tables — the research tables: foods × hazards, every number with
 * its study, and verdict tables (features/research/TablesPage.tsx). Un-nested
 * from /research like /research/claims. Selection lives in the search params:
 * ?table=<id> opens a table, ?food=&col= a cell, ?view=map|new the hazard map
 * or the new-table form, ?all=1 keeps foods with nothing yet, ?verdict=<id>
 * one verdict on its own (linked from the kitchen's grocery list). Auth-only.
 */

export const Route = createFileRoute('/research_/tables')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: TablesRoute,
  validateSearch: (search: Record<string, unknown>): TablesSearch => {
    const whole = (key: string) => {
      const value = Number(search[key]);
      return Number.isInteger(value) && value > 0 ? value : undefined;
    };
    const out: TablesSearch = {};
    const table = whole('table');
    const food = whole('food');
    if (table) out.table = table;
    if (food) out.food = food;
    const verdict = whole('verdict');
    if (verdict) out.verdict = verdict;
    if (typeof search.col === 'string' && search.col) out.col = search.col;
    if (search.view === 'map' || search.view === 'new') out.view = search.view;
    if (search.all === true || search.all === 'true' || search.all === 1 || search.all === '1') out.all = true;
    return out;
  },
});

function TablesRoute() {
  useDeactivateFrames();
  return <TablesPage />;
}
