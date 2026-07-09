import { createFileRoute } from '@tanstack/react-router';
import { InventoryPage } from '../features/inventory/InventoryPage';
import { useDeactivateFrames } from '../shell/useIframeView';

export interface InventorySearch {
  /** ?buy=<name> — opens the buy-item detail (replaces the old /item/buy/<name>). */
  buy?: string;
}

export const Route = createFileRoute('/inventory')({
  component: InventoryRoute,
  validateSearch: (search: Record<string, unknown>): InventorySearch => ({
    buy: typeof search.buy === 'string' && search.buy ? search.buy : undefined,
  }),
});

function InventoryRoute() {
  useDeactivateFrames();
  const { buy } = Route.useSearch();
  return <InventoryPage buyName={buy} />;
}
