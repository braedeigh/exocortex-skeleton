import { createFileRoute } from '@tanstack/react-router';
import { PeoplePage } from '../features/people/PeoplePage';
import { useDeactivateFrames } from '../shell/useIframeView';

// The People roster — native port of the legacy #tab-people (people.js).
export const Route = createFileRoute('/people')({
  component: PeopleRoute,
});

function PeopleRoute() {
  useDeactivateFrames();
  return <PeoplePage />;
}
