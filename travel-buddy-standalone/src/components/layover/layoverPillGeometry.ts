/**
 * Geometry constants for the ActiveLayoverPill.
 *
 * Extracted into a plain .ts file so useBottomInset.ts (a hook) can import
 * them without taking on a React/JSX component dependency.
 */

/**
 * Distance (pt) between the device bottom edge (excluding safe-area) and the
 * bottom edge of the pill's wrapping view.  Matches the `bottom` style in
 * ActiveLayoverPill:
 *   `bottom: insets.bottom + LAYOVER_PILL_BOTTOM_OFFSET`
 */
export const LAYOVER_PILL_BOTTOM_OFFSET = 74;

/**
 * Approximate rendered height (pt) of the pill itself — paddingVertical × 2
 * (10 + 10) plus icon / text line height (~24).  Used by the feed inset hook
 * to add enough clearance above the pill top edge.
 */
export const LAYOVER_PILL_HEIGHT = 44;
