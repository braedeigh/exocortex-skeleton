/**
 * presence.ts — visibility heartbeat for web push. Lets the server know
 * whether this device currently has the app open and visible
 * (POST /api/push/presence {endpoint, visible}), so it can skip sending a
 * push to a device that would just show a redundant OS notification for
 * something already on screen.
 *
 * Like usageBeacon.ts/usageTracker.ts this is fire-and-forget telemetry, not
 * routed through api.post (client.ts) — a presence ping must never redirect
 * to /login or throw. Unlike those, the "going away" ping uses
 * navigator.sendBeacon so it actually lands even as the tab unloads (fetch
 * with keepalive can get dropped mid-navigation on some browsers/OSes).
 */
import { isPushSupported, PUSH_ENABLED_EVENT, getCurrentSubscription } from './pushClient';

const HEARTBEAT_MS = 20_000;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let currentEndpoint: string | null = null;
let installed = false;

function sendPresence(endpoint: string, visible: boolean) {
  const body = JSON.stringify({ endpoint, visible });
  if (!visible && navigator.sendBeacon) {
    // sendBeacon requires a Blob/string body and survives page unload;
    // the backend accepts sendBeacon's default text/plain content type.
    navigator.sendBeacon('/api/push/presence', body);
    return;
  }
  fetch('/api/push/presence', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {
    // Fire-and-forget: presence must never surface an error to the user.
  });
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(endpoint: string) {
  stopHeartbeat();
  sendPresence(endpoint, true);
  heartbeatTimer = setInterval(() => sendPresence(endpoint, true), HEARTBEAT_MS);
}

function onVisibilityChange() {
  if (!currentEndpoint) return;
  if (document.visibilityState === 'visible') {
    startHeartbeat(currentEndpoint);
  } else {
    stopHeartbeat();
    sendPresence(currentEndpoint, false);
  }
}

function onPageHide() {
  if (!currentEndpoint) return;
  stopHeartbeat();
  sendPresence(currentEndpoint, false);
}

/** Re-check subscription state and (re)start the heartbeat if eligible.
 * Safe to call repeatedly — it's a no-op once already running for the same
 * subscription, and tears the heartbeat down if push got disabled. */
async function refresh(): Promise<void> {
  if (!isPushSupported() || Notification.permission !== 'granted') {
    currentEndpoint = null;
    stopHeartbeat();
    return;
  }
  const sub = await getCurrentSubscription();
  if (!sub) {
    currentEndpoint = null;
    stopHeartbeat();
    return;
  }
  currentEndpoint = sub.endpoint;
  if (document.visibilityState === 'visible') {
    startHeartbeat(currentEndpoint);
  }
}

/**
 * Install the presence heartbeat. Call once from main.tsx, next to the
 * other install* calls. Does nothing until push is actually enabled on this
 * device (checked asynchronously); if she enables push later via Settings,
 * the 'push-enabled' event (dispatched by pushClient's enablePush()) makes
 * this start without a reload.
 */
export function installPresence(): void {
  if (installed) return;
  installed = true;

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener(PUSH_ENABLED_EVENT, () => {
    void refresh();
  });

  void refresh();
}
