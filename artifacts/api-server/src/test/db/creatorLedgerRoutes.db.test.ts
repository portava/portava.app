/**
 * The creator-economy HTTP surface over the real routers, the real auth guards
 * and a real PostgreSQL 16 — census-discovery §52 (DC-23, DV-59, DV-74).
 *
 * `routes/creatorEconomy.ts` and `routes/adminCreatorLedger.ts` are mounted on
 * an express app whose Supabase client is `creatorLedgerPsqlClient`: tokens
 * resolve to seeded users, `requireAdmin` reads the seeded `profiles.role`, and
 * every ledger read and write runs against 2920/2921/2930/3385/3386/3387. The
 * flag is answered in memory; the harness row stays FALSE.
 *
 *   RT1  a creator reads their OWN ledger, and cannot name another's
 *   RT2  flag off answers feature_disabled on every read — never an empty ledger
 *   RT3  no token / a bad token is 401 and reads nothing
 *   RT4  a non-admin cannot hold; an admin's hold is written WITH its audit row
 *   RT5  release, reversal, and their refusals over HTTP; the audit trail reads back
 *   RT6  the earnings response is finished figures — nothing for a client to compute
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { randomUUID } from "node:crypto";
import { HAVE_DB, creatorLedgerPurgeSql, exec, rows, scalar, seedUser } from "./localDb.js";
import { creatorPsqlClient, lit } from "./creatorLedgerPsqlClient.js";
import { _setTestClient } from "../../lib/http.js";
import creatorEconomyRouter from "../../routes/creatorEconomy.js";
import adminCreatorLedgerRouter from "../../routes/adminCreatorLedger.js";
import {
  bookCreatorEarningUnderRule,
  recordCreatorAttributionUnderRule,
} from "../../services/creators/CreatorAttributionService.js";

const FLAG = "creator_attribution_enabled";
const VERSION = "creator-rules/travel-partner/v911";
let creatorA = "", creatorB = "", admin = "";
const users: string[] = [];
const tokens: Record<string, string> = {};
let server: http.Server | null = null;
let base = "";
let flagOn = true;

function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({
      hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let b: any; try { b = JSON.parse(raw); } catch { b = raw; } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** The client the routes see: the flag answered from `flagOn`, tokens from the seed. */
function install() {
  _setTestClient(creatorPsqlClient({ flags: flagOn ? { [FLAG]: true } : {}, tokens }), true);
}

describe("the creator-economy routes over a real database (census-discovery §52)", { skip: !HAVE_DB }, () => {
  let attributionA = "";
  before(async () => {
    creatorA = seedUser("p10rtA"); creatorB = seedUser("p10rtB"); admin = seedUser("p10rtAdmin");
    users.push(creatorA, creatorB, admin);
    exec(`UPDATE public.profiles SET role = 'admin' WHERE id = '${admin}';`);
    tokens["tok-a"] = creatorA; tokens["tok-b"] = creatorB; tokens["tok-admin"] = admin;
    exec(`INSERT INTO public.creator_rule_versions (creator_type, rule_version, params, effective_from, note) VALUES ('travel_partner', ${lit(VERSION)}, '{"creator_share_ppm":700000,"platform_fee_ppm":200000}'::jsonb, now() - interval '1 second', 'TEST FIXTURE (census-discovery §52 routes suite) — not a production rule; deleted after the suite');`);
    flagOn = true;
    install();
    const sc = creatorPsqlClient({ flags: { [FLAG]: true } });
    for (const [creator, gross] of [[creatorA, 10_000], [creatorB, 4_000]] as const) {
      const s = randomUUID();
      const a = await recordCreatorAttributionUnderRule(sc, {
        creatorType: "travel_partner", subjectId: s, valueEventId: s, beneficiaryUserId: creator,
        weight: 1, confidence: 1, grossRevenueMinor: gross, fraudHold: false, fraudHoldReason: null,
      } as any);
      assert.equal(a.ok, true, JSON.stringify(a));
      if (!a.ok) return;
      if (creator === creatorA) attributionA = a.value.id;
      assert.equal((await bookCreatorEarningUnderRule(sc, a.value.id)).ok, true);
    }
    const app = express();
    app.use(express.json());
    app.use(creatorEconomyRouter);
    app.use(adminCreatorLedgerRouter);
    await new Promise<void>((res) => { server = app.listen(0, "127.0.0.1", () => res()); });
    const addr = server!.address() as any;
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((res) => server!.close(() => res()));
    exec(
      `${creatorLedgerPurgeSql(users)}\n` +
      `DELETE FROM public.profiles WHERE id IN (${users.map(lit).join(",")});\n` +
      `DELETE FROM auth.users WHERE id IN (${users.map(lit).join(",")});\n` +
      `DELETE FROM public.creator_rule_versions WHERE rule_version = ${lit(VERSION)};`,
    );
  });

  test("RT1. a creator reads their OWN ledger; naming another creator in the request changes nothing", async () => {
    flagOn = true; install();
    const a = await call("GET", "/creator-economy/me/earnings", "tok-a");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const cee = a.body.earnings.find((b: any) => b.sourceLedger === "creator_earning_entries");
    assert.equal(cee.provisional, 7000);
    const sneaky = await call("GET", `/creator-economy/me/earnings?creatorId=${creatorA}&beneficiary_user_id=${creatorA}`, "tok-b");
    assert.equal(sneaky.status, 200);
    const bCee = sneaky.body.earnings.find((b: any) => b.sourceLedger === "creator_earning_entries");
    assert.equal(bCee.provisional, 2800, "B's own figure, whatever the query string says");
    const conv = await call("GET", "/creator-economy/me/attributions", "tok-b");
    assert.ok(conv.body.attributions.every((c: any) => c.attributionId !== attributionA), "no row of A reaches B");
    const impact = await call("GET", "/creator-economy/me/impact", "tok-a");
    assert.deepEqual(impact.body.impact.outcomes, [{ valueEvent: "verified_booking", attributed: 1, held: 0 }]);
  });

  test("RT2. with the flag off every read answers feature_disabled — not an empty ledger that reads as 'you earned nothing'", async () => {
    flagOn = false; install();
    for (const p of ["/creator-economy/me/earnings", "/creator-economy/me/attributions", "/creator-economy/me/impact"]) {
      const r = await call("GET", p, "tok-a");
      assert.equal(r.status, 404, p);
      assert.equal(r.body.error, "feature_disabled", p);
    }
    flagOn = true; install();
  });

  test("RT3. no token, or a token nobody issued, is 401 and reads nothing", async () => {
    assert.equal((await call("GET", "/creator-economy/me/earnings", null)).status, 401);
    assert.equal((await call("GET", "/creator-economy/me/earnings", "tok-forged")).status, 401);
    assert.equal((await call("POST", `/admin/creator-ledger/attributions/${attributionA}/hold`, null, { reason: "x" })).status, 401);
  });

  test("RT4. a non-admin cannot hold; an admin's hold lands WITH its audit row, and a second hold is a conflict", async () => {
    const denied = await call("POST", `/admin/creator-ledger/attributions/${attributionA}/hold`, "tok-a", { reason: "self-serve" });
    assert.equal(denied.status, 403);
    assert.equal(scalar(`SELECT count(*) FROM public.creator_attributions WHERE supersedes_id = '${attributionA}'`), "0");
    const noReason = await call("POST", `/admin/creator-ledger/attributions/${attributionA}/hold`, "tok-admin", {});
    assert.equal(noReason.status, 400);
    const held = await call("POST", `/admin/creator-ledger/attributions/${attributionA}/hold`, "tok-admin", { reason: "self_booking_loop" });
    assert.equal(held.status, 201, JSON.stringify(held.body));
    const audit = rows<any>(`SELECT action, actor_kind, actor_user_id, reason FROM public.creator_ledger_audit_events WHERE attribution_id = '${attributionA}'`);
    assert.deepEqual(audit, [{ action: "hold_placed", actor_kind: "admin", actor_user_id: admin, reason: "self_booking_loop" }]);
    const again = await call("POST", `/admin/creator-ledger/attributions/${attributionA}/hold`, "tok-admin", { reason: "again" });
    assert.deepEqual([again.status, again.body.reason], [409, "already_held"]);
    const mine = await call("GET", "/creator-economy/me/earnings", "tok-a");
    const cee = mine.body.earnings.find((b: any) => b.sourceLedger === "creator_earning_entries");
    assert.deepEqual([cee.provisional, cee.held, cee.available], [0, 7000, 0], "the creator sees it HELD, never payable");
  });

  test("RT5. release and reversal over HTTP, each audited; a repeat reversal is a conflict; the trail reads back whole", async () => {
    const rel = await call("POST", `/admin/creator-ledger/attributions/${attributionA}/release`, "tok-admin", { reason: "support verified the bookings" });
    assert.equal(rel.status, 201, JSON.stringify(rel.body));
    const trail = await call("GET", `/admin/creator-ledger/attributions/${attributionA}/audit`, "tok-admin");
    assert.equal(trail.status, 200);
    const tk = trail.body.entries.find((e: any) => e.entry_reason === "revenue_share").transaction_key;
    const rev = await call("POST", "/admin/creator-ledger/transactions/reverse", "tok-admin", { transactionKey: tk, reason: "refund" });
    assert.equal(rev.status, 201, JSON.stringify(rev.body));
    const rev2 = await call("POST", "/admin/creator-ledger/transactions/reverse", "tok-admin", { transactionKey: tk, reason: "refund" });
    assert.deepEqual([rev2.status, rev2.body.reason], [409, "already_reversed"]);
    const after = await call("GET", `/admin/creator-ledger/attributions/${attributionA}/audit`, "tok-admin");
    assert.deepEqual(after.body.audit.map((a: any) => a.action), ["hold_placed", "hold_released", "reversed"]);
    assert.deepEqual(after.body.unbalancedTransactions, []);
    const nonAdmin = await call("GET", `/admin/creator-ledger/attributions/${attributionA}/audit`, "tok-b");
    assert.equal(nonAdmin.status, 403);
    const badId = await call("GET", "/admin/creator-ledger/attributions/not-a-uuid/audit", "tok-admin");
    assert.equal(badId.status, 400);
  });

  test("RT6. `11` §6 — the earnings response is finished figures; it carries no rate, percentage or params to compute with", async () => {
    const r = await call("GET", "/creator-economy/me/earnings", "tok-a");
    assert.equal(r.status, 200);
    for (const b of r.body.earnings) {
      for (const k of ["provisional", "held", "reversedNet", "lifetimeNet", "available"]) assert.equal(typeof b[k], "number", k);
      assert.equal(b.lifetimeNet, b.provisional + b.held + b.reversedNet);
      assert.equal(b.available, 0);
    }
    assert.match(r.body.availableReason, /07 §4/);
    const text = JSON.stringify(r.body);
    assert.ok(!/ppm|params|percent|rate"/i.test(text), "the response hands the client something to compute an earning with");
    const cee = r.body.earnings.find((b: any) => b.sourceLedger === "creator_earning_entries");
    assert.equal(cee.provisional, 0, "the reversed revenue share is no longer provisional");
    assert.equal(cee.reversedNet, 0, "the reversal pair nets to zero");
  });
});
