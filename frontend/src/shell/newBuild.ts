/**
 * newBuild.ts — has the server got a newer build of this page than the one
 * that is open?
 *
 * The app never reloads itself: a tab or the phone app left open keeps
 * running the page it loaded, however many builds ship after. This file is
 * the check behind the reload bar (NewBuildBar.tsx). It reads the name of the
 * build this page was loaded from off its own document, asks the server for
 * the name of the build it holds now (GET /api/build, routes/spa.py), and
 * says whether they differ.
 *
 * Prompt that produced it: "add a small 'A newer version is ready — Reload'
 * bar that appears when the server has a newer build than the page you have
 * open".
 */
import { useEffect, useState } from 'react';

/** How often an open, visible page asks. Coming back to the tab also asks. */
const CHECK_EVERY_MS = 60_000;

/** Name the build this page was loaded from.
 *
 * The built page points at its main script and stylesheet by names that carry
 * a hash of their contents, so the names are the build's identity. They are
 * sorted and joined, exactly as the server does it (routes/spa.py build_id),
 * so equal builds give equal strings. Answers '' when the page loads no such
 * file, which is the development server. */
export function runningBuild(doc: Pick<Document, 'querySelectorAll'> = document): string {
  const names = new Set<string>();
  for (const el of doc.querySelectorAll('[src^="/assets/index-"], [href^="/assets/index-"]')) {
    const address = el.getAttribute('src') ?? el.getAttribute('href') ?? '';
    const name = address.slice('/assets/'.length);
    if (/^index-[\w-]+\.(js|css)$/.test(name)) names.add(name);
  }
  return [...names].sort().join('+');
}

/** Decide whether the server's build is a different one from this page's.
 * A blank on either side means "unknown" (a build is mid-write, or this is
 * the development server), and unknown is never news. */
export function isNewerBuild(running: string, served: string): boolean {
  return running !== '' && served !== '' && running !== served;
}

/** Ask the server which build it holds. Any failure answers '': offline, a
 * signed-out visitor and a server mid-reload all just mean "ask again later".
 * A plain fetch on purpose: the shared api client sends a signed-out visitor
 * to the login page on a 401, and a background check must never do that. */
async function servedBuild(): Promise<string> {
  try {
    const response = await fetch('/api/build', { cache: 'no-store' });
    if (!response.ok) return '';
    const body = (await response.json()) as { build?: unknown };
    return typeof body.build === 'string' ? body.build : '';
  } catch {
    return '';
  }
}

/** Watch for a newer build while the page is open.
 *
 * This is a poll: one small request a minute while the page is visible, and
 * one the moment she comes back to it. Returns the newer build's name, or
 * null while this page is current. Once a newer build is seen the answer
 * stays until the page is reloaded, though it follows on to a still newer
 * name so the bar can come back after being dismissed. */
export function useNewerBuild(enabled: boolean): string | null {
  const [newer, setNewer] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const running = runningBuild();
    if (!running) return;
    let stopped = false;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      void servedBuild().then((served) => {
        if (!stopped && isNewerBuild(running, served)) setNewer(served);
      });
    };
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', check);
    check();
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [enabled]);

  return newer;
}
