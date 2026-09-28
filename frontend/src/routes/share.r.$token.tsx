import { createFileRoute } from '@tanstack/react-router';
import { SharedRecipePage } from '../features/kitchen/SharedRecipePages';
import { readVisitor, type Visitor } from '../features/kitchen/shareApi';

/**
 * One shared recipe, opened by its link — open to anyone, drawn without the
 * shell (see __root.tsx). The visitor's age and sex live in the URL search.
 */
export const Route = createFileRoute('/share/r/$token')({
  validateSearch: readVisitor,
  component: SharedRecipeRoute,
});

function SharedRecipeRoute() {
  const { token } = Route.useParams();
  const visitor = Route.useSearch();
  const navigate = Route.useNavigate();
  const onVisitor = (next: Visitor) => navigate({ search: next, replace: true });
  return <SharedRecipePage token={token} visitor={visitor} onVisitor={onVisitor} />;
}
