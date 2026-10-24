/**
 * DC-23 — `11` §6's fourth creator-economy read, payout eligibility
 * (census-discovery §134).
 *
 * GET /api/creator-economy/me/payout-eligibility runs on the REAL router.
 *   E1  flag OFF or absent ⇒ 404 feature_disabled, never "not eligible"
 *   E2  signed out ⇒ 401
 *   E3  ON ⇒ the honest answer while W10D-B5 is open: undecided, nothing payable,
 *       the pending decision named, `07` §4's progression and inputs as
 *       vocabulary — and NO input read for the caller
 *   E4  the answer carries no number and no verdict a client could treat as one
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import creatorEconomyRouter from "../routes/creatorEconomy.js";
import { PAYOUT_ELIGIBILITY_INPUTS, PAYOUT_PROGRESSION, payoutEligibilityAnswer } from "../services/creators/creatorPayoutEligibility.js";
import { makeTelemetryDb } from "./helpers/fakeDiscoveryTelemetryDb.js";

const ALICE = "a11ce000-0000-4000-8000-000000000001";
const USERS = { "alice-token": ALICE };
let server: Server;
let base = "";
let db: ReturnType<typeof makeTelemetryDb>;
let tablesRead: string[] = [];

function install(flags: Record<string, { enabled: boolean }>) {
  db = makeTelemetryDb({ users: USERS, flags });
  tablesRead = [];
  const from = db.client.from.bind(db.client);
  (db.client as any).from = (t: string) => { tablesRead.push(t); return from(t); };
  _setTestClient(db.client as any, true);
  _setTestServiceClient(db.client as any);
}
async function get(token: string | null): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/creator-economy/me/payout-eligibility`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}
/** `profiles` is requireUser's own account-standing read; `feature_flags` the gate. Anything else would be an eligibility input. */
const readsOtherThanFlags = () => tablesRead.filter((t) => t !== "feature_flags" && t !== "profiles").length;

before(async () => {
  const app = express();
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use("/api", creatorEconomyRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => install({ creator_attribution_enabled: { enabled: true } }));

describe("DC-23 — payout eligibility is answered as undecided while W10D-B5 is open", () => {
  it("E1. flag OFF or absent ⇒ 404 feature_disabled", async () => {
    for (const flags of [{ creator_attribution_enabled: { enabled: false } }, {}]) {
      install(flags);
      const r = await get("alice-token");
      assert.equal(r.status, 404, JSON.stringify(flags));
      assert.equal(r.body?.error, "feature_disabled");
    }
  });

  it("E2. signed out ⇒ 401", async () => {
    assert.equal((await get(null)).status, 401);
  });

  it("E3. ON ⇒ undecided, nothing payable, the pending decision named, nothing read", async () => {
    const r = await get("alice-token");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { payoutEligibility: {
      status: "undecided", eligible: null, payable: false, reason: "thresholds_unset", decision: "W10D-B5",
      progression: [...PAYOUT_PROGRESSION], considers: [...PAYOUT_ELIGIBILITY_INPUTS],
    } });
    assert.ok(tablesRead.includes("feature_flags"), "precondition: the gate was read through this client");
    assert.equal(readsOtherThanFlags(), 0, `no eligibility input is read for the caller (nothing to leak, nothing to score): ${tablesRead.join(",")}`);
    assert.equal(PAYOUT_PROGRESSION.length, 6, "07 §4 names six stages");
    assert.equal(PAYOUT_ELIGIBILITY_INPUTS.length, 6, "and six inputs");
  });

  it("E4. no number and no verdict a client could treat as one", () => {
    const a = payoutEligibilityAnswer();
    const flat = JSON.stringify(a);
    assert.ok(!/\d/.test(flat.replace("W10D-B5", "")), `a number reached the answer: ${flat}`);
    assert.equal(a.eligible, null);
    assert.equal(a.payable, false);
  });
});
