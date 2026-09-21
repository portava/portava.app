/**
 * creator_share_ledger — "creator share can be computed from the same ledger"
 * (`08` §7), as properties rather than as one fixture.
 *
 * ── WHAT IS BEING PINNED ────────────────────────────────────────────────────
 * DV-64 is `08` §7's last acceptance bullet. Before migration 2930 there was no
 * "the same ledger" to compute from: earnings live in `intel_reward_ledger`
 * (2170 + 2900 — contributors, NON-CASH, `qiu` numeric + `earned_units`
 * integer, single-sided) and in `rent_buddy_earnings_entries` (2901 —
 * marketplace, DOUBLE ENTRY, signed `amount_minor` + `currency`). 2930 adds a
 * canonical VIEW over both, and this file pins the two things a view like that
 * can get wrong.
 *
 * THE FIRST IS THE ONE THIS CRITERION EXISTS TO PREVENT. A share that depends
 * on the order entries arrive in is a share that depends on a mutable total, so
 * every fold here is quantified over EVERY permutation of a small ledger and
 * over many shuffles of a large one. Note that order-independence is NOT free
 * in floating point: `qiu` is a fractional `numeric`, and summing doubles in
 * different orders genuinely gives different answers. The module accumulates
 * qiu in scaled integers for exactly that reason, and the adversarial fixture
 * below (0.1 + 0.2 class values) is chosen to fail if it ever stops.
 *
 * THE SECOND IS THE UNIT PROBLEM. qiu, non-cash credits and currency minor
 * units are not commensurable, and no rate between them exists anywhere in this
 * repository — `fx_rates` holds ECB rates between CURRENCIES only
 * (docs/architecture/09_Payment_Architecture.md §2), and 2170's header is
 * "Stamps/credits; no cash". `lib/rewardEarnings.ts` QIU_TO_CREDITS = 100 looks
 * like a rate and is not usable as one here: both figures are already recorded
 * on every reward row, so applying it would restate one earning twice. The
 * standing rule is the one §8 of that document states for a missing FX rate —
 * *"NEVER FABRICATE … a missing rate is a REFUSAL TO BOOK, not a guess"* — so
 * the properties below assert that NO total ever spans two units, that the unit
 * is a grouping key rather than a label, and that scaling one unit's amounts
 * leaves every other unit's answer untouched.
 *
 * NOTHING HERE MOVES MONEY, and the canonical surface cannot: `cash_recorded`
 * is the base tables' CHECK-zero columns, surfaced so a reader can assert the
 * boundary rather than assume it.
 *
 * Run: node --import tsx/esm --test src/test/creatorShareCanonicalProperties.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type CanonicalShareRow,
  type CreatorShare,
  creatorShares,
  projectEarningsEntryRow,
  projectRewardLedgerRow,
  reconcile,
  unitTotals,
} from "../lib/creatorShareCanonical.js";

// ── Deterministic shuffling. A property test seeded from Math.random is a flake
// generator; this is the seeded xorshift creatorLedgerProperties.test.ts uses,
// so a failure reproduces from the seed printed in the message.
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
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i++) {
    const rest = xs.slice(0, i).concat(xs.slice(i + 1));
    for (const p of permutations(rest)) out.push([xs[i]!, ...p]);
  }
  return out;
}

const CREATOR_A = "aaaaaaaa-1111-4111-8111-000000000001";
const CREATOR_B = "bbbbbbbb-2222-4222-8222-000000000002";
const BOOKING_1 = "cccccccc-3333-4333-8333-000000000001";
const BOOKING_2 = "cccccccc-3333-4333-8333-000000000002";

// ── Source rows, exactly as the base tables shape them ──────────────────────

let seq = 0;
const nextId = (tag: string) => `${tag}-${String(++seq).padStart(4, "0")}`;

function rewardRow(over: {
  actor_id: string; qiu: number; earned_units: number;
  reverses_entry_id?: string | null; id?: string;
}) {
  return {
    id: over.id ?? nextId("irl"),
    actor_id: over.actor_id,
    source: over.reverses_entry_id ? "reversal:contradicted" : "served",
    qiu: over.qiu,
    earned_units: over.earned_units,
    cash_amount: 0,
    ledger_version: "intel-reward/v1",
    reverses_entry_id: over.reverses_entry_id ?? null,
    created_at: "2026-09-14T00:00:00.000Z",
  };
}

function entryRow(over: {
  account: string; amount_minor: number; beneficiary_user_id: string | null;
  attribution_id: string; entry_reason?: string; currency?: string;
  reverses_entry_id?: string | null; id?: string;
}) {
  return {
    id: over.id ?? nextId("rbee"),
    account: over.account,
    entry_reason: over.entry_reason ?? "booking_gross",
    amount_minor: over.amount_minor,
    currency: over.currency ?? "USD",
    cash_settled_minor: 0,
    rule_version: "rent-buddy-fee-schedule/v1",
    attribution_kind: "booking",
    attribution_id: over.attribution_id,
    beneficiary_user_id: over.beneficiary_user_id,
    reverses_entry_id: over.reverses_entry_id ?? null,
    occurred_at: "2026-09-14T00:00:00.000Z",
  };
}

/**
 * One booking as `buildBookingEntries` books it: gross to the buddy, a platform
 * fee off the buddy, a traveller service fee to the platform. Six legs, two
 * parties, one attribution.
 */
function bookingEntries(opts: {
  bookingId: string; creatorId: string; grossMinor: number;
  feeMinor: number; travelerFeeMinor: number;
}): CanonicalShareRow[] {
  const rows = [
    entryRow({ account: "traveler_receivable", amount_minor: -opts.grossMinor, beneficiary_user_id: null, attribution_id: opts.bookingId }),
    entryRow({ account: "buddy_payable", amount_minor: opts.grossMinor, beneficiary_user_id: opts.creatorId, attribution_id: opts.bookingId }),
    entryRow({ account: "buddy_payable", amount_minor: -opts.feeMinor, beneficiary_user_id: opts.creatorId, attribution_id: opts.bookingId, entry_reason: "platform_fee" }),
    entryRow({ account: "platform_revenue", amount_minor: opts.feeMinor, beneficiary_user_id: null, attribution_id: opts.bookingId, entry_reason: "platform_fee" }),
    entryRow({ account: "traveler_receivable", amount_minor: -opts.travelerFeeMinor, beneficiary_user_id: null, attribution_id: opts.bookingId, entry_reason: "traveler_service_fee" }),
    entryRow({ account: "platform_revenue", amount_minor: opts.travelerFeeMinor, beneficiary_user_id: null, attribution_id: opts.bookingId, entry_reason: "traveler_service_fee" }),
  ];
  return rows.flatMap(projectEarningsEntryRow);
}

const shareKey = (s: CreatorShare) =>
  `${s.sourceLedger}|${s.creatorId}|${s.unitKind}|${s.unitCode}`;

const byKey = (shares: readonly CreatorShare[]) =>
  new Map(shares.map((s) => [shareKey(s), s]));

// ═══════════════════════════════════════════════════════════════════════════
// P-1 · The defect this criterion exists to prevent: a share that depends on
//       the order entries arrive in.
// ═══════════════════════════════════════════════════════════════════════════
describe("the share does not depend on entry order", () => {
  const small: CanonicalShareRow[] = [
    ...projectRewardLedgerRow(rewardRow({ actor_id: CREATOR_A, qiu: 0.8, earned_units: 80 })),
    ...projectRewardLedgerRow(rewardRow({ actor_id: CREATOR_A, qiu: 0.35, earned_units: 35 })),
    ...projectRewardLedgerRow(rewardRow({ actor_id: CREATOR_B, qiu: 1.25, earned_units: 125 })),
  ];

  it("holds over EVERY permutation of a small canonical ledger", () => {
    const expected = creatorShares(small);
    const perms = permutations(small);
    assert.ok(perms.length >= 720, `only ${perms.length} permutations — the quantifier is thin`);
    for (const p of perms) {
      assert.deepEqual(
        creatorShares(p), expected,
        "a share that depends on entry order is a share that depends on a mutable total",
      );
    }
  });

  it("holds over 200 shuffles of a mixed-ledger, mixed-unit ledger", () => {
    const rows: CanonicalShareRow[] = [];
    for (let i = 1; i <= 9; i++) {
      rows.push(...projectRewardLedgerRow(rewardRow({
        actor_id: i % 2 ? CREATOR_A : CREATOR_B,
        qiu: i * 0.17,
        earned_units: i * 17,
      })));
    }
    rows.push(...bookingEntries({ bookingId: BOOKING_1, creatorId: CREATOR_A, grossMinor: 12_000, feeMinor: 2_640, travelerFeeMinor: 250 }));
    rows.push(...bookingEntries({ bookingId: BOOKING_2, creatorId: CREATOR_B, grossMinor: 7_350, feeMinor: 1_617, travelerFeeMinor: 0 }));

    const expected = creatorShares(rows);
    assert.ok(expected.length >= 6, `only ${expected.length} share row(s) — the fixture is too thin to quantify over`);
    for (let seed = 1; seed <= 200; seed++) {
      assert.deepEqual(
        creatorShares(shuffled(rows, seed)), expected,
        `order dependence at seed ${seed}`,
      );
    }
  });

  it("holds for FRACTIONAL qiu, where naive float addition would not", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754, and the associativity failure is
    // order-dependent. If the fold ever goes back to accumulating doubles this
    // is the assertion that goes red.
    const rows = [0.1, 0.2, 0.3, 0.7, 0.000001, 1e-6, 2.675].flatMap((q) =>
      projectRewardLedgerRow(rewardRow({ actor_id: CREATOR_A, qiu: q, earned_units: 1 })));
    const expected = creatorShares(rows);
    const qiuShare = expected.find((s) => s.unitKind === "qiu");
    assert.ok(qiuShare, "no qiu share was produced");
    for (const p of permutations(rows.filter((r) => r.unitKind === "qiu"))) {
      assert.equal(
        creatorShares([...p, ...rows.filter((r) => r.unitKind !== "qiu")])
          .find((s) => s.unitKind === "qiu")!.creatorAmount,
        qiuShare!.creatorAmount,
        "fractional qiu summed to a different total under a different order",
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P-2 · Two unit systems, no fabricated conversion.
// ═══════════════════════════════════════════════════════════════════════════
describe("units are a grouping key, never a conversion", () => {
  const rows: CanonicalShareRow[] = [
    ...projectRewardLedgerRow(rewardRow({ actor_id: CREATOR_A, qiu: 2, earned_units: 200 })),
    ...bookingEntries({ bookingId: BOOKING_1, creatorId: CREATOR_A, grossMinor: 10_000, feeMinor: 2_200, travelerFeeMinor: 300 }),
  ];

  it("gives one creator THREE separate answers, one per unit — never a total", () => {
    const shares = creatorShares(rows).filter((s) => s.creatorId === CREATOR_A);
    const units = shares.map((s) => `${s.sourceLedger}/${s.unitKind}/${s.unitCode}`).sort();
    assert.deepEqual(units, [
      "intel_reward_ledger/credit/CREDIT",
      "intel_reward_ledger/qiu/QIU",
      "rent_buddy_earnings_entries/currency/USD",
    ]);
    // The amounts are deliberately different numbers in different systems. If
    // any two were ever added, one of these would move.
    const by = byKey(shares);
    assert.equal(by.get(`intel_reward_ledger|${CREATOR_A}|qiu|QIU`)!.creatorAmount, 2);
    assert.equal(by.get(`intel_reward_ledger|${CREATOR_A}|credit|CREDIT`)!.creatorAmount, 200);
    assert.equal(by.get(`rent_buddy_earnings_entries|${CREATOR_A}|currency|USD`)!.creatorAmount, 7_800);
  });

  it("is INDEPENDENT across units: changing one unit's amounts moves only that unit", () => {
    const base = byKey(creatorShares(rows));
    const scaled = rows.map((r) =>
      r.unitKind === "currency" ? { ...r, amount: r.amount * 3 } : r);
    const after = byKey(creatorShares(scaled));

    assert.equal(
      after.get(`intel_reward_ledger|${CREATOR_A}|qiu|QIU`)!.creatorAmount,
      base.get(`intel_reward_ledger|${CREATOR_A}|qiu|QIU`)!.creatorAmount,
      "tripling every currency amount changed the qiu answer — the two units are being added",
    );
    assert.equal(
      after.get(`intel_reward_ledger|${CREATOR_A}|credit|CREDIT`)!.creatorAmount,
      base.get(`intel_reward_ledger|${CREATOR_A}|credit|CREDIT`)!.creatorAmount,
      "tripling every currency amount changed the credit answer",
    );
    assert.equal(
      after.get(`rent_buddy_earnings_entries|${CREATOR_A}|currency|USD`)!.creatorAmount,
      base.get(`rent_buddy_earnings_entries|${CREATOR_A}|currency|USD`)!.creatorAmount * 3,
    );
  });

  it("keeps two currencies apart as firmly as it keeps credits from cents", () => {
    const eur = bookingEntries({ bookingId: BOOKING_2, creatorId: CREATOR_A, grossMinor: 5_000, feeMinor: 1_000, travelerFeeMinor: 0 })
      .map((r) => ({ ...r, unitCode: "EUR" }));
    const shares = creatorShares([...rows, ...eur]).filter((s) => s.creatorId === CREATOR_A);
    const codes = shares.filter((s) => s.unitKind === "currency").map((s) => s.unitCode).sort();
    assert.deepEqual(codes, ["EUR", "USD"], "two currencies were merged into one figure");
  });

  it("never emits a row whose unit is absent — an amount nobody can add up", () => {
    for (const t of unitTotals(rows)) {
      assert.ok(t.unitKind, "a unit total with no unit kind");
      assert.ok(t.unitCode, "a unit total with no unit code");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P-3 · A ratio is reported only where a denominator is RECORDED.
// ═══════════════════════════════════════════════════════════════════════════
describe("a share ratio is never invented", () => {
  it("is null on the single-sided contributor ledger — absent, not 100%", () => {
    const shares = creatorShares(
      projectRewardLedgerRow(rewardRow({ actor_id: CREATOR_A, qiu: 1, earned_units: 100 })),
    );
    assert.ok(shares.length === 2);
    for (const s of shares) {
      assert.equal(s.basis, "creator_side_only");
      assert.equal(s.platformAmount, null,
        "intel_reward_ledger records no platform counterpart; reporting one would invent it");
      assert.equal(s.sharedBaseAmount, null);
      assert.equal(s.sharePpm, null,
        "a ledger with no denominator has no ratio — 1.0 would be a fabrication");
      // The AMOUNT is still computable, which is what `08` §5's "creator/host
      // share" actually names.
      assert.ok(s.creatorAmount > 0);
    }
  });

  it("is computed on the double-entry marketplace ledger, from its own legs", () => {
    const rows = bookingEntries({ bookingId: BOOKING_1, creatorId: CREATOR_A, grossMinor: 10_000, feeMinor: 2_200, travelerFeeMinor: 300 });
    const [s] = creatorShares(rows).filter((x) => x.creatorId === CREATOR_A);
    assert.ok(s);
    assert.equal(s!.basis, "double_entry");
    assert.equal(s!.creatorAmount, 7_800);   // 10 000 gross − 2 200 fee
    assert.equal(s!.platformAmount, 2_500);  // 2 200 fee + 300 traveller service fee
    assert.equal(s!.sharedBaseAmount, 10_300);
    assert.equal(s!.sharePpm, Math.round((7_800 / 10_300) * 1_000_000));
  });

  it("REFUSES a ratio when one attribution names more than one creator", () => {
    const shared = [
      ...bookingEntries({ bookingId: BOOKING_1, creatorId: CREATOR_A, grossMinor: 10_000, feeMinor: 2_000, travelerFeeMinor: 0 }),
      ...projectEarningsEntryRow(entryRow({
        account: "buddy_payable", amount_minor: 1_000,
        beneficiary_user_id: CREATOR_B, attribution_id: BOOKING_1,
      })),
    ];
    for (const s of creatorShares(shared)) {
      assert.equal(s.basis, "ambiguous_attribution",
        "`07` §7 multi-party attribution is unbuilt; splitting the platform leg here would invent the weights");
      assert.equal(s.sharePpm, null);
      assert.equal(s.platformAmount, null);
      assert.ok(Number.isFinite(s.creatorAmount), "the creator's own amount stays computable");
    }
  });

  it("refuses a ratio when the shared base nets to zero", () => {
    const rows = bookingEntries({ bookingId: BOOKING_1, creatorId: CREATOR_A, grossMinor: 10_000, feeMinor: 2_000, travelerFeeMinor: 0 });
    const reversed = rows.map((r, i) => ({
      ...r,
      sourceEntryId: `rev-${i}`,
      amount: -r.amount,
      entryReason: "reversal",
      reversesSourceEntryId: r.sourceEntryId,
    }));
    const [s] = creatorShares([...rows, ...reversed]);
    assert.ok(s);
    assert.equal(s!.creatorAmount, 0);
    assert.equal(s!.sharedBaseAmount, 0);
    assert.equal(s!.sharePpm, null, "0/0 is not 100% and is not 0%");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P-4 · Reversals net, wherever they land.
// ═══════════════════════════════════════════════════════════════════════════
describe("a reversal nets the share back, at any position", () => {
  it("holds for the contributor ledger under every interleaving", () => {
    const original = rewardRow({ id: "irl-fixed-1", actor_id: CREATOR_A, qiu: 0.8, earned_units: 80 });
    const keep = rewardRow({ id: "irl-fixed-2", actor_id: CREATOR_A, qiu: 0.25, earned_units: 25 });
    const reversal = rewardRow({
      id: "irl-fixed-3", actor_id: CREATOR_A, qiu: -0.8, earned_units: -80,
      reverses_entry_id: "irl-fixed-1",
    });
    const rows = [original, keep, reversal].flatMap(projectRewardLedgerRow);
    for (const p of permutations(rows)) {
      const by = byKey(creatorShares(p));
      assert.equal(by.get(`intel_reward_ledger|${CREATOR_A}|credit|CREDIT`)!.creatorAmount, 25);
      assert.equal(by.get(`intel_reward_ledger|${CREATOR_A}|qiu|QIU`)!.creatorAmount, 0.25);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P-5 · Reconciliation, BOTH directions. The canonical answer must equal the
//       per-ledger answer computed independently, and vice versa.
// ═══════════════════════════════════════════════════════════════════════════
describe("canonical and per-ledger agree in both directions", () => {
  const rewardRows = [
    rewardRow({ actor_id: CREATOR_A, qiu: 0.8, earned_units: 80 }),
    rewardRow({ actor_id: CREATOR_B, qiu: 1.4, earned_units: 140 }),
  ];
  const bookingRows = [
    ...bookingEntries({ bookingId: BOOKING_1, creatorId: CREATOR_A, grossMinor: 10_000, feeMinor: 2_200, travelerFeeMinor: 300 }),
    ...bookingEntries({ bookingId: BOOKING_2, creatorId: CREATOR_B, grossMinor: 4_500, feeMinor: 990, travelerFeeMinor: 0 }),
  ];
  // "Canonical" = what the view returns, in whatever order the database felt
  // like. "Per-ledger" = each ledger read and projected on its own.
  const canonical = shuffled([...rewardRows.flatMap(projectRewardLedgerRow), ...bookingRows], 31337);
  const perLedger = [...rewardRows.flatMap(projectRewardLedgerRow), ...bookingRows];

  it("reconciles canonical -> per-ledger", () => {
    const r = reconcile(canonical, perLedger);
    assert.deepEqual(r.differences, []);
    assert.equal(r.ok, true);
  });

  it("reconciles per-ledger -> canonical", () => {
    const r = reconcile(perLedger, canonical);
    assert.deepEqual(r.differences, []);
    assert.equal(r.ok, true);
  });

  it("produces the SAME shares from either side", () => {
    assert.deepEqual(creatorShares(canonical), creatorShares(perLedger));
  });

  it("is not vacuous: it CATCHES a single lost entry, in both directions", () => {
    const short = perLedger.slice(1);
    assert.equal(reconcile(canonical, short).ok, false,
      "dropping an entry reconciled clean — the check is asleep");
    assert.equal(reconcile(short, canonical).ok, false,
      "the reverse direction missed a dropped entry");
  });

  it("is not vacuous: it CATCHES a unit swap that preserves every total", () => {
    // The exact failure mode a fabricated conversion would look like: the same
    // numbers, relabelled into another unit. Row counts and the grand total are
    // unchanged; only the per-unit totals move.
    const relabelled = perLedger.map((r) =>
      r.unitKind === "credit" ? { ...r, unitKind: "qiu" as const, unitCode: "QIU" } : r);
    assert.equal(reconcile(canonical, relabelled).ok, false,
      "credits relabelled as qiu reconciled clean — units are not being compared");
    assert.equal(reconcile(relabelled, canonical).ok, false);
  });

  it("is not vacuous: it CATCHES an amount that moved by one minor unit", () => {
    const off = perLedger.map((r, i) => (i === 4 ? { ...r, amount: r.amount + 1 } : r));
    assert.equal(reconcile(canonical, off).ok, false);
    assert.equal(reconcile(off, canonical).ok, false);
  });

  it("is not vacuous: it CATCHES a DUPLICATED entry that no other layer can see", () => {
    // FOUND BY MUTATION TESTING. Deleting the per-unit-total comparison from
    // reconcile() left every other assertion in this file green, because the
    // entry comparison indexes by key (a duplicate collapses into it) and the
    // share comparison only looks at creator and platform legs. A duplicated
    // TRAVELLER leg — the shape a bad join in the view would produce — is
    // therefore invisible to both, and visible only to the row COUNT inside the
    // unit totals. Without this the unit-total layer was untested.
    const traveler = perLedger.find((r) => r.partyRole === "traveler");
    assert.ok(traveler, "the fixture has no traveller leg to duplicate");
    const doubled = [...perLedger, { ...traveler! }];
    assert.equal(reconcile(canonical, doubled).ok, false,
      "a duplicated entry reconciled clean — the ledger could double-count and nothing would say so");
    assert.equal(reconcile(doubled, canonical).ok, false);
    assert.ok(
      reconcile(canonical, doubled).differences.some((d) => d.kind === "unit_total"),
      "the duplicate was caught by some other layer; the unit-total comparison is still untested",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P-6 · Losslessness of the projection itself: every identifier survives, and
//       the source row is reconstructible from its canonical rows.
// ═══════════════════════════════════════════════════════════════════════════
describe("the projection is lossless and invertible", () => {
  it("keeps the source identifier verbatim and fans out one row per unit", () => {
    const src = rewardRow({ id: "irl-keep-me", actor_id: CREATOR_A, qiu: 0.8, earned_units: 80 });
    const out = projectRewardLedgerRow(src);
    assert.equal(out.length, 2, "a reward row carries two units and must project to two rows");
    for (const r of out) {
      assert.equal(r.sourceEntryId, "irl-keep-me", "the source identifier was rewritten");
      assert.equal(r.sourceLedger, "intel_reward_ledger");
      assert.equal(r.creatorId, CREATOR_A);
      assert.equal(r.ruleVersion, "intel-reward/v1");
      assert.equal(r.cashRecorded, 0);
    }
    // Reconstructing the source row from its canonical rows.
    const qiu = out.find((r) => r.unitKind === "qiu")!;
    const credit = out.find((r) => r.unitKind === "credit")!;
    assert.equal(qiu.amount, src.qiu);
    assert.equal(credit.amount, src.earned_units);
  });

  it("gives (source_ledger, source_entry_id, unit_kind) as a unique key", () => {
    const rows = [
      ...projectRewardLedgerRow(rewardRow({ actor_id: CREATOR_A, qiu: 1, earned_units: 100 })),
      ...projectRewardLedgerRow(rewardRow({ actor_id: CREATOR_A, qiu: 2, earned_units: 200 })),
      ...bookingEntries({ bookingId: BOOKING_1, creatorId: CREATOR_A, grossMinor: 100, feeMinor: 10, travelerFeeMinor: 0 }),
    ];
    const keys = rows.map((r) => `${r.sourceLedger}|${r.sourceEntryId}|${r.unitKind}`);
    assert.equal(new Set(keys).size, keys.length, "the canonical key is not unique");
  });

  it("maps every 2901 account to a party role, with no silent default", () => {
    const seen = new Map<string, string>();
    for (const account of ["buddy_payable", "platform_revenue", "traveler_receivable", "cash_external"]) {
      const [row] = projectEarningsEntryRow(entryRow({
        account, amount_minor: 1, beneficiary_user_id: null, attribution_id: BOOKING_1,
      }));
      seen.set(account, row!.partyRole);
    }
    assert.deepEqual(Object.fromEntries(seen), {
      buddy_payable: "creator",
      platform_revenue: "platform",
      traveler_receivable: "traveler",
      cash_external: "external",
    });
  });

  it("surfaces the cash boundary rather than assuming it", () => {
    const rows = [
      ...projectRewardLedgerRow(rewardRow({ actor_id: CREATOR_A, qiu: 1, earned_units: 1 })),
      ...bookingEntries({ bookingId: BOOKING_1, creatorId: CREATOR_A, grossMinor: 100, feeMinor: 10, travelerFeeMinor: 0 }),
    ];
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.equal(r.cashRecorded, 0,
        "a canonical row recorded settled cash. No payment path exists (09 §1).");
    }
  });

  it("REPORTS a non-zero cash figure instead of zeroing it", () => {
    // FOUND BY MUTATION TESTING. Hardcoding `cashRecorded: 0` in the projection
    // left the assertion above green — which made it an assertion about the
    // projection's own constant rather than about the ledger, and would have
    // hidden exactly the condition it exists to detect. The CHECKs at 2170:40
    // and in 2901 make a non-zero value impossible in the table; the projection
    // must nevertheless PASS THROUGH whatever is there, so that a reader
    // asserting the boundary is asserting something.
    const [qiuRow] = projectRewardLedgerRow({
      id: "irl-cash", actor_id: CREATOR_A, qiu: 1, earned_units: 1,
      cash_amount: 5, ledger_version: "v1", source: "served", created_at: "2026-09-14T00:00:00.000Z",
    });
    assert.equal(qiuRow!.cashRecorded, 5,
      "a non-zero cash_amount was silently reported as 0; the cash assertion would be vacuous");

    const [entry] = projectEarningsEntryRow({
      ...entryRow({ account: "buddy_payable", amount_minor: 1, beneficiary_user_id: CREATOR_A, attribution_id: BOOKING_1 }),
      cash_settled_minor: 7,
    });
    assert.equal(entry!.cashRecorded, 7,
      "a non-zero cash_settled_minor was silently reported as 0");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P-7 · The balance is invariant under metadata that a later processor choice
//       would change — `09` §11, "provider can be swapped later".
// ═══════════════════════════════════════════════════════════════════════════
describe("nothing derived reads processor or narrative metadata", () => {
  it("gives the same shares when entry_reason and rule_version are rewritten", () => {
    const rows = [
      ...projectRewardLedgerRow(rewardRow({ actor_id: CREATOR_A, qiu: 0.5, earned_units: 50 })),
      ...bookingEntries({ bookingId: BOOKING_1, creatorId: CREATOR_A, grossMinor: 900, feeMinor: 90, travelerFeeMinor: 10 }),
    ];
    const rebadged = rows.map((r) => ({
      ...r,
      entryReason: `${r.entryReason}::rebadged`,
      ruleVersion: "some-later-processor/v9",
      occurredAt: "2099-01-01T00:00:00.000Z",
    }));
    assert.deepEqual(
      creatorShares(rebadged).map((s) => ({ ...s })),
      creatorShares(rows).map((s) => ({ ...s })),
      "a derived share moved because narrative metadata changed",
    );
  });
});
