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
 *   4. The maintenance pass lifts time-limited restrictions that have run out,
 *      and expireOldRestrictions reads its error instead of returning 0.
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
import { expireOldRestrictions, trustRestrictionLogger } from "../services/trust/TrustRestrictionService.js";
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

// ══ 4. Restriction expiry runs, and reports its failures ═════════════════════

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
      const db = failing(makeClient(tables()), "trust_restrictions", "update");
      const n = await expireOldRestrictions(db);
      assert.equal(n, 0);
      assert.equal(seen.length, 1, "one warn for the refused update");
      assert.match(String(seen[0][1]), /expireOldRestrictions failed/);
    } finally {
      (trustRestrictionLogger as any).warn = orig;
    }
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
    assert.equal(r.overall_score, 50, "the neutral baseline");
    assert.equal(r.evidenceWeight, 0);
    assert.equal(r.evidenceCount, 0);
    const read = await getTrustProfile(db, USER);
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
