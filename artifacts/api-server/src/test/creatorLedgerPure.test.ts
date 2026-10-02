/**
 * The pure halves of census-discovery §52: recommendation binding, rule
 * evaluation, chain/status derivation, and the door payloads.
 *
 *   B*  lib/creatorServedRecommendation.ts — a claimed id binds only to the
 *       converting viewer's own, earlier exposure of the named item
 *   E*  lib/creatorRuleEvaluation.ts — figures come from PUBLISHED params only;
 *       `{}` (every seeded version) refuses; no split, no rounding is invented
 *   S*  lib/creatorLedgerStatus.ts — chains, heads, the three derivable states,
 *       never `payable`; a hold reaches cee and rbee legs and not intel rows
 *   P*  lib/creatorLedgerPlans.ts — hold/release/recompute/reversal payloads
 *   V*  lib/creatorShareCanonical.ts — the third partition's projection
 *
 * Run: node --import tsx/esm --test src/test/creatorLedgerPure.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bindServedRecommendation } from "../lib/creatorServedRecommendation.js";
import { evaluateCreatorRule, readCreatorRuleParams } from "../lib/creatorRuleEvaluation.js";
import {
  attributedConversions,
  impactSummary,
  indexChains,
  summarizeCreatorEarnings,
  type AttributionRow,
  type EarningEntryRow,
} from "../lib/creatorLedgerStatus.js";
import {
  liveEntries,
  planHold,
  planRecompute,
  planRelease,
  planReversal,
  resolveHead,
} from "../lib/creatorLedgerPlans.js";
import {
  CREATOR_ACCOUNT_PARTY_ROLE,
  SOURCE_LEDGERS,
  fromViewRow,
  projectCreatorEarningEntryRow,
  type CanonicalShareRow,
} from "../lib/creatorShareCanonical.js";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CREATOR = "33333333-3333-4333-8333-333333333333";
const RID = "AbCdEfGhIjKlMnOpQrStUv";
const ADMIN = { kind: "admin" as const, userId: "44444444-4444-4444-8444-444444444444" };

// ═══════════════════════════════════════════════════════════════════════════
describe("B — a claimed recommendation binds only to the converting viewer's own earlier exposure", () => {
  const row = { id: "re-1", user_id: VIEWER, item_id: "node/1", surface: "discovery", served_at: "2026-09-27T10:00:00.000+00:00", recommendation_id: RID };
  const claim = { viewerUserId: VIEWER, recommendationId: RID, itemId: "node/1", occurredAt: "2026-09-27T11:00:00Z" };

  it("B1. binds the viewer's own exposure, canonicalising the instant", () => {
    const b = bindServedRecommendation(claim, row);
    assert.equal(b.ok, true);
    if (b.ok) assert.deepEqual([b.value.recommendationId, b.value.exposureRowId, b.value.servedAt], [RID, "re-1", "2026-09-27T10:00:00.000Z"]);
  });
  it("B2. another viewer's row binds nothing — even if a read lost its viewer filter", () => {
    const b = bindServedRecommendation(claim, { ...row, user_id: OTHER });
    assert.deepEqual([b.ok, !b.ok && b.reason], [false, "recommendation_not_found"]);
  });
  it("B3. no row, a malformed id, and no viewer each bind nothing", () => {
    assert.equal(bindServedRecommendation(claim, null).ok, false);
    const m = bindServedRecommendation({ ...claim, recommendationId: "not-an-id" }, row);
    assert.deepEqual([m.ok, !m.ok && m.reason], [false, "malformed_recommendation_id"]);
    const n = bindServedRecommendation({ ...claim, viewerUserId: "" }, row);
    assert.deepEqual([n.ok, !n.ok && n.reason], [false, "recommendation_not_found"]);
  });
  it("B4. an exposure of a different item, or served AFTER the conversion, is refused", () => {
    const i = bindServedRecommendation({ ...claim, itemId: "node/2" }, row);
    assert.deepEqual([i.ok, !i.ok && i.reason], [false, "recommendation_item_mismatch"]);
    const l = bindServedRecommendation({ ...claim, occurredAt: "2026-09-27T09:59:59Z" }, row);
    assert.deepEqual([l.ok, !l.ok && l.reason], [false, "recommendation_served_after_conversion"]);
  });
  it("B5. a row carrying a DIFFERENT id than claimed binds nothing", () => {
    const b = bindServedRecommendation(claim, { ...row, recommendation_id: "ZZZZZZZZZZZZZZZZZZZZZZ" });
    assert.equal(b.ok, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("E — figures come from PUBLISHED params, and nothing undecided is decided", () => {
  const P = { creator_share_ppm: 700_000, platform_fee_ppm: 200_000 };
  it("E1. every seeded version's `{}` is refused, not defaulted", () => {
    const r = evaluateCreatorRule({}, { grossRevenueMinor: 10_000, weight: 1 });
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, "rule_params_incomplete"]);
  });
  it("E2. published ppm → floored integer figures that never exceed the gross", () => {
    const r = evaluateCreatorRule(P, { grossRevenueMinor: 10_001, weight: 1 });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual([r.value.creatorShareMinor, r.value.platformFeeMinor], [7000, 2000]);
      assert.ok(r.value.creatorShareMinor + r.value.platformFeeMinor <= 10_001);
    }
  });
  it("E3. a multi-party weight is refused: `07` §7's split rule is not invented", () => {
    const r = evaluateCreatorRule(P, { grossRevenueMinor: 10_000, weight: 0.5 });
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, "multi_party_split_undecided"]);
  });
  it("E4. invalid params are refused: over 100%, non-integer, unknown rounding", () => {
    assert.equal(readCreatorRuleParams({ creator_share_ppm: 900_000, platform_fee_ppm: 200_000 }).ok, false);
    assert.equal(readCreatorRuleParams({ creator_share_ppm: 0.7, platform_fee_ppm: 0 }).ok, false);
    assert.equal(readCreatorRuleParams({ ...P, rounding: "half_up" }).ok, false);
  });
  it("E5. a gross large enough to lose precision in a float product stays exact", () => {
    // Found by search, not chosen by hand: for this pair the float product
    // floors to 3693813819136611 while the exact integer answer is …610.
    const r = evaluateCreatorRule({ creator_share_ppm: 417_402, platform_fee_ppm: 0 }, { grossRevenueMinor: 8_849_535_505_667_464, weight: 1 });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.creatorShareMinor, 3_693_813_819_136_610);
    assert.notEqual(Math.floor((8_849_535_505_667_464 * 417_402) / 1_000_000), 3_693_813_819_136_610,
      "the float path must actually differ here, or this case proves nothing");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
function attr(over: Partial<AttributionRow>): AttributionRow {
  return {
    id: "a1", creator_type: "travel_partner", subject_kind: "booking", subject_id: "bk-1", value_event: "verified_booking",
    value_event_id: "bk-1", attribution_basis: "recorded_value_event", beneficiary_user_id: CREATOR, weight: 1, confidence: 1,
    gross_revenue_minor: 10_000, provisional_share_minor: 7000, currency: "USD", rule_version: "creator-rules/travel-partner/v901",
    fraud_hold: false, fraud_hold_reason: null, supersedes_id: null, idempotency_key: "k-a1", computed_at: "2026-09-27T10:00:00Z",
    recommendation_id: null, ...over,
  };
}
function entry(over: Partial<EarningEntryRow>): EarningEntryRow {
  return {
    id: "e1", transaction_key: "t1", creator_type: "travel_partner", attribution_id: "a1", account: "creator_payable",
    entry_reason: "revenue_share", revenue_source: null, amount_minor: 7000, currency: "USD",
    rule_version: "creator-rules/travel-partner/v901", beneficiary_user_id: CREATOR, reverses_entry_id: null,
    provider: "none", idempotency_key: "t1#1", ...over,
  };
}
const canon = (e: EarningEntryRow): CanonicalShareRow => projectCreatorEarningEntryRow({ ...e, amount_minor: Number(e.amount_minor) })[0]!;

describe("S — chains, heads, and the three states rows can establish", () => {
  const a1 = attr({});
  const h = attr({ id: "h", supersedes_id: "a1", fraud_hold: true, fraud_hold_reason: "fake_visits", idempotency_key: "k-h" });
  const r = attr({ id: "r", supersedes_id: "h", idempotency_key: "k-r" });

  it("S1. the head is derived by walking successors; every member resolves to it", () => {
    const c = indexChains([r, a1, h]);
    assert.equal(c.headOf("a1")?.id, "r");
    assert.equal(c.headOf("h")?.id, "r");
    assert.deepEqual(c.chainOf("h").map((x) => x.id), ["a1", "h", "r"]);
    assert.deepEqual(c.forks, []);
  });
  it("S2. a fork (a row superseded twice) is reported, and a plan refuses it", () => {
    const fork = attr({ id: "f", supersedes_id: "a1", idempotency_key: "k-f" });
    assert.deepEqual(indexChains([a1, h, fork]).forks, ["a1"]);
    assert.deepEqual(resolveHead([a1, h, fork], "a1"), { ok: false, reason: "chain_forked", detail: "rows superseded twice: a1" });
  });
  it("S3. an entry on a held chain is HELD, a reversed pair is REVERSED, the rest PROVISIONAL — never payable", () => {
    const e1 = entry({});
    const e2 = entry({ id: "e2", transaction_key: "t2", idempotency_key: "t2#1", amount_minor: 500 });
    const rev = entry({ id: "e3", transaction_key: "reversal:t2", entry_reason: "reversal", amount_minor: -500, reverses_entry_id: "e2", idempotency_key: "rev" });
    const heldChain = [a1, h];
    const { summary, entries } = summarizeCreatorEarnings(CREATOR, [e1, e2, rev].map(canon), heldChain);
    assert.deepEqual(entries.map((x) => [x.sourceEntryId, x.status]), [["e1", "held"], ["e2", "reversed"], ["e3", "reversed"]]);
    const b = summary.buckets[0]!;
    assert.deepEqual([b.provisional, b.held, b.reversedNet, b.lifetimeNet, b.available], [0, 7000, 0, 7000, 0]);
    const released = summarizeCreatorEarnings(CREATOR, [e1].map(canon), [a1, h, r]);
    assert.equal(released.entries[0]!.status, "provisional");
  });
  it("S4. a Rent-a-Buddy leg is held through the travel_partner chain that names its booking; intel rows cannot be", () => {
    const rbee: CanonicalShareRow = {
      sourceLedger: "rent_buddy_earnings_entries", sourceEntryId: "rb1", unitKind: "currency", unitCode: "USD", amount: 5000,
      partyRole: "creator", creatorId: CREATOR, entryReason: "booking_gross", ruleVersion: "rent-buddy-fee-schedule/v1",
      attributionKind: "booking", attributionId: "bk-1", reversesSourceEntryId: null, cashRecorded: 0, occurredAt: "",
    };
    const intel: CanonicalShareRow = { ...rbee, sourceLedger: "intel_reward_ledger", sourceEntryId: "i1", unitKind: "qiu", unitCode: "QIU", amount: 0.25, attributionId: null };
    const { summary, entries } = summarizeCreatorEarnings(CREATOR, [rbee, intel], [a1, h]);
    assert.deepEqual(entries.map((x) => x.status), ["held", "provisional"]);
    assert.deepEqual(summary.buckets.map((b) => [b.sourceLedger, b.holdable]),
      [["intel_reward_ledger", false], ["rent_buddy_earnings_entries", true]]);
  });
  it("S5. another creator's legs are never summed into this creator's", () => {
    const mine = canon(entry({}));
    const theirs = { ...canon(entry({ id: "x" })), creatorId: OTHER };
    const { entries } = summarizeCreatorEarnings(CREATOR, [mine, theirs], [a1]);
    assert.deepEqual(entries.map((e) => e.sourceEntryId), ["e1"]);
  });
  it("S6. impact counts outcomes and seams separately — a held seam is still a seam; conversions list heads only, with no weight or confidence", () => {
    const seam = attr({ id: "s", creator_type: "trail_builder", subject_kind: "trail", value_event: "route_completion",
      value_event_id: null, attribution_basis: "seam_no_producer", fraud_hold: true, fraud_hold_reason: "x", idempotency_key: "k-s" });
    const imp = impactSummary([a1, h, r, seam]);
    assert.deepEqual(imp, { outcomes: [{ valueEvent: "verified_booking", attributed: 1, held: 0 }], seams: 1 });
    const conv = attributedConversions([a1, h, r, seam]);
    assert.deepEqual(conv.map((c) => [c.attributionId, c.state, c.revisions]).sort(), [["r", "active", 3], ["s", "held", 1]].sort());
    for (const c of conv) assert.ok(!("weight" in c) && !("confidence" in c), "07 §3: no raw score reaches a creator");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("P — every multi-row operation is ONE payload, keyed by what it acts on", () => {
  const head = attr({ id: "a1" });
  it("P1. a hold supersedes the head, carries the figures unchanged, and brings its audit row", () => {
    const p = planHold(head, "circular_transactions", ADMIN);
    assert.equal(p.ok, true);
    if (!p.ok) return;
    const a = p.payload.attribution!;
    assert.deepEqual([a.supersedes_id, a.fraud_hold, a.fraud_hold_reason, a.rule_version, a.provisional_share_minor, a.idempotency_key],
      ["a1", true, "circular_transactions", head.rule_version, 7000, "creator-attr-hold:a1"]);
    assert.deepEqual([p.payload.audit!.action, p.payload.audit!.actor_user_id, p.payload.audit!.reason, p.payload.audit!.resulting_attribution_id],
      ["hold_placed", ADMIN.userId, "circular_transactions", "$new"]);
    assert.deepEqual(p.payload.entries, []);
  });
  it("P2. unexplained, already-held and not-held are refused before anything is built", () => {
    assert.equal(planHold(head, "  ", ADMIN).ok, false);
    assert.deepEqual((planHold(attr({ fraud_hold: true, fraud_hold_reason: "x" }), "y", ADMIN) as any).reason, "already_held");
    assert.deepEqual((planRelease(head, "cleared", ADMIN) as any).reason, "not_held");
  });
  it("P3. a release clears the hold on the row and keeps WHY in the audit", () => {
    const held = attr({ id: "h", fraud_hold: true, fraud_hold_reason: "fake_visits" });
    const p = planRelease(held, "verified by support", ADMIN);
    assert.equal(p.ok, true);
    if (!p.ok) return;
    assert.deepEqual([p.payload.attribution!.fraud_hold, p.payload.attribution!.fraud_hold_reason], [false, null]);
    assert.deepEqual([p.payload.audit!.reason, (p.payload.audit!.detail as any).released_hold_reason], ["verified by support", "fake_visits"]);
  });
  it("P4. a recompute reverses every LIVE leg of the chain exactly and books the new ones against $new", () => {
    const e1 = entry({ id: "e1", account: "traveler_receivable", amount_minor: -7000, idempotency_key: "t1#0", beneficiary_user_id: null });
    const e2 = entry({ id: "e2" });
    const done = entry({ id: "e9", transaction_key: "t9", amount_minor: 100, idempotency_key: "t9#1" });
    const doneRev = entry({ id: "e10", transaction_key: "reversal:t9", entry_reason: "reversal", amount_minor: -100, reverses_entry_id: "e9", idempotency_key: "rv" });
    const p = planRecompute([head], [e1, e2, done, doneRev], head,
      { ruleVersion: "creator-rules/travel-partner/v902", figures: { grossRevenueMinor: 10_000, creatorShareMinor: 6500, platformFeeMinor: 2500 } },
      "v902 published", ADMIN);
    assert.equal(p.ok, true, JSON.stringify(p));
    if (!p.ok) return;
    const rev = p.payload.entries.filter((e) => e.entry_reason === "reversal");
    assert.deepEqual(rev.map((e) => [e.reverses_entry_id, e.amount_minor, e.rule_version]).sort(),
      [["e1", 7000, head.rule_version], ["e2", -7000, head.rule_version]].sort(), "only the live legs, each exactly negated under its OWN version");
    const fresh = p.payload.entries.filter((e) => e.entry_reason !== "reversal");
    assert.ok(fresh.every((e) => e.attribution_id === "$new" && e.rule_version === "creator-rules/travel-partner/v902"));
    assert.equal(fresh.reduce((s, e) => s + e.amount_minor, 0), 0, "the new transactions balance");
    assert.equal(p.payload.attribution!.provisional_share_minor, 6500);
  });
  it("P5. recompute refuses: same version, a held head, a seam", () => {
    const next = { ruleVersion: head.rule_version, figures: { grossRevenueMinor: 1, creatorShareMinor: 0, platformFeeMinor: 0 } };
    assert.equal((planRecompute([head], [], head, next, "r", ADMIN) as any).reason, "same_rule_version");
    const v2 = { ...next, ruleVersion: "creator-rules/travel-partner/v902" };
    assert.equal((planRecompute([head], [], attr({ fraud_hold: true, fraud_hold_reason: "x" }), v2, "r", ADMIN) as any).reason, "recompute_while_held");
    assert.equal((planRecompute([head], [], attr({ attribution_basis: "seam_no_producer", value_event_id: null }), v2, "r", ADMIN) as any).reason, "seam_has_no_computation");
  });
  it("P6. a reversal negates one transaction once, keyed by it", () => {
    const e1 = entry({ id: "e1", account: "traveler_receivable", amount_minor: -7000, idempotency_key: "t1#0", beneficiary_user_id: null });
    const e2 = entry({ id: "e2" });
    const p = planReversal([e1, e2], "t1", "refund", ADMIN);
    assert.equal(p.ok, true);
    if (!p.ok) return;
    assert.deepEqual(p.payload.entries.map((e) => [e.reverses_entry_id, e.amount_minor]), [["e1", 7000], ["e2", -7000]]);
    assert.equal(p.payload.audit!.idempotency_key, "audit:reverse:t1");
    const after = [e1, e2, ...p.payload.entries.map((e, i) => entry({ ...(e as any), id: `r${i}` }))];
    assert.equal((planReversal(after, "t1", "again", ADMIN) as any).reason, "already_reversed");
    assert.deepEqual(liveEntries(after), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("V — the third partition projects like the other two", () => {
  it("V1. creator_earning_entries is a source ledger, and its four accounts map to the four roles", () => {
    assert.ok(SOURCE_LEDGERS.includes("creator_earning_entries"));
    assert.deepEqual(CREATOR_ACCOUNT_PARTY_ROLE, {
      creator_payable: "creator", platform_revenue: "platform", traveler_receivable: "traveler", cash_external: "external",
    });
  });
  it("V2. a projected row names its attribution and its creator type, and an unknown account is refused", () => {
    const row = projectCreatorEarningEntryRow({ id: "e", creator_type: "trail_builder", attribution_id: "a", account: "creator_payable", amount_minor: "70", currency: "USD" })[0]!;
    assert.deepEqual([row.sourceLedger, row.unitKind, row.partyRole, row.attributionId, row.attributionKind, row.amount],
      ["creator_earning_entries", "currency", "creator", "a", "trail_builder", 70]);
    assert.throws(() => projectCreatorEarningEntryRow({ id: "e", creator_type: "x", attribution_id: "a", account: "wallet" }));
  });
  it("V3. a view row from the third partition is read, not refused", () => {
    const r = fromViewRow({ source_ledger: "creator_earning_entries", source_entry_id: "e", unit_kind: "currency", unit_code: "USD", party_role: "creator", amount: "5" });
    assert.equal(r.sourceLedger, "creator_earning_entries");
  });
});
