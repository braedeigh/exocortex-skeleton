import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import styles from './about.module.css';

/**
 * Public About page. The copy lives in the owner's content vault
 * (CONTENT_DIR/public_about.md — routes/shell.py renders it and serves it at
 * /api/about, both whitelisted in public_config.PUBLIC_PATHS), so this
 * skeleton repo stays free of personal content and the owner edits a plain
 * markdown file instead of a React component. Falls back to a generic blurb
 * when the vault file doesn't exist.
 */
export const Route = createFileRoute('/about')({
  component: AboutPage,
});

interface AboutResponse {
  html: string;
}

function AboutPage() {
  const { data, isPending } = useQuery({
    queryKey: ['about'],
    queryFn: ({ signal }) => api.get<AboutResponse>('/api/about', signal),
    staleTime: 5 * 60 * 1000,
  });

  const isPublic = typeof window !== 'undefined' && window.VIEW_MODE === 'public';

  return (
    <main className={styles.page}>
      <div className={styles.prose}>
        {isPending ? null : data?.html ? (
          <div dangerouslySetInnerHTML={{ __html: data.html }} />
        ) : (
          <div>
            <h1>About</h1>
            <p>
              This is a self-hosted Exocortex instance — a personal life and health dashboard.
              Create <code>public_about.md</code> in your content directory to replace this page
              with your own words.
            </p>
          </div>
        )}
        <p className={styles.backRow}>
          <Link to={isPublic ? '/' : '/todos'} className={styles.back}>
            &larr; Back to dashboard
          </Link>
        </p>
      </div>
    </main>
  );
}
