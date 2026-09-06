/**
 * A failed read must not fabricate a clean MODERATION record.
 *
 * These surfaces are the ones a moderator decides on. supabase-js RESOLVES
 * `{ data, error }`, so an unreadable `moderation_actions` / `reports` /
 * `user_account_states` / `rent_buddy_safety_events` used to arrive as
 * `undefined`, be coalesced by `?? []` or `?? 0`, and be rendered as an EMPTY
 * history and `openReports: 0` — a record that actively argues for an unban.
 *
 * The discipline here is fail LOUD: never a fabricated zero.
 *
 * Sites covered:
 *   3. admin.ts       — /admin/users, /admin/users/:id/summary, /moderation-summary
 *   4. rentABuddy.ts  — risk scan must not write on an unread current state
 *   5. rentABuddy.ts  — risk scan aborts; safety-event queue 500s
 *   8. CompassAbuseDefenseEngine — a detector that read nothing is not "clean"
 *
 * Run:
 *   node --import tsx/esm --test src/test/failedReadFabricatesModeration.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";
import rentABuddyRouter from "../routes/rentABuddy.js";
import { runScan } from "../compass/CompassAbuseDefenseEngine.js";

const ADMIN_ID  = "aaaaaaaa-1111-1111-1111-000000000001";
const TARGET_ID = "dddddddd-4444-4444-4444-000000000004";
const TOKEN     = "fake.jwt.token";

const READ_ERROR = { message: "permission denied for relation", code: "42501" };

let server: http.Server;
let base: string;

function request(
  method: "GET" | "POST",
  path: string,
  body?: object,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const headers: Record<string, string> = {
      "content-type":  "application/json",
      "authorization": `Bearer ${TOKEN}`,
    };
    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
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
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const ADMIN_PROFILE = {
  id: ADMIN_ID, role: "admin", account_status: "active",
  handle: "moderator", display_name: "Mod", username: "moderator",
};

const TARGET_PROFILE = {
  id: TARGET_ID, handle: "target", username: "target", name: "Target",
  display_name: "Target", bio: null, avatar_url: null, role: "user",
  verified: false, verification_status: "none", account_status: "active",
  created_at: "2026-01-01T00:00:00Z",
};

/**
 * Admin-capable fake client. `failTables` resolves those tables' reads as
 * `{ data: null, error }` — the exact failure mode that used to be swallowed.
 * `profiles` always resolves so the admin guard and the target lookup succeed:
 * the point of each test is a MODERATION section failing, not auth failing.
 */
function adminClient(opts: {
  failTables?: Set<string>;
  rows?: Record<string, any[]>;
  writes?: Array<{ table: string; values: any }>;
  singles?: Record<string, any>;
}) {
  const failTables = opts.failTables ?? new Set<string>();
  const rows       = opts.rows ?? {};
  const singles    = opts.singles ?? {};
  const writes     = opts.writes ?? [];

  function builder(table: string, op: "select" | "update" | "insert" | "upsert" | "delete", values?: any) {
    const fails = failTables.has(table) && op === "select";
    const b: any = {
      select: () => b, eq: () => b, neq: () => b, is: () => b, in: () => b, not: () => b,
      or: () => b, gte: () => b, lte: () => b, order: () => b, limit: () => b, range: () => b,
      ilike: () => b, contains: () => b,
      maybeSingle: async () => {
        if (fails) return { data: null, error: READ_ERROR };
        if (table === "profiles") return { data: singles.profiles ?? TARGET_PROFILE, error: null };
        return { data: singles[table] ?? null, error: null };
      },
      single: async () => {
        if (fails) return { data: null, error: READ_ERROR };
        return { data: singles[table] ?? null, error: null };
      },
      then: (resolve: any) => {
        if (op !== "select") writes.push({ table, values });
        if (fails) return Promise.resolve({ data: null, error: READ_ERROR, count: null }).then(resolve);
        const d = rows[table] ?? [];
        return Promise.resolve({ data: d, error: null, count: d.length }).then(resolve);
      },
    };
    return b;
  }

  return {
    _writes: writes,
    auth: {
      getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }),
      admin:   { listUsers: async () => ({ data: { users: [] }, error: null }) },
    },
    from: (table: string) => ({
      select: () => builder(table, "select"),
      update: (v: any) => builder(table, "update", v),
      insert: (v: any) => builder(table, "insert", v),
      upsert: (v: any) => builder(table, "upsert", v),
      delete: () => builder(table, "delete"),
    }),
    rpc: async () => ({ data: [], error: null }),
  } as any;
}

/**
 * `profiles` is answered BY ID, not by call order: requireUser reads it once for
 * account_status and requireAdmin reads it again for the role, so a counter would
 * hand the admin's own role lookup the target's row and 403 the whole suite.
 */
function withAdminGuard(c: any) {
  const originalFrom = c.from.bind(c);
  c.from = (table: string) => {
    if (table !== "profiles") return originalFrom(table);
    let wantedId: string | null = null;
    const b: any = {
      select: () => b, neq: () => b, is: () => b, in: () => b, not: () => b,
      or: () => b, gte: () => b, lte: () => b, order: () => b, limit: () => b,
      eq: (col: string, val: any) => { if (col === "id") wantedId = val; return b; },
      ilike: (_col: string, val: any) => { if (String(val) === "target") wantedId = TARGET_ID; return b; },
      maybeSingle: async () => ({
        data: wantedId === ADMIN_ID ? ADMIN_PROFILE : TARGET_PROFILE,
        error: null,
      }),
      single: async () => ({ data: ADMIN_PROFILE, error: null }),
      then: (resolve: any) => Promise.resolve({ data: [ADMIN_PROFILE], error: null, count: 1 }).then(resolve),
    };
    return b;
  };
  return c;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", adminRouter);
  app.use("/api", rentABuddyRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ── Site 3 — admin: a clean moderation record fabricated from a failed read ───

describe("admin moderation record: an unreadable table must not render as clean", () => {
  it("GET /admin/users/:id/moderation-summary marks the section unavailable, not empty", async () => {
    const c = withAdminGuard(adminClient({ failTables: new Set(["moderation_actions", "reports"]) }));
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const r = await request("GET", `/admin/users/${TARGET_ID}/moderation-summary`);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // OLD BEHAVIOUR: moderationActions === [] and reportsReceived === [], i.e.
    // a user with a moderation history rendered as one with none.
    assert.equal(
      r.body.sections.moderationActions.status, "unavailable",
      "an unreadable moderation_actions must be reported unavailable",
    );
    assert.equal(r.body.sections.moderationActions.rows, null, "never an empty array on failure");
    assert.equal(r.body.sections.reportsReceived.status, "unavailable");
    assert.equal(r.body.moderationActions, null, "the legacy key must not fabricate []");
    assert.equal(r.body.reportsReceived, null);
    assert.equal(r.body.degraded, true);
    assert.deepEqual(
      [...(r.body.unavailableSections as string[])].sort(),
      ["moderationActions", "reportsFiled", "reportsReceived"],
    );

    // A section that DID read must still say so.
    assert.equal(r.body.sections.accountStates.status, "ok");
    assert.ok(Array.isArray(r.body.accountStates));
  });

  it("GET /admin/users/:id/summary marks counts unavailable, not zero", async () => {
    const c = withAdminGuard(adminClient({ failTables: new Set(["blocks", "moderation_actions"]) }));
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const r = await request("GET", `/admin/users/${TARGET_ID}/summary`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sections.blockCount.status, "unavailable");
    assert.equal(r.body.blockCount, null, "a fabricated 0 is the number a moderator unbans on");
    assert.equal(r.body.sections.moderationActions.status, "unavailable");
    assert.equal(r.body.moderationActions, null);
    assert.equal(r.body.degraded, true);

    // Sections that read fine keep their real values.
    assert.equal(r.body.sections.muteCount.status, "ok");
    assert.equal(typeof r.body.muteCount, "number");
  });

  it("GET /admin/users?handle= must not report openReports: 0 off an unread reports table", async () => {
    const c = withAdminGuard(adminClient({ failTables: new Set(["reports"]) }));
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const r = await request("GET", `/admin/users?handle=target`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(
      r.body.openReports, null,
      "openReports: 0 on an unread table is the single most dangerous value here",
    );
    assert.equal(r.body.sections.openReports.status, "unavailable");
    assert.equal(r.body.degraded, true);
  });

  it("a fully readable record is still reported ok and degraded:false", async () => {
    const c = withAdminGuard(adminClient({
      rows: { moderation_actions: [{ id: "m1", action_type: "warn" }] },
    }));
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const r = await request("GET", `/admin/users/${TARGET_ID}/moderation-summary`);
    assert.equal(r.status, 200);
    assert.equal(r.body.degraded, false);
    assert.deepEqual(r.body.unavailableSections, []);
    assert.equal(r.body.sections.moderationActions.status, "ok");
    assert.equal((r.body.moderationActions as any[]).length, 1);
  });
});

// ── Sites 4 & 5 — Rent-a-Buddy risk scan and safety queue ─────────────────────

describe("rent-a-buddy risk scan: never a clean scan off an unread table", () => {
  it("POST /admin/run-risk-scan ABORTS with scan_incomplete instead of ok:true, flagged:[]", async () => {
    const c = withAdminGuard(adminClient({ failTables: new Set(["rent_buddy_safety_events"]) }));
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const r = await request("POST", `/api/rent-a-buddy/admin/run-risk-scan`, {});

    // OLD BEHAVIOUR: 200 { ok: true, flagged: [] } — a scan that measured
    // nothing, reported in the words of a scan that found nobody at risk.
    assert.equal(r.status, 500, `expected 500, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "scan_incomplete");
    assert.notEqual(r.body.ok, true, "an aborted scan must never claim ok:true");
  });

  it("does NOT downgrade a suspended buddy when the current risk state is unreadable", async () => {
    const writes: Array<{ table: string; values: any }> = [];

    // Enough safety events to cross the `no_show` threshold (3) for one user,
    // while rent_buddy_profiles — the CURRENT state — is unreadable.
    const c = withAdminGuard(adminClient({
      writes,
      failTables: new Set(["rent_buddy_profiles"]),
      rows: {
        rent_buddy_safety_events: [
          { target_user_id: TARGET_ID }, { target_user_id: TARGET_ID }, { target_user_id: TARGET_ID },
        ],
      },
    }));
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const r = await request("POST", `/api/rent-a-buddy/admin/run-risk-scan`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // OLD BEHAVIOUR: `?? "normal"` (index 0) made `newIdx > currentIdx` true for
    // every threshold, so a `suspended` buddy was silently rewritten to `watch`.
    const profileWrites = writes.filter((w) => w.table === "rent_buddy_profiles");
    assert.deepEqual(
      profileWrites, [],
      "no write may be made against an unread current risk state",
    );
    assert.deepEqual(r.body.flagged, [], "nothing was elevated, so nothing may be reported as elevated");
    assert.ok(
      (r.body.skipped as any[]).some((s) => s.userId === TARGET_ID && s.reason === "current_risk_unreadable"),
      `the skip must be named; got ${JSON.stringify(r.body.skipped)}`,
    );
  });

  it("still elevates when the current risk state IS readable and lower", async () => {
    // The fix must not disable the ratchet.
    const writes: Array<{ table: string; values: any }> = [];
    const c = withAdminGuard(adminClient({
      writes,
      singles: { rent_buddy_profiles: { risk_review_status: "normal" } },
      rows: {
        rent_buddy_safety_events: [
          { target_user_id: TARGET_ID }, { target_user_id: TARGET_ID }, { target_user_id: TARGET_ID },
        ],
      },
    }));
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const r = await request("POST", `/api/rent-a-buddy/admin/run-risk-scan`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(
      writes.some((w) => w.table === "rent_buddy_profiles" && w.values?.risk_review_status),
      "a readable, lower current state must still be elevated",
    );
    assert.ok((r.body.flagged as any[]).length > 0);
  });

  it("GET /admin/safety/events 500s instead of reporting an empty queue", async () => {
    const c = withAdminGuard(adminClient({ failTables: new Set(["rent_buddy_safety_events"]) }));
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const r = await request("GET", `/api/rent-a-buddy/admin/safety/events`);

    // OLD BEHAVIOUR: 200 { events: [], total: 0 } — "no open safety events",
    // which is exactly what a healthy queue looks like, so nobody looks again.
    assert.equal(r.status, 500, `expected 500, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.events, undefined, "must not ship an empty queue");
    assert.equal(r.body?.total, undefined);
  });
});

// ── Site 8 — Compass abuse detectors ─────────────────────────────────────────

describe("compass abuse scan: a detector that read nothing is not a clean detector", () => {
  /** Minimal fake whose named tables fail; every other read succeeds empty. */
  function scanClient(failTables: Set<string>) {
    function builder(table: string) {
      const fails = failTables.has(table);
      const b: any = {
        select: () => b, eq: () => b, in: () => b, gte: () => b, lte: () => b,
        or: () => b, is: () => b, not: () => b, order: () => b, limit: () => b,
        then: (resolve: any) =>
          Promise.resolve(
            fails ? { data: null, error: READ_ERROR } : { data: [], error: null },
          ).then(resolve),
      };
      return b;
    }
    return {
      from: (table: string) => ({
        select: () => builder(table),
        insert: async () => ({ data: null, error: null }),
        upsert: async () => ({ data: null, error: null }),
      }),
    } as any;
  }

  it("reports status 'incomplete' and names the failing detectors", async () => {
    const db = scanClient(new Set(["rent_buddy_reviews", "passport_stamps"]));
    const result = await runScan(db, null);

    // OLD BEHAVIOUR: { flagsWritten: 0 } — a value the scheduler logged as
    // "global scan completed", i.e. "we scanned, there is no abuse".
    assert.equal(result.status, "incomplete", "a scan with unread tables is not a clean scan");
    const names = result.failedDetectors.map((f) => f.detector).sort();
    assert.ok(names.includes("mutual_review_ring"), `got ${JSON.stringify(names)}`);
    assert.ok(names.includes("booking_loop"), "booking_loop also reads rent_buddy_reviews");
    assert.ok(names.includes("geotag_farming"), `got ${JSON.stringify(names)}`);
    assert.equal(result.flagsWritten, 0);
  });

  it("every one of the seven reading detectors can report its own failure", async () => {
    const cases: Array<[string, string]> = [
      ["rent_buddy_reviews",         "mutual_review_ring"],
      ["rent_buddy_bookings",        "booking_loop"],
      ["posts_comments",             "comment_pod"],
      ["hashtag_usage",              "hashtag_spam"],
      ["passport_stamps",            "geotag_farming"],
      ["compass_active_user_events", "available_now_abuse"],
    ];
    for (const [table, detector] of cases) {
      const result = await runScan(scanClient(new Set([table])), null);
      assert.equal(result.status, "incomplete", `${table} failing must mark the scan incomplete`);
      assert.ok(
        result.failedDetectors.some((f) => f.detector === detector),
        `${table} failing must be attributed to ${detector}; got ${JSON.stringify(result.failedDetectors)}`,
      );
    }
  });

  it("a genuinely empty but readable database is status 'ok'", async () => {
    // The distinction only means something if a real clean scan still reads clean.
    const result = await runScan(scanClient(new Set()), null);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.failedDetectors, []);
    assert.equal(result.flagsWritten, 0);
  });

  it("a null client is 'incomplete', not a clean scan", async () => {
    const result = await runScan(null, null);
    assert.equal(result.status, "incomplete", "no client means nothing was looked at");
    assert.equal(result.flagsWritten, 0);
  });
});
