import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Live tmux session list for the terminal pane — the React port of
 * split.html's session management (loadSessions / connectSessionStream /
 * add/removeSession, templates/split.html:623-837).
 *
 * Server contract (routes/terminal.py):
 *   GET    /api/sessions          -> { sessions: string[], defaults: string[] }
 *   POST   /api/sessions {name}   -> { sessions } | { error }
 *   DELETE /api/sessions {name}   -> { sessions } | { error }
 *   GET    /api/sessions/stream   -> SSE, each message the GET payload
 *   POST   /api/terminal/session {session}  -> records the active session
 *
 * The active session (which one the ttyd iframe is attached to) is UI state,
 * persisted to localStorage under the same key split.html used so a user's
 * choice survives the classic<->React swap.
 */

const ACTIVE_KEY = 'exo-desktop-session';
const FALLBACK = { sessions: ['chat', 'dev', 'other'], defaults: ['chat', 'dev', 'other'] };

export interface SessionState {
  sessions: string[];
  defaults: string[];
  active: string;
  setActive: (name: string) => void;
  addSession: (name: string) => Promise<void>;
  removeSession: (name: string) => Promise<void>;
  isCustom: (name: string) => boolean;
}

function readActive(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) || 'chat';
  } catch {
    return 'chat';
  }
}

export function useSessions(enabled: boolean): SessionState {
  const [sessions, setSessions] = useState<string[]>(FALLBACK.sessions);
  const [defaults, setDefaults] = useState<string[]>(FALLBACK.defaults);
  const [active, setActiveState] = useState<string>(readActive);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Keep `active` pointing at something real: if the stored/active session
  // vanishes from the list (closed elsewhere), fall back to the first one.
  const apply = useCallback((data: { sessions?: string[]; defaults?: string[] }) => {
    const list = Array.isArray(data.sessions) && data.sessions.length ? data.sessions : FALLBACK.sessions;
    setSessions(list);
    setDefaults(Array.isArray(data.defaults) ? data.defaults : []);
    if (!list.includes(activeRef.current)) {
      const first = list[0] || 'chat';
      setActiveState(first);
      try {
        localStorage.setItem(ACTIVE_KEY, first);
      } catch {
        // storage disabled — active still lives in React state
      }
    }
  }, []);

  const setActive = useCallback((name: string) => {
    setActiveState(name);
    try {
      localStorage.setItem(ACTIVE_KEY, name);
    } catch {
      // ignore
    }
    void fetch('/api/terminal/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: name }),
    }).catch(() => {
      // recording the active session is best-effort — the iframe still swaps
    });
  }, []);

  const addSession = useCallback(
    async (rawName: string) => {
      const clean = rawName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 30);
      if (!clean) return;
      const resp = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: clean }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'Could not create session');
      if (Array.isArray(data.sessions)) setSessions(data.sessions);
      setActive(clean);
    },
    [setActive],
  );

  const removeSession = useCallback(
    async (name: string) => {
      const resp = await fetch('/api/sessions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'Could not close session');
      const list: string[] = Array.isArray(data.sessions) ? data.sessions : [];
      setSessions(list);
      if (activeRef.current === name) setActive(list[0] || 'chat');
    },
    [setActive],
  );

  const isCustom = useCallback((name: string) => !defaults.includes(name), [defaults]);

  // Initial load + live SSE stream (reconnecting), mirroring
  // split.html's loadSessions() + connectSessionStream().
  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    fetch('/api/sessions')
      .then((r) => r.json())
      .then(apply)
      .catch(() => apply(FALLBACK));

    const connect = () => {
      if (closed) return;
      es = new EventSource('/api/sessions/stream');
      es.onmessage = (e) => {
        try {
          apply(JSON.parse(e.data));
        } catch {
          // malformed frame — ignore, next one will refresh us
        }
      };
      es.onerror = () => {
        es?.close();
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };
    connect();

    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
    };
  }, [enabled, apply]);

  return { sessions, defaults, active, setActive, addSession, removeSession, isCustom };
}
