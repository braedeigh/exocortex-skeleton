import { createFileRoute } from '@tanstack/react-router';
import { PersonPage } from '../features/person/PersonPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// The deep single-person view — native port of the Flask-served person.html
// + person.js at /person/<slug> (routes/person.py).
export const Route = createFileRoute('/person/$slug')({
  component: PersonRoute,
});

function PersonRoute() {
  useDeactivateFrames();
  const { slug } = Route.useParams();
  // Remount on slug change so per-person UI state (fact editors, scroll)
  // never bleeds between people.
  return <PersonPage key={slug} slug={slug} />;
}
