/**
 * rentBuddyAddonAutoApprove.test.ts
 *
 * Locks the add-on moderation model (product decision 2026-08-25): add-ons are
 * AUTO-APPROVED. There is no admin review workflow for add-ons — nothing ever
 * flips rent_buddy_addons.admin_approved after creation and requires_admin_approval
 * is read nowhere. The create route POST /rent-a-buddy/me/addons therefore ignores
 * any client `requiresAdminApproval` flag and always inserts admin_approved=true /
 * requires_admin_approval=false. Honouring the flag (the previous behaviour) set
 * admin_approved=false, hiding the add-on from the marketplace (GET .../addons
 * filters admin_approved=true) with no path to ever approve it — a self-inflicted
 * permanent-invisibility trap. This test asserts the trap is gone.
 *
 * (Direct-write protection of admin_approved / requires_admin_approval is a
 * separate concern, covered at the DB layer by rentBuddyAddonApprovalBoundary.test.ts
 * / migration 2156.)
 *
 * Fake-supabase unit test — no live DB. Run:
 *   node --import tsx/esm --test src/test/rentBuddyAddonAutoApprove.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";

const BUDDY_USER_ID = "aaaaaaaa-0000-0000-0000-0000000000a1";
const BP_ID = "cccccccc-0000-0000-0000-0000000000c1";

function trackingBuilder(singleData: any): any {
  let hasIn = false;
  const b: any = {
    select: () => b, insert: () => b, update: () => b, upsert: () => b, delete: () => b,
    eq: () => b, neq: () => b, in: () => { hasIn = true; return b; }, is: () => b, not: () => b,
    gte: () => b, lte: () => b, order: () => b, limit: () => b, range: () => b,
    single: () => Promise.resolve({ data: singleData, error: null }),
    maybeSingle: () => Promise.resolve({ data: singleData, error: null }),
    then: (resolve: (r: any) => any) =>
      Promise.resolve({ data: hasIn ? [] : (singleData == null ? [] : [singleData]), error: null }).then(resolve),
  };
  return b;
}

/** Captures the payload passed to .insert() on rent_buddy_addons. */
function capturingAddonBuilder(captured: { payload?: any }): any {
  const b: any = {
    insert: (payload: any) => { captured.payload = payload; return b; },
    select: () => b, eq: () => b, order: () => b,
    single: () => Promise.resolve({ data: { id: "addon-1", ...(captured.payload ?? {}) }, error: null }),
    maybeSingle: () => Promise.resolve({ data: { id: "addon-1", ...(captured.payload ?? {}) }, error: null }),
    then: (resolve: (r: any) => any) => Promise.resolve({ data: [], error: null }).then(resolve),
  };
  return b;
}

function makeClient(userId: string, captured: { payload?: any }) {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: userId } }, error: null }) },
    from: (table: string) => {
      if (table === "rent_buddy_addons") return capturingAddonBuilder(captured);
      if (table === "rent_buddy_profiles") return trackingBuilder({ id: BP_ID, user_id: userId, status: "active", admin_status: "active" });
      // FIXTURE, not behaviour. POST /rent-a-buddy/me/addons INSERTs a
      // rent_buddy_addons row, so it now clears the Rent-a-Buddy master switch
      // like every other write handler in the lane. Falling through to
      // trackingBuilder(null) hands the gate "no feature_flags row", which a
      // real database means as "the lane is off", and the handler correctly
      // 403s before the insert this suite is here to inspect. The auto-approve
      // assertions are untouched; only the database the fake describes changes.
      if (table === "feature_flags") return trackingBuilder({ enabled: true });
      return trackingBuilder(null);
    },
  };
}

describe("rent_buddy_addons auto-approve moderation model", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  before(async () => {
    const { default: mkt } = await import("../routes/rentABuddyMarketplace.js");
    const app = express();
    app.use(express.json());
    app.use("/api", mkt);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise((r) => setTimeout(r, 100));
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  async function createAddon(body: unknown, captured: { payload?: any }) {
    _setTestClient(makeClient(BUDDY_USER_ID, captured) as any, true);
    return fetch(`http://127.0.0.1:${port}/api/rent-a-buddy/me/addons`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify(body),
    });
  }

  it("auto-approves a new add-on and IGNORES a client requiresAdminApproval=true (no invisibility trap)", async () => {
    const captured: { payload?: any } = {};
    const res = await createAddon({ title: "Photo pack", priceUsd: 15, requiresAdminApproval: true }, captured);
    assert.equal(res.status, 201, "create must succeed");
    assert.equal(captured.payload?.admin_approved, true, "add-on must be auto-approved regardless of the client flag");
    assert.equal(captured.payload?.requires_admin_approval, false, "the client path must never set requires_admin_approval=true (it would hide the add-on forever)");
  });

  it("auto-approves when no approval flag is passed", async () => {
    const captured: { payload?: any } = {};
    const res = await createAddon({ title: "Guide pack", priceUsd: 20 }, captured);
    assert.equal(res.status, 201);
    assert.equal(captured.payload?.admin_approved, true);
    assert.equal(captured.payload?.requires_admin_approval, false);
  });
});
