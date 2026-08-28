import { useEffect, useRef, useState } from 'react';
import { IconButton } from '../../ui';
import type { DeityPayload } from './api';
import { parseDeityMantra, parseDeityName } from './deityHelpers';
import type { DeityProfile } from './types';
import styles from './DeityEditor.module.css';

interface EditableLink {
  title: string;
  url: string;
  description: string;
}

export interface DeityEditorProps {
  /** null = "New deity". */
  profile: DeityProfile | null;
  /** Rejected promise = save failed (toast already shown); editor stays open. */
  onSave: (id: string | null, payload: DeityPayload) => Promise<unknown>;
  onCancel: () => void;
  /** Validation messages (old code used alert()). */
  onError: (message: string) => void;
}

const BODY_PLACEHOLDER = [
  '# Medicine Buddha Mantra (Bhaiṣajyaguru)',
  '',
  '**Romanized text:**',
  'Tadyathā: oṃ bhaiṣajye ... svāhā',
  '',
  '-----',
  '',
  '## Translation',
  '...',
  '',
  '| Word | Meaning |',
  '|------|---------|',
  '| oṃ | sacred syllable |',
].join('\n');

/**
 * New/Edit deity form — port of _deityRenderEditor + the _deityLink* editor.
 * The body is one big pasted-markdown textarea; name + mantra are derived
 * from it on save (first `# H1`, line after "Romanized text:"). Links keep
 * the old up/down/× reorder controls.
 */
export function DeityEditor({ profile, onSave, onCancel, onError }: DeityEditorProps) {
  const [body, setBody] = useState(profile?.body || '');
  const [links, setLinks] = useState<EditableLink[]>(() =>
    (profile?.links || []).map((l) => ({
      title: l.title || '',
      url: l.url || '',
      description: l.description || '',
    })),
  );
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!profile) bodyRef.current?.focus();
  }, [profile]);

  function setLinkField(i: number, field: keyof EditableLink, value: string) {
    setLinks((cur) => cur.map((l, idx) => (idx === i ? { ...l, [field]: value } : l)));
  }

  function addLink() {
    setLinks((cur) => [...cur, { title: '', url: '', description: '' }]);
  }

  function removeLink(i: number) {
    setLinks((cur) => cur.filter((_, idx) => idx !== i));
  }

  function moveLink(i: number, dir: -1 | 1) {
    setLinks((cur) => {
      const j = i + dir;
      if (j < 0 || j >= cur.length) return cur;
      const next = cur.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function save() {
    if (!body.trim()) {
      onError('Paste some markdown first.');
      return;
    }
    const name = parseDeityName(body);
    if (!name) {
      onError('Add a "# Title" heading line so the deity has a name.');
      return;
    }
    const cleanLinks = links
      .map((l) => ({
        title: l.title.trim(),
        url: l.url.trim(),
        description: l.description.trim(),
      }))
      .filter((l) => l.title || l.url);
    const payload: DeityPayload = {
      name,
      mantra: parseDeityMantra(body),
      body,
      links: cleanLinks,
    };
    setSaving(true);
    try {
      await onSave(profile?.id ?? null, payload);
    } catch {
      // save failed — hook already toasted; keep editing
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className={styles.headRow}>
        <div className={styles.heading}>{profile ? 'Edit deity' : 'New deity'}</div>
      </div>
      <div className={styles.hint}>
        Paste the full markdown. The first <code>#&nbsp;Heading</code> becomes the deity&rsquo;s name in the list.
        Tables, &gt; quotes, ----- rules, lists and **bold** all render.
      </div>
      <div className={styles.form}>
        <textarea
          ref={bodyRef}
          className={styles.body}
          rows={22}
          placeholder={BODY_PLACEHOLDER}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />

        <div className={styles.linksSection}>
          <div className={styles.linksTitle}>Links</div>
          <div className={styles.hint}>
            Title shows as the clickable link, with an optional description below it. Reorder with the arrows.
          </div>
          <div>
            {links.length === 0 ? <div className={styles.noLinks}>No links yet.</div> : null}
            {links.map((l, i) => (
              <div className={styles.linkCard} key={i}>
                <div className={styles.linkTopRow}>
                  <input
                    className={styles.linkInput}
                    value={l.title}
                    onChange={(e) => setLinkField(i, 'title', e.target.value)}
                    placeholder="Link title"
                  />
                  <IconButton aria-label="Move link up" title="Move up" disabled={i === 0} onClick={() => moveLink(i, -1)}>
                    &uarr;
                  </IconButton>
                  <IconButton
                    aria-label="Move link down"
                    title="Move down"
                    disabled={i === links.length - 1}
                    onClick={() => moveLink(i, 1)}
                  >
                    &darr;
                  </IconButton>
                  <IconButton aria-label="Remove link" title="Remove link" danger onClick={() => removeLink(i)}>
                    &times;
                  </IconButton>
                </div>
                <input
                  className={styles.linkInput}
                  value={l.url}
                  onChange={(e) => setLinkField(i, 'url', e.target.value)}
                  placeholder="https://…"
                />
                <input
                  className={styles.linkInput}
                  value={l.description}
                  onChange={(e) => setLinkField(i, 'description', e.target.value)}
                  placeholder="Description (optional)"
                />
              </div>
            ))}
            <button type="button" className={styles.addLinkBtn} onClick={addLink}>
              + Add link
            </button>
          </div>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.saveBtn} onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className={styles.cancelBtn} onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
