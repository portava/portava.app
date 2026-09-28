/**
 * census-discovery §91 (lane W10-I), A07 — the client half of §79's fail-closed
 * Live claim. When a Live read the page owed FAILED, GET /discovery serves the
 * rows without their "open around now" claim and says so in
 * `meta.liveSafety: { readable: false, claimsWithheld }`. Both Discovery tabs
 * then say so too, in the words DiscoveryEventPostsRail already uses for the
 * same fact, so the absence of a "now" reason is never read as "nothing is on".
 *
 * Its own module, not services/discovery.ts: the component suites mock that
 * service exhaustively, and a helper added there would be `undefined` in them.
 */
import type { DiscoveryResult } from '../../services/discovery.ts';

/** True when the server withheld this page's "now" claims because a Live read failed. */
export function liveClaimsUnchecked(data: Pick<DiscoveryResult, 'meta'> | null | undefined): boolean {
  return data?.meta?.liveSafety?.readable === false;
}

/** The notice: the first sentence of the event rail's own refusal copy. */
export const LIVE_UNCHECKED_NOTICE = "We couldn't check what's live nearby just now.";
