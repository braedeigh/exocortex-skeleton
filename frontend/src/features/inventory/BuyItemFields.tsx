/**
 * Shared buy-item edit fields — the same Cost/Why/By/Category/Where/Order
 * URL/Priority/Kind grid + Notes textarea appears in both the row modal
 * (inventory.js openBuyItemModal) and the deep-link detail page
 * (renderBuyItemDetail); only sizes/labels around it differ.
 */
import type { BuyFormState } from './buyForm';
import styles from './inventory.module.css';

export interface BuyItemFieldsProps {
  form: BuyFormState;
  onChange: (patch: Partial<BuyFormState>) => void;
  knownCategories: string[];
  /** Distinct datalist ids per surface (modal vs detail can't share one DOM id). */
  datalistId: string;
  /** Detail page uses the narrower 80px label column and a taller notes box. */
  detail?: boolean;
}

export function BuyItemFields({ form, onChange, knownCategories, datalistId, detail = false }: BuyItemFieldsProps) {
  const label = (text: string) => <label className={styles.fieldLabel}>{text}</label>;

  return (
    <>
      <div className={`${styles.fieldGrid} ${detail ? styles.fieldGridDetail : ''}`}>
        {label('Cost')}
        <input
          type="text"
          className={styles.input}
          value={form.cost}
          placeholder={detail ? '$40-80, 30 min, or free' : '$40-80, or free'}
          onChange={(e) => onChange({ cost: e.target.value })}
        />
        {label('Why')}
        <input
          type="text"
          className={styles.input}
          value={form.why}
          placeholder="what it solves / unlocks"
          onChange={(e) => onChange({ why: e.target.value })}
        />
        {label('By')}
        <input
          type="text"
          className={styles.input}
          value={form.by}
          placeholder="deadline (YYYY-MM-DD) or open"
          onChange={(e) => onChange({ by: e.target.value })}
        />
        {label('Category')}
        <span>
          <input
            type="text"
            className={styles.input}
            style={{ width: '100%' }}
            list={datalistId}
            value={form.category}
            placeholder={detail ? 'services, supplements, household...' : 'supplements, household...'}
            onChange={(e) => onChange({ category: e.target.value })}
          />
          <datalist id={datalistId}>
            {knownCategories.map((c) => (
              <option value={c} key={c} />
            ))}
          </datalist>
        </span>
        {label('Where')}
        <input
          type="text"
          className={styles.input}
          value={form.where}
          placeholder="store/site (optional)"
          onChange={(e) => onChange({ where: e.target.value })}
        />
        {label('Order URL')}
        <input
          type="url"
          className={styles.input}
          value={form.order_url}
          placeholder={detail ? 'https://... (one-tap reorder link)' : 'https://...'}
          onChange={(e) => onChange({ order_url: e.target.value })}
        />
        {label('Priority')}
        <select
          className={styles.select}
          value={form.priority}
          onChange={(e) => onChange({ priority: e.target.value })}
        >
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        {label('Kind')}
        <select
          className={styles.select}
          value={form.kind}
          onChange={(e) => onChange({ kind: e.target.value })}
        >
          <option value="">Unsorted</option>
          <option value="consumable">Consumable</option>
          <option value="durable">Durable</option>
          <option value="service">Service</option>
        </select>
      </div>

      <div style={{ marginTop: detail ? 8 : 12 }}>
        <label className={styles.fieldLabel} style={{ display: 'block', marginBottom: 6 }}>
          Notes
        </label>
        <textarea
          className={styles.textarea}
          rows={detail ? 10 : 6}
          value={form.notes}
          placeholder={
            detail
              ? "research, alternatives, places to try, who recommended what, prices you've seen..."
              : "research, alternatives, who recommended what, prices you've seen..."
          }
          onChange={(e) => onChange({ notes: e.target.value })}
        />
      </div>
    </>
  );
}
