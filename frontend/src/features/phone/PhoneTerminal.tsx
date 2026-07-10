import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CopyPanel } from '../../shell/CopyPanel';
import { TermNotesPanel } from '../../shell/TermNotesPanel';
import {
  refreshTerminal,
  scrollTerminal,
  sendTerminalKey,
  sendTerminalText,
  uploadTerminalPhotos,
} from './phoneApi';
import {
  SPECIAL_KEYS,
  autosizeHeight,
  swipeToScroll,
  terminalSrc,
  uploadedPathsMessage,
  uploadingLabel,
} from './phoneLogic';
import styles from './PhoneTerminal.module.css';

const DEFAULT_PLACEHOLDER = 'message...';

/**
 * Native React port of templates/phone.html — the mobile terminal chrome the
 * /chat tab used to load as a `/phone?session=…` iframe (one per session, see
 * PhoneFrames). Everything phone.html did, in the same shape:
 *
 * - read-only ttyd iframe (`/terminal/?arg=<session>` — still an iframe, ttyd
 *   is a reverse-proxied external app) made untouchable with pointer-events:
 *   none + tabindex=-1 + inert;
 * - a touch layer over it translating vertical swipes into tmux scroll
 *   commands (swipeToScroll — 15px/line, no momentum, same as the original);
 * - the ret/esc/^C/^O/▲/▼/copy/photo/↻ toolbar over an auto-growing message
 *   textarea (bottom bar absolutely positioned so growth expands upward over
 *   the terminal without resizing the iframe);
 * - 📝/▲▲/▼▼ corner buttons: terminal dev-notes (shared TermNotesPanel) and
 *   jump-to-top/bottom (`mode: 'end'` scrolls);
 * - copy overlay (shared CopyPanel — the desktop port of this same overlay);
 * - multi-photo upload with spinner/error overlay, pasting `[uploaded: …]`
 *   refs into the terminal without pressing Enter;
 * - focus guarding: while this session is the active Chat view, focus falling
 *   to <body> or the ttyd iframe snaps back to the message input, and the
 *   input is (re)focused when the view activates / the terminal reloads.
 *
 * `visible` toggles CSS display (the keep-mounted trick — PhoneFrames never
 * unmounts a visited session, so the ttyd websocket and this component's
 * state survive switches); `active` is "this is the selected session"
 * regardless of the one-frame settle delay (see useSettledFrames).
 * `onInteract` fires on any tap inside the terminal view — the native
 * replacement for the window-blur signal ChatPage used to get when a tap
 * focused the /phone iframe (it folds the session picker away).
 */
export function PhoneTerminal({
  session,
  active,
  visible,
  onInteract,
}: {
  session: string;
  active: boolean;
  visible: boolean;
  onInteract?: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const touchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const notesBtnRef = useRef<HTMLButtonElement>(null);

  const [placeholder, setPlaceholder] = useState(DEFAULT_PLACEHOLDER);
  const [copyOpen, setCopyOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [upload, setUpload] = useState<{ label: string; error: boolean } | null>(null);

  const placeholderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The iframe onLoad focus check reads this instead of `active` so the
  // load listener doesn't need re-binding on every session switch.
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(
    () => () => {
      clearTimeout(placeholderTimer.current ?? undefined);
      clearTimeout(uploadTimer.current ?? undefined);
    },
    [],
  );

  // --- Touch-to-scroll (phone.html:381-402) --------------------------------
  // Native listeners, not React props: touchmove must preventDefault() to
  // stop the page rubber-banding, and React attaches touchmove passively.
  useEffect(() => {
    const el = touchRef.current;
    if (!el) return;
    let startY: number | null = null;
    const onStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
    };
    const onMove = (e: TouchEvent) => {
      e.preventDefault();
    };
    const onEnd = (e: TouchEvent) => {
      if (startY === null) return;
      const deltaY = e.changedTouches[0].clientY - startY;
      startY = null;
      const cmd = swipeToScroll(deltaY);
      if (!cmd) return;
      scrollTerminal(session, cmd.direction, 'lines', cmd.lines).catch(() => {
        // scroll is fire-and-forget, same as phone.html's bare fetch
      });
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
    };
  }, [session]);

  // --- Focus guarding (phone.html:453-484) ----------------------------------
  // Only while this session is the active Chat view: if focus lands on the
  // body or the (inert) ttyd iframe, pull it back to the message input so the
  // keyboard stays on our textarea.
  useEffect(() => {
    if (!active) return;
    const onFocusOut = () => {
      window.setTimeout(() => {
        if (!activeRef.current) return;
        const ae = document.activeElement;
        if (ae === document.body || ae === iframeRef.current) {
          inputRef.current?.focus();
        }
      }, 10);
    };
    document.addEventListener('focusout', onFocusOut);
    return () => document.removeEventListener('focusout', onFocusOut);
  }, [active]);

  // phone.html focused the input when its tab became active (the 'tabActive'
  // postMessage handler) and once on load. `visible` gates it past the
  // one-frame display:none settle so focus() never hits a hidden input.
  useEffect(() => {
    if (active && visible) inputRef.current?.focus();
  }, [active, visible]);

  // --- ttyd iframe -----------------------------------------------------------
  // Auto-refresh tmux 500ms after the terminal (re)loads, then restore focus.
  const onFrameLoad = () => {
    window.setTimeout(() => {
      refreshTerminal(session).catch(() => {});
    }, 500);
    if (activeRef.current) window.setTimeout(() => inputRef.current?.focus(), 600);
  };

  // The ↻ button: reassign src to force a full ttyd reload (phone.html:257).
  const reloadFrame = () => {
    const frame = iframeRef.current;
    if (frame) frame.src = terminalSrc(session);
  };

  // --- Message input ---------------------------------------------------------
  const onInput = (e: FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    el.style.height = 'auto';
    el.style.height = `${autosizeHeight(el.scrollHeight)}px`;
  };

  // Enter inserts a newline (default textarea behavior); only ↑ sends.
  const sendInput = async () => {
    const el = inputRef.current;
    if (!el) return;
    const text = el.value.trim();
    if (!text) return;
    // Clearing synchronously before the request is the double-send guard,
    // same as phone.html: a second tap mid-flight sees an empty box.
    el.value = '';
    el.style.height = 'auto';
    try {
      const data = await sendTerminalText(session, text, true);
      if (data.saved_to) {
        setPlaceholder('Saved to file — path pasted into terminal');
        clearTimeout(placeholderTimer.current ?? undefined);
        placeholderTimer.current = setTimeout(() => setPlaceholder(DEFAULT_PLACEHOLDER), 3000);
      }
    } catch {
      // same silent failure mode as phone.html's un-caught fetch
    }
  };

  const sendSpecial = (key: string) => {
    sendTerminalKey(session, key).catch(() => {});
  };

  const jump = (direction: 'up' | 'down') => {
    scrollTerminal(session, direction, 'end').catch(() => {});
  };

  // --- Photo upload (phone.html:339-379) -------------------------------------
  const onPhotoChange = async (input: HTMLInputElement) => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    clearTimeout(uploadTimer.current ?? undefined);
    setUpload({ label: uploadingLabel(files.length), error: false });
    try {
      const data = await uploadTerminalPhotos(files);
      if (!data.paths || !data.paths.length) throw new Error('no paths returned');
      await sendTerminalText(session, uploadedPathsMessage(data.paths), false);
      setUpload(null);
    } catch (e) {
      setUpload({
        label: `Upload failed: ${e instanceof Error ? e.message : 'unknown error'}`,
        error: true,
      });
      uploadTimer.current = setTimeout(() => setUpload(null), 2200);
    }
  };

  return (
    <div
      className={styles.root}
      style={visible ? undefined : { display: 'none' }}
      onPointerDown={onInteract}
    >
      <div className={styles.terminalArea}>
        <iframe
          ref={iframeRef}
          title={`Chat — ${session}`}
          className={styles.frame}
          src={terminalSrc(session)}
          scrolling="no"
          tabIndex={-1}
          inert
          onLoad={onFrameLoad}
        />
        {/* Sits over the whole terminal area; swipes become tmux scrolls. */}
        <div ref={touchRef} className={styles.touchLayer} />
      </div>

      {/* 📝 terminal dev-notes; ▲▲/▼▼ jump to top/bottom of scrollback
          (touch-drag on the terminal area covers everything in between). */}
      <div className={styles.cornerButtons}>
        <button
          ref={notesBtnRef}
          type="button"
          className={styles.cornerBtn}
          title="Terminal notes"
          aria-label="Terminal notes"
          onClick={() => setNotesOpen((o) => !o)}
        >
          &#128221;
        </button>
        <button
          type="button"
          className={[styles.cornerBtn, styles.jumpBtn].join(' ')}
          title="Jump to top"
          aria-label="Jump to top of scrollback"
          onClick={() => jump('up')}
        >
          &#9650;&#9650;
        </button>
        <button
          type="button"
          className={[styles.cornerBtn, styles.jumpBtn].join(' ')}
          title="Jump to bottom"
          aria-label="Jump to bottom of scrollback"
          onClick={() => jump('down')}
        >
          &#9660;&#9660;
        </button>
      </div>

      <TermNotesPanel open={notesOpen} onClose={() => setNotesOpen(false)} triggerRef={notesBtnRef} />

      <div className={styles.bottomBar}>
        <div className={styles.toolbar}>
          {SPECIAL_KEYS.map(({ label, key }) => (
            <button key={key} type="button" className={styles.toolBtn} onClick={() => sendSpecial(key)}>
              {label}
            </button>
          ))}
          <button type="button" className={styles.toolBtn} onClick={() => setCopyOpen(true)}>
            copy
          </button>
          <button type="button" className={styles.toolBtn} onClick={() => fileRef.current?.click()}>
            photo
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            title="Reload terminal"
            aria-label="Reload terminal"
            onClick={reloadFrame}
          >
            &#8635;
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            tabIndex={-1}
            className={styles.fileInput}
            onChange={(e) => void onPhotoChange(e.currentTarget)}
          />
        </div>
        <div className={styles.inputArea}>
          <textarea
            ref={inputRef}
            className={styles.input}
            rows={1}
            placeholder={placeholder}
            autoComplete="off"
            autoCorrect="on"
            autoCapitalize="sentences"
            spellCheck
            onInput={onInput}
          />
          <button type="button" className={styles.sendBtn} aria-label="Send" onClick={() => void sendInput()}>
            &#8593;
          </button>
        </div>
      </div>

      {copyOpen && <CopyPanel session={session} onClose={() => setCopyOpen(false)} />}

      {upload && (
        <div className={styles.uploadOverlay}>
          <div className={[styles.uploadBox, upload.error ? styles.uploadError : ''].filter(Boolean).join(' ')}>
            {!upload.error && <div className={styles.spinner} />}
            <div>{upload.label}</div>
          </div>
        </div>
      )}
    </div>
  );
}
