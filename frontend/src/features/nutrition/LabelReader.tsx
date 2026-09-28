/**
 * LabelReader.tsx — make a packaged food USDA hasn't got, from photos of its label.
 *
 * She photographs the Nutrition Facts panel (and the front, if she likes).
 * The photos go to the server, which sends a helper Claude session to read
 * them, the way the Kitchen's receipt scan works; this card waits, then shows
 * what was read beside the photo in a form she checks and corrects. Only
 * "Save" makes it a product (label_products.py): it gets the barcode, so the
 * next scan finds it, and joins the meal like any packaged food.
 *
 * Figures are typed per serving, as the label prints them; the server turns
 * them into per 100 g. A blank figure stays unknown, never zero.
 *
 * Shown by ./PackagedSearch.tsx. Data: POST /api/nutrition/labels, GET
 * /api/nutrition/labels/<job>, POST /api/nutrition/label-products
 * (routes/nutrition.py).
 *
 * Prompt: "a feature that is AI based that reads the nutrient label on there
 * and ports that information into that item and creates that item in the
 * database" — "i already have something similar to this in the receipt section".
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { getLabelJob, labelPhotoUrl, readLabel, saveLabelProduct } from './api';
import type { LabelDraft, LabelField, PackagedFood } from './types';
import styles from './Nutrition.module.css';

export function LabelReader({ barcode, onSaved }: { barcode: string; onSaved: (food: PackagedFood) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [job, setJob] = useState<{ job: string; photos: string[] } | null>(null);

  // Send the chosen photos; the server opens a helper session to read them.
  const upload = useMutation({
    mutationFn: (photos: File[]) => readLabel(photos, barcode),
    onSuccess: setJob,
  });

  // Wait for the reading: ask every 4 seconds until it's ready or has failed.
  const reading = useQuery({
    queryKey: ['nutrition', 'label-job', job?.job],
    queryFn: ({ signal }) => getLabelJob(job!.job, signal),
    enabled: !!job,
    refetchInterval: (query) => (query.state.data?.status === 'reading' || !query.state.data ? 4000 : false),
  });

  if (!job)
    return (
      <div className={styles.labelReader}>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            const photos = Array.from(event.target.files ?? []);
            if (photos.length) upload.mutate(photos);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className={styles.saveBtn}
          disabled={upload.isPending}
          onClick={() => fileInput.current?.click()}
        >
          {upload.isPending ? 'Sending…' : 'Read the label from a photo'}
        </button>
        <p className={styles.muted}>
          Photograph the Nutrition Facts panel (the front too, for the name). Claude reads it in about a minute, then
          you check each figure before it's saved{barcode ? ` under barcode ${barcode}` : ''}.
        </p>
        {upload.isError ? <p className={styles.error}>{(upload.error as Error).message}</p> : null}
      </div>
    );

  const status = reading.data?.status;
  if (status === 'ready' && reading.data?.draft && reading.data.fields)
    return (
      <LabelReview
        draft={reading.data.draft}
        fields={reading.data.fields}
        photos={job.photos}
        onSaved={onSaved}
        onCancel={() => setJob(null)}
      />
    );
  return (
    <div className={styles.labelReader}>
      {status === 'failed' || status === 'missing' ? (
        <p className={styles.error}>{reading.data?.error || 'The photo is gone.'}</p>
      ) : (
        <p className={styles.muted}>Claude is reading the label… this takes about a minute.</p>
      )}
      <button type="button" className={styles.chip} onClick={() => setJob(null)}>
        {status === 'failed' ? 'Try another photo' : 'Cancel'}
      </button>
    </div>
  );
}

// The check-it form: what was read, beside the photo, every figure editable.
function LabelReview({
  draft: read,
  fields,
  photos,
  onSaved,
  onCancel,
}: {
  draft: LabelDraft;
  fields: LabelField[];
  photos: string[];
  onSaved: (food: PackagedFood) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<LabelDraft>(read);
  // Figures are kept as typed ("0." mid-typing) and turned into numbers only on save.
  const [figures, setFigures] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(read.nutrients).map(([key, figure]) => [key, figure.amount?.toString() ?? ''])),
  );
  const [servingAmount, setServingAmount] = useState(read.serving_amount?.toString() ?? '');
  // The rows shown: every figure a US label must print, plus any other it was read with.
  const rows = fields.filter((field) => field.core || field.key in read.nutrients);
  const setText = (key: 'name' | 'brand' | 'barcode' | 'serving_text') => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  // Save: the typed figures as numbers, each in its row's unit; a blank one is left out.
  const save = useMutation({
    mutationFn: () => {
      const nutrients: LabelDraft['nutrients'] = {};
      for (const field of fields) {
        const amount = parseAmount(figures[field.key] ?? '');
        if (amount !== null) nutrients[field.key] = { amount, unit: field.unit };
      }
      return saveLabelProduct({ ...draft, serving_amount: parseAmount(servingAmount), nutrients }, photos[0]);
    },
    onSuccess: (reply) => onSaved(reply.food),
  });

  return (
    <div className={styles.labelReader}>
      <p className={styles.muted}>
        Read by AI from your photo. Check each figure against the label before saving; a blank one stays unknown.
      </p>
      <div className={styles.labelPhotos}>
        {photos.map((photo) => (
          <a key={photo} href={labelPhotoUrl(photo)} target="_blank" rel="noreferrer">
            <img src={labelPhotoUrl(photo)} alt="Label photo" className={styles.labelPhoto} />
          </a>
        ))}
      </div>
      <TextRow label="Name" value={draft.name} onChange={setText('name')} />
      <TextRow label="Brand" value={draft.brand} onChange={setText('brand')} />
      <TextRow label="Barcode" value={draft.barcode} onChange={setText('barcode')} />
      <TextRow label="Serving" value={draft.serving_text} onChange={setText('serving_text')} />
      <label className={styles.labelRow}>
        <span>Serving in</span>
        <input
          className={styles.gramsInput}
          inputMode="decimal"
          value={servingAmount}
          onChange={(event) => setServingAmount(event.target.value)}
        />
        <select
          className={styles.gramsInput}
          value={draft.serving_unit}
          onChange={(event) => setDraft((current) => ({ ...current, serving_unit: event.target.value as 'g' | 'ml' }))}
        >
          <option value="g">g</option>
          <option value="ml">ml</option>
        </select>
      </label>
      <p className={styles.muted}>Per serving, as the label prints them:</p>
      {rows.map((field) => {
        const figure = read.nutrients[field.key];
        return (
          <label key={field.key} className={styles.labelRow}>
            <span>{field.words}</span>
            <input
              className={styles.gramsInput}
              inputMode="decimal"
              value={figures[field.key] ?? ''}
              placeholder="?"
              onChange={(event) => setFigures((current) => ({ ...current, [field.key]: event.target.value }))}
            />
            <span className={styles.gramsUnit}>
              {field.unit}
              {figure?.amount == null && figure?.dv_percent != null ? ` (label: ${figure.dv_percent}% DV only)` : ''}
            </span>
          </label>
        );
      })}
      {read.unreadable.length ? (
        <p className={styles.muted}>Couldn't read: {read.unreadable.join(', ')}.</p>
      ) : null}
      {read.notes ? <p className={styles.muted}>Reader's note: {read.notes}</p> : null}
      <div className={styles.newMeal}>
        <button type="button" className={styles.saveBtn} disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save and add'}
        </button>
        <button type="button" className={styles.chip} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {save.isError ? <p className={styles.error}>{(save.error as Error).message}</p> : null}
    </div>
  );
}

function TextRow({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className={styles.labelRow}>
      <span>{label}</span>
      <input className={styles.searchInput} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

// A typed figure as a number; blank (or not a number) is unknown.
function parseAmount(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() === '' || !Number.isFinite(value) ? null : value;
}
