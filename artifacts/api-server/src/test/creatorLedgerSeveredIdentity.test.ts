/**
 * A SEVERED BENEFICIARY IDENTITY IS A STATE, NOT A STRING.
 *
 * `creator_attributions.beneficiary_user_id` is NOT NULL under 2920. The C-11
 * "retain pseudonymised" answer drops that: pseudonymisation is precisely the
 * severing of the identity link while the accounting row is kept. From the
 * moment one such row exists, every reader that wrote `String(row.beneficiary_user_id)`
 * produces the string `"null"` — a four-character beneficiary id that EVERY
 * erased creator in the ledger shares, so every pseudonymised row folds into
 * one phantom party.
 *
 * These tests fix that boundary in place. Three properties, each one of which
 * fails if the fix is reverted to `String(...)` or papered over with `?? ""`:
 *
 *   N1-N4  a row with a null beneficiary never produces the string `"null"`
 *          (nor `""`, nor `"undefined"`) anywhere a party is named;
 *   D1-D3  two DISTINCT severed rows stay distinct — they do not collapse into
 *          a single beneficiary, and each refusal names its own row;
 *   L1-L5  a row with a REAL beneficiary behaves EXACTLY as before. This is the
 *          regression that would actually ship, so the expected values are
 *          written out as literals rather than derived from the code under test;
 *   X1-X2  severed and "the entries do not say" are different states and are
 *          not reported under one reason;
 *   C1-C2  a severed row's chain is REFUSED, never answered as empty — a read
 *          that cannot establish the chain is not a chain of length zero.
 *
 * Run: node --import tsx/esm --test src/test/creatorLedgerSeveredIdentity.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  beneficiaryIsNamed,
  isIdentitySevered,
  type AttributionRow,
} from "../lib/creatorLedgerStatus.js";
import {
  attributionModelFromRow,
  planHold,
  planRecompute,
  planRelease,
  type LedgerActor,
} from "../lib/creatorLedgerPlans.js";
import {
  recomputeCreatorUnderRuleVersion,
  type CreatorLedgerEntry,
} from "../lib/creatorLedgerEntries.js";
import {
  readAttributionChain,
  recordCreatorAttribution,
} from "../services/creators/CreatorAttributionService.js";

const CREATOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN: LedgerActor = { kind: "admin", userId: "33333333-3333-4333-8333-333333333333" };
const RULE = "creator-rules/travel-partner/v901";
const RULE_V2 = "creator-rules/travel-partner/v902";

function attr(over: Partial<AttributionRow>): AttributionRow {
  return {
    id: "a1", creator_type: "travel_partner", subject_kind: "booking", subject_id: "bk-1",
    value_event: "verified_booking", value_event_id: "bk-1",
    attribution_basis: "recorded_value_event", beneficiary_user_id: CREATOR,
    weight: 1, confidence: 1, gross_revenue_minor: 10_000, provisional_share_minor: 7000,
    currency: "USD", rule_version: RULE, fraud_hold: false, fraud_hold_reason: null,
    supersedes_id: null, idempotency_key: "k-a1", computed_at: "2026-09-27T10:00:00Z",
    recommendation_id: null, ...over,
  };
}

/**
 * Every string anywhere inside `v`, however deeply nested, and whatever the
 * shape. A test that only inspected the fields it expected would pass while a
 * `"null"` sat in a field it did not think to look at.
 */
function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) allStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) allStrings(x, out);
  return out;
}

/**
 * The forbidden coercions, as the values they actually produce. `"null"` is
 * what `String(null)` yields, `"undefined"` what `String(undefined)` yields,
 * `""` what `?? ""` yields, and `"unknown"` the hand-written version. The list
 * holds only strings that are never a legitimate value anywhere in these
 * payloads — `provider: "none"`, for instance, is a real recorded value and is
 * deliberately absent, so this check stays a signal rather than noise.
 */
const PHANTOM_IDS = ["null", "undefined", "", "unknown", "NULL", "[object Object]", "NaN"];

function assertNoPhantomIdentity(label: string, v: unknown): void {
  const found = allStrings(v).filter((s) => PHANTOM_IDS.includes(s));
  assert.deepEqual(
    found, [],
    `${label} produced a phantom identity ${JSON.stringify(found)}; a severed beneficiary is a state, ` +
      `not a value, and every such string is one party that every erased creator would share`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// N — a null beneficiary never becomes a string
// ═══════════════════════════════════════════════════════════════════════════

describe("N — a severed identity never becomes the string \"null\"", () => {
  const severed = attr({ beneficiary_user_id: null });

  it("N1. the state is readable as a state, by one shared predicate", () => {
    assert.equal(isIdentitySevered(severed), true);
    assert.equal(beneficiaryIsNamed(severed), false);
    assert.equal(isIdentitySevered(attr({})), false);
    assert.equal(beneficiaryIsNamed(attr({})), true);
  });

  it("N2. attributionModelFromRow refuses rather than returning a model naming nobody", () => {
    const m = attributionModelFromRow(severed);
    assert.equal(m.ok, false);
    assert.ok(!m.ok);
    assert.equal(m.reason, "identity_severed");
    assert.match(m.detail, /a1/, "the refusal names the row it is about");
    assertNoPhantomIdentity("attributionModelFromRow(severed)", m);
    // And emphatically NOT a model with a coerced beneficiary.
    assert.equal("model" in m, false, "there is no model for a record that names no party");
  });

  it("N3. hold, release and recompute each refuse a severed head, with no payload", () => {
    const held = attr({ beneficiary_user_id: null, fraud_hold: true, fraud_hold_reason: "fake_visits" });
    const cases: Array<[string, ReturnType<typeof planHold>]> = [
      ["planHold", planHold(severed, "circular_transactions", ADMIN)],
      ["planRelease", planRelease(held, "appeal_upheld", ADMIN)],
      ["planRecompute", planRecompute(
        [severed], [], severed,
        { ruleVersion: RULE_V2, figures: { grossRevenueMinor: 10_000, creatorShareMinor: 6000, platformFeeMinor: 2000 } },
        "rule_republished", ADMIN,
      )],
    ];
    for (const [name, plan] of cases) {
      assert.equal(plan.ok, false, `${name} must refuse a severed head`);
      assert.ok(!plan.ok);
      assert.equal(plan.reason, "identity_severed", `${name} refused for the wrong reason: ${plan.reason}`);
      assert.equal("payload" in plan, false, `${name} must not build a payload for a severed head`);
      assertNoPhantomIdentity(name, plan);
    }
  });

  it("N5. the ROW TYPE admits null — the fix at its source, proved by the typecheck", () => {
    // M6 (`beneficiary_user_id: string | null` narrowed back to `string`) is a
    // COMPILE-TIME fact: tsx strips types, so no running assertion can observe
    // it. `pnpm typecheck:tests` is M6's killer, and this annotated binding —
    // like every `attr({ beneficiary_user_id: null })` above it — is what stops
    // compiling the moment the column is declared non-nullable again. The two
    // runtime assertions keep the binding live rather than unused.
    const severedBeneficiary: AttributionRow["beneficiary_user_id"] = null;
    assert.equal(severedBeneficiary, null);
    assert.equal(isIdentitySevered(attr({ beneficiary_user_id: severedBeneficiary })), true);
  });

  it("N4. the severed refusal is not the refusal for an unknown row, nor for a held or seam row", () => {
    // A severed row that is ALSO held answers `identity_severed`, not
    // `already_held`: "already held" is advice the admin cannot act on, because
    // the release is refused for the same reason.
    const severedAndHeld = attr({ beneficiary_user_id: null, fraud_hold: true, fraud_hold_reason: "fake_visits" });
    const r = planHold(severedAndHeld, "circular_transactions", ADMIN);
    assert.ok(!r.ok);
    assert.equal(r.reason, "identity_severed");

    // A severed SEAM row likewise, and not `seam_has_no_computation`.
    const severedSeam = attr({ beneficiary_user_id: null, attribution_basis: "seam_no_producer", value_event_id: null });
    const rc = planRecompute(
      [severedSeam], [], severedSeam,
      { ruleVersion: RULE_V2, figures: { grossRevenueMinor: 0, creatorShareMinor: 0, platformFeeMinor: 0 } },
      "rule_republished", ADMIN,
    );
    assert.ok(!rc.ok);
    assert.equal(rc.reason, "identity_severed");

    // And an unexplained operation is still refused for being unexplained: the
    // severed check must not swallow the reason requirement.
    const unexplained = planHold(severed, "   ", ADMIN);
    assert.ok(!unexplained.ok);
    assert.equal(unexplained.reason, "unexplained");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D — two severed rows do not collapse into one beneficiary
// ═══════════════════════════════════════════════════════════════════════════

describe("D — distinct severed rows stay distinct", () => {
  const sev1 = attr({ id: "a1", subject_id: "bk-1", idempotency_key: "k-a1", beneficiary_user_id: null });
  const sev2 = attr({ id: "a2", subject_id: "bk-2", idempotency_key: "k-a2", beneficiary_user_id: null });

  it("D1. each refusal names its OWN row, so the two are told apart", () => {
    const m1 = attributionModelFromRow(sev1);
    const m2 = attributionModelFromRow(sev2);
    assert.ok(!m1.ok && !m2.ok);
    assert.notEqual(m1.detail, m2.detail, "two severed rows must not produce one indistinguishable answer");
    assert.match(m1.detail, /\ba1\b/);
    assert.match(m2.detail, /\ba2\b/);
  });

  it("D2. neither row contributes a beneficiary id, so they cannot share a phantom one", () => {
    // Under the defect both of these produced the SAME beneficiaryUserId —
    // "null" — and any grouping by beneficiary folded them together.
    const beneficiaries = [sev1, sev2].map((row) => {
      const m = attributionModelFromRow(row);
      return m.ok ? m.model.beneficiaryUserId : null;
    });
    // `named` is computed BEFORE the deepEqual below: node:assert/strict's
    // deepEqual is `asserts actual is T`, so asserting against `[null, null]`
    // first would narrow `beneficiaries` to `null[]` and make the filter
    // vacuous — the assertion proving its own premise.
    const named = beneficiaries.filter((b) => typeof b === "string");
    assert.deepEqual(named, [], "a severed row must contribute no grouping key");
    assert.deepEqual(beneficiaries, [null, null], "no severed row yields a beneficiary at all");
  });

  it("D3. two severed heads do not produce one successor, nor two successors naming one party", () => {
    const plans = [sev1, sev2].map((h) => planHold(h, "circular_transactions", ADMIN));
    for (const p of plans) {
      assert.ok(!p.ok);
      assert.equal(p.reason, "identity_severed");
    }
    assert.notEqual(
      (plans[0] as { detail: string }).detail,
      (plans[1] as { detail: string }).detail,
      "the two refusals must be about the two different rows",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L — a real beneficiary behaves EXACTLY as before
// ═══════════════════════════════════════════════════════════════════════════
//
// This is the regression that would actually ship: a fix that quietly changed
// what a live row does is worse than the latent defect it removed. The expected
// values below are written as LITERALS, not derived from the code under test.

describe("L — a row with a real beneficiary is unchanged", () => {
  const live = attr({});

  it("L1. the model is exactly the object the pre-fix code returned", () => {
    const m = attributionModelFromRow(live);
    assert.equal(m.ok, true);
    assert.ok(m.ok);
    assert.deepEqual(m.model, {
      id: "k-a1",
      creatorType: "travel_partner",
      subjectKind: "booking",
      subjectId: "bk-1",
      valueEvent: "verified_booking",
      valueEventId: "bk-1",
      basis: "recorded_value_event",
      beneficiaryUserId: CREATOR,
      weight: 1,
      confidence: 1,
      grossRevenueMinor: 10_000,
      provisionalShareMinor: 7000,
      currency: "USD",
      settledMinor: 0,
      ruleVersion: RULE,
      fraudHold: false,
      fraudHoldReason: null,
      supersedesId: null,
      earnable: true,
      idempotencyKey: "k-a1",
    });
    assert.equal(typeof m.model.beneficiaryUserId, "string", "a real id stays a string, not a wrapper");
  });

  it("L2. planHold's payload is byte-identical to the pre-fix payload", () => {
    const p = planHold(live, "circular_transactions", ADMIN);
    assert.equal(p.ok, true);
    assert.ok(p.ok);
    assert.equal(p.subjectId, "a1");
    assert.deepEqual(p.payload.attribution, {
      creator_type: "travel_partner",
      subject_kind: "booking",
      subject_id: "bk-1",
      value_event: "verified_booking",
      value_event_id: "bk-1",
      attribution_basis: "recorded_value_event",
      beneficiary_user_id: CREATOR,
      weight: 1,
      confidence: 1,
      gross_revenue_minor: 10_000,
      provisional_share_minor: 7000,
      currency: "USD",
      rule_version: RULE,
      fraud_hold: true,
      fraud_hold_reason: "circular_transactions",
      supersedes_id: "a1",
      idempotency_key: "creator-attr-hold:a1",
      recommendation_id: null,
    });
    assert.deepEqual(p.payload.entries, []);
    assert.equal(p.payload.audit?.action, "hold_placed");
    assert.equal(p.payload.audit?.idempotency_key, "audit:hold:a1");
  });

  it("L3. planRelease carries the real beneficiary forward unchanged", () => {
    const held = attr({ fraud_hold: true, fraud_hold_reason: "fake_visits" });
    const p = planRelease(held, "appeal_upheld", ADMIN);
    assert.ok(p.ok);
    assert.equal(p.payload.attribution?.beneficiary_user_id, CREATOR);
    assert.equal(p.payload.attribution?.fraud_hold, false);
    assert.equal(p.payload.attribution?.fraud_hold_reason, null);
    assert.equal(p.payload.attribution?.idempotency_key, "creator-attr-release:a1");
  });

  it("L4. planRecompute books the new entries to the real beneficiary, as before", () => {
    const p = planRecompute(
      [live], [], live,
      { ruleVersion: RULE_V2, figures: { grossRevenueMinor: 10_000, creatorShareMinor: 6000, platformFeeMinor: 2000 } },
      "rule_republished", ADMIN,
    );
    assert.ok(p.ok);
    assert.equal(p.payload.attribution?.beneficiary_user_id, CREATOR);
    assert.equal(p.payload.attribution?.rule_version, RULE_V2);
    const payable = p.payload.entries.filter((e) => e.account === "creator_payable");
    assert.equal(payable.length, 1, "one creator_payable leg");
    assert.equal(payable[0]!.beneficiary_user_id, CREATOR);
    assert.equal(payable[0]!.amount_minor, 6000);
    // The legs that name nobody by construction still name nobody — null, and
    // not a coerced string. That was already correct and must stay correct.
    for (const e of p.payload.entries.filter((x) => x.account !== "creator_payable")) {
      assert.equal(e.beneficiary_user_id, null, `${e.account} names nobody by construction`);
    }
    assertNoPhantomIdentity("planRecompute(live)", p);
  });

  it("L5. a different real beneficiary is carried forward as itself", () => {
    const p = planHold(attr({ beneficiary_user_id: OTHER }), "paid_engagement", ADMIN);
    assert.ok(p.ok);
    assert.equal(p.payload.attribution?.beneficiary_user_id, OTHER);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// X — severed is not the same state as "the entries do not say"
// ═══════════════════════════════════════════════════════════════════════════

describe("X — a severed identity and an unreadable one are different states", () => {
  const leg = (over: Partial<CreatorLedgerEntry>): CreatorLedgerEntry => ({
    entryId: "x#0", transactionKey: "creator:a1:revenue_share:" + RULE, creatorType: "travel_partner",
    attributionId: "a1", account: "creator_payable", amountMinor: 7000, currency: "USD",
    entryReason: "revenue_share", revenueSource: null, cashSettledMinor: 0, ruleVersion: RULE,
    beneficiaryUserId: CREATOR, reversesEntryId: null, provider: "none", externalRef: null,
    idempotencyKey: "x#0", ...over,
  });

  it("X1. recomputing from entries that name nobody is refused, not booked to \"\"", () => {
    const anonymous = [
      leg({ entryId: "p#0", idempotencyKey: "p#0", account: "traveler_receivable", amountMinor: -2000, beneficiaryUserId: null, entryReason: "platform_fee", transactionKey: "creator:a1:platform_fee:" + RULE }),
      leg({ entryId: "p#1", idempotencyKey: "p#1", account: "platform_revenue", amountMinor: 2000, beneficiaryUserId: null, entryReason: "platform_fee", transactionKey: "creator:a1:platform_fee:" + RULE }),
    ];
    const r = recomputeCreatorUnderRuleVersion(anonymous, {
      attributionId: "a1", ruleVersion: RULE_V2,
      next: { grossRevenueMinor: 10_000, creatorShareMinor: 6000, platformFeeMinor: 2000 },
    });
    assert.equal(r.status, "refused");
    assert.ok(r.status === "refused");
    assertNoPhantomIdentity("recomputeCreatorUnderRuleVersion(anonymous)", r);
    // The honest reason: these ENTRIES do not name a beneficiary. It is NOT
    // "identity_severed" — from entries alone an erasure and an earning whose
    // legs never named anyone are indistinguishable, and asserting an erasure
    // would be a claim this function cannot make.
    assert.equal(r.reason, "beneficiary_not_in_entries");
    assert.notEqual(r.reason, "identity_severed", "the two states must not be reported as one");
  });

  it("X2. entries that DO name a beneficiary still recompute, to that beneficiary", () => {
    const named = [
      leg({ entryId: "r#0", idempotencyKey: "r#0", account: "traveler_receivable", amountMinor: -7000, beneficiaryUserId: null }),
      leg({ entryId: "r#1", idempotencyKey: "r#1", account: "creator_payable", amountMinor: 7000, beneficiaryUserId: CREATOR }),
    ];
    const r = recomputeCreatorUnderRuleVersion(named, {
      attributionId: "a1", ruleVersion: RULE_V2,
      next: { grossRevenueMinor: 10_000, creatorShareMinor: 6000, platformFeeMinor: 2000 },
    });
    assert.equal(r.status, "recomputed");
    assert.ok(r.status === "recomputed");
    const payable = r.entries.filter((e) => e.account === "creator_payable" && e.entryReason !== "reversal");
    assert.equal(payable.length, 1);
    assert.equal(payable[0]!.beneficiaryUserId, CREATOR, "the real beneficiary is carried forward, as before");
    assertNoPhantomIdentity("recomputeCreatorUnderRuleVersion(named)", r);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C — a chain that cannot be established is refused, not answered as empty
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The narrowest stub `readAttributionChain` can be driven by. It records every
 * filter it is asked for, so the test can assert that the second query — the
 * one that would have been `beneficiary_user_id=eq.null` and matched nothing —
 * is never issued at all.
 */
function stubClient(first: Record<string, unknown> | null) {
  const filters: Array<[string, unknown]> = [];
  let queries = 0;
  const builder = (): any => ({
    eq(k: string, v: unknown) { filters.push([k, v]); return builder(); },
    async maybeSingle() { return { data: first, error: null }; },
    async limit() { return { data: first ? [first] : [], error: null }; },
  });
  return {
    filters,
    get queries() { return queries; },
    sc: { from() { queries += 1; return { select: () => builder() }; } },
  };
}

describe("C — a severed row's chain is refused, never empty", () => {
  it("C1. readAttributionChain refuses, and never asks PostgREST for eq.null", async () => {
    const s = stubClient({ ...attr({ beneficiary_user_id: null }) } as unknown as Record<string, unknown>);
    const r = await readAttributionChain(s.sc as any, "a1");
    assert.equal(r.ok, false);
    assert.ok(!r.ok);
    assert.equal(r.reason, "identity_severed");
    // NOT `not_found`: the row was fetched by id and is there. NOT an empty
    // chain: that would report "the identity is gone" as "never acted on".
    assert.notEqual(r.reason, "not_found");
    assert.equal(s.queries, 1, "the beneficiary-keyed query must not be issued for a severed row");
    assert.deepEqual(
      s.filters.filter(([k]) => k === "beneficiary_user_id"), [],
      "a null beneficiary must never reach the query as a filter value",
    );
    assertNoPhantomIdentity("readAttributionChain(severed)", r);
  });

  it("C2. a real beneficiary is still grouped by, exactly as before", async () => {
    const row = attr({});
    const s = stubClient({ ...row } as unknown as Record<string, unknown>);
    const r = await readAttributionChain(s.sc as any, "a1");
    assert.equal(r.ok, true);
    assert.ok(r.ok);
    assert.deepEqual(r.value.map((x) => x.id), ["a1"]);
    assert.equal(s.queries, 2, "the chain query is still issued for a named beneficiary");
    assert.deepEqual(s.filters.filter(([k]) => k === "beneficiary_user_id"), [["beneficiary_user_id", CREATOR]]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R — a replay onto a severed record is neither a replay nor a conflict
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The narrowest PostgREST double `recordCreatorAttribution`'s 23505 branch can
 * be driven by: the flag read, the rule-version read, an INSERT that raises
 * the duplicate the TOTAL unique index raises, and the replay lookup that then
 * returns the already-persisted row.
 */
function replayClient(existing: Record<string, unknown> | null) {
  const from = (t: string) => {
    const state: any = {
      _payload: null as any,
      _single: false,
      select() { return this; },
      eq() { return this; },
      neq() { return this; },
      in() { return this; },
      lte() { return this; },
      order() { return this; },
      limit() { return this; },
      insert(p: any) { this._payload = p; return this; },
      single() { this._single = true; return this; },
      maybeSingle() { this._single = true; return this; },
      async then(res: (v: any) => void) {
        const emit = (v: any) =>
          res(this._single && Array.isArray(v.data) ? { ...v, data: v.data[0] ?? null } : v);
        if (t === "feature_flags") return emit({ data: { enabled: true }, error: null });
        if (this._payload !== null) return emit({ data: null, error: { code: "23505", message: "duplicate key" } });
        if (t === "creator_rule_versions") {
          return emit({
            data: [{ creator_type: "travel_partner", rule_version: RULE, params: {}, effective_from: "2026-01-01T00:00:00Z" }],
            error: null,
          });
        }
        if (t === "creator_attributions") return emit({ data: existing ? [existing] : [], error: null });
        return emit({ data: null, error: null });
      },
    };
    return state;
  };
  return { from, rpc: async () => ({ data: null, error: null }) };
}

const replayInput = {
  creatorType: "travel_partner" as const, subjectId: "s", valueEventId: "e",
  beneficiaryUserId: CREATOR, weight: 1, confidence: 1,
  grossRevenueMinor: 0, provisionalShareMinor: 0, fraudHold: false, fraudHoldReason: null,
};

describe("R — a key replayed onto a severed record", () => {
  it("R1. answers identity_severed, not conflicting_replay and not a replay", async () => {
    const severedRow = {
      ...attr({ beneficiary_user_id: null }),
      recommendation_id: null, gross_revenue_minor: 0, provisional_share_minor: 0,
    } as unknown as Record<string, unknown>;
    const r = await recordCreatorAttribution(replayClient(severedRow) as any, replayInput);
    assert.equal(r.ok, false);
    assert.ok(!r.ok);
    assert.equal(r.reason, "identity_severed");
    // `conflicting_replay` would say "already recorded with DIFFERENT content",
    // a sentence about a disagreement that does not exist: the stored row makes
    // no claim about who at all. Under the defect `String(null)` differed from
    // every real id and this is exactly what came back.
    assert.notEqual(r.reason, "conflicting_replay");
    assertNoPhantomIdentity("recordCreatorAttribution(severed existing)", r);
  });

  it("R2. a real, matching existing row is still answered as a replay, as before", async () => {
    const liveRow = {
      ...attr({}), recommendation_id: null, gross_revenue_minor: 0, provisional_share_minor: 0,
    } as unknown as Record<string, unknown>;
    const r = await recordCreatorAttribution(replayClient(liveRow) as any, replayInput);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.ok);
    assert.equal(r.replayed, true);
    assert.equal(r.value.attribution.beneficiaryUserId, CREATOR);
  });

  it("R3. a real existing row with a DIFFERENT beneficiary is still a conflicting replay", async () => {
    const otherRow = {
      ...attr({ beneficiary_user_id: OTHER }),
      recommendation_id: null, gross_revenue_minor: 0, provisional_share_minor: 0,
    } as unknown as Record<string, unknown>;
    const r = await recordCreatorAttribution(replayClient(otherRow) as any, replayInput);
    assert.equal(r.ok, false);
    assert.ok(!r.ok);
    assert.equal(r.reason, "conflicting_replay", "a real disagreement is still reported as one");
  });
});
