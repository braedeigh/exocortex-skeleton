import { createFileRoute } from '@tanstack/react-router';
import { SharedRecipesPage } from '../features/kitchen/SharedRecipePages';
import { readVisitor, type Visitor } from '../features/kitchen/shareApi';

/**
 * Every shared recipe, most opened first — open to anyone, drawn without the
 * shell (see __root.tsx). The visitor's age and sex live in the URL search.
 */
export const Route = createFileRoute('/share/recipes')({
  validateSearch: readVisitor,
  component: SharedRecipesRoute,
});

function SharedRecipesRoute() {
  const visitor = Route.useSearch();
  const navigate = Route.useNavigate();
  const onVisitor = (next: Visitor) => navigate({ search: next, replace: true });
  return <SharedRecipesPage visitor={visitor} onVisitor={onVisitor} />;
}
