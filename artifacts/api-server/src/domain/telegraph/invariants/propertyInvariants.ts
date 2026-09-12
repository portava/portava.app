/**
 * Telegraph §27.1 — the seven property invariants, as data.
 *
 * A property is not a case. "A blocked sender is denied in this fixture" is a
 * case; "for ALL relationship states, adding a block never increases what the
 * sender may do" is a property. The census recorded seven of these as NOT-BUILT
 * with the observation that `test/accessControl.test.ts` and
 * `test/rlsPrivacy.test.ts` "are case tests over fixed fixtures" — true, and the
 * distinction is the whole point of §27.1, because the failures a property test
 * finds are the input combinations nobody thought to write a case for.
 *
 * Each entry below is exercised by `src/test/telegraphPropertyInvariants.test.ts`
 * over a SEEDED enumeration of inputs, against the real resolver named in
 * `enforcedBy`. Seeded, not random: a property test that cannot be re-run on the
 * input that failed is a flake generator.
 *
 * Two of the seven (P-06, P-07) are `vacuous` because the operation they
 * quantify over — unsend — does not exist in this tree. Their test asserts that
 * absence structurally, so the day an unsend handler is added the test goes red
 * and the property must be written rather than remembered.
 */

import type { PropertyInvariant } from "../contracts/certification.js";

export const TELEGRAPH_PROPERTY_INVARIANTS: readonly PropertyInvariant[] = [
  {
    id: "P-01",
    censusRow: "T321",
    requirement: "permission decreases → accessible set never increases",
    quantifier:
      "for all relationship states S and all weakenings S' of S (any inclusion " +
      "signal turned off, or message requests turned off), " +
      "verdictRank(canMessage(S')) <= verdictRank(canMessage(S))",
    status: "enforced",
    enforcedBy: [
      "src/lib/messagingPermissions.ts",
      "src/domain/telegraph/policies/disclosureLattices.ts",
    ],
    note:
      "Runs the real canMessage over the full cross-product of the five " +
      "relationship signals and the six privacy settings, then re-runs every " +
      "single-signal weakening of each state and compares the verdicts on the " +
      "lattice denied < requires_request < allowed. This is the property that " +
      "catches an override added to the wrong side of a branch — the trip and " +
      "circle overrides in that resolver ELEVATE, so an inverted condition there " +
      "would grant on absence and no case test over a fixed fixture would " +
      "necessarily see it.",
  },
  {
    id: "P-02",
    censusRow: "T322",
    requirement: "location precision decreases → recipient precision never increases",
    quantifier:
      "for all raw crew-location inputs R and all precision-decreasing " +
      "transforms t, disclosedPrecision(buildCrewCard(t(R))) <= " +
      "disclosedPrecision(buildCrewCard(R))",
    status: "enforced",
    enforcedBy: [
      "src/lib/tripCrewLocation.ts",
      "src/domain/telegraph/policies/disclosureLattices.ts",
    ],
    note:
      "The census found the adjacent property proved for a module nothing uses " +
      "(presence/domain) and none for the location path that ships. This runs the " +
      "real buildCrewCard — the pure privacy resolver behind the crew map — over " +
      "an enumerated input space, and applies six genuinely precision-decreasing " +
      "transforms: ghost mode on, hotel blur on, live share removed, share level " +
      "stepped down the ladder, position aged past the freshness bound, and " +
      "location state dropped. The measured quantity is what LEAVES the function " +
      "(exact coords > district+city > city > nothing), not what went in.",
  },
  {
    id: "P-03",
    censusRow: "T323",
    requirement: "participant removed → future accessible sequences never increase",
    quantifier:
      "for all thread states, the id set returned by GET /threads/:id/messages " +
      "after a membership weakening is a SUBSET of the set returned before it",
    status: "enforced",
    enforcedBy: ["src/routes/messaging.ts", "src/services/groupChatHistoryBound.ts"],
    note:
      "There is no sequence column in this schema, so the property is expressed " +
      "over the thing a sequence would have ordered: the set of message ids a " +
      "member can actually read. Driven against the REAL route over an enumerated " +
      "set of weakenings (left_at set, visible_from_at introduced, visible_from_at " +
      "moved later, history bound flag turned on). Subset, not equality, is the " +
      "correct assertion — a weakening may legitimately remove nothing.",
  },
  {
    id: "P-04",
    censusRow: "T324",
    requirement: "block activated → future direct delivery impossible",
    quantifier:
      "for all pairs and all thread states, introducing a block row in EITHER " +
      "direction makes POST /threads/:id/messages non-2xx, and canMessage denied",
    status: "enforced",
    enforcedBy: [
      "src/routes/messaging.ts",
      "src/lib/blockGuard.ts",
      "src/lib/messagingPermissions.ts",
    ],
    note:
      "The census marked this BUILT-BUT-WRONG because the guard could be made " +
      "unreachable by failing its input read. That is closed in the tree: the " +
      "roster read now refuses the send on error instead of inferring an empty " +
      "roster. The property therefore quantifies over the FAILURE states too — " +
      "block present, block present with an unreadable blocks table, and block " +
      "present with an unreadable roster — and all three must deny. A property " +
      "that only ranges over healthy databases would have passed before the fix.",
  },
  {
    id: "P-05",
    censusRow: "T325",
    requirement: "thread / availability / location expiry → temporary scopes terminate",
    quantifier:
      "for all windows W and all instants t > expiry(W), isVisibleTo(W, …, t) " +
      "is false for every viewer relationship, with no sweep having run",
    status: "enforced",
    enforcedBy: [
      "src/services/passport/OpenToPlansService.ts",
      "src/services/safeReturn/SafeReturnPrivacyGuard.ts",
    ],
    note:
      "Expiry here is a READ-TIME property, not a job: the predicate recomputes " +
      "it on every call, so a stalled sweep cannot render an expired scope as " +
      "current. The property is run over the cross-product of the five visibility " +
      "policies, both sources, and instants either side of the boundary, and it " +
      "checks the boundary itself (an expiry is not in the future at the instant " +
      "it names). Thread expiry has no referent in this schema and the test says " +
      "so rather than passing vacuously.",
  },
  {
    id: "P-06",
    censusRow: "T326",
    requirement: "message unseen → unsend may succeed",
    quantifier: "for all messages M with no eligible recipient receipt, unsend(M) succeeds",
    status: "vacuous",
    enforcedBy: ["src/routes/messaging.ts"],
    note:
      "There is no unsend operation in this tree — no route, no column, no " +
      "handler — so the property has nothing to quantify over. Migration 2325 and " +
      "its route live in unmerged PR #472 and are applied to portava-ci only. The " +
      "test asserts the absence STRUCTURALLY (no unsend/unsent surface in the " +
      "messaging router), so it goes red the moment one lands and the property " +
      "must then be written for real.",
  },
  {
    id: "P-07",
    censusRow: "T327",
    requirement: "any eligible recipient seen → unseen-unsend impossible",
    quantifier:
      "for all messages M and all recipients R, seen(R, M) → every unsend(M) is refused",
    status: "vacuous",
    enforcedBy: ["src/routes/messaging.ts"],
    note:
      "Same absence as P-06, and the same structural assertion guards it. This is " +
      "the safety half of the pair: P-06 failing costs a user an affordance, P-07 " +
      "failing retracts something a person has already read. When unsend lands, " +
      "this property — not a fixture — is what has to hold, because the failure " +
      "mode is a race and a race is exactly what a fixed fixture cannot cover.",
  },
];

export const TELEGRAPH_PROPERTY_IDS: readonly string[] =
  TELEGRAPH_PROPERTY_INVARIANTS.map((p) => p.id);
