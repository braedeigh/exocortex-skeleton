import { computeSpendStats } from './historyHelpers';
import { Section } from './Section';
import type { KitchenTrip } from './types';
import styles from './kitchen.module.css';

/** Port of the Grocery Spend card — mini bar sparkline (last 8 trips) plus
 * last / avg-per-trip / 30-day numbers. Renders nothing without priced trips. */
export function SpendTrendSection({ trips }: { trips: KitchenTrip[] }) {
  const stats = computeSpendStats(trips);
  if (!stats) return null;

  const max = Math.max(...stats.sparkData, 1);
  const dateLabel = stats.lastDate
    ? new Date(stats.lastDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '';

  return (
    <Section title="Grocery Spend">
      <div style={{ padding: '10px 0' }}>
        <div className={styles.rowFlex} style={{ gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 30 }}>
            {stats.sparkData.map((v, i) => (
              <span
                key={i}
                title={`$${v.toFixed(2)}`}
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: Math.max(3, Math.round((v / max) * 28)),
                  background: 'var(--green)',
                  borderRadius: 1,
                  marginRight: 2,
                  verticalAlign: 'bottom',
                }}
              />
            ))}
          </div>
          <div className={styles.muted12} style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <span>
              <b style={{ color: 'var(--text)', fontSize: 13 }}>${stats.lastTotal.toFixed(2)}</b> last ({dateLabel})
            </span>
            <span>
              <b style={{ color: 'var(--text)', fontSize: 13 }}>${stats.last5Avg.toFixed(2)}</b> avg/trip
            </span>
            <span>
              <b style={{ color: 'var(--text)', fontSize: 13 }}>${stats.last30Total.toFixed(2)}</b> last 30d
            </span>
            <span style={{ opacity: 0.7 }}>
              {stats.tripCount} trip{stats.tripCount === 1 ? '' : 's'} logged
            </span>
          </div>
        </div>
      </div>
    </Section>
  );
}
