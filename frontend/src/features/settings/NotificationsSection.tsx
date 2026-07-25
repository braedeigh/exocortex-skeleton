import { useEffect, useState } from 'react';
import {
  disablePush,
  enablePush,
  getCurrentSubscription,
  isPushSupported,
  sendTestPush,
  PUSH_ENABLED_EVENT,
} from '../../push/pushClient';
import styles from './NotificationsSection.module.css';

type Status = 'checking' | 'on' | 'off' | 'blocked' | 'unsupported';

/** iPhone/iPad, viewed outside the installed Home Screen app — Safari never
 * grants push permission there, but the app still works once added. */
function isUninstalledIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone;
  return isIOSDevice && !standalone;
}

async function resolveStatus(): Promise<Status> {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const sub = await getCurrentSubscription();
  return sub ? 'on' : 'off';
}

const STATUS_LABEL: Record<Status, string> = {
  checking: 'Notifications: checking…',
  on: 'Notifications: on for this device',
  off: 'Notifications: off',
  blocked: 'Notifications: blocked in browser settings',
  unsupported: 'Notifications: not supported here',
};

/**
 * Notifications — web push enable/disable/test for this device
 * (src/push/pushClient.ts + push-sw.js). One subscription per device/
 * browser, matching PushSubscription semantics: "this device" language
 * throughout rather than "this account".
 */
export function NotificationsSection() {
  const [status, setStatus] = useState<Status>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testSent, setTestSent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    resolveStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // If push gets enabled/disabled elsewhere (or by this component), re-check.
  useEffect(() => {
    function onChanged() {
      resolveStatus().then(setStatus);
    }
    window.addEventListener(PUSH_ENABLED_EVENT, onChanged);
    return () => window.removeEventListener(PUSH_ENABLED_EVENT, onChanged);
  }, []);

  function onEnableClick() {
    // No awaits before this line — enablePush()'s first await is
    // Notification.requestPermission(), which iOS requires to stay inside
    // this click's call stack.
    setError('');
    setBusy(true);
    enablePush()
      .then(() => setStatus('on'))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Could not enable notifications.');
        resolveStatus().then(setStatus);
      })
      .finally(() => setBusy(false));
  }

  async function onDisableClick() {
    setError('');
    setBusy(true);
    try {
      await disablePush();
      setStatus('off');
      setTestSent(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not disable notifications.');
    } finally {
      setBusy(false);
    }
  }

  async function onTestClick() {
    setError('');
    setTestSent(false);
    setBusy(true);
    try {
      await sendTestPush();
      setTestSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the test notification.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.status}>{STATUS_LABEL[status]}</div>

      {status === 'unsupported' && isUninstalledIOS() ? (
        <div className={styles.hint}>
          Add the app to your Home Screen (Share &rarr; Add to Home Screen), then enable here.
        </div>
      ) : null}

      <div className={styles.actions}>
        {status === 'off' ? (
          <button type="button" className={styles.btn} onClick={onEnableClick} disabled={busy}>
            Enable on this device
          </button>
        ) : null}

        {status === 'on' ? (
          <>
            <button
              type="button"
              className={styles.btn}
              onClick={() => void onTestClick()}
              disabled={busy}
            >
              Send test notification
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSecondary}`}
              onClick={() => void onDisableClick()}
              disabled={busy}
            >
              Disable
            </button>
          </>
        ) : null}
      </div>

      {testSent ? <div className={styles.success}>Test notification sent.</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}
    </div>
  );
}
