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
 * P-06 and P-07 were `vacuous` — the operation they quantify over, unsend, did
 * not exist in this tree — and their test asserted that absence structurally so
 * that the day a handler landed it would go red. It did not. The assertion read
 * `src/routes/messaging.ts` alone, and unsend landed in telegraphLifecycle and
 * the §13.1 command route. A tripwire scoped to one file only watches one
 * doorway. Both properties are now written and `enforced`; what replaced the
 * absence assertion quantifies over the decision rather than over any file's
 * text, so there is no doorway left to come through.
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
      "src/domain/trips/services/tripCrewLocation.ts",
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
    status: "enforced",
    enforcedBy: [
      "src/migrations/3000_telegraph_unsend_authoritative.sql",
      "src/services/telegraph/unsend.ts",
    ],
    note:
      "Was `vacuous` until 2026-09-23, when unsend landed. Now quantified over " +
      "204 enumerated states — three message lifecycles x sender-or-not x " +
      "actor-present-or-departed x 17 recipient rosters covering every read " +
      "position including the created_at BOUNDARY — and run against BOTH copies " +
      "of the rule: the model of telegraph_unsend_message_before_seen, which is " +
      "pinned against the migration's own SQL, and planUnsend. The success must " +
      "also WRITE; a build that answered `unsent` without writing would satisfy " +
      "a weaker reading of this property and lose the message nowhere.",
  },
  {
    id: "P-07",
    censusRow: "T327",
    requirement: "any eligible recipient seen → unseen-unsend impossible",
    quantifier:
      "for all messages M and all recipients R, seen(R, M) → every unsend(M) is refused",
    status: "enforced",
    enforcedBy: [
      "src/migrations/3000_telegraph_unsend_authoritative.sql",
      "src/services/telegraph/unsend.ts",
    ],
    note:
      "The safety half of the pair: P-06 failing costs a user an affordance, " +
      "P-07 failing retracts something a person has already read. Over the same " +
      "204 states, every state with an eligible reader refuses AND writes " +
      "nothing, with seenBy equal to the count — and a fourth assertion requires " +
      "the live space to be PARTITIONED, because a build that refused every " +
      "unsend would satisfy this property and violate P-06. The race itself is " +
      "not closed here: it is closed by the FOR UPDATE locks in migration 3000, " +
      "whose lock-then-read ORDER is asserted against the migration text in " +
      "telegraphUnsendFunctionFake.test.ts, and executed for real by the " +
      "`api-server · kernel SQL executed on a throwaway database` job.",
  },
];

export const TELEGRAPH_PROPERTY_IDS: readonly string[] =
  TELEGRAPH_PROPERTY_INVARIANTS.map((p) => p.id);
