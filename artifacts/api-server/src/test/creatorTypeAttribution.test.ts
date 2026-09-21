/**
 * creatorTypeAttribution — `07` §7/§8/§9's attribution model, as properties.
 *
 * ── WHAT IS BEING PINNED ────────────────────────────────────────────────────
 * `07` §7: "The attribution engine should record contributions before deciding
 * payout weights." `07` §8: store gross revenue, attribution candidates,
 * confidence, rule version, provisional share — and "Actual percentages must
 * remain configurable". `07` §9/§10: fraud holds exist.
 *
 * The properties below are quantified OVER ALL SIX TYPES rather than shown on
 * one, because the defect this unit closes is precisely that the two types with
 * code satisfied everything and the other four had no representation at all. A
 * fixture for `travel_partner` would have passed against the old tree.
 *
 * ── THE SEAM IS TESTED AS A REFUSAL, NOT AS COVERAGE ────────────────────────
 * Four of the six types have no producer for their value event. The model is
 * required to REFUSE to mint an earning for them, and the refusal is asserted
 * per type. A test that let a producerless type earn would be manufacturing the
 * coverage this lane exists not to claim.
 *
 * Run: node --import tsx/esm --test src/test/creatorTypeAttribution.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CREATOR_TYPES,
  creatorTypeFacts,
  typesWithoutValueEventProducer,
  type CreatorType,
} from "../lib/creatorTypes.js";
import {
  buildAttribution,
  attributionBasisFor,
  splitCandidates,
  holdAttribution,
  supersedeAttribution,
  totalWeight,
  type AttributionInput,
} from "../lib/creatorTypeAttribution.js";

const BENEFICIARY = "11111111-1111-4111-8111-111111111111";
const SUBJECT = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";

/** A well-formed input for a type, with the value event present iff a producer is. */
function inputFor(t: CreatorType, over: Partial<AttributionInput> = {}): AttributionInput {
  const f = creatorTypeFacts(t);
  const hasProducer = f.valueEventProducer !== null;
  return {
    creatorType: t,
    subjectId: SUBJECT,
    valueEventId: hasProducer ? EVENT : null,
    beneficiaryUserId: BENEFICIARY,
    ruleVersion: f.defaultRuleVersion,
    weight: hasProducer ? 0.5 : 0,
    confidence: hasProducer ? 0.9 : 0,
    grossRevenueMinor: 0,
    provisionalShareMinor: 0,
    fraudHold: false,
    fraudHoldReason: null,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
describe("`07` §10 property 1 — value can be attributed, FOR ALL SIX TYPES", () => {
  it("every one of the six builds an attribution", () => {
    for (const t of CREATOR_TYPES) {
      const r = buildAttribution(inputFor(t));
      assert.equal(r.status, "built", `${t}: ${JSON.stringify(r)}`);
    }
  });

  it("the subject kind is DERIVED from the type — a caller cannot mis-file one", () => {
    for (const t of CREATOR_TYPES) {
      const r = buildAttribution(inputFor(t));
      assert.equal(r.status, "built");
      if (r.status !== "built") return;
      assert.equal(r.attribution.subjectKind, creatorTypeFacts(t).subjectKind);
      assert.equal(r.attribution.valueEvent, creatorTypeFacts(t).valueEvent);
      assert.equal(r.attribution.creatorType, t);
    }
  });

  it("an unknown creator type is REFUSED, not coerced", () => {
    const r = buildAttribution({ ...inputFor("trail_builder"), creatorType: "influencer" as CreatorType });
    assert.equal(r.status, "refused");
    if (r.status === "refused") assert.equal(r.reason, "unknown_creator_type");
  });

  it("an attribution with no subject or no beneficiary is REFUSED — it could not be audited", () => {
    for (const bad of [{ subjectId: "" }, { beneficiaryUserId: "" }]) {
      const r = buildAttribution(inputFor("local_expert", bad));
      assert.equal(r.status, "refused", JSON.stringify(bad));
      if (r.status === "refused") assert.equal(r.reason, "missing_attribution");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the seam is a REFUSAL, per type — no producer, no earning", () => {
  it("attributionBasisFor agrees with the producer column, for all six", () => {
    for (const t of CREATOR_TYPES) {
      assert.equal(
        attributionBasisFor(t),
        creatorTypeFacts(t).valueEventProducer === null ? "seam_no_producer" : "recorded_value_event",
      );
    }
  });

  it("a producerless type's attribution carries NO weight, NO gross and NO share", () => {
    const seamTypes = typesWithoutValueEventProducer();
    assert.ok(seamTypes.length > 0, "the fixture assumes at least one seam type exists");
    for (const t of seamTypes) {
      const r = buildAttribution(inputFor(t));
      assert.equal(r.status, "built");
      if (r.status !== "built") continue;
      assert.equal(r.attribution.basis, "seam_no_producer");
      assert.equal(r.attribution.weight, 0, `${t}: a seam carries weight`);
      assert.equal(r.attribution.grossRevenueMinor, 0);
      assert.equal(r.attribution.provisionalShareMinor, 0);
      assert.equal(r.attribution.valueEventId, null);
      assert.equal(r.attribution.earnable, false, `${t}: a seam was marked earnable`);
    }
  });

  it("asking a producerless type to carry a share is REFUSED, not silently zeroed", () => {
    for (const t of typesWithoutValueEventProducer()) {
      const r = buildAttribution(inputFor(t, { grossRevenueMinor: 1000, provisionalShareMinor: 100 }));
      assert.equal(r.status, "refused", `${t} accepted a share with no value event`);
      if (r.status === "refused") assert.equal(r.reason, "seam_cannot_carry_value");
    }
  });

  it("supplying a value event for a producerless type is REFUSED — no producer can have made one", () => {
    for (const t of typesWithoutValueEventProducer()) {
      const r = buildAttribution(inputFor(t, { valueEventId: EVENT }));
      assert.equal(r.status, "refused", `${t} accepted an event no code can produce`);
      if (r.status === "refused") assert.equal(r.reason, "no_value_event_producer");
    }
  });

  it("a type WITH a producer but no event id is REFUSED — the basis would be a lie", () => {
    for (const t of CREATOR_TYPES.filter((x) => creatorTypeFacts(x).valueEventProducer !== null)) {
      const r = buildAttribution(inputFor(t, { valueEventId: null }));
      assert.equal(r.status, "refused", `${t} claimed a recorded event it does not have`);
      if (r.status === "refused") assert.equal(r.reason, "missing_value_event");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("`07` §10 property 3 — rules are versioned, per type", () => {
  it("an attribution with no rule version is REFUSED — it could not be recomputed", () => {
    for (const t of CREATOR_TYPES) {
      const r = buildAttribution(inputFor(t, { ruleVersion: "" }));
      assert.equal(r.status, "refused", t);
      if (r.status === "refused") assert.equal(r.reason, "missing_rule_version");
    }
  });

  it("a rule version belonging to ANOTHER type is REFUSED", () => {
    const r = buildAttribution(
      inputFor("trail_builder", { ruleVersion: creatorTypeFacts("local_expert").defaultRuleVersion }),
    );
    assert.equal(r.status, "refused");
    if (r.status === "refused") assert.equal(r.reason, "rule_version_type_mismatch");
  });

  it("a LATER generation of the type's own lineage is accepted — versions must be able to move", () => {
    const r = buildAttribution(inputFor("travel_partner", { ruleVersion: "creator-rules/travel-partner/v7" }));
    assert.equal(r.status, "built", JSON.stringify(r));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("`07` §10 property 4 — fraud holds exist, and preserve the evidence", () => {
  it("a hold is RECORDED and makes the attribution un-earnable, for every type", () => {
    for (const t of CREATOR_TYPES) {
      const r = buildAttribution(inputFor(t, { fraudHold: true, fraudHoldReason: "collusive_group" }));
      assert.equal(r.status, "built", `${t}: a held attribution must still be recorded`);
      if (r.status !== "built") continue;
      assert.equal(r.attribution.fraudHold, true);
      assert.equal(r.attribution.fraudHoldReason, "collusive_group");
      assert.equal(r.attribution.earnable, false, `${t}: a held attribution was earnable`);
    }
  });

  it("an UNEXPLAINED hold is refused — a hold nobody can justify is a bug, not a control", () => {
    const r = buildAttribution(inputFor("travel_partner", { fraudHold: true, fraudHoldReason: null }));
    assert.equal(r.status, "refused");
    if (r.status === "refused") assert.equal(r.reason, "unexplained_fraud_hold");
  });

  it("a reason WITHOUT a hold is refused — a claim nobody acted on", () => {
    const r = buildAttribution(inputFor("travel_partner", { fraudHold: false, fraudHoldReason: "fake_visits" }));
    assert.equal(r.status, "refused");
    if (r.status === "refused") assert.equal(r.reason, "unexplained_fraud_hold");
  });

  it("holdAttribution appends a NEW held row under the SAME rule version", () => {
    // The same version on purpose: a hold is a fact about THIS computation, not
    // a recomputation of it. An earlier version of the service invented a
    // `…/v1+hold` version to get past supersedeAttribution's same_rule_version
    // refusal, and that string is not a generation of any lineage — a hold
    // recorded under rules nobody wrote.
    for (const t of CREATOR_TYPES) {
      const first = buildAttribution(inputFor(t));
      assert.equal(first.status, "built");
      if (first.status !== "built") continue;
      const held = holdAttribution(first.attribution, "paid_engagement");
      assert.equal(held.status, "built", `${t}: ${JSON.stringify(held)}`);
      if (held.status !== "built") continue;
      assert.equal(held.attribution.ruleVersion, first.attribution.ruleVersion, t);
      assert.equal(held.attribution.fraudHold, true);
      assert.equal(held.attribution.fraudHoldReason, "paid_engagement");
      assert.equal(held.attribution.earnable, false);
      assert.equal(held.attribution.supersedesId, first.attribution.id);
      assert.notEqual(held.attribution.idempotencyKey, first.attribution.idempotencyKey);
      // THE ORIGINAL IS UNTOUCHED.
      assert.equal(first.attribution.fraudHold, false, t);
    }
  });

  it("holding twice is refused — one linked row per attribution, as 2920's index allows", () => {
    const first = buildAttribution(inputFor("travel_partner"));
    assert.equal(first.status, "built");
    if (first.status !== "built") return;
    const once = holdAttribution(first.attribution, "refund_abuse");
    assert.equal(once.status, "built");
    if (once.status !== "built") return;
    const twice = holdAttribution(once.attribution, "refund_abuse");
    assert.equal(twice.status, "refused");
    if (twice.status === "refused") assert.equal(twice.reason, "already_held");
  });

  it("holdAttribution with no reason is refused", () => {
    const first = buildAttribution(inputFor("local_expert"));
    assert.equal(first.status, "built");
    if (first.status !== "built") return;
    const r = holdAttribution(first.attribution, "");
    assert.equal(r.status, "refused");
    if (r.status === "refused") assert.equal(r.reason, "unexplained_fraud_hold");
  });

  it("holding does not zero the recorded figures — the evidence survives the hold", () => {
    const r = buildAttribution(
      inputFor("travel_partner", {
        fraudHold: true, fraudHoldReason: "self_booking_loop",
        grossRevenueMinor: 10_000, provisionalShareMinor: 2_000,
      }),
    );
    assert.equal(r.status, "built");
    if (r.status !== "built") return;
    assert.equal(r.attribution.grossRevenueMinor, 10_000);
    assert.equal(r.attribution.provisionalShareMinor, 2_000);
    assert.equal(r.attribution.earnable, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("`07` §7 multi-party attribution, and `07` §8's no-hard-coding rule", () => {
  it("several parties can be recorded against ONE value event", () => {
    const r = splitCandidates([
      { ...inputFor("travel_partner"), weight: 0.6, beneficiaryUserId: BENEFICIARY },
      { ...inputFor("local_expert"), weight: 0.4, beneficiaryUserId: "44444444-4444-4444-8444-444444444444" },
    ]);
    assert.equal(r.status, "built", JSON.stringify(r));
    if (r.status !== "built") return;
    assert.equal(r.attributions.length, 2);
    assert.equal(totalWeight(r.attributions), 1);
  });

  it("weights summing past 1.0 are REFUSED — that is paying out more than the conversion produced", () => {
    const r = splitCandidates([
      { ...inputFor("travel_partner"), weight: 0.7 },
      { ...inputFor("local_expert"), weight: 0.7 },
    ]);
    assert.equal(r.status, "refused");
    if (r.status === "refused") assert.equal(r.reason, "weights_exceed_whole");
  });

  it("weights summing BELOW 1.0 are accepted — §7 records contributions before deciding weights", () => {
    const r = splitCandidates([{ ...inputFor("travel_partner"), weight: 0.3 }]);
    assert.equal(r.status, "built");
  });

  it("a provisional share larger than the gross it shares is REFUSED", () => {
    const r = buildAttribution(
      inputFor("travel_partner", { grossRevenueMinor: 1000, provisionalShareMinor: 1001 }),
    );
    assert.equal(r.status, "refused");
    if (r.status === "refused") assert.equal(r.reason, "share_exceeds_gross");
  });

  it("NO percentage is hard-coded: the same inputs under two rule versions differ only by the version", () => {
    const a = buildAttribution(inputFor("travel_partner", { ruleVersion: "creator-rules/travel-partner/v1" }));
    const b = buildAttribution(inputFor("travel_partner", { ruleVersion: "creator-rules/travel-partner/v2" }));
    assert.equal(a.status, "built");
    assert.equal(b.status, "built");
    if (a.status !== "built" || b.status !== "built") return;
    // The module computes no share of its own; it records what it was given.
    assert.deepEqual(
      { ...a.attribution, ruleVersion: null, idempotencyKey: null },
      { ...b.attribution, ruleVersion: null, idempotencyKey: null },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("`07` §10 property 5 — historical recalculation, never a rewrite", () => {
  it("superseding produces a NEW attribution naming the old, under the NEW version", () => {
    const first = buildAttribution(inputFor("travel_partner"));
    assert.equal(first.status, "built");
    if (first.status !== "built") return;

    const next = supersedeAttribution(first.attribution, {
      ruleVersion: "creator-rules/travel-partner/v2",
      grossRevenueMinor: 9_000,
      provisionalShareMinor: 900,
    });
    assert.equal(next.status, "built", JSON.stringify(next));
    if (next.status !== "built") return;

    assert.equal(next.attribution.supersedesId, first.attribution.id);
    assert.equal(next.attribution.ruleVersion, "creator-rules/travel-partner/v2");
    assert.notEqual(next.attribution.id, first.attribution.id);
    assert.notEqual(next.attribution.idempotencyKey, first.attribution.idempotencyKey);
    // THE OLD ROW IS UNTOUCHED. This is the property; a mutation here would be
    // exactly the `rent_buddy_earnings_ledger` defect `09` §1.3 records.
    assert.equal(first.attribution.ruleVersion, creatorTypeFacts("travel_partner").defaultRuleVersion);
    assert.equal(first.attribution.grossRevenueMinor, 0);
  });

  it("superseding under the SAME version is refused — nothing was recomputed", () => {
    const first = buildAttribution(inputFor("travel_partner"));
    assert.equal(first.status, "built");
    if (first.status !== "built") return;
    const same = supersedeAttribution(first.attribution, {
      ruleVersion: first.attribution.ruleVersion,
    });
    assert.equal(same.status, "refused");
    if (same.status === "refused") assert.equal(same.reason, "same_rule_version");
  });

  it("superseding a SEAM is refused — there is no computation to redo", () => {
    for (const t of typesWithoutValueEventProducer()) {
      const first = buildAttribution(inputFor(t));
      assert.equal(first.status, "built");
      if (first.status !== "built") continue;
      const r = supersedeAttribution(first.attribution, {
        ruleVersion: `${creatorTypeFacts(t).defaultRuleVersion.replace(/v\d+$/, "v2")}`,
      });
      assert.equal(r.status, "refused", `${t}: a seam was "recomputed"`);
      if (r.status === "refused") assert.equal(r.reason, "seam_cannot_carry_value");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("`09` §1 — the pre-money boundary, in the type system and in the refusals", () => {
  it("there is NO settled field a caller could set, and the built row reports zero", () => {
    for (const t of CREATOR_TYPES) {
      const r = buildAttribution(inputFor(t));
      assert.equal(r.status, "built");
      if (r.status !== "built") continue;
      assert.equal(r.attribution.settledMinor, 0, `${t}: a settlement was recorded`);
    }
  });

  it("a caller asserting money was collected is REFUSED outright", () => {
    const r = buildAttribution({ ...inputFor("travel_partner"), settledMinor: 1 } as AttributionInput);
    assert.equal(r.status, "refused");
    if (r.status === "refused") assert.equal(r.reason, "settlement_not_recordable");
  });

  it("negative money figures are refused rather than booked", () => {
    for (const bad of [{ grossRevenueMinor: -1 }, { provisionalShareMinor: -1 }]) {
      const r = buildAttribution(inputFor("travel_partner", bad));
      assert.equal(r.status, "refused", JSON.stringify(bad));
      if (r.status === "refused") assert.equal(r.reason, "negative_input");
    }
  });

  it("weight and confidence outside [0,1] are refused", () => {
    for (const bad of [{ weight: 1.01 }, { weight: -0.01 }, { confidence: 2 }, { confidence: -1 }]) {
      const r = buildAttribution(inputFor("travel_partner", bad));
      assert.equal(r.status, "refused", JSON.stringify(bad));
      if (r.status === "refused") assert.equal(r.reason, "out_of_range");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("identity is derived from the EVENT, not the attempt (`09` §7.1)", () => {
  it("building the same attribution twice yields the same id and idempotency key", () => {
    for (const t of CREATOR_TYPES) {
      const a = buildAttribution(inputFor(t));
      const b = buildAttribution(inputFor(t));
      assert.equal(a.status, "built");
      assert.equal(b.status, "built");
      if (a.status !== "built" || b.status !== "built") continue;
      assert.equal(a.attribution.id, b.attribution.id, `${t}: id depends on the attempt`);
      assert.equal(a.attribution.idempotencyKey, b.attribution.idempotencyKey);
    }
  });

  it("two DIFFERENT beneficiaries on one event get DIFFERENT keys — §7 is multi-party", () => {
    const a = buildAttribution(inputFor("travel_partner"));
    const b = buildAttribution(inputFor("travel_partner", { beneficiaryUserId: "55555555-5555-4555-8555-555555555555" }));
    assert.equal(a.status, "built");
    assert.equal(b.status, "built");
    if (a.status !== "built" || b.status !== "built") return;
    assert.notEqual(a.attribution.idempotencyKey, b.attribution.idempotencyKey);
  });

  it("the six types never collide on a key even with identical subject and event", () => {
    const keys = CREATOR_TYPES.map((t) => {
      const r = buildAttribution(inputFor(t));
      return r.status === "built" ? r.attribution.idempotencyKey : `refused:${t}`;
    });
    assert.equal(new Set(keys).size, 6, `keys collided: ${JSON.stringify(keys)}`);
  });
});
