/**
 * adminGuardSharedPath.test.ts
 *
 * The nine local admin guards that `check:admin-guard` used to report are gone;
 * every one of those route groups now asks the SHARED guard
 * (`lib/requireAdmin.ts`) the role question. This file is the evidence that the
 * removal did not change any of those routes' answers.
 *
 * WHAT THIS IS ACTUALLY FOR
 * -------------------------
 * A checker that exits 0 proves only that no function in src/routes/ has the
 * SHAPE of a local guard. It cannot prove the delegation preserved behaviour,
 * and "the guard vanished because the handler stopped checking" also makes a
 * shape checker green. So each route group here is pinned in three directions:
 *
 *   DENY   a non-admin gets a SPECIFIC status and a SPECIFIC body. Asserting
 *          only `!== 200` would pass on a crash, on a 404 from a typo'd path,
 *          and on a request that died in input validation before ever reaching
 *          the guard — every route below is called with a VALID payload for
 *          exactly that reason.
 *   ALLOW  an admin gets the route's real success response, not merely "not
 *          403". Without this, deleting the handler body would still pass.
 *   FAIL   the guard's `profiles.role` read RESOLVING as an error still denies.
 *          supabase-js does not throw on a DB error — it resolves
 *          `{ data: null, error }` — so this is the direction a role check
 *          silently flips permissive in. `makeFailClosedClient` injects exactly
 *          that shape, and never throws, so a pass here cannot come from a
 *          try/catch that production does not have.
 *
 * TWO DIVERGENCES ARE PINNED AS DIVERGENCES, not flattened:
 *   - rentABuddyRollout accepts 'owner' as well as 'admin' (D5/E). Folding it
 *     onto the default role set would have revoked a working capability, so the
 *     'owner' case is asserted to be ALLOWED here and nowhere else — H asserts
 *     an 'owner' is REFUSED by a default-role route, which is what stops the
 *     wider set leaking outward.
 *   - adminVisuals is admin AND the `ai_visual_admin_review_enabled` flag, i.e.
 *     STRICTER than plain admin. G2 asserts an admin is still refused when the
 *     flag is off.
 *
 * ORDERING NOTE for the FAIL cases: `requireUser` reads `profiles` first (the
 * ban gate reads `account_status`), and the guard reads `profiles.role` after
 * it. Failing every `profiles` read would therefore be answered by the ban gate
 * (503 degraded_unavailable) and would never reach the code under test, so
 * `failRoleRead()` below fails the SECOND profiles read onward — the guard's.
 * The 403 those cases assert is itself the proof the right read was hit: a
 * mis-counted injection surfaces as 503, not as a pass.
 *
 * Runtime: node:test (NOT vitest). Judged by exit code.
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/adminGuardSharedPath.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import type { Express } from "express";

import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, noopLog, type FakeClientSpec } from "./helpers/failClosedSupabase.js";

import adminVisualsRouter from "../routes/adminVisuals.js";
import circleRouter from "../routes/circle.js";
import compassGraphRouter from "../routes/compassGraph.js";
import placesCanonicalRouter from "../routes/placesCanonical.js";
import marketplaceRouter from "../routes/rentABuddyMarketplace.js";
import rolloutRouter, { checkRentBuddyAccess, invalidateGcCache } from "../routes/rentABuddyRollout.js";
import specRouter from "../routes/rentABuddySpec.js";
import visualsRouter from "../routes/visuals.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CALLER   = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "22222222-2222-4222-8222-222222222222";
const SURVIVOR = "33333333-3333-4333-8333-333333333333";
const VISUAL_ID = "44444444-4444-4444-8444-444444444444";
const TOKEN    = "test-bearer-token";

/** Fail the guard's `profiles.role` read — the SECOND profiles read of a request. */
function failRoleRead(): FakeClientSpec["failOn"] {
  let seen = 0;
  return (ctx) => {
    if (ctx.table !== "profiles") return null;
    seen += 1;
    return seen >= 2 ? { message: "connection terminated unexpectedly", code: "57P01" } : null;
  };
}

/**
 * A client whose caller has `role`, plus whatever extra table rows the route
 * under test needs. `role: null` omits the profile row entirely.
 */
function clientFor(opts: {
  role: string | null;
  rows?: Record<string, Record<string, any>[]>;
  failOn?: FakeClientSpec["failOn"];
}): any {
  const profiles = opts.role === null ? [] : [{ id: CALLER, role: opts.role }];
  return makeFailClosedClient({
    users: { [TOKEN]: CALLER },
    rows: { profiles, ...(opts.rows ?? {}) },
    failOn: opts.failOn,
  });
}

function install(client: any): void {
  _setTestClient(client, true);
  _setTestServiceClient(client);
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

interface Reply { status: number; body: any }

function request(base: string, method: string, path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * One server per router. Mounting eight routers on one app would let a path
 * declared by an earlier router answer a later router's test, which is exactly
 * the sort of accident these assertions are supposed to be immune to.
 *
 * `req.log` is installed here because the real server installs it: omitting it
 * makes handlers THROW, and a 500-from-crash is easy to misread as a
 * fail-closed denial.
 */
const servers: http.Server[] = [];

async function serve(router: any): Promise<string> {
  const app: Express = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = capturingLog(); next(); });
  app.use("/api", router);
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as any;
  return `http://127.0.0.1:${addr.port}`;
}

let compassBase = "";
let circleBase = "";
let placesBase = "";
let marketBase = "";
let rolloutBase = "";
let specBase = "";
let adminVisualsBase = "";
let visualsBase = "";

before(async () => {
  compassBase      = await serve(compassGraphRouter);
  circleBase       = await serve(circleRouter);
  placesBase       = await serve(placesCanonicalRouter);
  marketBase       = await serve(marketplaceRouter);
  rolloutBase      = await serve(rolloutRouter);
  specBase         = await serve(specRouter);
  adminVisualsBase = await serve(adminVisualsRouter);
  visualsBase      = await serve(visualsRouter);
});

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

beforeEach(() => {
  // `_setTestClient` takes (client, ready) — passing one argument stopped
  // compiling when the readiness flag was added. The reset path is its own
  // helper, and it is the one that belongs here: it clears the readiness
  // sentinel back to null ("never set") rather than to false ("set, not
  // ready"), which is what a per-test reset means.
  _clearTestClient();
  _setTestServiceClient(null as any);
  invalidateGcCache();
});

/** The shared guard's refusal, byte for byte. */
/**
 * A read failure is DENIED, but it is not a role denial and must not be answered
 * as one.
 *
 * These nine cases originally asserted 403 "Admin role required" for an
 * unreadable profiles row. The direction was right — supabase-js resolves on a
 * database error with data null, so `!data` denied either way — but the ANSWER
 * was a false statement: a real admin locked out by an outage was told they are
 * not an admin, and nothing logged it. That is the same shape as the six
 * UNCHECKED_READS_ALLOWLIST entries the shared guard retired, and answering it
 * identically would have moved the defect into the shared guard rather than
 * closing it.
 */
/**
 * Lines the guard logged during the last request.
 *
 * Needed because the outage branch's OTHER half — logging at error level so an
 * operator sees the outage — is invisible to a status assertion: dropping the log
 * and keeping the 503 left all nine cases green. A fix nobody can watch fail is
 * not a fix.
 */
const loggedLines: string[] = [];
function capturingLog(): any {
  const rec = (...a: unknown[]) => { loggedLines.push(a.map((x) => JSON.stringify(x)).join(" ")); };
  const l: any = { info: rec, warn: rec, error: rec, debug: rec };
  l.child = () => l;
  return l;
}

function assertSharedUnavailable(reply: Reply, what: string): void {
  assert.equal(reply.status, 503, `${what}: expected 503, got ${reply.status} ${JSON.stringify(reply.body)}`);
  assert.equal(reply.body?.error, "db_error", `${what}: error code`);
  assert.equal(reply.body?.message, "Could not verify admin role", `${what}: message`);
  // and it must NOT claim the caller lacks the role
  assert.notEqual(reply.body?.error, "forbidden", `${what}: an outage is not a role denial`);
}

function assertSharedForbidden(reply: Reply, what: string): void {
  assert.equal(reply.status, 403, `${what}: expected 403, got ${reply.status} ${JSON.stringify(reply.body)}`);
  assert.equal(reply.body?.error, "forbidden", `${what}: error code`);
  assert.equal(reply.body?.message, "Admin role required", `${what}: message`);
}

describe("the outage branch is LOUD, not just closed", () => {
  it("logs the failed role read at error level, naming it as not a role denial", async () => {
    // The status assertion alone cannot see this: dropping the log while keeping
    // the 503 leaves every other case in this file green. Measured, then pinned.
    loggedLines.length = 0;
    install(clientFor({ role: "admin", failOn: failRoleRead() }));
    const reply = await request(compassBase, "GET", "/api/compass/graph/status");
    assertSharedUnavailable(reply, "LOG");
    assert.ok(
      loggedLines.some((l) => l.includes("profiles role read failed")),
      `the outage must be logged, not only answered. Saw: ${JSON.stringify(loggedLines)}`,
    );
    assert.ok(
      loggedLines.some((l) => l.includes("NOT a role denial")),
      "the log must say what it is, so an operator is not sent looking for a permissions problem",
    );
  });

  it("logs NOTHING for a genuine role refusal", async () => {
    // The control. A guard that logged an outage for every denial would pass the
    // case above while making the signal useless.
    loggedLines.length = 0;
    install(clientFor({ role: "user" }));
    assertSharedForbidden(await request(compassBase, "GET", "/api/compass/graph/status"), "LOG-CTL");
    assert.equal(
      loggedLines.filter((l) => l.includes("profiles role read failed")).length, 0,
      "a real non-admin is not an outage",
    );
  });
});

// ── A: compassGraph.ts — GET /api/compass/graph/status ────────────────────────

describe("A: compassGraph admin routes go through the shared guard", () => {
  it("A1 refuses role 'user' with the shared 403", async () => {
    install(clientFor({ role: "user" }));
    assertSharedForbidden(await request(compassBase, "GET", "/api/compass/graph/status"), "A1");
  });

  it("A2 refuses a caller with no profile row at all", async () => {
    install(clientFor({ role: null }));
    assertSharedForbidden(await request(compassBase, "GET", "/api/compass/graph/status"), "A2");
  });

  it("A3 admits role 'admin' and returns the real graph status body", async () => {
    install(clientFor({
      role: "admin",
      rows: {
        compass_graph_nodes: [{ id: "n1" }, { id: "n2" }],
        compass_graph_edges: [{ id: "e1" }],
        compass_city_confidence: [{ city: "Cebu", depth_score: 9, tier: "deep", computed_at: "2026-01-01" }],
      },
    }));
    const r = await request(compassBase, "GET", "/api/compass/graph/status");
    assert.equal(r.status, 200, `A3: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.nodes, 2);
    assert.equal(r.body.edges, 1);
    assert.equal(r.body.strongestCity, "Cebu");
  });

  it("A4 fails CLOSED when the role read resolves as an error", async () => {
    install(clientFor({ role: "admin", failOn: failRoleRead() }));
    assertSharedUnavailable(await request(compassBase, "GET", "/api/compass/graph/status"), "A4");
  });
});

// ── B: circle.ts — GET /api/admin/circle/reports ──────────────────────────────

describe("B: circle admin routes go through the shared guard", () => {
  it("B1 refuses role 'user' with the shared 403", async () => {
    install(clientFor({ role: "user" }));
    assertSharedForbidden(await request(circleBase, "GET", "/api/admin/circle/reports"), "B1");
  });

  it("B2 admits role 'admin' and returns the report list", async () => {
    install(clientFor({
      role: "admin",
      rows: {
        circle_audit_events: [
          { id: "ev1", actor_user_id: CALLER, target_user_id: null, context_type: "trip",
            context_id: PLACE_ID, event_type: "needs_help_triggered", metadata: {}, created_at: "2026-01-01" },
        ],
      },
    }));
    const r = await request(circleBase, "GET", "/api/admin/circle/reports");
    assert.equal(r.status, 200, `B2: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.reports.length, 1);
    assert.equal(r.body.reports[0].id, "ev1");
  });

  it("B3 fails CLOSED when the role read resolves as an error", async () => {
    install(clientFor({ role: "admin", failOn: failRoleRead() }));
    assertSharedUnavailable(await request(circleBase, "GET", "/api/admin/circle/reports"), "B3");
  });
});

// ── C: placesCanonical.ts — POST /api/admin/places/:id/unmerge ────────────────

describe("C: placesCanonical admin routes go through the shared guard", () => {
  const mergedPlace = { id: PLACE_ID, merged_into_place_id: SURVIVOR };

  it("C1 refuses role 'user' with the shared 403 (valid id — not an input-validation 400)", async () => {
    install(clientFor({ role: "user", rows: { places: [mergedPlace] } }));
    assertSharedForbidden(
      await request(placesBase, "POST", `/api/admin/places/${PLACE_ID}/unmerge`, {}),
      "C1",
    );
  });

  it("C2 admits role 'admin' and performs the unmerge", async () => {
    install(clientFor({ role: "admin", rows: { places: [mergedPlace] } }));
    const r = await request(placesBase, "POST", `/api/admin/places/${PLACE_ID}/unmerge`, {});
    assert.equal(r.status, 200, `C2: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body, { ok: true, restoredId: PLACE_ID });
  });

  it("C3 fails CLOSED when the role read resolves as an error", async () => {
    install(clientFor({ role: "admin", rows: { places: [mergedPlace] }, failOn: failRoleRead() }));
    assertSharedUnavailable(
      await request(placesBase, "POST", `/api/admin/places/${PLACE_ID}/unmerge`, {}),
      "C3",
    );
  });
});

// ── D: rentABuddyMarketplace.ts — GET .../admin/marketplace/analytics ─────────

describe("D: rentABuddyMarketplace admin routes go through the shared guard", () => {
  const path = "/api/rent-a-buddy/admin/marketplace/analytics";

  it("D1 refuses role 'user' with the shared 403", async () => {
    install(clientFor({ role: "user" }));
    assertSharedForbidden(await request(marketBase, "GET", path), "D1");
  });

  it("D2 admits role 'admin' and returns the analytics body", async () => {
    install(clientFor({ role: "admin" }));
    const r = await request(marketBase, "GET", path);
    assert.equal(r.status, 200, `D2: ${JSON.stringify(r.body)}`);
    assert.ok(r.body && typeof r.body === "object", "D2: expected a JSON object body");
  });

  it("D3 fails CLOSED when the role read resolves as an error", async () => {
    install(clientFor({ role: "admin", failOn: failRoleRead() }));
    assertSharedUnavailable(await request(marketBase, "GET", path), "D3");
  });
});

// ── E: rentABuddyRollout.ts requireAdmin — the WIDER role set is preserved ────

describe("E: rentABuddyRollout admin routes accept admin OR owner", () => {
  const path = "/api/admin/rent-buddy/rollout/cities";
  const cities = { rent_buddy_city_rollouts: [{ id: "r1", city: "Cebu", status: "waitlist_only" }] };

  it("E1 refuses role 'user' with the shared 403", async () => {
    install(clientFor({ role: "user", rows: cities }));
    assertSharedForbidden(await request(rolloutBase, "GET", path), "E1");
  });

  it("E2 admits role 'admin'", async () => {
    install(clientFor({ role: "admin", rows: cities }));
    const r = await request(rolloutBase, "GET", path);
    assert.equal(r.status, 200, `E2: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.cities[0].city, "Cebu");
  });

  it("E3 STILL admits role 'owner' — the divergence this route has always had", async () => {
    install(clientFor({ role: "owner", rows: cities }));
    const r = await request(rolloutBase, "GET", path);
    assert.equal(r.status, 200, `E3: owner must not be locked out — ${JSON.stringify(r.body)}`);
    assert.equal(r.body.cities[0].city, "Cebu");
  });

  it("E4 fails CLOSED when the role read resolves as an error", async () => {
    install(clientFor({ role: "admin", rows: cities, failOn: failRoleRead() }));
    assertSharedUnavailable(await request(rolloutBase, "GET", path), "E4");
  });
});

// ── F: rentABuddyRollout.ts checkRentBuddyAccess — the predicate form ─────────
//
// Exercised directly rather than over HTTP: this is a pure decision function
// that OWNS NO RESPONSE (it returns an AccessDecision and never sends), which is
// precisely why it uses `isAdmin` and not `requireAdmin`. Calling it directly
// also keeps `requireUser`'s ban-gate read out of the way, so the fail-closed
// case can fail the very first `profiles` read.

describe("F: checkRentBuddyAccess admin-only mode uses the shared predicate", () => {
  const flags = {
    feature_flags: [
      { flag: "rent_buddy_enabled", enabled: true },
      { flag: "RENT_BUDDY_ADMIN_ONLY_MODE", enabled: true },
    ],
  };

  it("F1 refuses a non-admin with code 'admin_only' and HTTP 403", async () => {
    const sc = clientFor({ role: "user", rows: flags });
    const d = await checkRentBuddyAccess({ sc, userId: CALLER, action: "read" });
    assert.equal(d.allowed, false, "F1: a plain user must not pass admin-only mode");
    assert.equal(d.code, "admin_only");
    assert.equal(d.httpStatus, 403);
  });

  it("F2 refuses a caller with no profile row", async () => {
    const sc = clientFor({ role: null, rows: flags });
    const d = await checkRentBuddyAccess({ sc, userId: CALLER, action: "read" });
    assert.equal(d.allowed, false, "F2");
    assert.equal(d.code, "admin_only");
  });

  it("F3 admits role 'admin'", async () => {
    const sc = clientFor({ role: "admin", rows: flags });
    const d = await checkRentBuddyAccess({ sc, userId: CALLER, action: "read" });
    assert.equal(d.allowed, true, `F3: ${JSON.stringify(d)}`);
  });

  it("F4 STILL admits role 'owner' — the wider set this function has always had", async () => {
    const sc = clientFor({ role: "owner", rows: flags });
    const d = await checkRentBuddyAccess({ sc, userId: CALLER, action: "read" });
    assert.equal(d.allowed, true, `F4: owner must not be locked out — ${JSON.stringify(d)}`);
  });

  it("F5 fails CLOSED when the role read resolves as an error", async () => {
    const sc = clientFor({
      role: "admin",
      rows: flags,
      failOn: (ctx) => (ctx.table === "profiles" ? { message: "boom", code: "57P01" } : null),
    });
    const d = await checkRentBuddyAccess({ sc, userId: CALLER, action: "read" });
    assert.equal(d.allowed, false, "F5: an unreadable role must NOT read as 'is an admin'");
    assert.equal(d.code, "admin_only");
    assert.equal(d.httpStatus, 403);
  });
});

// ── G: adminVisuals.ts — admin AND the feature flag (STRICTER than admin) ─────

describe("G: adminVisuals keeps its extra feature-flag gate on top of the shared guard", () => {
  const path = `/api/admin/visuals/${VISUAL_ID}`;
  const flagOn = { feature_flags: [{ flag: "ai_visual_admin_review_enabled", enabled: true }] };
  const flagOff = { feature_flags: [{ flag: "ai_visual_admin_review_enabled", enabled: false }] };
  const visual = { generated_visuals: [{ id: VISUAL_ID, entity_type: "place", entity_id: PLACE_ID }] };

  it("G1 refuses role 'user' with the shared 403 even with the flag ON", async () => {
    install(clientFor({ role: "user", rows: { ...flagOn, ...visual } }));
    assertSharedForbidden(await request(adminVisualsBase, "DELETE", path), "G1");
  });

  it("G2 refuses an ADMIN when the flag is OFF — the local gate is still stricter", async () => {
    install(clientFor({ role: "admin", rows: { ...flagOff, ...visual } }));
    const r = await request(adminVisualsBase, "DELETE", path);
    assert.equal(r.status, 403, `G2: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "feature_disabled", "G2: must be the FLAG refusal, not the role refusal");
    assert.equal(r.body?.message, "AI visual admin is not enabled");
  });

  it("G3 admits an admin with the flag ON", async () => {
    install(clientFor({ role: "admin", rows: { ...flagOn, ...visual } }));
    const r = await request(adminVisualsBase, "DELETE", path);
    assert.equal(r.status, 200, `G3: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body, { ok: true, id: VISUAL_ID });
  });

  it("G4 fails CLOSED when the role read resolves as an error", async () => {
    install(clientFor({ role: "admin", rows: { ...flagOn, ...visual }, failOn: failRoleRead() }));
    assertSharedUnavailable(await request(adminVisualsBase, "DELETE", path), "G4");
  });
});

// ── H: rentABuddySpec.ts — default role set, and 'owner' does NOT leak in ─────

describe("H: rentABuddySpec admin routes go through the shared guard", () => {
  const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
  const path = `/api/admin/rent-a-buddy/services/${SERVICE_ID}/approve`;
  const services = { buddy_services: [{ id: SERVICE_ID, approved: false, is_active: true }] };

  it("H1 refuses role 'user' with the shared 403", async () => {
    install(clientFor({ role: "user", rows: services }));
    assertSharedForbidden(await request(specBase, "POST", path, {}), "H1");
  });

  it("H2 admits role 'admin' and approves the service", async () => {
    install(clientFor({ role: "admin", rows: services }));
    const r = await request(specBase, "POST", path, {});
    assert.equal(r.status, 200, `H2: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.service.approved, true);
  });

  it("H3 refuses role 'owner' — the wider set stays confined to rentABuddyRollout", async () => {
    install(clientFor({ role: "owner", rows: services }));
    assertSharedForbidden(await request(specBase, "POST", path, {}), "H3");
  });

  it("H4 fails CLOSED when the role read resolves as an error", async () => {
    install(clientFor({ role: "admin", rows: services, failOn: failRoleRead() }));
    assertSharedUnavailable(await request(specBase, "POST", path, {}), "H4");
  });
});

// ── I: visuals.ts canEditEntity — admin BYPASS, ownership otherwise ───────────
//
// `canEditEntity` is not an admin guard: it is an ownership check with an admin
// bypass, and it sends nothing. Only the bypass moved to the shared predicate,
// so both halves are pinned — the admin gets in, and the non-admin non-owner
// still does not.

describe("I: visuals.ts keeps ownership semantics with a shared admin bypass", () => {
  const path = `/api/visuals/${VISUAL_ID}`;
  const placeVisual = {
    generated_visuals: [
      { id: VISUAL_ID, entity_type: "place", entity_id: PLACE_ID, purpose: "place_header", style: "portava_editorial" },
    ],
  };

  it("I1 refuses a non-admin: 'place' is admin-managed and has no owner to match", async () => {
    install(clientFor({ role: "user", rows: placeVisual }));
    const r = await request(visualsBase, "DELETE", path);
    assert.equal(r.status, 403, `I1: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "forbidden");
  });

  it("I2 admits an admin through the shared predicate", async () => {
    install(clientFor({ role: "admin", rows: placeVisual }));
    const r = await request(visualsBase, "DELETE", path);
    assert.equal(r.status, 200, `I2: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
  });

  it("I3 still admits a trip OWNER who is not an admin — ownership was not flattened away", async () => {
    install(clientFor({
      role: "user",
      rows: {
        generated_visuals: [
          { id: VISUAL_ID, entity_type: "trip", entity_id: PLACE_ID, purpose: "trip_cover", style: "portava_editorial" },
        ],
        trips: [{ id: PLACE_ID, owner_id: CALLER }],
      },
    }));
    const r = await request(visualsBase, "DELETE", path);
    assert.equal(r.status, 200, `I3: the trip owner must keep access — ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
  });

  it("I4 fails CLOSED when the role read resolves as an error", async () => {
    install(clientFor({ role: "admin", rows: placeVisual, failOn: failRoleRead() }));
    const r = await request(visualsBase, "DELETE", path);
    assert.equal(r.status, 403, `I4: an unreadable role must NOT read as 'is an admin' — ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "forbidden");
  });
});
