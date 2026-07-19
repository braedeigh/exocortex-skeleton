import { useMemo } from 'react';
import { buildSparkline } from './sparklineMath';

export interface SparklineProps {
  dates: readonly string[];
  now: Date;
  className?: string;
}

/**
 * Hand-rolled monthly-bin sparkline (port of people.js sparklineSVG):
 * accent bars for mention months, faint stubs for quiet ones, native
 * <title> tooltips per bar. Stretches to the row width via
 * preserveAspectRatio="none", exactly like the old inline SVG.
 */
export function Sparkline({ dates, now, className }: SparklineProps) {
  const spec = useMemo(() => buildSparkline(dates, now), [dates, now]);
  if (!spec) return null;
  return (
    <svg className={className} viewBox={`0 0 ${spec.width} ${spec.height}`} preserveAspectRatio="none">
      {spec.bars.map((bar, i) => (
        <path key={i} d={bar.path} fill={bar.filled ? 'var(--accent)' : 'var(--ppl-hm-empty)'}>
          <title>{bar.title}</title>
        </path>
      ))}
    </svg>
  );
}
