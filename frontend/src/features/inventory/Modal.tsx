/**
 * Centered overlay modal + the two small dialogs the old tab used:
 * - ConfirmDialog — the #modal "Remove <b>x</b>?" two-step delete confirm.
 * - PromptDialog — replaces window.prompt() for retire reviews / review edits.
 *
 * Portaled to document.body for the same stacking reason as ui/Sheet.tsx
 * (the terminal pane's isolation traps fixed descendants).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './Modal.module.css';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Wide, left-aligned, scrollable editor look (buy/archival modals). */
  editor?: boolean;
  'aria-label': string;
  children: ReactNode;
}

export function Modal({ open, onClose, editor = false, children, ...rest }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className={styles.overlay} onClick={onClose} role="presentation">
      <div
        className={`${styles.modal} ${editor ? styles.editor : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={rest['aria-label']}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmState {
  label: string;
  onConfirm: () => void;
}

export interface ConfirmDialogProps {
  state: ConfirmState | null;
  onClose: () => void;
}

/** Two-step delete confirm — "Remove <b>label</b>?" with Cancel / Remove. */
export function ConfirmDialog({ state, onClose }: ConfirmDialogProps) {
  return (
    <Modal open={state !== null} onClose={onClose} aria-label="Confirm removal">
      {state ? (
        <>
          <p className={styles.confirmText}>
            Remove <b>{state.label}</b>?
          </p>
          <div className={styles.confirmButtons}>
            <button
              type="button"
              className={styles.confirmBtn}
              onClick={() => {
                onClose();
                state.onConfirm();
              }}
            >
              Remove
            </button>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

export interface PromptState {
  message: string;
  initial: string;
  onSave: (value: string) => void;
}

export interface PromptDialogProps {
  state: PromptState | null;
  onClose: () => void;
}

/** Text prompt — Cancel aborts (like prompt() returning null), Save submits
 * even when empty (like OK on an empty prompt). */
export function PromptDialog({ state, onClose }: PromptDialogProps) {
  const [value, setValue] = useState('');
  const openedFor = useRef<PromptState | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Reset the draft when a new prompt opens (not on every re-render).
  useEffect(() => {
    if (state && openedFor.current !== state) {
      openedFor.current = state;
      setValue(state.initial);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
    if (!state) openedFor.current = null;
  }, [state]);

  return (
    <Modal open={state !== null} onClose={onClose} editor aria-label={state?.message || 'Prompt'}>
      {state ? (
        <>
          <p className={styles.promptMessage}>{state.message}</p>
          <textarea
            ref={inputRef}
            rows={3}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 14,
              outline: 'none',
              background: 'var(--bg)',
              color: 'var(--text)',
              fontFamily: 'inherit',
              lineHeight: 1.5,
              resize: 'vertical',
            }}
          />
          <div className={styles.confirmButtons} style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={styles.confirmBtn}
              style={{ background: 'var(--text)' }}
              onClick={() => {
                onClose();
                state.onSave(value);
              }}
            >
              Save
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
