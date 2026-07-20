import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { fetchProfile, saveProfile, type ProfileFields } from './settingsApi';
import { profileChangedFields } from './settingsHelpers';
import styles from './ProfileSection.module.css';

type MsgKind = 'info' | 'error' | 'success';

const EMPTY_FIELDS: ProfileFields = { owner_name: '', owner_email: '', app_name: '' };

const FIELDS: ReadonlyArray<[keyof ProfileFields, string, string]> = [
  ['owner_name', 'Your name', 'name'],
  ['owner_email', 'Email', 'email'],
  ['app_name', 'App name', 'off'],
];

/**
 * Profile — GET/PUT /api/profile (routes/profile.py): owner_name,
 * owner_email, app_name. Each field shows its explicitly-stored value if
 * set, otherwise the input stays empty and the resolved (env/default) value
 * shows as a placeholder — "set" vs "inherited" is visible without extra
 * chrome. Save PUTs only the fields that changed; a key cleared back to ""
 * un-sets it server-side (falls back to inherited again).
 */
export function ProfileSection() {
  const [profile, setProfile] = useState<ProfileFields | null>(null);
  const [stored, setStored] = useState<Partial<ProfileFields>>({});
  const [inputs, setInputs] = useState<ProfileFields>(EMPTY_FIELDS);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: MsgKind; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchProfile()
      .then((res) => {
        if (cancelled) return;
        setProfile(res.profile);
        setStored(res.stored);
        setInputs({
          owner_name: res.stored.owner_name ?? '',
          owner_email: res.stored.owner_email ?? '',
          app_name: res.stored.app_name ?? '',
        });
      })
      .catch(() => {
        if (!cancelled) setMsg({ kind: 'error', text: "Couldn't load profile." });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function setField(key: keyof ProfileFields, value: string) {
    setInputs((cur) => ({ ...cur, [key]: value }));
  }

  async function save() {
    const changed = profileChangedFields(inputs, stored);
    if (Object.keys(changed).length === 0) {
      setMsg({ kind: 'info', text: 'Nothing to save.' });
      return;
    }
    setMsg({ kind: 'info', text: 'saving…' });
    setBusy(true);
    try {
      const res = await saveProfile(changed);
      setProfile(res.profile);
      setStored(res.stored);
      setInputs({
        owner_name: res.stored.owner_name ?? '',
        owner_email: res.stored.owner_email ?? '',
        app_name: res.stored.app_name ?? '',
      });
      setMsg({ kind: 'success', text: 'Saved.' });
    } catch (e) {
      const text = e instanceof ApiError && e.message ? e.message : 'Network error.';
      setMsg({ kind: 'error', text });
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className={styles.loading}>Loading&hellip;</div>;
  }

  return (
    <div className={styles.form}>
      {FIELDS.map(([key, label, autoComplete]) => (
        <div className={styles.field} key={key}>
          <label className={styles.label} htmlFor={`profile-${key}`}>
            {label}
          </label>
          <input
            id={`profile-${key}`}
            type="text"
            className={styles.input}
            value={inputs[key]}
            placeholder={profile?.[key] ?? ''}
            onChange={(e) => setField(key, e.target.value)}
            autoComplete={autoComplete}
          />
        </div>
      ))}
      <div className={styles.actions}>
        <button type="button" className={styles.saveBtn} onClick={save} disabled={busy}>
          Save
        </button>
        {msg ? (
          <span
            className={`${styles.msg} ${msg.kind === 'error' ? styles.msgError : ''} ${
              msg.kind === 'success' ? styles.msgSuccess : ''
            }`}
          >
            {msg.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
