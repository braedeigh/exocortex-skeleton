/**
 * pushClient.ts — web-push subscription helpers backing
 * features/settings/NotificationsSection.tsx. Talks to routes/push.py
 * (GET /api/push/vapid-key, POST /api/push/subscribe|unsubscribe|test).
 *
 * iOS Safari (16.4+, installed-to-Home-Screen only) requires
 * Notification.requestPermission() to run synchronously inside the
 * click-gesture call stack — no `await` before it. enablePush() is written
 * so its first line is the permission request; everything that needs
 * network (fetching the VAPID key, subscribing, POSTing to the server)
 * happens only after permission is already granted — that's all safely
 * async since the gesture requirement only applies to requestPermission()
 * itself.
 */
import { api, ApiError } from '../api/client';

/** Prefer the server's own error message (ApiError.message) when there is
 * one; otherwise fall back to a plain description of what failed. */
function describeFailure(e: unknown, fallback: string): Error {
  if (e instanceof ApiError && e.message) return new Error(e.message);
  return new Error(fallback);
}

/** True when this browser can do web push at all — gates the whole feature. */
export function isPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Fired on window whenever this device's push enablement changes
 * (subscribed by enablePush(), or unsubscribed by disablePush()), so
 * presence.ts — already running from page load — can start or stop its
 * heartbeat immediately, without needing a reload. */
export const PUSH_ENABLED_EVENT = 'push-enabled';

/** Standard VAPID applicationServerKey conversion: base64url -> Uint8Array.
 * Typed `Uint8Array<ArrayBuffer>` (not the bare/generic `Uint8Array`,
 * defaulted to `ArrayBufferLike`) so it satisfies PushManager.subscribe()'s
 * `BufferSource` requirement, which excludes `SharedArrayBuffer`. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** The current PushSubscription for this device, if any (null if never
 * subscribed or the SW isn't ready yet). */
export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

interface VapidKeyResponse {
  key: string;
}

/**
 * Enable push on this device. MUST be called directly from a click handler
 * (no awaited work before Notification.requestPermission()) — iOS silently
 * ignores permission requests made outside a user-gesture call stack.
 */
export async function enablePush(): Promise<void> {
  if (!isPushSupported()) {
    throw new Error('Push notifications aren’t supported in this browser.');
  }

  const permission = await Notification.requestPermission();
  if (permission === 'denied') {
    throw new Error('Notifications are blocked for this site in your browser settings.');
  }
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }

  const reg = await navigator.serviceWorker.ready;

  let key: string;
  try {
    ({ key } = await api.get<VapidKeyResponse>('/api/push/vapid-key'));
  } catch (e) {
    throw describeFailure(e, 'Could not reach the server to enable push.');
  }

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });

  try {
    await api.post('/api/push/subscribe', { subscription: subscription.toJSON() });
  } catch (e) {
    throw describeFailure(e, 'Could not save the subscription on the server.');
  }

  window.dispatchEvent(new CustomEvent(PUSH_ENABLED_EVENT));
}

/** Disable push on this device: unsubscribe server-side, then locally. */
export async function disablePush(): Promise<void> {
  const sub = await getCurrentSubscription();
  if (!sub) return;

  await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {
    // Best-effort server cleanup — still unsubscribe locally below even if
    // this fails, so the UI doesn't get stuck "on" with a dead server entry.
  });

  await sub.unsubscribe();
  window.dispatchEvent(new CustomEvent(PUSH_ENABLED_EVENT));
}

interface TestPushResponse {
  ok: boolean;
  sent: number;
  error?: string;
}

/**
 * Ask the server to send a test push to every subscribed device.
 *
 * Throws when nothing was actually delivered. The route answers `ok: false`
 * with a reason for a push the push service REFUSED (a 200 response only
 * means the server handled the request) — so a rejected send has to be
 * turned back into an error here, or the UI reports success over a phone
 * that never buzzed. That exact false "sent" hid a broken VAPID contact
 * claim until an iPhone was the only subscriber.
 */
export async function sendTestPush(): Promise<void> {
  let res: TestPushResponse;
  try {
    res = await api.post<TestPushResponse>('/api/push/test', {});
  } catch (e) {
    throw describeFailure(e, 'Could not send the test notification.');
  }
  if (!res.ok) {
    throw new Error(res.error || 'The push service rejected the notification.');
  }
}
