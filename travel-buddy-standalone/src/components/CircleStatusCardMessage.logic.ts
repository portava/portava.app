/**
 * Pure (zero-import) logic helpers for CircleStatusCardMessage.
 *
 * Extracted so they can be tested with node:test without pulling in React,
 * React Native, or theme tokens.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type CardVariant = 'checkin' | 'meeting_point' | 'unknown';

/** The shape pulled out of a circle_status_card message body. */
export interface CircleCardPayload {
  subtype?: string | null;
  venueLabel?: string | null;
  approxArea?: string | null;
}

// ── Body parsing ────────────────────────────────────────────────────────────

/**
 * Parse the raw message body string of a circle_status_card.
 * Returns null for null/empty/malformed input — callers must treat null the
 * same as a missing payload (renders the generic placeholder).
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

// ── Subtype classification ───────────────────────────────────────────────────

/** Map a raw subtype string to one of the three card variants. */
export function classifySubtype(subtype: string | null | undefined): CardVariant {
  if (!subtype) return 'unknown';
  if (subtype === 'meeting_point') return 'meeting_point';
  return 'checkin';
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

// ── Rendering decision ───────────────────────────────────────────────────────

export type RenderDecision =
  | { show: 'placeholder' }
  | { show: 'checkin';       subtype: string; senderName: string | null | undefined }
  | { show: 'meeting_point'; locationText: string | null; senderName: string | null | undefined };

/**
 * Determine what the card should render given the raw message body string,
 * the caller's Circle membership status, and an optional senderName override.
 *
 * Privacy rules (fail-closed):
 *   - isCircleMember !== true  → placeholder for every viewer
 *   - null/missing/unknown subtype → placeholder even for members
 *   - 'meeting_point' subtype  → meeting-point card
 *   - any other subtype        → check-in card
 */
export function resolveCardRender(
  body: string | null | undefined,
  isCircleMember: boolean | null | undefined,
  senderName: string | null | undefined,
  subtypeOverride?: string | null,
): RenderDecision {
  if (isCircleMember !== true) return { show: 'placeholder' };

  const payload = parseCircleCardBody(body);
  const subtype = subtypeOverride ?? payload?.subtype ?? null;
  const variant = classifySubtype(subtype);

  if (variant === 'unknown') return { show: 'placeholder' };

  if (variant === 'meeting_point') {
    const venueLabel = payload?.venueLabel ?? null;
    const approxArea = payload?.approxArea ?? null;
    return {
      show: 'meeting_point',
      locationText: venueLabel || approxArea || null,
      senderName,
    };
  }

  return { show: 'checkin', subtype: subtype!, senderName };
}
