/**
 * Pure (zero-import) logic helpers for CircleStatusCardMessage.
 *
 * Extracted so they can be tested with node:test without pulling in React,
 * React Native, or theme tokens.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** The privacy-safe placeholder rendered for every non-member viewer. */
export const PLACEHOLDER_TEXT = 'Shared a Circle update.' as const;

// ── Types ────────────────────────────────────────────────────────────────────

export type CardVariant = 'checkin' | 'meeting_point' | 'unknown';

/** The shape pulled out of a circle_status_card message body. */
export interface CircleCardPayload {
  subtype?: string | null;
  venueLabel?: string | null;
  approxArea?: string | null;
}

/**
 * Typed discriminated union returned by both `resolveCardRender` and
 * `resolveCardRenderFromProps`.  The component switches on `show` and reads
 * the pre-computed display values (`text`, `label`, `locationText`) so the
 * same logic that is unit-tested also drives the actual render.
 */
export type RenderDecision =
  | { show: 'placeholder'; text: typeof PLACEHOLDER_TEXT }
  | { show: 'checkin';       subtype: string; label: string; senderName: string | null | undefined }
  | { show: 'meeting_point'; locationText: string | null;    senderName: string | null | undefined };

// ── Body parsing ─────────────────────────────────────────────────────────────

/**
 * Parse the raw message body string of a circle_status_card.
 * Returns null for null/empty/malformed/non-object input — callers must treat
 * null the same as a missing payload (renders the generic placeholder).
 */
export function parseCircleCardBody(body: string | null | undefined): CircleCardPayload | null {
  try {
    const parsed = JSON.parse(body ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as CircleCardPayload;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Subtype classification ────────────────────────────────────────────────────

/** Exhaustive set of known check-in subtype values. */
const CHECKIN_SUBTYPES: ReadonlySet<string> = new Set(['arrived', 'with_group', 'leaving', 'safe']);

/**
 * Map a raw subtype string to one of the three card variants.
 * Only explicitly-known check-in subtypes produce 'checkin'.
 * Any unrecognised value returns 'unknown' and renders the placeholder.
 */
export function classifySubtype(subtype: string | null | undefined): CardVariant {
  if (!subtype) return 'unknown';
  if (subtype === 'meeting_point') return 'meeting_point';
  if (CHECKIN_SUBTYPES.has(subtype)) return 'checkin';
  return 'unknown';
}

/** Human-readable label for a check-in subtype. */
export function checkinLabel(subtype: string): string {
  switch (subtype) {
    case 'arrived':    return 'Arrived at the destination';
    case 'with_group': return 'Checked in with the group';
    case 'leaving':    return 'Heading out';
    case 'safe':       return 'Marked as safe';
    default:           return 'Checked in';
  }
}

// ── Rendering decisions ───────────────────────────────────────────────────────

/**
 * Decide what to render given already-parsed props (subtype, venueLabel,
 * approxArea, senderName) and the Circle membership flag.
 *
 * This is what the component calls at render time.  The same function is also
 * unit-tested, so the tested logic IS the runtime logic.
 *
 * Privacy rules (fail-closed):
 *   - isCircleMember !== true  → placeholder for every viewer
 *   - null/missing/unknown subtype → placeholder even for members
 *   - 'meeting_point' subtype  → meeting-point card
 *   - any other subtype        → check-in card with a pre-computed label
 */
export function resolveCardRenderFromProps(
  subtype: string | null | undefined,
  venueLabel: string | null | undefined,
  approxArea: string | null | undefined,
  isCircleMember: boolean | null | undefined,
  senderName: string | null | undefined,
): RenderDecision {
  if (isCircleMember !== true) return { show: 'placeholder', text: PLACEHOLDER_TEXT };

  const variant = classifySubtype(subtype);
  if (variant === 'unknown') return { show: 'placeholder', text: PLACEHOLDER_TEXT };

  if (variant === 'meeting_point') {
    return {
      show: 'meeting_point',
      locationText: venueLabel || approxArea || null,
      senderName,
    };
  }

  return {
    show: 'checkin',
    subtype: subtype!,
    label: checkinLabel(subtype!),
    senderName,
  };
}

/**
 * Short human-readable preview string for a circle_status_card in the thread
 * list inbox (TelegraphInboxScreen / ThreadRow).
 *
 * Does NOT apply privacy gating — the caller is already a member of the thread
 * (it appears in their inbox).  Returns one of three strings:
 *   '✓ Circle check-in'      — for any known check-in subtype
 *   '📍 Meeting point updated' — for meeting_point subtype
 *   'Circle update'           — for null / malformed / unknown body
 */
export function circleCardInboxPreview(body: string | null | undefined): string {
  const payload = parseCircleCardBody(body);
  const variant = classifySubtype(payload?.subtype);
  if (variant === 'meeting_point') return '📍 Meeting point updated';
  if (variant === 'checkin') return '✓ Circle check-in';
  return 'Circle update';
}

/**
 * Decide what to render given a raw (unparsed) message body string.
 * Useful for testing the full JSON-parsing → rendering pipeline end-to-end.
 * Accepts an optional `subtypeOverride` that bypasses body parsing (mirrors
 * the MessageBubble pattern in `[id].tsx`).
 */
export function resolveCardRender(
  body: string | null | undefined,
  isCircleMember: boolean | null | undefined,
  senderName: string | null | undefined,
  subtypeOverride?: string | null,
): RenderDecision {
  const payload = parseCircleCardBody(body);
  const subtype = subtypeOverride ?? payload?.subtype ?? null;
  const venueLabel = payload?.venueLabel ?? null;
  const approxArea = payload?.approxArea ?? null;
  return resolveCardRenderFromProps(subtype, venueLabel, approxArea, isCircleMember, senderName);
}
