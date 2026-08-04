/**
 * actionRowGap — responsive external spacing between post-action groups
 * (Stamp / Comment / Share / Save / More) per the icon-spacing spec.
 *
 * The gap grows with the widest formatted counter in a cluster so a wide
 * counter ("24M") never crowds its neighbor, while a row of bare/zero
 * counters ("0") doesn't look artificially spread out. Clamped to the
 * documented range: 14px baseline, 24px max.
 */

export const ACTION_GAP_MIN = 14;
export const ACTION_GAP_MAX = 24;

// Compact counters top out around 4 characters ("999K", "9.9B"); spread the
// full 14->24 range across ~3 characters of growth beyond a single digit.
const PX_PER_EXTRA_CHAR = (ACTION_GAP_MAX - ACTION_GAP_MIN) / 3;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Computes the external gap (px) for a cluster of action groups, driven by
 * the length of the widest formatted counter label among them. Pass the
 * already-compact-formatted label (e.g. via `formatCompactCount`) for each
 * item that has a counter; omit/undefined entries (no counter, e.g. Share,
 * More) are ignored.
 */
export function computeActionGap(labels: Array<string | undefined>): number {
  const maxChars = labels.reduce((max, label) => {
    if (!label) return max;
    return Math.max(max, label.length);
  }, 1);
  return clamp(ACTION_GAP_MIN + (maxChars - 1) * PX_PER_EXTRA_CHAR, ACTION_GAP_MIN, ACTION_GAP_MAX);
}
