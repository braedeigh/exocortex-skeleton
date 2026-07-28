/**
 * Quick-add bar for the top of the Inventory page — mirrors the to-do AddBar.
 * A full-width name field that, once focused or typed in, reveals the buy-item
 * fields below (kind, priority, category, where). Enter or Add submits; the
 * extra row collapses again when the bar is blurred empty. Notes/fronts are
 * left to the detail sheet — this is for a fast capture up top.
 *
 * Prompt: at the top of the inventory page, a "quick add" like the to-dos but
 * with the inventory item fields/categories in the UI.
 *
 * Touches: ui/Button, inventory add action (actions.addBuy in InventoryPage),
 * BuyAddBar.module.css (mirrors AddBar.module.css tokens).
 */
import { useRef, useState } from 'react';
import type { FocusEvent, FormEvent } from 'react';
import { Button } from '../../ui';
import styles from './BuyAddBar.module.css';

export interface BuyAddBarPayload {
  name: string;
  priority: string;
  kind: string;
  where: string;
  category: string;
  notes: string;
  fronts: string[];
}

export interface BuyAddBarProps {
  onAdd: (payload: BuyAddBarPayload) => Promise<void>;
  /** Existing categories → the category field's datalist. */
  knownCategories?: string[];
}

export function BuyAddBar({ onAdd, knownCategories = [] }: BuyAddBarProps) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('durable');
  const [priority, setPriority] = useState('medium');
  const [category, setCategory] = useState('');
  const [where, setWhere] = useState('');
  const [focused, setFocused] = useState(false);
  const [adding, setAdding] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const expanded = focused || name.trim().length > 0;

  function reset() {
    setName('');
    setCategory('');
    setWhere('');
    setFocused(false);
    // kind + priority stick between adds (like the section add-form)
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || adding) return;
    setAdding(true);
    try {
      await onAdd({
        name: trimmed,
        priority,
        kind,
        where: where.trim(),
        category: category.trim(),
        notes: '',
        fronts: [],
      });
      reset();
    } catch {
      // error toast pushed upstream; keep the inputs so nothing's lost
    } finally {
      setAdding(false);
    }
  }

  // Collapse only once focus has left the whole form (tapping a select below
  // blurs the input first, but the new target is still inside the form).
  function handleBlur(e: FocusEvent<HTMLFormElement>) {
    if (!formRef.current?.contains(e.relatedTarget as Node | null)) {
      setFocused(false);
    }
  }

  return (
    <form ref={formRef} className={styles.bar} onSubmit={submit} onBlur={handleBlur}>
      <datalist id="buy-quick-categories">
        {knownCategories.map((c) => (
          <option value={c} key={c} />
        ))}
      </datalist>
      <div className={styles.topRow}>
        <input
          className={styles.input}
          type="text"
          placeholder="Add to buy list…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={() => setFocused(true)}
        />
        {expanded ? (
          <Button type="submit" disabled={adding} data-track="buy-add">
            Add
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <div className={styles.extra}>
          <select
            className={styles.select}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            aria-label="Kind"
          >
            <option value="consumable">Consumable</option>
            <option value="durable">Durable</option>
            <option value="service">Service</option>
          </select>
          <select
            className={styles.select}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            aria-label="Priority"
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <input
            className={styles.miniInput}
            type="text"
            list="buy-quick-categories"
            placeholder="Category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
          <input
            className={styles.miniInput}
            type="text"
            placeholder="Where"
            value={where}
            onChange={(e) => setWhere(e.target.value)}
          />
        </div>
      ) : null}
    </form>
  );
}
