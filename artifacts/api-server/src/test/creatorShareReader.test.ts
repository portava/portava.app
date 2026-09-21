/**
 * CanonicalShareReader — the read that answers `08` §7, and the reconciliation
 * that makes it checkable.
 *
 * ── WHAT THIS PINS ──────────────────────────────────────────────────────────
 * Three things that a "it returned some numbers" test would miss:
 *
 *   1. THE READ PAGES TO EXHAUSTION. PostgREST caps a response; a fold over the
 *      first page of a ledger is not a smaller balance, it is a wrong one. The
 *      fixture below is deliberately larger than the page size.
 *   2. A FAILURE AT ANY PAGE REFUSES THE WHOLE CALL. A partial fold returned as
 *      a success is `09` §5.3 I7's silent absence, applied to money.
 *   3. THE RECONCILIATION RUNS BOTH WAYS, AND CATCHES BOTH KINDS OF DEFECT —
 *      a view that DROPPED an entry and a view that INVENTED one. Those are
 *      different failures and one direction cannot see both.
 *
 * The reader has no write path and cannot acquire one: the canonical relation
 * is a UNION ALL view, which PostgreSQL does not make auto-updatable.
 *
 * Run: node --import tsx/esm --test src/test/creatorShareReader.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeCreatorShares,
  readCanonicalShareRows,
  readPerLedgerShareRows,
  reconcileCanonicalAgainstSources,
} from "../services/ledger/CanonicalShareReader.js";
import { projectEarningsEntryRow, projectRewardLedgerRow } from "../lib/creatorShareCanonical.js";

const CREATOR_A = "aaaaaaaa-1111-4111-8111-000000000001";
const BOOKING_1 = "cccccccc-3333-4333-8333-000000000001";

// ── The fixture, in BASE-TABLE shape ────────────────────────────────────────

function rewardRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `irl-${String(i).padStart(4, "0")}`,
    actor_id: CREATOR_A,
    source: "served",
    qiu: 0.25,
    earned_units: 25,
    cash_amount: 0,
    ledger_version: "intel-reward/v1",
    reverses_entry_id: null,
    created_at: "2026-09-14T00:00:00.000Z",
  }));
}

const BOOKING_ROWS = [
  { account: "traveler_receivable", amount_minor: -10_000, beneficiary_user_id: null, entry_reason: "booking_gross" },
  { account: "buddy_payable", amount_minor: 10_000, beneficiary_user_id: CREATOR_A, entry_reason: "booking_gross" },
  { account: "buddy_payable", amount_minor: -2_200, beneficiary_user_id: CREATOR_A, entry_reason: "platform_fee" },
  { account: "platform_revenue", amount_minor: 2_200, beneficiary_user_id: null, entry_reason: "platform_fee" },
].map((r, i) => ({
  id: `rbee-${String(i).padStart(4, "0")}`,
  entry_reason: r.entry_reason,
  account: r.account,
  amount_minor: r.amount_minor,
  currency: "USD",
  cash_settled_minor: 0,
  rule_version: "rent-buddy-fee-schedule/v1",
  attribution_kind: "booking",
  attribution_id: BOOKING_1,
  beneficiary_user_id: r.beneficiary_user_id,
  reverses_entry_id: null,
  occurred_at: "2026-09-14T00:00:00.000Z",
}));

/** The base rows as the VIEW's SELECT list renders them (2930). */
function viewRowsFor(rewards: any[], entries: any[]) {
  const toView = (r: any) => ({
    source_ledger: r.sourceLedger,
    source_entry_id: r.sourceEntryId,
    unit_kind: r.unitKind,
    unit_code: r.unitCode,
    amount: r.amount,
    party_role: r.partyRole,
    creator_id: r.creatorId,
    entry_reason: r.entryReason,
    rule_version: r.ruleVersion,
    attribution_kind: r.attributionKind,
    attribution_id: r.attributionId,
    reverses_source_entry_id: r.reversesSourceEntryId,
    cash_recorded: r.cashRecorded,
    occurred_at: r.occurredAt,
  });
  return [
    ...rewards.flatMap(projectRewardLedgerRow).map(toView),
    ...entries.flatMap(projectEarningsEntryRow).map(toView),
  ];
}

/**
 * A fake PostgREST client that models the part that matters here: `.range()`
 * paging over a fixed table. `failOn` makes one relation error at a chosen page
 * so the partial-fold refusal can be exercised rather than asserted about.
 */
function fakeClient(tables: Record<string, any[]>, failOn?: { relation: string; atPage: number }) {
  const pagesServed: Record<string, number> = {};
  const from = (relation: string) => {
    const q: any = {
      select() { return this; },
      order() { return this; },
      eq() { return this; },
      async range(lo: number, hi: number) {
        const seen = (pagesServed[relation] = (pagesServed[relation] ?? 0) + 1);
        if (failOn && failOn.relation === relation && seen > failOn.atPage) {
          return { data: null, error: { message: `simulated failure on ${relation} page ${seen}` } };
        }
        const rows = tables[relation] ?? [];
        return { data: rows.slice(lo, hi + 1), error: null };
      },
    };
    return q;
  };
  return { client: { from }, pagesServed };
}

const CANONICAL = viewRowsFor(rewardRows(1_200), BOOKING_ROWS);

const TABLES = {
  creator_share_ledger: CANONICAL,
  intel_reward_ledger: rewardRows(1_200),
  rent_buddy_earnings_entries: BOOKING_ROWS,
};

// ═══════════════════════════════════════════════════════════════════════════
describe("the canonical read pages to exhaustion", () => {
  it("returns EVERY row of a ledger larger than one page", async () => {
    const { client, pagesServed } = fakeClient(TABLES);
    const r = await readCanonicalShareRows(client, { pageSize: 500 });
    assert.equal(r.ok, true);
    assert.equal((r as any).value.length, CANONICAL.length);
    assert.equal(CANONICAL.length, 2_404, "the fixture stopped spanning multiple pages");
    assert.ok(
      (pagesServed["creator_share_ledger"] ?? 0) >= 5,
      "one page was enough — the fixture no longer exercises paging",
    );
  });

  it("REFUSES rather than returning the pages it did get", async () => {
    const { client } = fakeClient(TABLES, { relation: "creator_share_ledger", atPage: 2 });
    const r = await readCanonicalShareRows(client, { pageSize: 500 });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "db_error");
    assert.match((r as any).detail, /simulated failure/);
  });

  it("refuses a per-ledger read that fails on the SECOND relation", async () => {
    const { client } = fakeClient(TABLES, { relation: "rent_buddy_earnings_entries", atPage: 0 });
    const r = await readPerLedgerShareRows(client, { pageSize: 500 });
    assert.equal(r.ok, false);
  });

  it("refuses a canonical row whose unit nobody can name", async () => {
    const poisoned = [{ ...CANONICAL[0], unit_kind: "bananas" }];
    const { client } = fakeClient({ creator_share_ledger: poisoned });
    const r = await readCanonicalShareRows(client, { pageSize: 500 });
    assert.equal(r.ok, false, "an amount with an unknown unit was folded into a balance");
    assert.match((r as any).detail, /unit_kind/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the share is computed from the one canonical ledger", () => {
  it("gives one row per (creator, source ledger, unit) and no grand total", async () => {
    const { client } = fakeClient(TABLES);
    const r = await computeCreatorShares(client, { pageSize: 500 });
    assert.equal(r.ok, true);
    const shares = (r as any).value;
    assert.deepEqual(
      shares.map((s: any) => `${s.sourceLedger}/${s.unitKind}/${s.unitCode}`).sort(),
      [
        "intel_reward_ledger/credit/CREDIT",
        "intel_reward_ledger/qiu/QIU",
        "rent_buddy_earnings_entries/currency/USD",
      ],
      "the units were collapsed, or a unit was lost",
    );
    const usd = shares.find((s: any) => s.unitKind === "currency");
    assert.equal(usd.creatorAmount, 7_800);
    assert.equal(usd.platformAmount, 2_200);
    assert.equal(usd.basis, "double_entry");

    const credit = shares.find((s: any) => s.unitKind === "credit");
    assert.equal(credit.creatorAmount, 30_000, "1200 rows x 25 credits");
    assert.equal(credit.sharePpm, null, "the contributor ledger has no recorded denominator");

    const qiu = shares.find((s: any) => s.unitKind === "qiu");
    assert.equal(qiu.creatorAmount, 300, "1200 rows x 0.25 qiu, summed exactly");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the canonical ledger reconciles against the sources, both ways", () => {
  it("is clean when the view and the base tables agree", async () => {
    const { client } = fakeClient(TABLES);
    const r = await reconcileCanonicalAgainstSources(client, { pageSize: 500 });
    assert.equal(r.ok, true);
    const rec = (r as any).value;
    assert.deepEqual(rec.canonicalVsPerLedger.differences, []);
    assert.deepEqual(rec.perLedgerVsCanonical.differences, []);
    assert.equal(rec.ok, true);
    // Vacuity: a reconciliation that compared nothing is not a pass.
    assert.equal(rec.canonicalVsPerLedger.compared.entries, CANONICAL.length);
    assert.ok(rec.canonicalVsPerLedger.compared.unitTotals >= 3);
    assert.ok(rec.canonicalVsPerLedger.compared.shares >= 3);
  });

  it("CATCHES a view that dropped an entry", async () => {
    const { client } = fakeClient({ ...TABLES, creator_share_ledger: CANONICAL.slice(1) });
    const rec = (await reconcileCanonicalAgainstSources(client, { pageSize: 500 }) as any).value;
    assert.equal(rec.ok, false);
    assert.ok(rec.canonicalVsPerLedger.differences.length > 0);
    assert.ok(rec.perLedgerVsCanonical.differences.length > 0);
  });

  it("CATCHES a view that invented an entry", async () => {
    const invented = { ...CANONICAL[1], source_entry_id: "irl-9999" };
    const { client } = fakeClient({ ...TABLES, creator_share_ledger: [...CANONICAL, invented] });
    const rec = (await reconcileCanonicalAgainstSources(client, { pageSize: 500 }) as any).value;
    assert.equal(rec.ok, false);
  });

  it("CATCHES a view that relabelled a unit while preserving every total", async () => {
    // The exact shape a fabricated conversion would take: the same numbers,
    // moved into another unit. Row count and the grand total are unchanged.
    const relabelled = CANONICAL.map((r: any) =>
      r.unit_kind === "credit" ? { ...r, unit_kind: "qiu", unit_code: "QIU" } : r);
    const { client } = fakeClient({ ...TABLES, creator_share_ledger: relabelled });
    const rec = (await reconcileCanonicalAgainstSources(client, { pageSize: 500 }) as any).value;
    assert.equal(rec.ok, false, "credits relabelled as qiu reconciled clean");
  });

  it("CATCHES a platform leg mis-assigned to the creator", async () => {
    // Totals per unit are untouched; only the party role moves. Nothing but the
    // share comparison can see this.
    const swapped = CANONICAL.map((r: any) =>
      r.party_role === "platform" ? { ...r, party_role: "creator", creator_id: CREATOR_A } : r);
    const { client } = fakeClient({ ...TABLES, creator_share_ledger: swapped });
    const rec = (await reconcileCanonicalAgainstSources(client, { pageSize: 500 }) as any).value;
    assert.equal(rec.ok, false, "the platform's take was folded into the creator's share unnoticed");
  });
});
