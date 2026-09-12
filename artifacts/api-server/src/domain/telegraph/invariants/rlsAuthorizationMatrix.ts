/**
 * Telegraph §26 — RLS & Authorization Test Matrix, as data.
 *
 * The spec gives ten rows of "Case → Expected". This file is those ten rows in
 * a form a checker can read, and `src/test/telegraphRlsAuthorizationMatrix.test.ts`
 * drives each one against the REAL route handler, middleware or resolver named
 * in `enforcedBy` — never against a model of it.
 *
 * WHAT WOULD TURN THIS RED (P24)
 * ------------------------------
 *   - Deleting or renaming any cited artifact: the guard resolves every
 *     `enforcedBy` path on disk.
 *   - Adding a case without a test: the guard greps the test file for each id.
 *   - Letting the non-enforced set grow: the guard pins the count in
 *     TELEGRAPH_CERTIFICATION_BASELINE.json and refuses an increase.
 *   - FIXING a divergence without updating this file: the test for a
 *     `divergent` case asserts TODAY'S behaviour, with the expected behaviour
 *     written beside it. When §14.3's bound is turned on by default, RLS-03's
 *     test goes red and the status must move to `enforced`. That is deliberate:
 *     a divergence that can be closed silently is one that can be reopened
 *     silently.
 *
 * The four statuses are defined in ../contracts/certification.ts. `enforced`
 * means "true on every deployment of this tree" — not "true once the migration
 * is applied", and not "true once the flag is on".
 */

import type { RlsMatrixCase } from "../contracts/certification.js";

export const TELEGRAPH_RLS_MATRIX: readonly RlsMatrixCase[] = [
  {
    id: "RLS-01",
    censusRow: "T311",
    requirement: "Non-member reads conversation",
    expected: "DENY",
    status: "enforced",
    enforcedBy: ["src/routes/messaging.ts"],
    note:
      "GET /threads/:threadId/messages reads the CALLER'S OWN membership row " +
      "(thread_id + user_id + left_at IS NULL) and returns 403 'Not a member of " +
      "this thread' before any message query runs. A caller with no row cannot " +
      "reach the messages table at all. The membership read uses .maybeSingle(), " +
      "whose error path yields data:null — which lands on the same 403, so an " +
      "unreadable membership table denies rather than admits.",
  },
  {
    id: "RLS-02",
    censusRow: "T312",
    requirement: "Removed member reads future sequence",
    expected: "DENY",
    status: "enforced",
    enforcedBy: ["src/routes/messaging.ts"],
    note:
      "Achieved by a blunter rule that is strictly stronger than the spec's: " +
      "`.is('left_at', null)` denies a departed member the ENTIRE thread, not " +
      "merely the sequences published after they left. There is no sequence " +
      "column in this schema (Appendix A's rule — reuse canonical structures), " +
      "so the required outcome is reached without one.",
  },
  {
    id: "RLS-03",
    censusRow: "T313",
    requirement: "New member reads pre-membership history without policy",
    expected: "DENY",
    status: "flag_gated",
    enforcedBy: [
      "src/services/groupChatHistoryBound.ts",
      "src/migrations/2400_telegraph_history_bound.sql",
      "src/routes/messaging.ts",
    ],
    note:
      "BUILT AND OFF. Migration 2400 adds message_thread_members.visible_from_at " +
      "and the flag telegraph_history_bound_enabled, SEEDED FALSE, and the read " +
      "path applies the bound only while the flag is true — while it is false the " +
      "query is byte-identical to the pre-2400 one and a newly added trip member " +
      "reads the whole back history. The test below proves BOTH halves, so the " +
      "gap is measured rather than described. To reach `enforced`: 2400 applied " +
      "everywhere AND the flag defaulted on. Neither is a code change, so this " +
      "row cannot be moved from inside the tree.",
  },
  {
    id: "RLS-04",
    censusRow: "T314",
    requirement: "Blocked sender sends DM",
    expected: "DENY",
    status: "enforced",
    enforcedBy: ["src/routes/messaging.ts", "src/lib/blockGuard.ts"],
    note:
      "Two gates, both fail-closed. isBlockedBetween returns true on a blocks-table " +
      "error and uses .limit(1) so a MUTUAL block (two rows) cannot raise. And the " +
      "roster read that decides whether the guard is even reachable now REFUSES the " +
      "send on error ('degraded_unavailable') instead of inferring an empty roster — " +
      "the fail-open this census recorded at T220 is closed in the tree, so the " +
      "guard can no longer be skipped by making its input fail.",
  },
  {
    id: "RLS-05",
    censusRow: "T315",
    requirement: "Expired exact location read",
    expected: "DENY",
    status: "enforced",
    enforcedBy: ["src/services/safeReturn/SafeReturnPrivacyGuard.ts"],
    note:
      "requireSafeReturnRecipient runs as middleware BEFORE the handler and checks, " +
      "in order: read error → refuse; missing → 404; expires_at in the past → 404; " +
      "status not 'active' → 404; recipient_user_id mismatch → 403. Independently, " +
      "exact coordinates cannot leave the API at all: toPublicSession projects a " +
      "field allowlist through stripGPS, which deletes lat/lng/latitude/longitude/" +
      "coords/coordinates at every depth. Expiry and precision are enforced by two " +
      "separate artifacts, so neither is a single point of failure.",
  },
  {
    id: "RLS-06",
    censusRow: "T316",
    requirement: "Availability audience excludes viewer",
    expected: "DENY",
    status: "enforced",
    enforcedBy: [
      "src/services/passport/OpenToPlansService.ts",
      "src/migrations/2260_availability_windows.sql",
    ],
    note:
      "isVisibleTo is a pure predicate with three independent conjuncts: the " +
      "window's source must be 'explicit' (an inferred window is never visible to " +
      "anyone but self, whatever visibility it carries), it must not be expired at " +
      "the instant of the read, and its visibility policy must admit the viewer's " +
      "relationship. Underneath it, 2260 enables RLS with an owner-only SELECT " +
      "policy and NO cross-user read policy at all, so the predicate is the only " +
      "path by which one traveller's window reaches another.",
  },
  {
    id: "RLS-07",
    censusRow: "T317",
    requirement: "Private Memory source shared without derivative authorization",
    expected: "DENY",
    status: "enforced",
    enforcedBy: [
      "src/domain/telegraph/policies/shareAuthorizationPolicy.ts",
      "src/scripts/checkTelegraphShareProducers.ts",
    ],
    note:
      "Was an UNGUARDED ABSENCE: no Memory share path existed, so the case could " +
      "not arise and nothing would have refused it. It is now refused by " +
      "construction. authorizeTelegraphShare is fail-closed — an unregistered " +
      "object family, a private source, or a missing derivative grant all return " +
      "a refusal, and the only way to obtain an allow for a PRIVATE_SOURCE family " +
      "is to present a derivative authorization the source domain issued. The CI " +
      "guard makes the policy unavoidable: every Telegraph share-card subtype in " +
      "the tree must be declared in the producer registry, and a producer whose " +
      "family is private-source must route through the policy. A new Memory share " +
      "added without one turns CI red. NO producer in the tree is PRIVATE_SOURCE " +
      "today — that is the finding, not an omission — so the gate is the guarantee " +
      "rather than a live code path, and the guard's second rule is what keeps it " +
      "one: a producer whose sourceDomain is private-by-default may ONLY be " +
      "declared PRIVATE_SOURCE, so the misdeclaration route out of the policy is " +
      "closed for exactly the domains this case is about.",
  },
  {
    id: "RLS-08",
    censusRow: "T318",
    requirement: "Authorized user reads current safe share projection",
    expected: "ALLOW",
    status: "vacuous",
    enforcedBy: ["src/domain/telegraph/policies/shareAuthorizationPolicy.ts"],
    note:
      "The POSITIVE case, and it has no implementation to admit. §5's share " +
      "projection does not exist (T44): every share card in the tree is frozen " +
      "JSON in messages.body with no current-state resolution, so there is no " +
      "'current safe share projection' for an authorized user to read. The policy " +
      "below answers the authorization half — an authorized viewer of a PUBLIC or " +
      "AUTHORIZED_DERIVATIVE family is allowed — but nothing calls it with a live " +
      "source object, because nothing resolves one. Counted as not-built, never as " +
      "an allow.",
  },
  {
    id: "RLS-09",
    censusRow: "T319",
    requirement: "Trip member loses Trip membership → capabilities downgrade",
    expected: "DOWNGRADE_IMMEDIATELY",
    status: "divergent",
    enforcedBy: ["src/services/groupChatSync.ts", "src/routes/messaging.ts"],
    note:
      "The gate is immediate; the PROPAGATION is not. Once message_thread_members " +
      "says left_at, every read and every send denies on the next request — there " +
      "is no cached capability to go stale. But the fact that trip membership " +
      "ended reaches that table only through syncTripChatMembers, invoked " +
      "fire-and-forget from the membership routes, so between the trip write and " +
      "the sync the removed member still reads the thread. The test drives both: " +
      "before the sync, ALLOW (the divergence); after it, DENY. To reach " +
      "`enforced` the trip-membership write and the thread-membership write must " +
      "be one transaction, which is a Trips-owned change.",
  },
  {
    id: "RLS-10",
    censusRow: "T320",
    requirement: "Buddy booking cancelled → booking-only actions disabled",
    expected: "DISABLE_IMMEDIATELY",
    status: "divergent",
    enforcedBy: [
      "src/lib/calls/callGatewayAdapter.ts",
      "travel-buddy-standalone/src/components/rentabuddy/BookingMilestoneMessage.tsx",
    ],
    note:
      "Correct for the one action that re-derives, wrong for every action that " +
      "renders. isRabBookingCallEligible is evaluated from the booking row at call " +
      "START, and 'cancelled' is not in RAB_CALL_ELIGIBLE_STATUSES, so the next " +
      "start attempt is refused — the live call is deliberately allowed to ride " +
      "out, which is a stated policy, not an oversight. Every OTHER booking action " +
      "is markup over a frozen payload: BookingMilestoneMessage contains no fetch, " +
      "no effect and no capability read, so its buttons outlive the booking state " +
      "they were rendered from. To reach `enforced`: §30A.10's action capability " +
      "registry (T410) must supply the card's buttons at render time.",
  },
];

/** The ten §26 case ids, in spec order. */
export const TELEGRAPH_RLS_CASE_IDS: readonly string[] = TELEGRAPH_RLS_MATRIX.map((c) => c.id);
