/**
 * creatorLedgerEntries — the ten acceptance properties, as properties.
 *
 * ── WHAT THIS PINS, AND WHY IT IS A PROPERTY TEST ───────────────────────────
 * `07` §10 and `09` §11 set a PRE-MONEY bar: "earnings can be recorded without
 * paying" and "payment architecture is ready BEFORE PAYOUTS when every earning
 * can be reconstructed, no balance depends on mutable totals, attribution is
 * linked, reversals are possible, provider can be swapped later."
 *
 * Each of those is a statement about EVERY entry sequence, not about one
 * fixture. A single example can be satisfied by a correct-looking accident —
 * `rent_buddy_earnings_ledger`'s one mutable summary row per booking passes any
 * single-booking fixture you write for it and still cannot express a reversal,
 * a recalculation, or a second booking. So these are quantified:
 *
 *   • reconstruction is INDEPENDENT OF ORDER  — over every permutation of a
 *     small ledger, and over a shuffled large one;
 *   • every transaction SUMS TO ZERO per currency (the invariant that makes a
 *     fictitious collection impossible: it has no counterpart to book);
 *   • a reversal NETS THE BALANCE BACK, wherever it is appended;
 *   • the balance is INVARIANT UNDER PROVIDER METADATA — the property that
 *     means a processor can be swapped later without rewriting history;
 *   • a recomputation under a new rule version leaves the OLD version's
 *     entries readable and still reconstructing the OLD balance.
 *
 * NOTHING HERE MOVES MONEY. `buildBookingEntries` REFUSES to record a
 * collection at all — the code-side twin of `2170:40`'s
 * `CHECK (cash_amount = 0)`.
 *
 * Run: node --import tsx/esm --test src/test/creatorLedgerProperties.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  balanceOf,
  buildBookingEntries,
  buildReversal,
  entriesAtRuleVersion,
  historicalBalanceAt,
  recomputeUnderRuleVersion,
  reconstructBalances,
  toMinor,
  unbalancedTransactions,
  type LedgerEntry,
} from "../lib/creatorLedgerEntries.js";

// ── A deterministic shuffler. A property test that depends on Math.random is a
// flake generator; this is a seeded xorshift so a failure is reproducible from
// the seed printed in the assertion message.
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
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
    const rest = xs.slice(0, i).concat(xs.slice(i + 1));
    for (const p of permutations(rest)) out.push([xs[i], ...p]);
  }
  return out;
}

const BOOKING = {
  bookingId: "00000000-0000-4000-8000-000000000001",
  beneficiaryUserId: "00000000-0000-4000-8000-0000000000b1",
  ruleVersion: "rb-fee-schedule/v1",
  totalUsd: 100,
  tipUsd: 10,
  platformFeeUsd: 15,
  travelerServiceFeeUsd: 3,
};

function built(overrides: Partial<typeof BOOKING> = {}): LedgerEntry[] {
  const r = buildBookingEntries({ ...BOOKING, ...overrides });
  assert.equal(r.status, "built", `expected built, got ${JSON.stringify(r)}`);
  return (r as { status: "built"; entries: LedgerEntry[] }).entries;
}

// ═══════════════════════════════════════════════════════════════════════════
// P-A · "every earning can be reconstructed" + "no balance depends on mutable
//        totals" (`09` §11) — reconstruction is a pure function of the entries
//        and is INDEPENDENT OF THE ORDER they arrive in.
// ═══════════════════════════════════════════════════════════════════════════
describe("reconstruction is order-independent", () => {
  it("holds over EVERY permutation of one booking's entries", () => {
    const entries = built();
    const expected = reconstructBalances(entries);
    const perms = permutations(entries);
    assert.ok(perms.length >= 24, `too few permutations (${perms.length}) — the quantifier is vacuous`);
    for (const p of perms) {
      assert.deepEqual(
        reconstructBalances(p), expected,
        "a balance that depends on entry order is a balance that depends on a mutable total",
      );
    }
  });

  it("holds over 200 shuffles of a multi-booking, multi-beneficiary ledger", () => {
    const ledger: LedgerEntry[] = [];
    for (let i = 1; i <= 12; i++) {
      ledger.push(...built({
        bookingId: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
        beneficiaryUserId: `00000000-0000-4000-8000-0000000000b${i % 3}`,
        totalUsd: 40 + i * 7.35,
        tipUsd: i % 4 === 0 ? 0 : i * 1.05,
        platformFeeUsd: (40 + i * 7.35) * 0.22,
        travelerServiceFeeUsd: i % 2 ? 0 : 2.5,
      }));
    }
    const expected = reconstructBalances(ledger);
    for (let seed = 1; seed <= 200; seed++) {
      assert.deepEqual(
        reconstructBalances(shuffled(ledger, seed)), expected,
        `order dependence surfaced at seed ${seed}`,
      );
    }
  });

  it("is exact in minor units — no float drift across 500 thirds-of-a-cent bookings", () => {
    const ledger: LedgerEntry[] = [];
    for (let i = 0; i < 500; i++) {
      ledger.push(...built({
        bookingId: `00000000-0000-4000-8000-0000000${String(20000 + i)}`,
        totalUsd: 33.33, tipUsd: 0.01, platformFeeUsd: 11.11, travelerServiceFeeUsd: 0,
      }));
    }
    // 500 × (3333 + 1 − 1111) cents, computed as integers, never as 0.1+0.2.
    assert.equal(balanceOf(ledger, "buddy_payable"), 500 * (3333 + 1 - 1111));
    assert.equal(balanceOf(ledger, "platform_revenue"), 500 * 1111);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P-B · double entry — every transaction sums to zero per currency. This is
//        what makes `09` §1.3.1 ("it records money as collected that was never
//        collected") structurally impossible: a collection has no counterpart.
// ═══════════════════════════════════════════════════════════════════════════
describe("every transaction sums to zero per currency", () => {
  it("holds for a built booking", () => {
    assert.deepEqual(unbalancedTransactions(built()), []);
  });

  it("holds for 300 randomised bookings", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const total = Math.round((5 + (seed * 37) % 950) * 100) / 100;
      const entries = built({
        bookingId: `00000000-0000-4000-8000-0000000${String(30000 + seed)}`,
        totalUsd: total,
        tipUsd: Math.round(((seed * 13) % 50) * 100) / 100,
        platformFeeUsd: Math.round(total * ((seed % 5) * 3 + 12)) / 100,
        travelerServiceFeeUsd: (seed % 3) * 1.75,
      });
      assert.deepEqual(unbalancedTransactions(entries), [], `unbalanced at seed ${seed}`);
    }
  });

  it("DETECTS an unbalanced transaction rather than silently summing it", () => {
    const entries = built();
    const tampered = entries.map((e, i) => (i === 0 ? { ...e, amountMinor: e.amountMinor + 1 } : e));
    const bad = unbalancedTransactions(tampered);
    assert.equal(bad.length, 1, "a one-cent hole must be visible");
    assert.equal(bad[0].residualMinor, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P-C · "reversals are possible" (`09` §11). A reversal is a NEW, opposite
//        entry set — never an edit — and it nets the balance back wherever it
//        is appended.
// ═══════════════════════════════════════════════════════════════════════════
describe("reversals", () => {
  const feeTxn = (entries: LedgerEntry[]) =>
    entries.find((e) => e.entryReason === "platform_fee")!.transactionKey;

  it("nets the reversed transaction's effect to zero", () => {
    const entries = built();
    const before = reconstructBalances(entries);
    const r = buildReversal(entries, { transactionKey: feeTxn(entries) });
    assert.equal(r.status, "reversed", JSON.stringify(r));
    const after = reconstructBalances([...entries, ...(r as any).entries]);

    // The fee transaction moved 1500 minor from buddy_payable to
    // platform_revenue. After reversal both sides are back where they were.
    assert.equal(after.platform_revenue, before.platform_revenue - 1500);
    assert.equal(after.buddy_payable, before.buddy_payable + 1500);
  });

  it("nets identically NO MATTER WHERE the reversal entries are interleaved", () => {
    const entries = built();
    const r = buildReversal(entries, { transactionKey: feeTxn(entries) });
    const rev = (r as any).entries as LedgerEntry[];
    const expected = reconstructBalances([...entries, ...rev]);
    for (let seed = 1; seed <= 100; seed++) {
      assert.deepEqual(reconstructBalances(shuffled([...entries, ...rev], seed)), expected,
        `reversal placement changed the balance at seed ${seed}`);
    }
  });

  it("is itself balanced — a reversal cannot create a hole", () => {
    const entries = built();
    const r = buildReversal(entries, { transactionKey: feeTxn(entries) });
    assert.deepEqual(unbalancedTransactions([...entries, ...(r as any).entries]), []);
  });

  it("LINKS each reversing entry to the exact entry it reverses", () => {
    const entries = built();
    const key = feeTxn(entries);
    const originals = entries.filter((e) => e.transactionKey === key);
    const rev = (buildReversal(entries, { transactionKey: key }) as any).entries as LedgerEntry[];
    assert.equal(rev.length, originals.length);
    assert.deepEqual(
      rev.map((e) => e.reversesEntryId).sort(),
      originals.map((e) => e.entryId).sort(),
      "an unlinked reversal is an unexplained entry",
    );
    for (const e of rev) assert.equal(e.entryReason, "reversal");
  });

  it("REFUSES a second reversal of the same transaction", () => {
    const entries = built();
    const key = feeTxn(entries);
    const first = (buildReversal(entries, { transactionKey: key }) as any).entries as LedgerEntry[];
    const second = buildReversal([...entries, ...first], { transactionKey: key });
    assert.equal(second.status, "refused");
    assert.equal((second as any).reason, "already_reversed",
      "double-reversing is how a ledger invents money");
  });

  it("REFUSES to reverse a transaction that is not in the ledger", () => {
    const r = buildReversal(built(), { transactionKey: "no-such-transaction" });
    assert.equal(r.status, "refused");
    assert.equal((r as any).reason, "unknown_transaction");
  });

  it("carries the reversed entry's rule version, not today's", () => {
    const entries = built();
    const key = feeTxn(entries);
    const rev = (buildReversal(entries, { transactionKey: key }) as any).entries as LedgerEntry[];
    for (const e of rev) assert.equal(e.ruleVersion, BOOKING.ruleVersion);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P-D · "earnings can be recorded without paying" (`07` §10). The builder
//        REFUSES to record a collection. There is no shape of input that
//        produces a "money arrived" entry.
// ═══════════════════════════════════════════════════════════════════════════
describe("the pre-money boundary", () => {
  it("REFUSES an input that claims money was collected", () => {
    const r = buildBookingEntries({ ...BOOKING, collectedMinor: 2000 });
    assert.equal(r.status, "refused");
    assert.equal((r as any).reason, "collection_not_recordable",
      "`09` §1: Portava moves no money — a collection has no funding source to book against");
  });

  it("accepts an explicit zero collection (the honest statement of the same fact)", () => {
    assert.equal(buildBookingEntries({ ...BOOKING, collectedMinor: 0 }).status, "built");
  });

  it("emits no entry whose reason asserts settlement", () => {
    const reasons = new Set(built().map((e) => e.entryReason));
    for (const forbidden of ["collection", "capture", "payout", "settlement"]) {
      assert.ok(!reasons.has(forbidden as any), `entry reason ${forbidden} would claim money moved`);
    }
  });

  it("REFUSES negative inputs rather than booking a negative earning", () => {
    for (const bad of [{ totalUsd: -1 }, { tipUsd: -0.01 }, { platformFeeUsd: -5 }, { travelerServiceFeeUsd: -2 }]) {
      const r = buildBookingEntries({ ...BOOKING, ...bad });
      assert.equal(r.status, "refused", `accepted ${JSON.stringify(bad)}`);
      assert.equal((r as any).reason, "negative_input");
    }
  });

  it("REFUSES an entry with no cause — absence of attribution is never silent", () => {
    for (const bad of [{ bookingId: "" }, { beneficiaryUserId: "" }]) {
      const r = buildBookingEntries({ ...BOOKING, ...bad });
      assert.equal(r.status, "refused", `accepted ${JSON.stringify(bad)}`);
      assert.equal((r as any).reason, "missing_attribution",
        "`09` §5.3 I7: a transaction with no attribution is not permitted to be silent");
    }
  });

  it("REFUSES an unversioned entry — it could never be recomputed", () => {
    const r = buildBookingEntries({ ...BOOKING, ruleVersion: "" });
    assert.equal(r.status, "refused");
    assert.equal((r as any).reason, "missing_rule_version");
  });

  it("omits zero-amount entries entirely — no entry may be worth nothing", () => {
    const entries = built({ tipUsd: 0, travelerServiceFeeUsd: 0 });
    assert.ok(entries.every((e) => e.amountMinor !== 0));
    assert.ok(!entries.some((e) => e.entryReason === "tip"));
    assert.ok(!entries.some((e) => e.entryReason === "traveler_service_fee"));
    assert.deepEqual(unbalancedTransactions(entries), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P-E · "attribution is linked" (`09` §11) / "value can be attributed" (`07`
//        §10). Every entry names its cause and its beneficiary at write time.
// ═══════════════════════════════════════════════════════════════════════════
describe("attribution", () => {
  it("stamps cause and rule version on EVERY entry, including reversals", () => {
    const entries = built();
    const rev = (buildReversal(entries, {
      transactionKey: entries.find((e) => e.entryReason === "platform_fee")!.transactionKey,
    }) as any).entries as LedgerEntry[];
    for (const e of [...entries, ...rev]) {
      assert.equal(e.attributionKind, "booking");
      assert.equal(e.attributionId, BOOKING.bookingId);
      assert.ok(e.ruleVersion.length > 0, "an entry with no rule version cannot be recomputed");
      assert.ok(e.idempotencyKey.length > 0, "an entry with no idempotency key is not replay-safe");
    }
  });

  it("names the beneficiary on the entries that credit one, and only those", () => {
    for (const e of built()) {
      if (e.account === "buddy_payable") assert.equal(e.beneficiaryUserId, BOOKING.beneficiaryUserId);
      else assert.equal(e.beneficiaryUserId, null);
    }
  });

  it("derives idempotency from the EVENT, not the attempt — two builds agree", () => {
    const a = built(), b = built();
    assert.deepEqual(a.map((e) => e.idempotencyKey), b.map((e) => e.idempotencyKey));
    assert.equal(new Set(a.map((e) => e.idempotencyKey)).size, a.length, "keys must be unique per entry");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P-F · "provider can be swapped later" (`09` §11). No balance reads provider
//        metadata; changing it changes nothing that is derived.
// ═══════════════════════════════════════════════════════════════════════════
describe("provider independence", () => {
  it("ships provider 'none' — no processor is installed (`09` §1.1)", () => {
    for (const e of built()) {
      assert.equal(e.provider, "none");
      assert.equal(e.externalRef, null);
    }
  });

  it("reconstructs the SAME balance after provider metadata is rewritten", () => {
    const entries = built();
    const expected = reconstructBalances(entries);
    for (const provider of ["stripe", "adyen", "wise", "none", ""]) {
      const restamped = entries.map((e, i) => ({ ...e, provider, externalRef: `${provider}-ref-${i}` }));
      assert.deepEqual(reconstructBalances(restamped), expected,
        `balance moved when provider became ${provider} — the ledger depends on the processor`);
      assert.deepEqual(unbalancedTransactions(restamped), []);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P-G · "historical recalculation is possible" / "rules are versioned"
//        (`07` §10). A new rule version is a REVERSAL plus new entries; the old
//        version's entries stay readable and still reconstruct the old balance.
// ═══════════════════════════════════════════════════════════════════════════
describe("historical recalculation", () => {
  it("leaves the old rule version intact and still reconstructible", () => {
    const v1 = built();
    const v1Balance = reconstructBalances(v1);

    const r = recomputeUnderRuleVersion(v1, {
      attributionId: BOOKING.bookingId,
      ruleVersion: "rb-fee-schedule/v2",
      next: { ...BOOKING, ruleVersion: "rb-fee-schedule/v2", platformFeeUsd: 25 },
    });
    assert.equal(r.status, "recomputed", JSON.stringify(r));
    const all = [...v1, ...(r as any).entries];

    // The v1 rows are still PHYSICALLY THERE and byte-identical: a
    // recomputation appends, it never edits.
    assert.deepEqual(entriesAtRuleVersion(all, "rb-fee-schedule/v1").filter(
      (e) => e.entryReason !== "reversal"), v1);

    // And the historical question — "what did the ledger say under v1?" — is
    // still answerable, which is the whole of `07` §10's last criterion.
    assert.deepEqual(historicalBalanceAt(all, "rb-fee-schedule/v1"), v1Balance);

    // The live balance is the v2 answer: 100 + 10 − 25 = 85.00.
    assert.equal(balanceOf(all, "buddy_payable"), toMinor(85));
    assert.equal(balanceOf(all, "platform_revenue"), toMinor(25 + 3));
    assert.deepEqual(unbalancedTransactions(all), []);
  });

  it("REFUSES to recompute under the version already in force", () => {
    const v1 = built();
    const r = recomputeUnderRuleVersion(v1, {
      attributionId: BOOKING.bookingId,
      ruleVersion: BOOKING.ruleVersion,
      next: BOOKING,
    });
    assert.equal(r.status, "refused");
    assert.equal((r as any).reason, "same_rule_version",
      "a recomputation that is not versioned is an untraceable rewrite");
  });

  it("REFUSES to recompute a booking that has no entries", () => {
    const r = recomputeUnderRuleVersion(built(), {
      attributionId: "00000000-0000-4000-8000-00000000ffff",
      ruleVersion: "rb-fee-schedule/v2",
      next: BOOKING,
    });
    assert.equal(r.status, "refused");
    assert.equal((r as any).reason, "nothing_to_recompute");
  });
});
