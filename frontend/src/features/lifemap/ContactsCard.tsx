import { useEffect, useRef, useState, type ReactNode } from 'react';
import { lastNDays } from './calendarMath';
import { CONTACT_METHODS, METHOD_COLORS, capitalize, historyByDate, lastMethodOn } from './contactMath';
import type { Contact } from './types';
import { useSnapRight } from './useSnapRight';
import styles from './ContactsCard.module.css';

/** Method picker popover on an empty calendar dot (contacts.js showLogPicker),
 * nudged horizontally when it would clip at a viewport edge. */
function LogPicker({ onPick, onClose }: { onPick: (method: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Keep the picker on-screen — nudge if clipped at an edge.
    const el = ref.current;
    if (el) {
      requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const pad = 8;
        let shift = 0;
        if (r.right > window.innerWidth - pad) shift = window.innerWidth - pad - r.right;
        else if (r.left < pad) shift = pad - r.left;
        if (shift) el.style.transform = `translateX(calc(-50% + ${Math.round(shift)}px))`;
      });
    }
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    const t = setTimeout(() => document.addEventListener('click', close), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('click', close);
    };
  }, [onClose]);

  return (
    <div className={styles.logPicker} ref={ref}>
      {CONTACT_METHODS.map((m) => (
        <button key={m} type="button" onClick={() => onPick(m.toLowerCase())}>
          {m}
        </button>
      ))}
    </div>
  );
}

export interface ContactCalendarProps {
  contacts: Contact[];
  serverDate: string;
  onLog: (name: string, method: string, date: string) => void;
  onConfirm: (text: ReactNode, onConfirm: () => void) => void;
  onRemoveHistory: (name: string, date: string, method: string) => void;
}

/** Keep-in-touch calendar — port of contacts.js renderContactCalendar:
 * last 30 days × contacts, filled dots colored by last method (click to
 * remove), empty dots open a method picker to backfill. */
export function ContactCalendar({ contacts, serverDate, onLog, onConfirm, onRemoveHistory }: ContactCalendarProps) {
  const snapRef = useSnapRight();
  const [picker, setPicker] = useState<{ name: string; date: string } | null>(null);

  if (!contacts.length) return null;
  const days = lastNDays(serverDate, 30);

  return (
    <>
      <div className={styles.calendar} ref={snapRef}>
        <table>
          <tbody>
            <tr>
              <td className={styles.calName} />
              {days.map((d, i) => {
                const show = i % 5 === 0 || i === days.length - 1;
                return (
                  <td key={d}>
                    {show ? (
                      <span className={styles.calDate}>
                        {new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
            {contacts.map((c) => {
              const byDate = historyByDate(c.history);
              return (
                <tr key={c.name}>
                  <td className={styles.calName}>{c.name}</td>
                  {days.map((d) => {
                    const last = lastMethodOn(byDate, d);
                    if (last) {
                      const color = METHOD_COLORS[last] || '#888';
                      return (
                        <td key={d}>
                          <div
                            className={styles.dotWrap}
                            onClick={() =>
                              onConfirm(
                                <>
                                  Remove <b>{capitalize(last)}</b> with <b>{c.name}</b> on {d}?
                                </>,
                                () => onRemoveHistory(c.name, d, last),
                              )
                            }
                          >
                            <div className={`${styles.dot} ${styles.dotFilled}`} style={{ background: color }} />
                            <div className={styles.calX}>&times;</div>
                            <div className={styles.tooltip}>Click to remove</div>
                          </div>
                        </td>
                      );
                    }
                    return (
                      <td key={d}>
                        <div className={styles.dotWrap}>
                          <button
                            type="button"
                            className={`${styles.dot} ${styles.dotEmpty}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setPicker({ name: c.name, date: d });
                            }}
                          />
                          <div className={styles.tooltip}>Click to log</div>
                          {picker && picker.name === c.name && picker.date === d ? (
                            <LogPicker
                              onPick={(method) => {
                                setPicker(null);
                                onLog(c.name, method, d);
                              }}
                              onClose={() => setPicker(null)}
                            />
                          ) : null}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Legend — outside the scrollable area */}
      <div className={styles.legend}>
        {Object.entries(METHOD_COLORS).map(([method, color]) => (
          <span key={method}>
            <span className={styles.legendSwatch} style={{ background: color }} />
            {capitalize(method)}
          </span>
        ))}
      </div>
    </>
  );
}
