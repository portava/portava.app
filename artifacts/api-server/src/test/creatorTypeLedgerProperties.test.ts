/**
 * creatorLedgerEntries, read across ALL SIX of `07` §2's creator value types.
 *
 * ── WHY THIS IS SEPARATE FROM creatorLedgerProperties.test.ts ───────────────
 * That file quantifies the ten acceptance properties over Rent-a-Buddy BOOKING
 * entries, and it is right about them. But every one of its fixtures is a
 * booking, so it is satisfied by a ledger that can ONLY express a booking —
 * which is exactly what `rent_buddy_earnings_entries` (2901) is:
 * `booking_id NOT NULL REFERENCES rent_buddy_bookings(id)` and
 * `CHECK (attribution_kind IN ('booking'))`.
 *
 * `07` §10's five properties are claims about the CREATOR ECONOMY, not about
 * one marketplace. So these quantify over the six types, and the properties
 * that must hold for a type with no producer are asserted as REFUSALS — a green
 * test that let a producerless type mint an earning would be manufacturing the
 * coverage this lane exists not to claim.
 *
 * ── PROPERTIES, NOT EXAMPLES ────────────────────────────────────────────────
 *   • reconstruction is INDEPENDENT OF ORDER, over every permutation of a small
 *     ledger and over a seeded shuffle of a six-type one;
 *   • every transaction SUMS TO ZERO per currency — the invariant that makes a
 *     fictitious collection impossible: it has no counterpart to book;
 *   • a reversal NETS THE BALANCE BACK wherever it is appended, for every type;
 *   • the balance is INVARIANT UNDER PROVIDER METADATA (`09` §11's "provider
 *     can be swapped later", reduced to a testable statement);
 *   • a recomputation under a new rule version leaves the OLD version's entries
 *     readable and still reconstructing the OLD balance, per type.
 *
 * NOTHING HERE MOVES MONEY. The builder REFUSES to record a settlement.
 *
 * Run: node --import tsx/esm --test src/test/creatorTypeLedgerProperties.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CREATOR_TYPES, creatorTypeFacts, typesWithoutValueEventProducer } from "../lib/creatorTypes.js";
import { buildAttribution, type CreatorAttribution } from "../lib/creatorTypeAttribution.js";
import {
  CREATOR_LEDGER_ACCOUNTS,
  buildCreatorEarningEntries,
  buildCreatorReversal,
  creatorEntriesAtRuleVersion,
  historicalCreatorBalanceAt,
  recomputeCreatorUnderRuleVersion,
  reconstructCreatorBalances,
  unbalancedCreatorTransactions,
  type CreatorLedgerEntry,
} from "../lib/creatorLedgerEntries.js";

// A seeded xorshift: a property test that depends on Math.random is a flake
// generator, and a failure must be reproducible from the seed in the message.
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i++) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) out.push([xs[i], ...p]);
  }
  return out;
}

const B = "11111111-1111-4111-8111-111111111111";

/** An earnable attribution for one of the two types that have a producer. */
function earnableAttribution(t: "local_expert" | "travel_partner", subject = "s-1"): CreatorAttribution {
  const r = buildAttribution({
    creatorType: t,
    subjectId: subject,
    valueEventId: `evt-${subject}`,
    beneficiaryUserId: B,
    ruleVersion: creatorTypeFacts(t).defaultRuleVersion,
    weight: 1, confidence: 1,
    grossRevenueMinor: 0, provisionalShareMinor: 0,
    fraudHold: false, fraudHoldReason: null,
  });
  assert.equal(r.status, "built");
  if (r.status !== "built") throw new Error("unreachable");
  return r.attribution;
}

const earn = (a: CreatorAttribution, over: Partial<Parameters<typeof buildCreatorEarningEntries>[1]> = {}) =>
  buildCreatorEarningEntries(a, {
    grossRevenueMinor: 10_000,
    creatorShareMinor: 8_000,
    platformFeeMinor: 2_000,
    revenueSource: "booking_commission",
    ...over,
  });

function built(r: ReturnType<typeof buildCreatorEarningEntries>): CreatorLedgerEntry[] {
  assert.equal(r.status, "built", JSON.stringify(r));
  if (r.status !== "built") throw new Error("unreachable");
  return r.entries;
}

// ═══════════════════════════════════════════════════════════════════════════
describe("`07` §10 property 2 — earnings are recordable WITHOUT PAYING", () => {
  it("a settlement is REFUSED outright, for every type that could earn", () => {
    for (const t of ["local_expert", "travel_partner"] as const) {
      const r = earn(earnableAttribution(t), { settledMinor: 1 });
      assert.equal(r.status, "refused", `${t} accepted a settlement`);
      if (r.status === "refused") assert.equal(r.reason, "settlement_not_recordable");
    }
  });

  it("no built entry carries a settlement, and no account is a wallet", () => {
    const entries = built(earn(earnableAttribution("travel_partner")));
    assert.ok(entries.length > 0);
    for (const e of entries) {
      assert.equal(e.cashSettledMinor, 0);
      assert.ok(CREATOR_LEDGER_ACCOUNTS.includes(e.account));
      assert.ok(
        !/wallet|balance|payout|disburse/i.test(e.account),
        `account ${e.account} names a money-moving concept`,
      );
    }
  });

  it("every transaction sums to zero per currency — a one-sided booking is inexpressible", () => {
    for (const t of ["local_expert", "travel_partner"] as const) {
      const entries = built(earn(earnableAttribution(t)));
      assert.deepEqual(unbalancedCreatorTransactions(entries), [], t);
    }
  });

  // FOUND BY MUTATION. Deleting `share_exceeds_gross` from
  // buildCreatorEarningEntries left all ten suites GREEN: every fixture happened
  // to split the gross exactly, so nothing distinguished a ledger that checks
  // the split from one that does not. A ledger that will distribute more than
  // the conversion produced is how a ledger invents money — the defect `09`
  // §1.3.1 names — so the arm is now quantified rather than assumed.
  it("distributing MORE than the gross is REFUSED, by any margin", () => {
    for (const over of [
      { grossRevenueMinor: 1000, creatorShareMinor: 1001, platformFeeMinor: 0 },
      { grossRevenueMinor: 1000, creatorShareMinor: 0, platformFeeMinor: 1001 },
      { grossRevenueMinor: 1000, creatorShareMinor: 600, platformFeeMinor: 401 },
      { grossRevenueMinor: 0, creatorShareMinor: 1, platformFeeMinor: 0 },
    ]) {
      for (const t of ["local_expert", "travel_partner"] as const) {
        const r = earn(earnableAttribution(t), over);
        assert.equal(r.status, "refused", `${t} accepted ${JSON.stringify(over)}`);
        if (r.status === "refused") assert.equal(r.reason, "share_exceeds_gross");
      }
    }
  });

  it("splitting the gross EXACTLY, or leaving a remainder, is accepted", () => {
    for (const ok of [
      { grossRevenueMinor: 1000, creatorShareMinor: 800, platformFeeMinor: 200 },
      { grossRevenueMinor: 1000, creatorShareMinor: 500, platformFeeMinor: 100 }, // remainder is not the creator's
      { grossRevenueMinor: 0, creatorShareMinor: 0, platformFeeMinor: 0 },
    ]) {
      const r = earn(earnableAttribution("travel_partner"), ok);
      assert.equal(r.status, "built", `${JSON.stringify(ok)}: ${JSON.stringify(r)}`);
    }
  });

  it("a non-integer or negative component is REFUSED — minor units are integers", () => {
    for (const bad of [
      { creatorShareMinor: -1 }, { platformFeeMinor: -1 }, { grossRevenueMinor: -1 },
      { grossRevenueMinor: 100.5, creatorShareMinor: 100, platformFeeMinor: 0 },
      { grossRevenueMinor: 100, creatorShareMinor: 99.5, platformFeeMinor: 0 },
      { grossRevenueMinor: Number.NaN, creatorShareMinor: 0, platformFeeMinor: 0 },
    ]) {
      const r = earn(earnableAttribution("travel_partner"), bad);
      assert.equal(r.status, "refused", JSON.stringify(bad));
      if (r.status === "refused") assert.equal(r.reason, "negative_input");
    }
  });

  it("an unknown revenue source is REFUSED rather than written as free text", () => {
    const r = earn(earnableAttribution("travel_partner"), { revenueSource: "vibes" as any });
    assert.equal(r.status, "refused");
    if (r.status === "refused") assert.equal(r.reason, "unknown_revenue_source");
  });

  it("a zero component books NO entry rather than a noise row", () => {
    const entries = built(earn(earnableAttribution("travel_partner"), { platformFeeMinor: 0 }));
    assert.equal(entries.filter((e) => e.entryReason === "platform_fee").length, 0);
    assert.ok(entries.every((e) => e.amountMinor !== 0));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the seam refusal, per type — no producer, no earning", () => {
  it("every producerless type is REFUSED an earning", () => {
    for (const t of typesWithoutValueEventProducer()) {
      const a = buildAttribution({
        creatorType: t, subjectId: "s", valueEventId: null, beneficiaryUserId: B,
        ruleVersion: creatorTypeFacts(t).defaultRuleVersion,
        weight: 0, confidence: 0, grossRevenueMinor: 0, provisionalShareMinor: 0,
        fraudHold: false, fraudHoldReason: null,
      });
      assert.equal(a.status, "built");
      if (a.status !== "built") continue;
      const r = earn(a.attribution);
      assert.equal(r.status, "refused", `${t} minted an earning with no value event`);
      if (r.status === "refused") assert.equal(r.reason, "not_earnable");
    }
  });

  it("a FRAUD HELD attribution is refused an earning, for every type that could earn", () => {
    for (const t of ["local_expert", "travel_partner"] as const) {
      const a = buildAttribution({
        creatorType: t, subjectId: "s", valueEventId: "e", beneficiaryUserId: B,
        ruleVersion: creatorTypeFacts(t).defaultRuleVersion,
        weight: 1, confidence: 1, grossRevenueMinor: 0, provisionalShareMinor: 0,
        fraudHold: true, fraudHoldReason: "collusive_group",
      });
      assert.equal(a.status, "built");
      if (a.status !== "built") continue;
      const r = earn(a.attribution);
      assert.equal(r.status, "refused", `${t} earned under a fraud hold`);
      if (r.status === "refused") assert.equal(r.reason, "fraud_hold");
    }
  });

  it("the refusal covers every one of the six — nothing is silently earnable", () => {
    const refusedTypes = new Set<string>();
    for (const t of CREATOR_TYPES) {
      const f = creatorTypeFacts(t);
      const a = buildAttribution({
        creatorType: t, subjectId: "s", valueEventId: f.valueEventProducer ? "e" : null,
        beneficiaryUserId: B, ruleVersion: f.defaultRuleVersion,
        weight: f.valueEventProducer ? 1 : 0, confidence: f.valueEventProducer ? 1 : 0,
        grossRevenueMinor: 0, provisionalShareMinor: 0, fraudHold: false, fraudHoldReason: null,
      });
      assert.equal(a.status, "built", t);
      if (a.status !== "built") continue;
      if (earn(a.attribution).status === "refused") refusedTypes.add(t);
    }
    assert.deepEqual([...refusedTypes].sort(), [...typesWithoutValueEventProducer()].sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("reconstruction is a FOLD — never a stored total (`09` §11)", () => {
  it("the balance is independent of order, over EVERY permutation of one earning", () => {
    const entries = built(earn(earnableAttribution("travel_partner")));
    const expected = reconstructCreatorBalances(entries);
    for (const p of permutations(entries)) {
      assert.deepEqual(reconstructCreatorBalances(p), expected);
    }
  });

  it("…and over a seeded shuffle of a ledger spanning both earning types", () => {
    const all = [
      ...built(earn(earnableAttribution("travel_partner", "a"))),
      ...built(earn(earnableAttribution("local_expert", "b"), { grossRevenueMinor: 333, creatorShareMinor: 333, platformFeeMinor: 0 })),
      ...built(earn(earnableAttribution("travel_partner", "c"), { grossRevenueMinor: 1, creatorShareMinor: 1, platformFeeMinor: 0 })),
    ];
    const expected = reconstructCreatorBalances(all);
    for (const seed of [1, 7, 99, 12345, 0xdeadbeef]) {
      assert.deepEqual(
        reconstructCreatorBalances(shuffled(all, seed)), expected,
        `order dependence at seed ${seed}`,
      );
    }
  });

  it("the balance is INVARIANT UNDER PROVIDER METADATA — a processor can be swapped later", () => {
    const entries = built(earn(earnableAttribution("travel_partner")));
    const rebadged = entries.map((e) => ({ ...e, provider: "some-psp", externalRef: "pi_123" }));
    assert.deepEqual(reconstructCreatorBalances(rebadged), reconstructCreatorBalances(entries));
  });

  it("every account of the vocabulary appears in the fold, even at zero", () => {
    const b = reconstructCreatorBalances([]);
    assert.deepEqual(Object.keys(b).sort(), [...CREATOR_LEDGER_ACCOUNTS].sort());
    assert.ok(Object.values(b).every((v) => v === 0));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("reversals are possible, and at most once (`09` §11)", () => {
  // An earning is more than one TRANSACTION — the creator's share and the
  // platform's fee are booked separately, exactly as buildBookingEntries does
  // above. Reversing one of them therefore MUST NOT zero the ledger, and the
  // first version of this test asserted that it would. Both halves are pinned
  // here: the partial reversal leaves precisely the other transaction standing,
  // and reversing every transaction nets to zero in any order.
  it("reversing ONE transaction of an earning leaves the others standing", () => {
    const entries = built(earn(earnableAttribution("local_expert")));
    const keys = [...new Set(entries.map((e) => e.transactionKey))];
    assert.ok(keys.length > 1, "fixture assumes an earning spans more than one transaction");
    const rev = buildCreatorReversal(entries, { transactionKey: keys[0] });
    assert.equal(rev.status, "reversed");
    if (rev.status !== "reversed") return;
    const after = reconstructCreatorBalances([...entries, ...rev.entries]);
    const remaining = reconstructCreatorBalances(entries.filter((e) => e.transactionKey !== keys[0]));
    assert.deepEqual(after, remaining, "a partial reversal moved something it did not name");
  });

  it("reversing EVERY transaction nets the balance back, wherever the reversals are appended", () => {
    for (const t of ["local_expert", "travel_partner"] as const) {
      const entries = built(earn(earnableAttribution(t)));
      const reversals: CreatorLedgerEntry[] = [];
      for (const key of new Set(entries.map((e) => e.transactionKey))) {
        const rev = buildCreatorReversal(entries, { transactionKey: key });
        assert.equal(rev.status, "reversed", JSON.stringify(rev));
        if (rev.status === "reversed") reversals.push(...rev.entries);
      }
      const after = [...entries, ...reversals];
      for (const seed of [3, 42, 777]) {
        const b = reconstructCreatorBalances(shuffled(after, seed));
        assert.ok(Object.values(b).every((v) => v === 0), `${t}: seed ${seed} left ${JSON.stringify(b)}`);
      }
    }
  });

  it("reversing twice is REFUSED — that re-credits an earning that existed once", () => {
    const entries = built(earn(earnableAttribution("travel_partner")));
    const key = entries[0].transactionKey;
    const first = buildCreatorReversal(entries, { transactionKey: key });
    assert.equal(first.status, "reversed");
    if (first.status !== "reversed") return;
    const second = buildCreatorReversal([...entries, ...first.entries], { transactionKey: key });
    assert.equal(second.status, "refused");
    if (second.status === "refused") assert.equal(second.reason, "already_reversed");
  });

  it("a reversal carries the rule version of what it reverses, not today's", () => {
    const entries = built(earn(earnableAttribution("travel_partner")));
    const rev = buildCreatorReversal(entries, { transactionKey: entries[0].transactionKey });
    assert.equal(rev.status, "reversed");
    if (rev.status !== "reversed") return;
    for (const r of rev.entries) {
      const original = entries.find((e) => e.entryId === r.reversesEntryId);
      assert.ok(original);
      assert.equal(r.ruleVersion, original!.ruleVersion);
      assert.equal(r.creatorType, original!.creatorType);
    }
  });

  it("reversing an unknown transaction is refused rather than silently no-op", () => {
    const r = buildCreatorReversal([], { transactionKey: "nope" });
    assert.equal(r.status, "refused");
    if (r.status === "refused") assert.equal(r.reason, "unknown_transaction");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("`07` §10 property 5 — historical recalculation, per creator type", () => {
  it("the old version's balance stays readable after a recomputation, for each earning type", () => {
    for (const t of ["local_expert", "travel_partner"] as const) {
      const a = earnableAttribution(t);
      const v1 = built(earn(a));
      const v1Balance = historicalCreatorBalanceAt(v1, a.ruleVersion);

      const v2Version = a.ruleVersion.replace(/v\d+$/, "v2");
      const re = recomputeCreatorUnderRuleVersion(v1, {
        attributionId: a.id,
        ruleVersion: v2Version,
        next: { grossRevenueMinor: 20_000, creatorShareMinor: 16_000, platformFeeMinor: 4_000,
                revenueSource: "booking_commission" },
      });
      assert.equal(re.status, "recomputed", `${t}: ${JSON.stringify(re)}`);
      if (re.status !== "recomputed") continue;

      const all = [...v1, ...re.entries];
      // THE OLD ANSWER IS UNCHANGED. This is the property.
      assert.deepEqual(historicalCreatorBalanceAt(all, a.ruleVersion), v1Balance, t);
      // …and the old entries are all still there, unmodified.
      assert.equal(
        creatorEntriesAtRuleVersion(all, a.ruleVersion).filter((e) => e.entryReason !== "reversal").length,
        v1.length, t,
      );
      // …while the CURRENT fold reflects only the new version.
      const current = reconstructCreatorBalances(all);
      assert.equal(current.creator_payable, 16_000, t);
      assert.equal(current.platform_revenue, 4_000, t);
      assert.deepEqual(unbalancedCreatorTransactions(all), [], t);
    }
  });

  it("recomputing under the SAME version is refused — nothing was recomputed", () => {
    const a = earnableAttribution("travel_partner");
    const v1 = built(earn(a));
    const r = recomputeCreatorUnderRuleVersion(v1, {
      attributionId: a.id, ruleVersion: a.ruleVersion,
      next: { grossRevenueMinor: 1, creatorShareMinor: 1, platformFeeMinor: 0 },
    });
    assert.equal(r.status, "refused");
    if (r.status === "refused") assert.equal(r.reason, "same_rule_version");
  });

  it("recomputing an attribution with no entries is refused", () => {
    const r = recomputeCreatorUnderRuleVersion([], {
      attributionId: "nothing", ruleVersion: "creator-rules/travel-partner/v2",
      next: { grossRevenueMinor: 1, creatorShareMinor: 1, platformFeeMinor: 0 },
    });
    assert.equal(r.status, "refused");
    if (r.status === "refused") assert.equal(r.reason, "nothing_to_recompute");
  });

  it("entries carry the creator type, so a per-type recomputation needs no join", () => {
    const mixed = [
      ...built(earn(earnableAttribution("travel_partner", "x"))),
      ...built(earn(earnableAttribution("local_expert", "y"))),
    ];
    assert.equal(new Set(mixed.map((e) => e.creatorType)).size, 2);
    assert.equal(mixed.filter((e) => e.creatorType === "local_expert").length, mixed.length / 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the existing booking path is untouched by the widening", () => {
  it("a creator entry and a booking entry never share an idempotency key space", async () => {
    const { buildBookingEntries } = await import("../lib/creatorLedgerEntries.js");
    const booking = buildBookingEntries({
      bookingId: "b-1", beneficiaryUserId: B, ruleVersion: "rent-buddy-fee-schedule/v1",
      totalUsd: 100, tipUsd: 0, platformFeeUsd: 10, travelerServiceFeeUsd: 5,
    });
    assert.equal(booking.status, "built");
    if (booking.status !== "built") return;
    const creator = built(earn(earnableAttribution("travel_partner")));
    const bookingKeys = new Set(booking.entries.map((e) => e.idempotencyKey));
    for (const e of creator) {
      assert.ok(!bookingKeys.has(e.idempotencyKey), `collision on ${e.idempotencyKey}`);
    }
  });
});
