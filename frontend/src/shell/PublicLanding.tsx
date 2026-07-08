import styles from './PublicLanding.module.css';

/**
 * Shown at "/" for anonymous visitors (window.VIEW_MODE === 'public') instead
 * of the authed redirect to /todos. Mirrors the intent of split.html's public
 * mode (frosted dashboard + a "fake terminal" intro), simplified to a single
 * frosted card: the server-rendered intro plus a sign-in link.
 */
export function PublicLanding() {
  const introHtml = typeof window !== 'undefined' ? window.PUBLIC_INTRO_HTML : null;

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        {introHtml ? (
          <div className={styles.intro} dangerouslySetInnerHTML={{ __html: introHtml }} />
        ) : (
          <p className={styles.intro}>Welcome.</p>
        )}
        <div className={styles.actions}>
          <a href="/login" className={styles.signIn}>
            Sign in
          </a>
        </div>
      </div>
    </div>
  );
}
