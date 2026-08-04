/**
 * counterFormat — compact tabular-numeral formatting for post-action counters
 * (Stamp / Comment / Share / Save counts) per the icon-spacing spec.
 *
 * Rules: values below 1,000 render as-is. At 1,000+ the value compresses to
 * K/M/B, scaled to that unit. When the scaled value is under 10 (e.g. 1.2K)
 * one decimal place is kept for readability; at 10+ the decimal is dropped
 * (24M, not 24.0M). A trailing ".0" is always trimmed (1000 -> "1K", not
 * "1.0K"). The exact (un-abbreviated) count is always preserved separately
 * for accessibility labels via `formatExactCount`/`actionAccessibilityLabel`.
 */

const UNITS: Array<{ threshold: number; suffix: string }> = [
  { threshold: 1_000_000_000, suffix: 'B' },
  { threshold: 1_000_000, suffix: 'M' },
  { threshold: 1_000, suffix: 'K' },
];

/** Compact display string for a counter: 999 -> "999", 1200 -> "1.2K", 24_000_000 -> "24M", 1_200_000_000 -> "1.2B". */
export function formatCompactCount(count: number): string {
  const n = Math.max(0, Math.trunc(count));
  for (const { threshold, suffix } of UNITS) {
    if (n >= threshold) {
      const scaled = n / threshold;
      const decimals = scaled < 10 ? 1 : 0;
      let out = scaled.toFixed(decimals);
      if (out.endsWith('.0')) out = out.slice(0, -2);
      return `${out}${suffix}`;
    }
  }
  return `${n}`;
}

/** Exact, never-abbreviated, comma-grouped count — used only in accessibility labels. */
export function formatExactCount(count: number): string {
  const n = Math.max(0, Math.trunc(count));
  return n.toLocaleString('en-US');
}

/**
 * Builds a combined accessibility label for a post-action control: the base
 * action name plus the exact (non-abbreviated) count when present, e.g.
 * "Comment, 24,000,000". When `count` is omitted or zero, returns just the
 * action name so silent/countless actions (e.g. Share, More) stay concise.
 */
export function actionAccessibilityLabel(action: string, count?: number): string {
  if (!count) return action;
  return `${action}, ${formatExactCount(count)}`;
}
