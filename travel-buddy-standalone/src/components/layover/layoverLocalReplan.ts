/**
 * §16 L156 (client half) — may this CACHED bundle be replanned offline?
 *
 * ── WHY THIS RULE IS DUPLICATED AT ALL, WHICH NEEDS JUSTIFYING ───────────────
 * Every other derivation on this surface is the server's and is read, not
 * re-derived: the posture, the deadline, the window, the per-candidate
 * feasibility band. `LayoverReturnPanel.tsx` was deleted at `a718beb5` for
 * carrying thresholds the server did not have. So a second copy of a rule here
 * needs a reason, and there is exactly one:
 *
 *   THE ANSWER IS NEEDED WHEN THE SERVER CANNOT BE REACHED.
 *
 * `localReplan` decides whether a bundle cached on this device may be replanned
 * WHILE OFFLINE. An endpoint serving it would be unreachable in precisely the
 * situation it exists for, and an endpoint reachable while ONLINE would publish
 * a second feasibility answer about a layover that already has a certified one
 * — which is what §L1/§L2 forbid and why the server lane refused to expose it.
 * The refusal was right; it leaves this side needing the rule anyway.
 *
 * ── SO IT IS PINNED, NOT TRUSTED ─────────────────────────────────────────────
 * This is a MIRROR of
 * `artifacts/api-server/src/services/airport/LayoverDegradedService.ts#localReplan`,
 * and `__tests__/layoverLocalReplan.test.ts` asserts it against
 * `__fixtures__/layoverLocalReplan.fixture.json`, every expectation in which was
 * produced BY EXECUTING THAT FUNCTION
 * (scripts/generate-layover-local-replan-fixture.mjs). Nothing here was
 * transcribed by eye. If the server's rule moves and the fixture is
 * regenerated, this file goes red — which is the whole arrangement.
 *
 * The staleness half is not re-implemented at all: it delegates to
 * `bundleFreshness` in `layoverReturnFacts.ts`, which was already the pinned
 * mirror of the server's `bundleFreshness` including its `>=` boundary. One
 * staleness rule on this client, not two.
 *
 * ── WHAT A CALLER MAY DO WITH A REFUSAL ──────────────────────────────────────
 * Show the last certified deadline, labelled. §16's own words are "otherwise
 * show unavailable/stale", and `lastCertifiedDeadline` is present on EVERY
 * decision, allowed or not, because the deadline is the one number that must
 * stay on screen when everything else has gone dark.
 */
import type { LayoverOfflineBundle, LayoverReturnState } from '../../services/layover.ts';
import { bundleFreshness, type BundleFreshness } from './layoverReturnFacts.ts';

/** The server's three refusals, verbatim. Its vocabulary, not ours. */
export type LocalReplanRefusal =
  | 'bundle_stale'
  | 'schedule_changed_since_certification'
  | 'already_past_hard_return';

/**
 * The fields the rule reads, and only those.
 *
 * `certifiedUsableMinutes`, the two current times and the two certified ones
 * all come from the server — the window it certified and the session it
 * certified it against. Nothing here is measured on the device except `nowMs`.
 */
export interface LocalReplanInput {
  nowMs: number;
  certifiedUsableMinutes: number;
  currentDepartureTime: string;
  currentBoardingTime: string | null;
  certifiedDepartureTime: string;
  certifiedBoardingTime: string | null;
}

export interface LocalReplanDecision {
  allowed: boolean;
  /** EVERY reason, in the server's order — never just the first one found. */
  refusals: LocalReplanRefusal[];
  /** ALWAYS present, allowed or not. The deadline survives everything. */
  lastCertifiedDeadline: string;
  lastCertifiedReturnState: LayoverReturnState;
  freshness: BundleFreshness;
  /** Usable minutes a conservative local recompute may assume. Null when refused. */
  conservativeUsableMinutes: number | null;
}

/**
 * The bundle fields the rule reads. A whole `LayoverOfflineBundle` satisfies
 * it, and so does the trimmed object the shared fixture carries — which is why
 * the fixture can be the same file on both sides of the wire.
 */
export type LocalReplanBundle = Pick<
  LayoverOfflineBundle,
  'certifiedAt' | 'staleAfter' | 'returnDeadline'
>;

export function localReplan(
  bundle: LocalReplanBundle,
  input: LocalReplanInput,
): LocalReplanDecision {
  const freshness = bundleFreshness(bundle, input.nowMs);
  const refusals: LocalReplanRefusal[] = [];

  // Older than the TTL: the escalation state in the bundle may be a step behind
  // the traveller. `bundleFreshness` also reports `stale: true` for a bundle
  // whose instants do not parse, which is the same answer for the same reason —
  // an age that cannot be established cannot be claimed small.
  if (freshness.stale) refusals.push('bundle_stale');

  // The deadline in the bundle is about a DIFFERENT flight than the one the
  // traveller is on. `?? null` on both sides so that `undefined` and `null`
  // are the same absence, and an absent boarding time on both sides is not a
  // change — the server's own comparison, and the fixture pins both halves.
  if (
    input.currentDepartureTime !== input.certifiedDepartureTime ||
    (input.currentBoardingTime ?? null) !== (input.certifiedBoardingTime ?? null)
  ) {
    refusals.push('schedule_changed_since_certification');
  }

  // Past the deadline, nothing local can produce a safe plan. §15 owns this
  // moment, not §16.
  if (input.nowMs >= new Date(bundle.returnDeadline.hardReturnTime).getTime()) {
    refusals.push('already_past_hard_return');
  }

  const allowed = refusals.length === 0;
  return {
    allowed,
    refusals,
    lastCertifiedDeadline: bundle.returnDeadline.hardReturnTime,
    lastCertifiedReturnState: bundle.returnDeadline.returnState,
    freshness,
    // The certified window MINUS the bundle's age: it cannot exceed the
    // certified figure and it shrinks with time, so an offline plan can only
    // ever get more cautious. That is the one direction a fallback may move.
    conservativeUsableMinutes: allowed
      ? Math.max(0, input.certifiedUsableMinutes - freshness.ageMinutes)
      : null,
  };
}
