import { createFileRoute } from '@tanstack/react-router';
import { MoneyPage } from '../features/money/MoneyPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// Money tab — native port of /tab/money (#tab-money + static/js/money.js).
export const Route = createFileRoute('/money')({
  component: MoneyRoute,
});

function MoneyRoute() {
  useDeactivateFrames();
  return <MoneyPage />;
}
