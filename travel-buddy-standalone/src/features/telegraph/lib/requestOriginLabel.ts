/**
 * Telegraph §22 — how a message request's origin is worded to the recipient.
 *
 * The server sends `{ type, id, verified }`. `verified` means the SERVER
 * established the claim (today only `trip`, and only when both parties are
 * accepted members); everything else is the sender's own assertion.
 *
 * ── THE TWO SENTENCES MUST NOT CONVERGE ──────────────────────────────────────
 * This module exists because there is exactly one dangerous simplification
 * available here: printing "In your trip crew" for an unverified trip claim. A
 * stranger who wants to be trusted asserts "Trip", and a recipient who reads
 * that as a fact has been told something the product does not know, at the
 * moment they are deciding whether to let a stranger talk to them.
 *
 * So a verified origin is stated ("In your trip crew") and an unverified one is
 * ATTRIBUTED ("They say they found you via Nearby"). The grammar carries the
 * epistemics, because a badge colour does not survive being screenshotted,
 * described aloud, or read by someone in a hurry.
 */

export type RequestOriginType = 'event' | 'trip' | 'nearby' | 'bump' | 'buddy' | 'profile';

export interface RequestOrigin {
  type: RequestOriginType;
  id: string | null;
  verified: boolean;
}

/** What a VERIFIED origin is allowed to say — a statement of fact. */
const VERIFIED_TEXT: Partial<Record<RequestOriginType, string>> = {
  // Only trip can be verified server-side today. The others are listed nowhere
  // on purpose: an entry here would be a sentence with nothing behind it.
  trip: 'In your trip crew',
};

/** What an UNVERIFIED origin says — attributed to the sender, never asserted. */
const CLAIMED_TEXT: Record<RequestOriginType, string> = {
  event: 'They say they found you at an event',
  trip: 'They say you share a trip',
  nearby: 'They say they found you nearby',
  bump: 'They say you crossed paths',
  buddy: 'They say this is about a Buddy booking',
  profile: 'They say they found your profile',
};

export interface OriginLabel {
  text: string;
  /** True only when the product is stating a fact it checked. */
  verified: boolean;
}

/**
 * The one sentence to show, or null when there is nothing to say.
 *
 * Returns null for an absent origin — which is what every request carries until
 * migration 2813 is applied and its flag is on — so the row renders exactly as
 * it always did rather than saying "unknown origin", a phrase that would make
 * every historical request look suspicious.
 */
export function originLabel(origin: RequestOrigin | null | undefined): OriginLabel | null {
  if (!origin || !origin.type) return null;
  if (!CLAIMED_TEXT[origin.type]) return null;   // an unknown type says nothing

  if (origin.verified === true) {
    const text = VERIFIED_TEXT[origin.type];
    // A verified origin with no verified wording falls back to the CLAIM
    // wording rather than inventing a statement of fact. This is reachable the
    // day a second origin becomes verifiable server-side and this table has not
    // been updated — the failure mode is understating, which is the safe one.
    return text ? { text, verified: true } : { text: CLAIMED_TEXT[origin.type], verified: false };
  }
  return { text: CLAIMED_TEXT[origin.type], verified: false };
}
