/**
 * DV-69 (`09` §11 "provider can be swapped later") and DV-63's money half —
 * the payout provider is a replaceable boundary, its only implementation moves
 * no money, and the ledger does not know it exists.
 *
 *   PV1  every one of `09` §9's six operations on the `none` provider answers
 *        `payouts_disabled` and touches NO network primitive (fetch, http,
 *        https, net, tls, dns all patched to record and throw)
 *   PV2  no provider is chosen: anything but `none` is refused, not looked up
 *   PV3  the provider module imports nothing, and no ledger module imports it
 *   PV4  swapping the provider needs no ledger change: every derived quantity
 *        is identical whatever the `provider` / `external_ref` columns hold
 *   PV5  the ledger's writers and operations run with every network primitive
 *        patched, and none is reached; every row they build records no
 *        settlement
 *
 * Run: node --import tsx/esm --test src/test/creatorPayoutProviderBoundary.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import {
  NONE_PAYOUT_PROVIDER,
  NONE_PROVIDER_ID,
  resolvePayoutProvider,
} from "../services/creators/PayoutProvider.js";
import {
  buildCreatorEarningEntries,
  reconstructCreatorBalances,
  unbalancedCreatorTransactions,
  type CreatorLedgerEntry,
} from "../lib/creatorLedgerEntries.js";
import { buildAttribution } from "../lib/creatorTypeAttribution.js";
import { toCreatorEarningEntryRow } from "../lib/creatorLedgerRows.js";
import { projectCreatorEarningEntryRow, creatorShares } from "../lib/creatorShareCanonical.js";
import { summarizeCreatorEarnings } from "../lib/creatorLedgerStatus.js";
import { planHold, planRecompute, planReversal } from "../lib/creatorLedgerPlans.js";
import {
  recordCreatorAttribution,
  recordCreatorEarning,
} from "../services/creators/CreatorAttributionService.js";
import { placeCreatorHold } from "../services/creators/CreatorLedgerOperations.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const CREATOR = "33333333-3333-4333-8333-333333333333";

// ── A network trap: every primitive records and throws ─────────────────────
const reached: string[] = [];
const saved: Array<[any, string, any]> = [];
function trap(obj: any, key: string, label: string) {
  saved.push([obj, key, obj[key]]);
  obj[key] = (..._a: unknown[]) => { reached.push(label); throw new Error(`network primitive reached: ${label}`); };
}
before(() => {
  trap(globalThis, "fetch", "fetch");
  trap(http, "request", "http.request"); trap(http, "get", "http.get");
  trap(https, "request", "https.request"); trap(https, "get", "https.get");
  trap(net, "connect", "net.connect"); trap(net, "createConnection", "net.createConnection");
  trap(tls, "connect", "tls.connect"); trap(dns, "lookup", "dns.lookup");
});
after(() => { for (const [o, k, v] of saved.reverse()) o[k] = v; });

describe("PV — the payout provider boundary", () => {
  it("PV1. all six `09` §9 operations answer payouts_disabled and reach no network primitive", async () => {
    reached.length = 0;
    const p = NONE_PAYOUT_PROVIDER;
    const results = await Promise.all([
      p.createRecipient({ creatorId: CREATOR, settlementCurrency: "USD" }),
      p.validateRecipient("r"),
      p.requestPayout({ creatorId: CREATOR, amountMinor: 700, currency: "USD", idempotencyKey: "k" }),
      p.getPayoutStatus("x"),
      p.handleWebhook("{}", { "x-signature": "s" }),
      p.reverseOrHold("x", "hold"),
    ]);
    assert.equal(results.length, 6);
    for (const r of results) {
      assert.equal(r.ok, false);
      if (!r.ok) assert.deepEqual([r.provider, r.reason], [NONE_PROVIDER_ID, "payouts_disabled"]);
    }
    assert.deepEqual(reached, [], "the no-money provider touched the network");
    assert.ok(Object.isFrozen(NONE_PAYOUT_PROVIDER), "the provider cannot be monkey-patched into moving money");
  });

  it("PV2. no provider is chosen: `none` and absence resolve; any real name is refused, not guessed", () => {
    for (const c of [undefined, null, "", "none", " NONE "]) {
      const r = resolvePayoutProvider(c as any);
      assert.equal(r.ok && r.provider.id, "none", String(c));
    }
    for (const c of ["stripe", "paypal", "adyen", "wise"]) {
      const r = resolvePayoutProvider(c);
      assert.deepEqual([r.ok, !r.ok && r.reason], [false, "no_provider_chosen"], c);
    }
  });

  it("PV3. the provider imports nothing, and no ledger module imports the provider", () => {
    const own = readFileSync(join(SRC, "services/creators/PayoutProvider.ts"), "utf8");
    assert.deepEqual(own.match(/^\s*import\s/gm) ?? [], [], "PayoutProvider.ts must import nothing — no client, no SDK, no fetch");
    const ledgerFiles = [
      ...readdirSync(join(SRC, "lib")).filter((f) => /^creator.*\.ts$/.test(f)).map((f) => `lib/${f}`),
      ...readdirSync(join(SRC, "services/creators")).filter((f) => f.endsWith(".ts") && f !== "PayoutProvider.ts").map((f) => `services/creators/${f}`),
      "services/ledger/CanonicalShareReader.ts",
    ];
    assert.ok(ledgerFiles.length >= 10, `scanned ${ledgerFiles.length} files`);
    for (const f of ledgerFiles) {
      const src = readFileSync(join(SRC, f), "utf8");
      assert.ok(!/from\s+["'][^"']*PayoutProvider/.test(src), `${f} imports the payout provider; the ledger must not know it`);
      assert.ok(!/\bfetch\s*\(|from\s+["']node:(https?|net|tls)["']|from\s+["'](stripe|@stripe|paypal|adyen|axios)/.test(src),
        `${f} reaches a network or payment client`);
    }
  });

  it("PV4. rewriting every entry's provider and external_ref changes no derived quantity", () => {
    const a = buildAttribution({
      creatorType: "travel_partner", subjectId: "bk", valueEventId: "bk", beneficiaryUserId: CREATOR,
      ruleVersion: "creator-rules/travel-partner/v1", weight: 1, confidence: 1, grossRevenueMinor: 10_000,
      provisionalShareMinor: 7000, fraudHold: false, fraudHoldReason: null,
    });
    assert.equal(a.status, "built");
    if (a.status !== "built") return;
    const built = buildCreatorEarningEntries(a.attribution, { grossRevenueMinor: 10_000, creatorShareMinor: 7000, platformFeeMinor: 2000 });
    assert.equal(built.status, "built");
    if (built.status !== "built") return;
    const swapped: CreatorLedgerEntry[] = built.entries.map((e) => ({ ...e, provider: "some_future_processor", externalRef: `po_${e.entryId}` }));
    assert.deepEqual(reconstructCreatorBalances(swapped), reconstructCreatorBalances(built.entries));
    assert.deepEqual(unbalancedCreatorTransactions(swapped), unbalancedCreatorTransactions(built.entries));
    const canon = (es: CreatorLedgerEntry[]) =>
      es.flatMap((e, i) => projectCreatorEarningEntryRow({ ...toCreatorEarningEntryRow(e, "att-1"), id: `e${i}`, provider: e.provider } as any));
    assert.deepEqual(creatorShares(canon(swapped)), creatorShares(canon(built.entries)));
    assert.deepEqual(summarizeCreatorEarnings(CREATOR, canon(swapped), []), summarizeCreatorEarnings(CREATOR, canon(built.entries), []));
  });

  it("PV5. the ledger's writers and operations reach no network primitive, and every row they build settles nothing", async () => {
    reached.length = 0;
    const writes: any[] = [];
    const row = {
      id: "aaaaaaaa-0000-4000-8000-000000000001", creator_type: "travel_partner", subject_kind: "booking",
      subject_id: "bbbbbbbb-0000-4000-8000-000000000001", value_event: "verified_booking",
      value_event_id: "bbbbbbbb-0000-4000-8000-000000000001", attribution_basis: "recorded_value_event",
      beneficiary_user_id: CREATOR, weight: 1, confidence: 1, gross_revenue_minor: 10_000, provisional_share_minor: 7000,
      currency: "USD", rule_version: "creator-rules/travel-partner/v1", fraud_hold: false, fraud_hold_reason: null,
      supersedes_id: null, idempotency_key: "k", recommendation_id: null,
    };
    const q: any = (t: string) => {
      const s: any = {
        _p: null, _f: [] as any[],
        select() { return s; }, eq(c: string, v: any) { s._f.push([c, v]); return s; }, in() { return s; }, neq() { return s; },
        lte() { return s; }, order() { return s; }, limit() { return s; },
        insert(p: any) { s._p = p; writes.push(p); return s; }, upsert(p: any) { s._p = p; writes.push(p); return s; },
        single() { return s; }, maybeSingle() { s._one = true; return s; },
        then(res: any) {
          if (t === "feature_flags") return res({ data: { enabled: true }, error: null });
          if (s._p) return res({ data: Array.isArray(s._p) ? s._p : { id: "x", ...s._p }, error: null });
          if (t === "creator_rule_versions") return res({ data: [{ creator_type: "travel_partner", rule_version: "creator-rules/travel-partner/v1", params: {}, effective_from: "2026-01-01" }], error: null });
          if (t === "creator_attributions") return res({ data: s._one ? row : [row], error: null });
          return res({ data: [], error: null });
        },
      };
      return s;
    };
    const client = {
      from: q,
      rpc: async (_fn: string, args: any) => { writes.push(args.p); return { data: { attribution_id: "y", attribution_inserted: true, entries_inserted: 0, entries_replayed: 0, audit_id: "z", audit_inserted: true }, error: null }; },
    };
    const a = await recordCreatorAttribution(client, {
      creatorType: "travel_partner", subjectId: row.subject_id, valueEventId: row.subject_id, beneficiaryUserId: CREATOR,
      weight: 1, confidence: 1, grossRevenueMinor: 10_000, provisionalShareMinor: 7000, fraudHold: false, fraudHoldReason: null,
    });
    assert.equal(a.ok, true, JSON.stringify(a));
    if (!a.ok) return;
    assert.equal((await recordCreatorEarning(client, row.id, a.value.attribution, { grossRevenueMinor: 10_000, creatorShareMinor: 7000, platformFeeMinor: 2000 })).ok, true);
    assert.equal((await placeCreatorHold(client, { attributionId: row.id, reason: "fake_visits", actor: { kind: "admin", userId: CREATOR } })).ok, true);
    assert.deepEqual(reached, [], "a ledger operation reached the network");

    // Every row built — directly or in a door payload — asserts no settlement.
    const flat = writes.flatMap((w) => (Array.isArray(w) ? w : w?.entries ? [w.attribution, ...w.entries] : [w])).filter(Boolean);
    assert.ok(flat.length >= 5, `inspected ${flat.length} rows`);
    for (const r of flat) {
      for (const k of ["settled_minor", "cash_settled_minor"]) if (k in r) assert.equal(r[k], 0, `${k} on ${JSON.stringify(r).slice(0, 80)}`);
    }
    // And the plans themselves carry no settlement field a caller could set.
    const head = { ...row } as any;
    for (const p of [
      planHold(head, "x", { kind: "system", userId: null }),
      planRecompute([head], [], head, { ruleVersion: "creator-rules/travel-partner/v2", figures: { grossRevenueMinor: 1, creatorShareMinor: 1, platformFeeMinor: 0 } }, "x", { kind: "system", userId: null }),
      planReversal([], "t", "x", { kind: "system", userId: null }),
    ]) {
      if (!p.ok) continue;
      assert.ok(!JSON.stringify(p.payload).includes("settled"), "a door payload names a settlement column");
    }
  });
});
