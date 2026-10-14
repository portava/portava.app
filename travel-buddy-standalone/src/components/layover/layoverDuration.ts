/**
 * Layover duration formatting, PURE — no react-native, no theme.
 *
 * `fmtDur` lived in `layoverFormat.ts`, which imports the theme tokens and,
 * through them, react-native's TYPES. A module that only formats minutes
 * should not carry those: `layoverExperienceFacts.ts` is loaded by the
 * api-server's own suite (census-layover L75, §71 — the producer's cards run
 * through the app's line), and react-native's global timer types leaking into
 * that program re-typed every server scheduler's `setInterval`. Moved here
 * unchanged; `layoverFormat.ts` re-exports it, so no caller changes.
 */

/** "135" → "2h 15m", "45" → "45m" */
export function fmtDur(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min) || min < 0) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
