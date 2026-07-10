import { createFileRoute, Link } from '@tanstack/react-router';

// Port of templates/about.html — a public static blurb. Edit the copy here.
export const Route = createFileRoute('/about')({
  component: AboutPage,
});

function AboutPage() {
  return (
    <main style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ maxWidth: 640, margin: '48px auto', padding: '0 20px', lineHeight: 1.6 }}>
        <h1>About</h1>
        <p>
          This is a self-hosted Exocortex instance — a personal life and health dashboard. Edit
          this page (<code>frontend/src/routes/about.tsx</code>) to say whatever you want about
          your own instance.
        </p>
        <p>
          <Link to="/">&larr; Back to dashboard</Link>
        </p>
      </div>
    </main>
  );
}
