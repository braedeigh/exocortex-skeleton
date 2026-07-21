import { Link } from '@tanstack/react-router';
import styles from './FakeTerminal.module.css';

/**
 * The public-mode "fake terminal" — React port of split.html's `.cc-fake`
 * block (archived in the owner's vault at reference/old-frontend/). Renders
 * the owner's intro (CONTENT_DIR/public_intro.md, injected by routes/spa.py as
 * window.PUBLIC_INTRO_HTML) as a mock Claude Code session: banner, a fake
 * "what is this site" prompt, the intro as chat output, a blinking cursor, and
 * the two bottom status bars (About link + tmux-style session line).
 *
 * Desktop public visitors get it docked in SplitLayout's left pane — the same
 * spot the real terminal occupies when authed, so the intro's "this side of
 * the page" copy stays true. Mobile public visitors get it full-bleed as the
 * "/" landing (PublicLanding).
 *
 * The intro HTML carries global cc-* classes (cc-p, cc-dim, cc-tool, cc-file)
 * emitted by routes/shell.py's mini-renderer; FakeTerminal.module.css styles
 * them via :global under the scoped root.
 *
 * `onCollapse` is optional and only passed by SplitLayout's desktop public
 * split: when present, a top-right control cluster (about-me link + hide
 * button) renders inside the terminal, and clicking hide calls it so the
 * parent can collapse the pane into the slim rail. PublicLanding's mobile
 * usage omits the prop, so mobile visitors never see the cluster — there's
 * no pane to collapse there.
 */
export function FakeTerminal({ onCollapse }: { onCollapse?: () => void }) {
  const introHtml = typeof window !== 'undefined' ? window.PUBLIC_INTRO_HTML : null;
  const version = typeof window !== 'undefined' ? window.APP_META?.version : null;

  return (
    <div className={styles.fake}>
      {onCollapse ? (
        <div className={styles.controls}>
          <Link to="/about" className={styles.controlBtn}>
            about me
          </Link>
          <button type="button" className={styles.controlBtn} aria-label="Hide this pane" onClick={onCollapse}>
            <span aria-hidden="true">&#8249;</span> hide
          </button>
        </div>
      ) : null}
      <div className={styles.content}>
        <div className={`${styles.banner} ${onCollapse ? styles.bannerControlsPad : ''}`}>
          <span className={styles.mark}>&#9670;</span> Claude Code{' '}
          <span className={styles.dim}>&middot; ~/exocortex{version ? ` · v${version}` : ''}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.prompt}>&gt;</span> <span className={styles.user}>what is this site</span>
        </div>
        {introHtml ? (
          <div className={styles.intro} dangerouslySetInnerHTML={{ __html: introHtml }} />
        ) : null}
        <div className={`${styles.row} ${styles.cursorRow}`}>
          <span className={styles.prompt}>&gt;</span> <span className={styles.cursor}>&#9614;</span>
        </div>
      </div>
      <Link to="/about" className={`${styles.statusbar} ${styles.warn} ${styles.statusbarLink}`}>
        read more about my project here
      </Link>
      <div className={styles.statusbar}>&#9660; ~/exocortex &nbsp;&middot;&nbsp; claude-fable-5 &nbsp;&middot;&nbsp; tmux: chat</div>
    </div>
  );
}
