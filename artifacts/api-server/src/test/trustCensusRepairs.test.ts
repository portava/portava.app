/**
 * Trust census repairs — docs/architecture/census-trust.md.
 *
 * Each block pins one BUILT-BUT-WRONG or NOT-BUILT row from the census and is
 * written so the hand-revert of that one repair fails it:
 *
 *   1. A pending_review event lands on the admin queue (trust_reviews), and
 *      confirming it closes that row. The engine's header always said serious
 *      events were "queued for admin review"; only the status was ever set.
 *   2. GET /admin/trust/events/pending exists and is admin-gated.
 *      TrustAdminService.getPendingEvents had no route.
 *   3. applyEventCaps keys on the EMITTED location vocabulary
 *      (`gps_coordinate_jump`), not the constant's name.
 *   4. The maintenance pass lifts time-limited restrictions that have run out;
 *      the sweep is BOUNDED per pass, reads its error on both halves, and
 *      reports {expired, truncated, failed} so the caller can tell a FAILED
 *      sweep from a TRUNCATED one from an IDLE successful one. Repeated passes
 *      drain the backlog rather than starving the oldest rows.
 *   5. PUT /admin/trust/settings/:key rejects values the engine cannot compute
 *      with (a zero half-life, a weight above 1, a fraction in an INTEGER).
 *   6. A recalculation publishes how much evidence stands behind the scores
 *      (migration 2371), in a statement separate from the score persist, and
 *      a pre-2371 row reads NULL — not zero.
 *   7. Migration 2370 revokes every anon/authenticated privilege on all seven
 *      trust tables and TRUNCATE from service_role; both migrations have a
 *      rollback.
 *
 * node:test + fake client, no live database. The fake resolves `{ data, error }`
 * the way postgrest-js does, so error-path tests exercise the real branch.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import trustAdminRouter, { trustSettingRejection } from "../routes/trust-admin.js";
import { recordTrustEvent } from "../services/trust/TrustEventService.js";
import { confirmEvent } from "../services/trust/TrustAdminService.js";
import { applyEventCaps } from "../services/trust/TrustCapService.js";
import {
  expireOldRestrictions,
  trustRestrictionLogger,
  RESTRICTION_EXPIRY_BATCH,
} from "../services/trust/TrustRestrictionService.js";
import { recalculateTrustScore, getTrustProfile, measureEvidence } from "../services/trust/TrustScoreService.js";
import { runTrustMaintenance } from "../lib/trustMaintenanceScheduler.js";

const USER   = "00000000-0000-0000-0000-00000000cea1";
const USER_2 = "00000000-0000-0000-0000-00000000cea2";
const ADMIN  = "00000000-0000-0000-0000-00000000ad01";

// ── Fake client ───────────────────────────────────────────────────────────────

type Store = Record<string, any[]>;

function makeClient(tables: Store) {
  let seq = 1;
  function from(table: string) {
    const store = (tables[table] ??= []);
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let limitN: number | null = null;
    let orderBy: { col: string; asc: boolean } | null = null;

    const b: any = {
      select() { return b; },
      insert(row: any) {
        const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...row };
        store.push(r); pendingInsert = r; return b;
      },
      upsert(row: any, opts?: any) {
        const key = opts?.onConflict ?? "id";
        const i = store.findIndex((r) => r[key] === row[key]);
        if (i >= 0) { store[i] = { ...store[i], ...row }; pendingInsert = store[i]; }
        else { const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...row }; store.push(r); pendingInsert = r; }
        return b;
      },
      update(patch: any) { pendingUpdate = patch; return b; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      gt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] > val); return b; },
      lt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] < val); return b; },
      or() { return b; },
      not() { return b; },
      order(col: string, opts?: any) { orderBy = { col, asc: opts?.ascending !== false }; return b; },
      limit(n: number) { limitN = n; return b; },
      range() { return b; },
      maybeSingle() { return one(); },
      single() { return one(); },
      then(onF: any, onR: any) { return list().then(onF, onR); },
    };

    function matched() {
      let rows = store.filter((r) => filters.every((f) => f(r)));
      if (orderBy) {
        const { col, asc } = orderBy;
        rows = [...rows].sort((x, y) => (x[col] > y[col] ? 1 : x[col] < y[col] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }
    async function one() {
      if (pendingInsert && !pendingUpdate) return { data: pendingInsert, error: null };
      const rows = matched();
      if (pendingUpdate) rows.forEach((r) => Object.assign(r, pendingUpdate));
      return { data: rows[0] ?? null, error: null };
    }
    async function list() {
      if (pendingInsert && !pendingUpdate) return { data: [pendingInsert], error: null, count: 1 };
      const rows = matched();
      if (pendingUpdate) rows.forEach((r) => Object.assign(r, pendingUpdate));
      return { data: rows, error: null, count: rows.length };
    }
    return b;
  }
  return { from, auth: { getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }) } } as any;
}

const SETTINGS_ROW = {
  id: 1,
  weight_plan_attendance: 0.18, weight_host_quality: 0.12, weight_communication: 0.10,
  weight_respect_safety: 0.15, weight_location_honesty: 0.13, weight_content_quality: 0.08,
  weight_community_value: 0.08, weight_guide_accuracy: 0.08, weight_passport_auth: 0.08,
  decay_half_life_days: 90,
  level_building_trust: 35, level_reliable: 50, level_trusted: 65, level_highly_trusted: 78, level_city_trusted: 90,
  daily_cap_plan_attend: 3, daily_cap_guide_verify: 5, daily_cap_gem_save: 10,
  weekly_cap_plan_attend: 10, weekly_cap_guide_verify: 20, weekly_cap_gem_save: 40,
  gaming_checkin_cluster_limit: 5, gaming_mutual_rate_threshold: 0.8, gaming_rapid_jump_points: 20,
};

function tables(overrides: Store = {}): Store {
  return {
    feature_flags: [
      { flag: "trust_engine_enabled", enabled: true },
      { flag: "trust_gaming_detection_enabled", enabled: false },
    ],
    trust_settings: [{ ...SETTINGS_ROW }],
    trust_events: [], trust_caps: [], trust_restrictions: [], trust_profiles: [],
    trust_reviews: [], trust_admin_actions: [], plan_attendance_events: [],
    ...overrides,
  };
}

/** A client whose `<table>.<op>` resolves the real postgrest failure shape. */
function failing(base: any, table: string, op: "insert" | "update") {
  return {
    ...base,
    from: (t: string) => {
      const real = base.from(t);
      if (t !== table) return real;
      const err = { message: `${table} ${op} refused`, code: "42501" };
      const dead: any = new Proxy({}, {
        get: (_o, k) => {
          if (k === "then") return (res: any, rej?: any) => Promise.resolve({ data: null, error: err }).then(res, rej);
          if (k === "maybeSingle" || k === "single") return async () => ({ data: null, error: err });
          return () => dead;
        },
      });
      return new Proxy(real, { get: (o, k) => (k === op ? () => dead : (o as any)[k]) });
    },
  };
}

/**
 * A client that lets a CONCURRENT pass land between a sweep's due-set read and
 * its write: the first `update()` on `trust_restrictions` stamps `id` with
 * `at` before the real update is issued. That window is the only place the
 * write's `.is("lifted_at", null)` re-assert does any work — the due-set read
 * has already excluded every row that was lifted BEFORE the sweep started.
 */
function racedLift(base: any, t: Store, id: string, at: string) {
  let raced = false;
  return {
    ...base,
    from: (name: string) => {
      const real = base.from(name);
      if (name !== "trust_restrictions") return real;
      return new Proxy(real, {
        get: (o: any, k: any) => {
          if (k === "update" && !raced) {
            return (patch: any) => {
              raced = true;
              const row = (t["trust_restrictions"] ?? []).find((r) => r.id === id);
              if (row) row.lifted_at = at;
              return o.update(patch);
            };
          }
          return o[k];
        },
      });
    },
  };
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const daysAhead = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

// ══ 1. Pending events reach the review queue ═════════════════════════════════

describe("pending_review events land on the admin review queue", () => {
  it("a serious event writes an open event_review row keyed by source_event_id", async () => {
    const t = tables();
    const db = makeClient(t);
    const r = await recordTrustEvent(db, {
      userId: USER, eventType: "gps_impossible_speed", category: "location_honesty",
      delta: -8, severity: "serious", sourceType: "gps", sourceId: "s1",
    });
    assert.equal(r.ok, true);
    assert.equal(r.pendingReview, true);
    const reviews = t.trust_reviews.filter((x) => x.source_event_id === r.eventId);
    assert.equal(reviews.length, 1, "exactly one review per pending event");
    assert.equal(reviews[0].review_type, "event_review");
    assert.equal(reviews[0].status, "open");
    assert.equal(reviews[0].user_id, USER);
    assert.equal(reviews[0].metadata.event_type, "gps_impossible_speed");
    assert.equal(reviews[0].metadata.severity, "serious");
  });

  it("an applied (minor) event writes no review row", async () => {
    const t = tables();
    const r = await recordTrustEvent(makeClient(t), {
      userId: USER, eventType: "plan_attended", category: "plan_attendance",
      delta: 5, severity: "minor", sourceType: "geofence_checkin", sourceId: "g1",
    });
    assert.equal(r.ok, true);
    assert.notEqual(r.pendingReview, true);
    assert.equal(t.trust_reviews.length, 0);
  });

  it("a failed review insert is non-fatal: the event is still recorded and reported", async () => {
    const t = tables();
    const db = failing(makeClient(t), "trust_reviews", "insert");
    const r = await recordTrustEvent(db, {
      userId: USER, eventType: "behavior_report_confirmed", category: "respect_safety",
      delta: -20, severity: "severe", sourceType: "moderation", sourceId: "m1",
    });
    assert.equal(r.ok, true, "the finding is the event; a queue failure must not lose it");
    assert.equal(r.pendingReview, true);
    assert.equal(t.trust_events.length, 1);
    assert.equal(t.trust_reviews.length, 0);
  });

  it("confirming the event resolves its queue row — the close that used to close nothing", async () => {
    const t = tables();
    const db = makeClient(t);
    const r = await recordTrustEvent(db, {
      userId: USER, eventType: "gps_impossible_speed", category: "location_honesty",
      delta: -8, severity: "serious", sourceType: "gps", sourceId: "s2",
    });
    await confirmEvent(db, ADMIN, r.eventId!, "verified trace");
    const review = t.trust_reviews.find((x) => x.source_event_id === r.eventId)!;
    assert.equal(review.status, "resolved");
    assert.equal(review.resolved_by, ADMIN);
    assert.equal(t.trust_events[0].status, "confirmed");
  });
});

// ══ 2. The pending-events route ══════════════════════════════════════════════

let server: http.Server;
let base = "";

function httpReq(method: string, p: string, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const u = new URL(base + p);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: { "content-type": "application/json", authorization: "Bearer test-token",
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => { let parsed: any = null; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; } resolve({ status: res.statusCode ?? 0, body: parsed }); });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function routeClient(role: string, t: Store) {
  const inner = makeClient(t);
  const c: any = {
    from: (table: string) => {
      if (table === "profiles") {
        const p: any = { select: () => p, eq: () => p, maybeSingle: async () => ({ data: { id: ADMIN, role }, error: null }) };
        return p;
      }
      return inner.from(table);
    },
    auth: { getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }) },
  };
  _setTestClient(c, true);
  _setTestServiceClient(c);
  return c;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(trustAdminRouter);
  server = http.createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
  server.close();
});

describe("GET /admin/trust/events/pending", () => {
  it("is refused for a non-admin", async () => {
    routeClient("user", tables());
    const { status } = await httpReq("GET", "/admin/trust/events/pending");
    assert.equal(status, 403);
  });

  it("lists only pending_review events, oldest first", async () => {
    const t = tables({
      trust_events: [
        { id: "e-old", user_id: USER, event_type: "gps_impossible_speed", category: "location_honesty", delta: -8, severity: "serious", status: "pending_review", source_type: "gps", metadata: {}, created_at: daysAgo(3) },
        { id: "e-applied", user_id: USER, event_type: "plan_attended", category: "plan_attendance", delta: 5, severity: "minor", status: "applied", source_type: "geofence_checkin", metadata: {}, created_at: daysAgo(2) },
        { id: "e-new", user_id: USER_2, event_type: "event_host_no_show", category: "host_quality", delta: -15, severity: "serious", status: "pending_review", source_type: "events", metadata: {}, created_at: daysAgo(1) },
      ],
    });
    routeClient("admin", t);
    const { status, body } = await httpReq("GET", "/admin/trust/events/pending");
    assert.equal(status, 200);
    assert.equal(body.total, 2);
    assert.deepEqual(body.events.map((e: any) => e.id), ["e-old", "e-new"]);
  });
});

// ══ 3. Cap map keys on the emitted vocabulary ════════════════════════════════

describe("applyEventCaps keys on the emitted location vocabulary", () => {
  it("gps_coordinate_jump — the string recordLocationTrustEvent writes — caps location_honesty", async () => {
    const t = tables();
    await applyEventCaps(makeClient(t), USER, "gps_coordinate_jump", "moderate", "evt-1");
    const caps = t.trust_caps.filter((c) => c.user_id === USER);
    assert.equal(caps.length, 1, "one cap for the finding");
    assert.equal(caps[0].category, "location_honesty");
    assert.equal(caps[0].reason_code, "coordinate_jump");
    assert.ok(caps[0].expires_at, "a coordinate jump ceiling is time-limited");
  });
});

// ══ 4. Restriction expiry runs, bounded, and reports its outcome ════════════
//
// THE THREE OUTCOMES. `expireOldRestrictions` used to return a bare number, and
// on any database error it returned 0 — the same 0 a clean sweep with nothing
// due returns. A broken restriction lift and an idle one were, at the call
// site, the same observation forever. It was also UNBOUNDED: one statement
// against a table that only grows.
//
// It now returns {expired, truncated, failed} and the maintenance pass carries
// all three out to its caller. The tests below pin each outcome AT THE CALLER
// (runTrustMaintenance), not only at the service, because the call site is
// where the collapse used to happen.

describe("maintenance lifts restrictions that have run out", () => {
  it("marks an expired restriction lifted and leaves a live one alone", async () => {
    const t = tables({
      trust_restrictions: [
        { id: "r-expired", user_id: USER, restriction_type: "hosting", reason: "x", expires_at: daysAgo(1), lifted_at: null },
        { id: "r-live", user_id: USER, restriction_type: "messaging", reason: "y", expires_at: daysAhead(5), lifted_at: null },
        { id: "r-permanent", user_id: USER_2, restriction_type: "hosting", reason: "z", expires_at: null, lifted_at: null },
      ],
    });
    const r = await runTrustMaintenance(makeClient(t));
    assert.equal(r.skipped, undefined);
    assert.equal(r.restrictionsExpired, 1);
    const by = Object.fromEntries(t.trust_restrictions.map((x) => [x.id, x]));
    assert.ok(by["r-expired"].lifted_at, "the lapsed restriction is now marked lifted");
    assert.equal(by["r-live"].lifted_at, null);
    assert.equal(by["r-permanent"].lifted_at, null);
  });

  it("expireOldRestrictions surfaces a failed update instead of a silent 0", async () => {
    const seen: any[] = [];
    const orig = trustRestrictionLogger.warn;
    (trustRestrictionLogger as any).warn = (...args: any[]) => { seen.push(args); };
    try {
      // A restriction must actually BE due. The sweep reads the due set first
      // and returns early when there is nothing to lift, so against an empty
      // table the refused update is never reached and this test would assert
      // nothing. The seeded row is what makes the refusal reachable.
      const t = tables({
        trust_restrictions: [
          { id: "r-expired", user_id: USER, restriction_type: "hosting", reason: "x", expires_at: daysAgo(1), lifted_at: null },
        ],
      });
      const db = failing(makeClient(t), "trust_restrictions", "update");
      const r = await expireOldRestrictions(db);
      assert.equal(r.expired, 0);
      assert.equal(
        r.failed, true,
        "the point of the rewrite: a refused lift is NOT a clean sweep with nothing to do",
      );
      assert.equal(t.trust_restrictions[0].lifted_at, null, "and nothing was lifted");
      assert.equal(seen.length, 1, "one warn for the refused update");
      assert.match(String(seen[0][1]), /expireOldRestrictions: lift failed/);
    } finally {
      (trustRestrictionLogger as any).warn = orig;
    }
  });

  it("a concurrent lift between the read and the write is NOT overwritten", async () => {
    // The write re-asserts `lifted_at IS NULL`. Remove it and this sweep
    // overwrites the instant the other pass recorded with its own, later one —
    // silently moving the moment a sanction is recorded as having ended.
    const ORIGINAL = "2026-01-01T00:00:00.000Z";
    const t = tables({
      trust_restrictions: [
        { id: "r-raced", user_id: USER, restriction_type: "hosting", reason: "x", expires_at: daysAgo(3), lifted_at: null },
      ],
    });
    const r = await expireOldRestrictions(racedLift(makeClient(t), t, "r-raced", ORIGINAL));
    assert.equal(r.failed, false, "losing a race is not an error");
    assert.equal(r.expired, 0, "this pass lifted nothing — the other pass got there first");
    assert.equal(
      t.trust_restrictions[0].lifted_at, ORIGINAL,
      "the FIRST lift's instant must survive; re-lifting would move it later",
    );
  });

  it("does not re-stamp a restriction another pass already lifted", async () => {
    // The write re-asserts `lifted_at IS NULL`. Without it, a second pass
    // racing the first would overwrite the original lifted_at with a later
    // instant — silently moving the recorded moment a sanction ended.
    const ORIGINAL = "2026-01-01T00:00:00.000Z";
    const t = tables({
      trust_restrictions: [
        { id: "r-already", user_id: USER, restriction_type: "hosting", reason: "x", expires_at: daysAgo(3), lifted_at: ORIGINAL },
      ],
    });
    const r = await expireOldRestrictions(makeClient(t));
    assert.equal(r.expired, 0);
    assert.equal(r.failed, false, "an already-lifted row is not a failure");
    assert.equal(
      t.trust_restrictions[0].lifted_at, ORIGINAL,
      "the first lift's instant must survive a later pass",
    );
  });
});

// ── 4b. The three outcomes, told apart at the CALLER ───────────────────────

describe("runTrustMaintenance distinguishes failure, truncation and an idle sweep", () => {
  it("IDLE SUCCESS — nothing was due, and the pass says so without claiming failure", async () => {
    const t = tables({
      trust_restrictions: [
        { id: "r-live", user_id: USER, restriction_type: "messaging", reason: "y", expires_at: daysAhead(5), lifted_at: null },
      ],
    });
    const r = await runTrustMaintenance(makeClient(t));
    assert.equal(r.restrictionsExpired, 0);
    assert.equal(r.restrictionSweepFailed, false, "zero lifted is not a failure when the sweep worked");
    assert.equal(r.restrictionSweepTruncated, false, "and it covered everything due — which was nothing");
  });

  it("FAILURE — zero lifted, but the pass reports it could not tell", async () => {
    const t = tables({
      trust_restrictions: [
        { id: "r-expired", user_id: USER, restriction_type: "hosting", reason: "x", expires_at: daysAgo(1), lifted_at: null },
      ],
    });
    const r = await runTrustMaintenance(failing(makeClient(t), "trust_restrictions", "update"));
    assert.equal(r.restrictionsExpired, 0, "same count as the idle pass above");
    assert.equal(
      r.restrictionSweepFailed, true,
      "and THAT is the difference the old Promise<number> could not express",
    );
    assert.equal(t.trust_restrictions[0].lifted_at, null, "the lapsed row is still listed as active");
  });

  it("TRUNCATED — a partial sweep never reads as full coverage", async () => {
    const t = tables({
      trust_restrictions: Array.from({ length: RESTRICTION_EXPIRY_BATCH + 1 }, (_, i) => ({
        id: `r-${i}`, user_id: USER, restriction_type: "hosting", reason: "x",
        expires_at: new Date(Date.now() - (RESTRICTION_EXPIRY_BATCH + 1 - i) * 60_000).toISOString(),
        lifted_at: null,
      })),
    });
    const r = await runTrustMaintenance(makeClient(t));
    assert.equal(r.restrictionsExpired, RESTRICTION_EXPIRY_BATCH, "one full batch, no more");
    assert.equal(r.restrictionSweepTruncated, true, "and the pass says there may be more");
    assert.equal(r.restrictionSweepFailed, false, "a bounded sweep is not a broken one");
  });

  it("STARVATION — repeated passes drain the whole backlog; the remainder is not dropped", async () => {
    // The bound is only safe if what it leaves behind is picked up. Seed one
    // more than a full batch, run passes until the sweep stops reporting
    // truncation, and require that EVERY eligible row ended up lifted.
    const total = RESTRICTION_EXPIRY_BATCH + 1;
    const t = tables({
      trust_restrictions: Array.from({ length: total }, (_, i) => ({
        id: `r-${i}`, user_id: USER, restriction_type: "hosting", reason: "x",
        expires_at: new Date(Date.now() - (total - i) * 60_000).toISOString(),
        lifted_at: null,
      })),
    });
    const db = makeClient(t);

    let passes = 0;
    let lifted = 0;
    for (;;) {
      const r = await runTrustMaintenance(db);
      passes += 1;
      lifted += r.restrictionsExpired;
      assert.equal(r.restrictionSweepFailed, false, `pass ${passes} must not fail`);
      if (!r.restrictionSweepTruncated) break;
      assert.ok(passes < 10, "must converge, not loop forever");
    }

    assert.equal(passes, 2, "one full batch, then the single remainder");
    assert.equal(lifted, total, "every eligible restriction was lifted across the passes");
    assert.equal(
      t.trust_restrictions.filter((x) => x.lifted_at == null).length, 0,
      "nothing was silently dropped by the bound",
    );
  });

  it("STARVATION — the oldest-overdue rows go first, so a newcomer cannot overtake them", async () => {
    // Ordering is what turns "bounded" into "eventually complete". If the due
    // set were unordered, a table that keeps gaining rows could leave the same
    // old ones behind on every pass.
    const t = tables({
      trust_restrictions: Array.from({ length: 7 }, (_, i) => ({
        id: `r-${i}`, user_id: USER, restriction_type: "hosting", reason: "x",
        expires_at: daysAgo(10 - i), lifted_at: null,   // r-0 is the most overdue
      })),
    });
    const db = makeClient(t);
    const liftedIds = () => t.trust_restrictions.filter((x) => x.lifted_at != null).map((x) => x.id).sort();

    const p1 = await expireOldRestrictions(db, 3);
    assert.equal(p1.expired, 3);
    assert.equal(p1.truncated, true);
    assert.deepEqual(liftedIds(), ["r-0", "r-1", "r-2"], "the three most overdue");

    // A brand-new lapsed restriction arrives mid-backlog. It is due, but it is
    // the YOUNGEST due row — it must not jump the queue.
    t.trust_restrictions.push({
      id: "r-newcomer", user_id: USER_2, restriction_type: "messaging", reason: "n",
      expires_at: daysAgo(0.1), lifted_at: null,
    } as any);

    const p2 = await expireOldRestrictions(db, 3);
    assert.equal(p2.expired, 3);
    assert.deepEqual(
      liftedIds(), ["r-0", "r-1", "r-2", "r-3", "r-4", "r-5"],
      "the next three oldest — the newcomer did not overtake r-3..r-5",
    );

    const p3 = await expireOldRestrictions(db, 3);
    assert.equal(p3.expired, 2, "the last original row plus the newcomer");
    assert.equal(p3.truncated, false, "under the cap — the backlog is drained");
    assert.equal(
      t.trust_restrictions.filter((x) => x.lifted_at == null).length, 0,
      "every eligible restriction, including the one that arrived mid-drain",
    );

    const p4 = await expireOldRestrictions(db, 3);
    assert.deepEqual(
      { expired: p4.expired, truncated: p4.truncated, failed: p4.failed },
      { expired: 0, truncated: false, failed: false },
      "and a further pass is a clean idle sweep, not a failure",
    );
  });
});

// ══ 5. Settings the engine cannot compute with are refused ═══════════════════

describe("PUT /admin/trust/settings/:key refuses values outside the engine's domain", () => {
  it("trustSettingRejection: the structural bounds", () => {
    assert.equal(trustSettingRejection("weight_host_quality", 0.2), null);
    assert.match(trustSettingRejection("weight_host_quality", 1.5)!, /at most 1/);
    assert.match(trustSettingRejection("weight_host_quality", -0.1)!, /at least 0/);
    assert.match(trustSettingRejection("decay_half_life_days", 0)!, /at least 1/);
    assert.match(trustSettingRejection("decay_half_life_days", 2.5)!, /integer/);
    assert.equal(trustSettingRejection("decay_half_life_days", 45), null);
    assert.match(trustSettingRejection("level_trusted", 101)!, /at most 100/);
    assert.match(trustSettingRejection("gaming_mutual_rate_threshold", 1.2)!, /at most 1/);
    assert.match(trustSettingRejection("gaming_rapid_jump_points", 0)!, /greater than 0/);
    assert.match(trustSettingRejection("daily_cap_gem_save", 3.5)!, /integer/);
    assert.match(trustSettingRejection("not_a_setting", 1)!, /Unknown/);
    assert.match(trustSettingRejection("weight_host_quality", Number.NaN)!, /finite/);
  });

  it("the route returns 400 with the reason and leaves the row untouched", async () => {
    const t = tables();
    routeClient("admin", t);
    const bad = await httpReq("PUT", "/admin/trust/settings/decay_half_life_days", { value: 0 });
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(bad.body), /at least 1/);
    assert.equal(t.trust_settings[0].decay_half_life_days, 90, "rejected value never reached the row");

    const ok = await httpReq("PUT", "/admin/trust/settings/decay_half_life_days", { value: 45 });
    assert.equal(ok.status, 200);
    assert.equal(t.trust_settings[0].decay_half_life_days, 45);
  });
});

// ══ 6. Evidence behind the score ═════════════════════════════════════════════

describe("recalculation publishes the evidence behind the scores", () => {
  it("measureEvidence: decay-weighted weight and raw count over the scored events", () => {
    const events = [{ created_at: daysAgo(0) }, { created_at: daysAgo(90) }, { created_at: daysAgo(180) }];
    const m = measureEvidence(events, 90);
    assert.equal(m.count, 3);
    // 1 + 0.5 + 0.25, to three decimals
    assert.ok(Math.abs(m.weight - 1.75) < 0.002, `weight ${m.weight} should be ~1.75`);
    assert.deepEqual(measureEvidence([], 90), { weight: 0, count: 0 });
  });

  it("a user with events gets weight and count persisted and returned", async () => {
    const t = tables({
      trust_events: [
        { user_id: USER, category: "host_quality", delta: 6, severity: "minor", status: "applied", created_at: daysAgo(1) },
        { user_id: USER, category: "host_quality", delta: 6, severity: "minor", status: "applied", created_at: daysAgo(2) },
        { user_id: USER, category: "communication", delta: -15, severity: "serious", status: "pending_review", created_at: daysAgo(1) },
      ],
    });
    const r = await recalculateTrustScore(makeClient(t), USER);
    assert.equal(r.evidenceCount, 2, "pending_review is not evidence — it is not scored either");
    assert.ok(r.evidenceWeight! > 1.9 && r.evidenceWeight! <= 2, `weight ${r.evidenceWeight}`);
    const row = t.trust_profiles.find((p) => p.user_id === USER)!;
    assert.equal(row.evidence_count, 2);
    assert.equal(row.evidence_weight, r.evidenceWeight);
  });

  it("a user with no events is MEASURED EMPTY (0), which is not the same as unmeasured (null)", async () => {
    const t = tables();
    const db = makeClient(t);
    const r = await recalculateTrustScore(db, USER);
    // Q1, owner decision 2026-09-22: the score line used to read
    // `assert.equal(r.overall_score, 50, "the neutral baseline")`. That baseline
    // was the fabricated neutral the decision removes, so with no events the
    // score is now NULL = not scored.
    //
    // THE SUBJECT OF THIS TEST IS UNCHANGED and is the two lines below it: the
    // EVIDENCE columns say 0 — "measured, and there was nothing there" — which
    // is a different answer from the `null` a pre-2371 row gives ("never
    // measured"). Q1 makes the SCORE carry that same distinction; it does not
    // disturb the evidence one, and the assertion is kept to prove that.
    assert.equal(r.overall_score, null, "no events means no score — not a neutral baseline");
    assert.equal(r.evidenceWeight, 0);
    assert.equal(r.evidenceCount, 0);

    // The read-back used to be taken on this same NEVER-SCORED user, which
    // assumed a row had been written for them. It is not written any more: see
    // "NO EVIDENCE IS NOT NEUTRAL EARNED TRUST" in TrustScoreService — the 50
    // above is arithmetic, never a measurement, and persisting it promoted a
    // user with nothing behind them to `reliable_traveler`. Asserted here so
    // the two facts stay adjacent rather than one quietly undoing the other.
    assert.equal(r.persisted, false, "a never-scored user is computed, not persisted");
    assert.equal(await getTrustProfile(db, USER), null);

    // The 0-vs-null ROUND TRIP THROUGH THE ROW is what this test is for, and it
    // is unchanged — taken on a user who HAS a row and whose evidence has since
    // decayed away. That is the same "measured, and there is nothing there"
    // state on the wire, and it is still refreshed and still reads 0, not null.
    const t2 = tables({
      trust_profiles: [{ user_id: USER, overall_score: 61, public_level: "reliable_traveler",
        plan_attendance: 50, host_quality: 72, communication: 50, respect_safety: 50, location_honesty: 50,
        content_quality: 50, community_value: 50, guide_accuracy: 50, passport_authenticity: 50 }],
    });
    const db2 = makeClient(t2);
    const r2 = await recalculateTrustScore(db2, USER);
    assert.equal(r2.persisted, true, "an existing row is still refreshed");
    const read = await getTrustProfile(db2, USER);
    assert.equal(read!.evidenceWeight, 0);
    assert.equal(read!.evidenceCount, 0);
  });

  it("a pre-2371 row reads null evidence — a consumer must not treat it as zero", async () => {
    const t = tables({
      trust_profiles: [{ user_id: USER, overall_score: 61, public_level: "reliable_traveler",
        plan_attendance: 50, host_quality: 72, communication: 50, respect_safety: 50, location_honesty: 50,
        content_quality: 50, community_value: 50, guide_accuracy: 50, passport_authenticity: 50 }],
    });
    const read = await getTrustProfile(makeClient(t), USER);
    assert.equal(read!.evidenceWeight, null);
    assert.equal(read!.evidenceCount, null);
  });

  it("the evidence write is a separate statement: when it is refused, the score still persists", async () => {
    const t = tables({
      trust_events: [
        { user_id: USER, category: "host_quality", delta: 6, severity: "minor", status: "applied", created_at: daysAgo(1) },
      ],
    });
    // update() is refused (a database without migration 2371 answers PGRST204);
    // upsert() is not — exactly production's shape today.
    const db = failing(makeClient(t), "trust_profiles", "update");
    const r = await recalculateTrustScore(db, USER);
    const row = t.trust_profiles.find((p) => p.user_id === USER);
    assert.ok(row, "the score persist landed");
    assert.equal(row.host_quality, r.categories.host_quality);
    assert.equal(row.evidence_weight, undefined, "the refused evidence write touched nothing");
    assert.equal(r.evidenceCount, 1, "the computed result still carries the measurement");
  });
});

// ══ 7. The migrations ════════════════════════════════════════════════════════

describe("migrations 2370 / 2371 say what the census says they say", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrations = path.resolve(here, "../migrations");
  const rollbacks = path.resolve(here, "../../../../db/rollback");
  const TRUST_TABLES = [
    "trust_admin_actions", "trust_caps", "trust_events", "trust_profiles",
    "trust_restrictions", "trust_reviews", "trust_settings",
  ];

  it("2370 revokes every role on all seven trust tables and grants service_role without TRUNCATE", () => {
    const sql = fs.readFileSync(path.join(migrations, "2370_trust_tables_privileges.sql"), "utf8");
    const listed = TRUST_TABLES.filter((tbl) => sql.includes(`'${tbl}'`));
    assert.equal(listed.length, 7, `all seven tables must be in the migration's list; found ${listed.length}`);
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      assert.match(sql, new RegExp(`REVOKE ALL ON public\\.%I FROM ${role}`), `REVOKE ALL FROM ${role}`);
    }
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.%I TO service_role/);
    assert.doesNotMatch(sql, /GRANT[^;]*TRUNCATE/, "nothing re-grants TRUNCATE");
    assert.match(sql, /RAISE EXCEPTION '2370 postcondition/, "the postcondition can fail");
    assert.ok(fs.existsSync(path.join(rollbacks, "2026-09-07-2370-trust-tables-privileges-rollback.sql")));
  });

  it("2371 adds two nullable, default-less evidence columns and has a rollback", () => {
    const sql = fs.readFileSync(path.join(migrations, "2371_trust_profiles_evidence.sql"), "utf8");
    assert.match(sql, /ADD COLUMN IF NOT EXISTS evidence_weight NUMERIC\(8,3\)/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS evidence_count\s+INTEGER/);
    assert.doesNotMatch(sql, /evidence_(weight|count)[^,;]*(NOT NULL|DEFAULT)/, "no default, nullable");
    assert.match(sql, /RAISE EXCEPTION '2371 postcondition/);
    const rb = fs.readFileSync(path.join(rollbacks, "2026-09-07-2371-trust-profiles-evidence-rollback.sql"), "utf8");
    assert.match(rb, /DROP COLUMN IF EXISTS evidence_weight/);
    assert.match(rb, /DROP COLUMN IF EXISTS evidence_count/);
  });
});
