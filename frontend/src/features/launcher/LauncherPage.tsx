import { useEffect } from 'react';
import { APPS, BASED_FOODS, appStartHref, basedFoodsUrl, leaveApp } from '../../shell/apps';
import styles from './LauncherPage.module.css';

/**
 * LauncherPage.tsx — the front door ("/") now that the site is cut into apps.
 *
 * One card per app (apps.json, read through shell/apps.ts), each opening
 * that app's start page with `?app=<id>` — a full page load, not a router
 * move, so the server dresses the page as that app (its manifest, icon and
 * name; routes/spa.py) and "Add to Home Screen" installs the right one.
 * Based Foods gets a card too when this install has its address
 * (config.based_foods_url); it is its own app, so the card simply leaves.
 *
 * Under the cards, how installing works, including the iPhone catch: each
 * Home Screen app keeps its own sign-in, so she signs in once per app, and a
 * notification belongs to the app that turned notifications on.
 *
 * Opening the launcher forgets the window's app, so a window that came here
 * from the Journal isn't still treated as the Journal (shell/apps.ts).
 *
 * Her ask: "i don't necessarily want to use the full exocortex app once i've
 * separated them out though. i just want them all to be modular pieces that
 * can connect."
 */
export function LauncherPage() {
  useEffect(() => leaveApp(), []);
  const foods = basedFoodsUrl();
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Apps</h1>
      <nav className={styles.cards} aria-label="Apps">
        {APPS.map((app) => (
          <a key={app.id} className={styles.card} href={appStartHref(app)}>
            <span className={styles.glyph} aria-hidden="true">
              {app.glyph}
            </span>
            <span className={styles.name}>{app.name}</span>
          </a>
        ))}
        {foods ? (
          <a className={styles.card} href={foods}>
            <span className={styles.glyph} aria-hidden="true">
              {BASED_FOODS.glyph}
            </span>
            <span className={styles.name}>{BASED_FOODS.name} ↗</span>
          </a>
        ) : null}
      </nav>
      <section className={styles.install}>
        <h2 className={styles.installTitle}>Putting one on your phone</h2>
        <p>
          Open the app here, then tap Share → <strong>Add to Home Screen</strong>. Each app goes on
          the Home Screen as its own icon.
        </p>
        <p>
          On an iPhone each Home Screen app keeps its own sign-in, so sign in once in each one. Turn
          notifications on inside the app you want them in — they arrive in that app.
        </p>
      </section>
    </div>
  );
}
