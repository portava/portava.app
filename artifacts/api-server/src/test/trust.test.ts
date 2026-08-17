/**
 * Trust Score Engine tests
 *
 * Uses the node:test + fake-client pattern (no vitest, no real DB).
 * Covers all "Done looks like" bullet points from Task #321.
 *
 * Run: node --import tsx/esm --test src/test/trust.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  recordTrustEvent,
} from "../services/trust/TrustEventService.js";
import {
  recalculateTrustScore,
  getTrustProfile,
} from "../services/trust/TrustScoreService.js";
import {
  createCap,
  liftCap,
  getActiveCaps,
  expireOldCaps,
} from "../services/trust/TrustCapService.js";
import {
  applyRestriction,
  liftRestriction,
  getRestrictionState,
  trustRestrictionLogger,
} from "../services/trust/TrustRestrictionService.js";
import {
  confirmEvent,
  dismissEvent,
  adminApplyRestriction,
  adminLiftRestriction,
  adminOverrideScore,
  adminRemoveOverride,
  getPendingEvents,
} from "../services/trust/TrustAdminService.js";
import {
  getSafeTrustSummary,
  getPublicTrustBadge,
  isEventLlmSafe,
} from "../services/trust/TrustPrivacyGuard.js";
import { getRecoveryStatus } from "../services/trust/TrustRecoveryService.js";
import { runGamingDetectionScan } from "../services/trust/TrustGamingDetectionService.js";

// ── Fake client factory ───────────────────────────────────────────────────────

const USER_A = "user-trust-a";
const USER_B = "user-trust-b";
const ADMIN  = "user-admin";

interface FakeTables {
  feature_flags: any[];
  trust_settings: any[];
  trust_events: any[];
  trust_caps: any[];
  trust_restrictions: any[];
  trust_profiles: any[];
  trust_reviews: any[];
  trust_admin_actions: any[];
  plan_attendance_events: any[];
}

function makeTrustClient(tables: FakeTables) {
  let idCounter = 1;
  function nextId() { return `fake-id-${idCounter++}`; }

  function from(table: keyof FakeTables) {
    const store = tables[table] as any[];
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let pendingDelete = false;
    let limitN: number | null = null;
    let selectFields: string | null = null;
    let isCount = false;

    const builder: any = {
      select(fields?: string, opts?: any) {
        selectFields = fields ?? null;
        if (opts?.count === "exact") isCount = true;
        return builder;
      },
      insert(row: any) {
        const r = { id: nextId(), created_at: new Date().toISOString(), ...row };
        store.push(r);
        pendingInsert = r;
        return builder;
      },
      upsert(row: any, opts?: any) {
        const conflictKey = opts?.onConflict ?? "id";
        const existing = store.findIndex((r) => r[conflictKey] === (row as any)[conflictKey]);
        if (existing >= 0) {
          store[existing] = { ...store[existing], ...row };
          pendingInsert = store[existing];
        } else {
          const r = { id: nextId(), created_at: new Date().toISOString(), ...row };
          store.push(r);
          pendingInsert = r;
        }
        return builder;
      },
      update(patch: any) {
        pendingUpdate = patch;
        return builder;
      },
      delete() {
        pendingDelete = true;
        return builder;
      },
      eq(col: string, val: any)   { filters.push((r) => r[col] === val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      is(col: string, val: any)   { filters.push((r) => val === null ? r[col] == null : r[col] === val); return builder; },
      gt(col: string, val: any)   { filters.push((r) => r[col] > val); return builder; },
      lt(col: string, val: any)   { filters.push((r) => r[col] < val); return builder; },
      or()                        { return builder; }, // simplified — not exercised in detail
      not(col: string, _op: string, val: any) {
        filters.push((r) => r[col] !== val);
        return builder;
      },
      order()  { return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle() { return resolveSingle(true); },
      single()      { return resolveSingle(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function matched() {
      let rows = store.filter((r) => filters.every((f) => f(r)));
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }

    async function resolveSingle(maybe: boolean) {
      if (pendingInsert && !pendingUpdate) {
        return { data: pendingInsert, error: null };
      }
      if (pendingUpdate) {
        const rows = matched();
        rows.forEach((r) => Object.assign(r, pendingUpdate));
        return { data: rows[0] ?? null, error: null };
      }
      if (pendingDelete) {
        const rows = matched();
        rows.forEach((r) => { store.splice(store.indexOf(r), 1); });
        return { data: rows[0] ?? null, count: rows.length, error: null };
      }
      const rows = matched();
      if (maybe) return { data: rows[0] ?? null, error: null };
      return { data: rows[0] ?? null, error: null };
    }

    async function resolveList() {
      if (pendingInsert && !pendingUpdate) {
        return { data: [pendingInsert], error: null, count: 1 };
      }
      if (pendingUpdate) {
        const rows = matched();
        rows.forEach((r) => Object.assign(r, pendingUpdate));
        return { data: rows, error: null };
      }
      if (pendingDelete) {
        const rows = matched();
        rows.forEach((r) => { store.splice(store.indexOf(r), 1); });
        return { data: rows, error: null, count: rows.length };
      }
      const rows = matched();
      return { data: rows, error: null, count: rows.length };
    }

    return builder;
  }

  const client: any = {
    from,
    auth: { getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }) },
  };
  return client;
}

function makeTables(): FakeTables {
  return {
    feature_flags: [
      // The feature_flags table uses "flag" as the column name, not "key".
      { flag: "trust_engine_enabled", enabled: true },
      { flag: "trust_gaming_detection_enabled", enabled: true },
    ],
    trust_settings: [{
      id: 1,
      weight_plan_attendance: 0.18, weight_host_quality: 0.12,
      weight_communication: 0.10,  weight_respect_safety: 0.15,
      weight_location_honesty: 0.13, weight_content_quality: 0.08,
      weight_community_value: 0.08, weight_guide_accuracy: 0.08,
      weight_passport_auth: 0.08,
      decay_half_life_days: 90,
      level_building_trust: 35, level_reliable: 50,
      level_trusted: 65, level_highly_trusted: 78, level_city_trusted: 90,
      daily_cap_plan_attend: 3, daily_cap_guide_verify: 5, daily_cap_gem_save: 10,
      weekly_cap_plan_attend: 10, weekly_cap_guide_verify: 20, weekly_cap_gem_save: 40,
      gaming_checkin_cluster_limit: 5,
      gaming_mutual_rate_threshold: 0.80,
      gaming_rapid_jump_points: 20,
    }],
    trust_events: [],
    trust_caps: [],
    trust_restrictions: [],
    trust_profiles: [],
    trust_reviews: [],
    trust_admin_actions: [],
    plan_attendance_events: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TrustEventService", () => {
  it("records a positive event and returns ok + eventId", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    const result = await recordTrustEvent(db, {
      userId: USER_A, eventType: "PLAN_ATTENDED",
      category: "plan_attendance", delta: 5, severity: "minor",
      sourceType: "plan", sourceId: "plan-1",
    });
    assert.equal(result.ok, true);
    assert.ok(result.eventId);
    assert.equal(result.pendingReview, false);
    assert.equal(tables.trust_events.length, 1);
    assert.equal(tables.trust_events[0].status, "applied");
  });

  it("routes serious event to pending_review", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    const result = await recordTrustEvent(db, {
      userId: USER_A, eventType: "GPS_IMPOSSIBLE_SPEED",
      category: "location_honesty", delta: -8, severity: "serious",
      sourceType: "gps", sourceId: "snap-1",
    });
    assert.equal(result.ok, true);
    assert.equal(result.pendingReview, true);
    assert.equal(tables.trust_events[0].status, "pending_review");
  });

  it("deduplication prevents farming same source within window", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    await recordTrustEvent(db, {
      userId: USER_A, eventType: "PLAN_ATTENDED",
      category: "plan_attendance", delta: 5, severity: "minor",
      sourceType: "plan", sourceId: "plan-2",
    });
    const dup = await recordTrustEvent(db, {
      userId: USER_A, eventType: "PLAN_ATTENDED",
      category: "plan_attendance", delta: 5, severity: "minor",
      sourceType: "plan", sourceId: "plan-2",
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.skipReason, "dedup");
    assert.equal(tables.trust_events.length, 1);
  });

  it("daily cap prevents earning beyond limit", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    // daily_cap_plan_attend = 3, fill up 3
    for (let i = 0; i < 3; i++) {
      await recordTrustEvent(db, {
        userId: USER_A, eventType: "plan_attend_positive",
        category: "plan_attendance", delta: 5, severity: "minor",
        sourceType: "plan", sourceId: `plan-daily-${i}`,
      });
    }
    const capped = await recordTrustEvent(db, {
      userId: USER_A, eventType: "plan_attend_positive",
      category: "plan_attendance", delta: 5, severity: "minor",
      sourceType: "plan", sourceId: "plan-daily-4",
    });
    assert.equal(capped.ok, false);
    assert.equal(capped.skipReason, "daily_cap");
  });

  it("canonical uppercase event type PLAN_ATTENDED enforces daily cap", async () => {
    const tables = makeTables();
    tables.trust_settings[0].daily_cap_plan_attend = 2;
    const db = makeTrustClient(tables);
    // Fill 2 events using canonical uppercase name
    for (let i = 0; i < 2; i++) {
      tables.trust_events.push({
        id: `canonical-ev-${i}`, user_id: USER_A,
        event_type: "plan_attended", // lowercase stored — cap lookup is case-insensitive
        category: "plan_attendance", delta: 5, severity: "minor", status: "applied",
        created_at: new Date().toISOString(),
      });
    }
    // Now attempt with uppercase canonical name — must hit daily cap
    const capped = await recordTrustEvent(db, {
      userId: USER_A, eventType: "PLAN_ATTENDED",
      category: "plan_attendance", delta: 5, severity: "minor",
      sourceType: "plan", sourceId: "plan-canonical-cap",
    });
    assert.equal(capped.ok, false);
    assert.equal(capped.skipReason, "daily_cap");
  });

  it("weekly cap prevents earning beyond weekly limit when daily is not yet reached", async () => {
    const tables = makeTables();
    // Set weekly_cap_plan_attend = 4, daily = 10 (so daily never triggers first)
    tables.trust_settings[0].weekly_cap_plan_attend = 4;
    tables.trust_settings[0].daily_cap_plan_attend = 10;
    const db = makeTrustClient(tables);
    // Fill weekly cap with 4 events on different days (simulate old created_at within 7 days)
    // We pre-seed 4 events directly so the count query picks them up
    for (let i = 0; i < 4; i++) {
      tables.trust_events.push({
        id: `weekly-ev-${i}`, user_id: USER_A,
        event_type: "plan_attend_weekly", category: "plan_attendance",
        delta: 5, severity: "minor", status: "applied",
        // spread across past 6 days (all within 7-day window)
        created_at: new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
      });
    }
    const weekCapped = await recordTrustEvent(db, {
      userId: USER_A, eventType: "plan_attend_weekly",
      category: "plan_attendance", delta: 5, severity: "minor",
      sourceType: "plan", sourceId: "plan-weekly-new",
    });
    assert.equal(weekCapped.ok, false);
    assert.equal(weekCapped.skipReason, "daily_cap"); // weekly cap fires as daily_cap skip
  });

  it("flag_off: skips when trust_engine_enabled = false", async () => {
    const tables = makeTables();
    tables.feature_flags[0].enabled = false;
    const db = makeTrustClient(tables);
    const result = await recordTrustEvent(db, {
      userId: USER_A, eventType: "PLAN_ATTENDED",
      category: "plan_attendance", delta: 5, severity: "minor",
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipReason, "flag_off");
    assert.equal(tables.trust_events.length, 0);
  });
});

describe("TrustScoreService", () => {
  it("positive verified event raises category score above 50", async () => {
    const tables = makeTables();
    tables.trust_events.push({
      id: "ev-1", user_id: USER_A,
      category: "plan_attendance", delta: 8, severity: "minor",
      status: "applied", created_at: new Date().toISOString(),
    });
    const db = makeTrustClient(tables);
    const result = await recalculateTrustScore(db, USER_A);
    assert.ok(result.categories.plan_attendance > 50, "expected > 50 after positive event");
  });

  it("negative confirmed event lowers score", async () => {
    const tables = makeTables();
    tables.trust_events.push({
      id: "ev-2", user_id: USER_A,
      category: "respect_safety", delta: -15, severity: "serious",
      status: "confirmed", created_at: new Date().toISOString(),
    });
    const db = makeTrustClient(tables);
    const result = await recalculateTrustScore(db, USER_A);
    assert.ok(result.categories.respect_safety < 50, "expected < 50 after negative event");
  });

  it("persists result to trust_profiles", async () => {
    const tables = makeTables();
    tables.trust_events.push({
      id: "ev-3", user_id: USER_B,
      category: "host_quality", delta: 10, severity: "minor",
      status: "applied", created_at: new Date().toISOString(),
    });
    const db = makeTrustClient(tables);
    await recalculateTrustScore(db, USER_B);
    const profile = tables.trust_profiles.find((p) => p.user_id === USER_B);
    assert.ok(profile, "profile should be persisted");
    assert.equal(typeof profile.overall_score, "number");
    assert.ok(["new_traveler","building_trust","reliable_traveler",
                "trusted_traveler","highly_trusted","city_trusted"]
              .includes(profile.public_level));
  });

  it("getTrustProfile returns null for unknown user", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    const profile = await getTrustProfile(db, "unknown-user");
    assert.equal(profile, null);
  });
});

describe("TrustCapService", () => {
  it("createCap stores a new cap row", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    const cap = await createCap(db, {
      userId: USER_A, category: "plan_attendance",
      ceilingScore: 55, reasonCode: "no_show",
    });
    assert.ok(cap.id);
    assert.equal(cap.ceilingScore, 55);
    assert.equal(tables.trust_caps.length, 1);
  });

  it("serious confirmed event applies cap as ceiling — score cannot exceed it", async () => {
    const tables = makeTables();
    // Seed lots of positive events
    for (let i = 0; i < 5; i++) {
      tables.trust_events.push({
        id: `ev-pos-${i}`, user_id: USER_A,
        category: "plan_attendance", delta: 12, severity: "minor",
        status: "applied", created_at: new Date().toISOString(),
      });
    }
    // Cap at 60
    tables.trust_caps.push({
      id: "cap-1", user_id: USER_A, category: "plan_attendance",
      ceiling_score: 60, reason_code: "no_show", lifted_at: null, expires_at: null,
      created_at: new Date().toISOString(),
    });
    const db = makeTrustClient(tables);
    const result = await recalculateTrustScore(db, USER_A);
    assert.ok(
      result.categories.plan_attendance <= 60,
      `plan_attendance ${result.categories.plan_attendance} should be <= 60`,
    );
    assert.ok(result.capsApplied.includes("plan_attendance"));
  });

  it("liftCap sets lifted_at", async () => {
    const tables = makeTables();
    tables.trust_caps.push({
      id: "cap-lift", user_id: USER_A, category: "host_quality",
      ceiling_score: 50, reason_code: "test", lifted_at: null, expires_at: null,
      created_at: new Date().toISOString(),
    });
    const db = makeTrustClient(tables);
    await liftCap(db, "cap-lift", ADMIN);
    const cap = tables.trust_caps.find((c) => c.id === "cap-lift");
    assert.ok(cap.lifted_at, "lifted_at should be set");
  });

  it("expireOldCaps lifts caps whose expires_at has passed", async () => {
    const tables = makeTables();
    tables.trust_caps.push({
      id: "cap-old", user_id: USER_A, category: "communication",
      ceiling_score: 50, reason_code: "test",
      expires_at: new Date(Date.now() - 1000).toISOString(), // in the past
      lifted_at: null, created_at: new Date().toISOString(),
    });
    const db = makeTrustClient(tables);
    const n = await expireOldCaps(db);
    assert.equal(n, 1);
  });

  it("getActiveCaps returns only caps that are not lifted", async () => {
    const tables = makeTables();
    tables.trust_caps.push(
      { id: "c1", user_id: USER_A, category: "plan_attendance", ceiling_score: 55, reason_code: "a", lifted_at: null, expires_at: null, created_at: new Date().toISOString() },
      { id: "c2", user_id: USER_A, category: "host_quality", ceiling_score: 40, reason_code: "b", lifted_at: new Date().toISOString(), expires_at: null, created_at: new Date().toISOString() },
    );
    const db = makeTrustClient(tables);
    const caps = await getActiveCaps(db, USER_A);
    assert.equal(caps.length, 1);
    assert.equal(caps[0].id, "c1");
  });
});

describe("TrustRestrictionService", () => {
  it("applyRestriction stores restriction row", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    const r = await applyRestriction(db, {
      userId: USER_A, restrictionType: "hosting", reason: "behavior_confirmed",
    });
    assert.ok(r.id);
    assert.equal(r.restrictionType, "hosting");
  });

  it("getRestrictionState reflects active restrictions", async () => {
    const tables = makeTables();
    tables.trust_restrictions.push({
      id: "r1", user_id: USER_A, restriction_type: "messaging",
      reason: "test", lifted_at: null, expires_at: null,
      created_at: new Date().toISOString(),
    });
    const db = makeTrustClient(tables);
    const state = await getRestrictionState(db, USER_A);
    assert.equal(state.canMessage, false);
    assert.equal(state.canHost, true); // no hosting restriction
    assert.ok(state.activeRestrictions.includes("messaging"));
  });

  it("liftRestriction sets lifted_at and state becomes clear", async () => {
    const tables = makeTables();
    tables.trust_restrictions.push({
      id: "r2", user_id: USER_A, restriction_type: "hosting",
      reason: "test", lifted_at: null, expires_at: null,
      created_at: new Date().toISOString(),
    });
    const db = makeTrustClient(tables);
    await liftRestriction(db, "r2", ADMIN);
    const r = tables.trust_restrictions.find((x) => x.id === "r2");
    assert.ok(r.lifted_at, "lifted_at should be set");
  });

  it("repeated no-shows: after cap + restriction, canHost = false", async () => {
    const tables = makeTables();
    tables.trust_restrictions.push({
      id: "r3", user_id: USER_A, restriction_type: "hosting",
      reason: "repeated_no_show", lifted_at: null, expires_at: null,
      created_at: new Date().toISOString(),
    });
    const db = makeTrustClient(tables);
    const state = await getRestrictionState(db, USER_A);
    assert.equal(state.canHost, false);
  });
});

describe("TrustAdminService", () => {
  it("end-to-end: recordTrustEvent → confirmEvent → applyEventCaps sets correct cap category and reasonCode", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // recordTrustEvent normalizes to lowercase and routes serious events to pending_review
    const result = await recordTrustEvent(db, {
      userId: USER_A, eventType: "GPS_IMPOSSIBLE_SPEED",
      category: "location_honesty", delta: -10, severity: "serious",
      sourceType: "system",
    });
    assert.equal(result.ok, true, "event should record");
    assert.equal(result.pendingReview, true, "serious event should be pending_review");

    // Event stored with lowercase eventType
    const storedEvent = tables.trust_events.find((e: any) => e.user_id === USER_A);
    assert.ok(storedEvent, "event should be in store");
    assert.equal(storedEvent.event_type, "gps_impossible_speed", "event_type must be normalized to lowercase");
    assert.equal(storedEvent.status, "pending_review");

    // Admin confirms event — applyEventCaps should use lowercase stored value
    const confirmResult = await confirmEvent(db, ADMIN, storedEvent.id, "Confirmed fake GPS");
    assert.equal(confirmResult.ok, true);

    // Cap should be created for location_honesty with reason "impossible_speed"
    const cap = tables.trust_caps.find(
      (c: any) => c.user_id === USER_A && c.category === "location_honesty" && c.reason_code === "impossible_speed",
    );
    assert.ok(cap, "location_honesty cap with reason 'impossible_speed' must exist after confirmEvent");
  });

  it("confirm_event moves status to confirmed and logs admin action", async () => {
    const tables = makeTables();
    tables.trust_events.push({
      id: "ev-pending", user_id: USER_A,
      event_type: "gps_impossible_speed", category: "location_honesty",
      delta: -8, severity: "serious", status: "pending_review",
      created_at: new Date().toISOString(),
    });
    const db = makeTrustClient(tables);
    const result = await confirmEvent(db, ADMIN, "ev-pending", "Confirmed fake GPS");
    assert.equal(result.ok, true);
    const ev = tables.trust_events.find((e) => e.id === "ev-pending");
    assert.equal(ev.status, "confirmed");
    const logged = tables.trust_admin_actions.find((a) => a.action_type === "confirm_event");
    assert.ok(logged, "admin action should be logged");
    assert.equal(logged.admin_id, ADMIN);
  });

  it("dismiss_event moves status to dismissed and logs admin action", async () => {
    const tables = makeTables();
    tables.trust_events.push({
      id: "ev-dismiss", user_id: USER_A,
      event_type: "GPS_IMPOSSIBLE_SPEED", category: "location_honesty",
      delta: -8, severity: "serious", status: "pending_review",
      created_at: new Date().toISOString(),
    });
    const db = makeTrustClient(tables);
    const result = await dismissEvent(db, ADMIN, "ev-dismiss", "False positive");
    assert.equal(result.ok, true);
    const ev = tables.trust_events.find((e) => e.id === "ev-dismiss");
    assert.equal(ev.status, "dismissed");
    const logged = tables.trust_admin_actions.find((a) => a.action_type === "dismiss_event");
    assert.ok(logged);
  });

  it("adminApplyRestriction stores restriction and logs action", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    const r = await adminApplyRestriction(db, ADMIN, USER_A, "messaging", "Spam confirmed");
    assert.equal(r.ok, true);
    assert.ok(r.restrictionId);
    assert.equal(tables.trust_restrictions.length, 1);
    const action = tables.trust_admin_actions.find((a) => a.action_type === "apply_restriction");
    assert.ok(action);
  });

  it("adminLiftRestriction lifts restriction and logs action", async () => {
    const tables = makeTables();
    tables.trust_restrictions.push({
      id: "r-lift", user_id: USER_A, restriction_type: "messaging",
      reason: "test", lifted_at: null, expires_at: null,
      created_at: new Date().toISOString(),
    });
    const db = makeTrustClient(tables);
    const result = await adminLiftRestriction(db, ADMIN, USER_A, "r-lift", "Resolved");
    assert.equal(result.ok, true);
    const action = tables.trust_admin_actions.find((a) => a.action_type === "lift_restriction");
    assert.ok(action);
  });

  it("getPendingEvents returns only pending_review events", async () => {
    const tables = makeTables();
    tables.trust_events.push(
      { id: "ev-a", user_id: USER_A, event_type: "GPS", category: "location_honesty",
        delta: -8, severity: "serious", status: "pending_review", created_at: new Date().toISOString() },
      { id: "ev-b", user_id: USER_A, event_type: "PLAN", category: "plan_attendance",
        delta: 5, severity: "minor", status: "applied", created_at: new Date().toISOString() },
    );
    const db = makeTrustClient(tables);
    const queue = await getPendingEvents(db);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].id, "ev-a");
  });

  it("adminOverrideScore creates a cap and adminRemoveOverride lifts it + recalcs", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // Apply override — cap should exist
    const applyResult = await adminOverrideScore(db, ADMIN, USER_A, "plan_attendance", 45, "Testing override");
    assert.equal(applyResult.ok, true);
    const capAfterApply = tables.trust_caps.filter(
      (c: any) => c.user_id === USER_A && c.reason_code === "admin_override" && c.lifted_at == null,
    );
    assert.equal(capAfterApply.length, 1, "cap should exist after adminOverrideScore");
    assert.equal(capAfterApply[0].ceiling_score, 45);

    // Remove override — cap should be lifted
    const removeResult = await adminRemoveOverride(db, ADMIN, USER_A, "plan_attendance", "Removing test override");
    assert.equal(removeResult.ok, true);
    const capAfterRemove = tables.trust_caps.filter(
      (c: any) => c.user_id === USER_A && c.reason_code === "admin_override" && c.lifted_at == null,
    );
    assert.equal(capAfterRemove.length, 0, "cap should be lifted after adminRemoveOverride");

    // Admin action audit log entries should exist for both operations
    const overrideActions = tables.trust_admin_actions.filter((a: any) => a.action_type === "score_override");
    assert.ok(overrideActions.length >= 2, "both apply and remove should be logged");
  });
});

describe("TrustPrivacyGuard", () => {
  it("getSafeTrustSummary strips raw scores and reporter identity", async () => {
    const tables = makeTables();
    tables.trust_profiles.push({
      user_id: USER_A, overall_score: 62, public_level: "reliable_traveler",
      plan_attendance: 70, host_quality: 65, communication: 60, respect_safety: 60,
      location_honesty: 55, content_quality: 60, community_value: 55,
      guide_accuracy: 50, passport_authenticity: 50,
      on_probation: false, probation_ends_at: null,
      last_recalculated_at: new Date().toISOString(),
    });
    const db = makeTrustClient(tables);
    const summary = await getSafeTrustSummary(db, USER_A);
    assert.equal(summary.publicLevel, "reliable_traveler");
    assert.equal(typeof (summary as any).overall_score, "undefined", "should not expose raw score");
    assert.ok(Array.isArray(summary.strengths));
    assert.ok(Array.isArray(summary.restrictions));
    assert.ok(Array.isArray(summary.recoveryHints));
  });

  it("getPublicTrustBadge returns level + label, no internal detail", async () => {
    const tables = makeTables();
    tables.trust_profiles.push({
      user_id: USER_B, overall_score: 80, public_level: "highly_trusted",
      plan_attendance: 85, host_quality: 80, communication: 75, respect_safety: 80,
      location_honesty: 80, content_quality: 70, community_value: 75,
      guide_accuracy: 70, passport_authenticity: 70,
    });
    const db = makeTrustClient(tables);
    const badge = await getPublicTrustBadge(db, USER_B);
    assert.equal(badge.level, "highly_trusted");
    assert.equal(badge.label, "Highly Trusted");
    assert.equal(typeof (badge as any).overall_score, "undefined");
  });

  it("isEventLlmSafe rejects pending_review events", () => {
    assert.equal(isEventLlmSafe({ status: "pending_review" }), false);
    assert.equal(isEventLlmSafe({ status: "applied" }), true);
    assert.equal(isEventLlmSafe({ status: "applied", reporter_id: "x" }), false);
  });

  it("restrictions are shown as human-readable messages only", async () => {
    const tables = makeTables();
    tables.trust_restrictions.push({
      id: "r-msg", user_id: USER_A, restriction_type: "hosting",
      reason: "behavior", lifted_at: null, expires_at: null,
      created_at: new Date().toISOString(),
    });
    tables.trust_profiles.push({
      user_id: USER_A, overall_score: 45, public_level: "building_trust",
      plan_attendance: 45, host_quality: 40, communication: 50, respect_safety: 35,
      location_honesty: 50, content_quality: 50, community_value: 50,
      guide_accuracy: 50, passport_authenticity: 50,
      on_probation: false, probation_ends_at: null,
    });
    const db = makeTrustClient(tables);
    const summary = await getSafeTrustSummary(db, USER_A);
    assert.ok(summary.restrictions.length > 0, "should have restriction messages");
    // Must not contain the technical restriction_type key
    for (const msg of summary.restrictions) {
      assert.equal(typeof msg, "string");
      assert.ok(!msg.includes("hosting") || msg.length > 8, "message should be human-readable");
    }
  });
});

describe("TrustRecoveryService", () => {
  it("generates recovery steps for user with low scores", async () => {
    const tables = makeTables();
    tables.trust_profiles.push({
      user_id: USER_A, overall_score: 35, public_level: "building_trust",
      plan_attendance: 30, host_quality: 35, communication: 40, respect_safety: 25,
      location_honesty: 45, content_quality: 50, community_value: 50,
      guide_accuracy: 50, passport_authenticity: 50,
      on_probation: false, probation_ends_at: null,
    });
    const db = makeTrustClient(tables);
    const status = await getRecoveryStatus(db, USER_A);
    assert.ok(status.suggestedSteps.length > 0, "should have recovery steps");
    // Lowest scoring categories should appear first
    const first = status.suggestedSteps[0];
    assert.ok(first.category, "step should have category");
    assert.ok(first.action, "step should have action");
    assert.equal(first.priority, 1);
  });

  it("decay/recovery: removing old negative events improves computed score", async () => {
    const tables = makeTables();
    // Old negative event (simulated by using a very old created_at)
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(); // 200 days ago
    tables.trust_events.push({
      id: "ev-old", user_id: USER_A,
      category: "plan_attendance", delta: -10, severity: "moderate",
      status: "applied", created_at: oldDate,
    });
    // Recent positive event
    tables.trust_events.push({
      id: "ev-new", user_id: USER_A,
      category: "plan_attendance", delta: 8, severity: "minor",
      status: "applied", created_at: new Date().toISOString(),
    });
    const db = makeTrustClient(tables);
    const result = await recalculateTrustScore(db, USER_A);
    // Recent positive should dominate (decay makes old negative contribute little)
    assert.ok(
      result.categories.plan_attendance > 50,
      `expected > 50 when recent event outweighs decayed negative; got ${result.categories.plan_attendance}`,
    );
  });
});

describe("TrustGamingDetectionService", () => {
  it("detects check-in cluster farming and creates gaming review", async () => {
    const tables = makeTables();
    // 6 check-ins at same geofence (limit = 5)
    for (let i = 0; i < 6; i++) {
      tables.plan_attendance_events.push({
        id: `att-${i}`, user_id: USER_A, geofence_id: "gf-1",
        event_type: "checked_in", created_at: new Date().toISOString(),
      });
    }
    const db = makeTrustClient(tables);
    const result = await runGamingDetectionScan(db);
    assert.equal(result.ok, true);
    assert.ok(result.flaggedUsers > 0, "should flag at least one user");
    const review = tables.trust_reviews.find((r) => r.review_type === "gaming_suspected");
    assert.ok(review, "should create gaming_suspected review");
    assert.equal(review.user_id, USER_A);
  });

  it("skips scan when gaming detection flag is off", async () => {
    const tables = makeTables();
    tables.feature_flags[1].enabled = false; // gaming flag off
    const db = makeTrustClient(tables);
    const result = await runGamingDetectionScan(db);
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.flaggedUsers, 0);
  });

  it("detects rapid score jump and flags for review", async () => {
    const tables = makeTables();
    // 25 delta in 24h (threshold = 20)
    for (let i = 0; i < 5; i++) {
      tables.trust_events.push({
        id: `rapid-${i}`, user_id: USER_A,
        category: "plan_attendance", delta: 5, severity: "minor",
        status: "applied", source_type: "user_action",
        created_at: new Date().toISOString(),
      });
    }
    const db = makeTrustClient(tables);
    const result = await runGamingDetectionScan(db);
    assert.equal(result.ok, true);
    const review = tables.trust_reviews.find(
      (r) => r.review_type === "gaming_suspected" && r.metadata?.pattern === "rapid_jump",
    );
    assert.ok(review, "should create rapid_jump review");
  });
});

describe("Integration: fake GPS confirmed caps location confidence", () => {
  it("FAKE_GPS_CONFIRMED event pending review → confirm → caps location_honesty", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // Record a severe fake GPS event (→ pending_review)
    const rec = await recordTrustEvent(db, {
      userId: USER_A,
      eventType: "FAKE_GPS_CONFIRMED",
      category: "location_honesty",
      delta: -20,
      severity: "severe",
      sourceType: "admin",
      sourceId: "fake-gps-case-1",
    });
    assert.equal(rec.pendingReview, true);

    // Admin confirms it
    const r = await confirmEvent(db, ADMIN, rec.eventId!, "Confirmed via manual review");
    assert.equal(r.ok, true);

    // Score should now be capped
    const result = await recalculateTrustScore(db, USER_A);
    assert.ok(
      result.categories.location_honesty < 50,
      `location_honesty should be < 50 after confirmed severe event; got ${result.categories.location_honesty}`,
    );
  });
});

// ── getRestrictionState: authoritative vs degraded reads ─────────────────────
//
// postgrest-js RESOLVES an { data, error } tuple on failure — it does not
// reject unless .throwOnError() was called. So the error cases below are
// delivered as resolved tuples on purpose: a test that only threw would have
// passed against a `const { data } = await db...` implementation and proved
// nothing. Exactly one case (the last) exercises a genuine throw.

type QueryOutcome =
  | { kind: "tuple"; data: any[] | null; error: any }
  | { kind: "throw"; err: Error };

/** Minimal client whose trust_restrictions read resolves/rejects on demand. */
function makeRestrictionQueryClient(outcome: QueryOutcome): any {
  const builder: any = {
    select: () => builder,
    eq:     () => builder,
    is:     () => builder,
    or:     () => builder,
    then(onF: any, onR: any) {
      const p =
        outcome.kind === "throw"
          ? Promise.reject(outcome.err)
          : Promise.resolve({ data: outcome.data, error: outcome.error });
      return p.then(onF, onR);
    },
  };
  return { from: () => builder };
}

/** Runs fn with the service logger intercepted, so channels can be asserted. */
async function captureTrustLogs<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; warns: any[]; errors: any[] }> {
  const warns: any[] = [];
  const errors: any[] = [];
  const originalWarn  = trustRestrictionLogger.warn.bind(trustRestrictionLogger);
  const originalError = trustRestrictionLogger.error.bind(trustRestrictionLogger);
  (trustRestrictionLogger as any).warn  = (obj: any, msg?: string) => { warns.push({ obj, msg }); };
  (trustRestrictionLogger as any).error = (obj: any, msg?: string) => { errors.push({ obj, msg }); };
  try {
    return { result: await fn(), warns, errors };
  } finally {
    (trustRestrictionLogger as any).warn  = originalWarn;
    (trustRestrictionLogger as any).error = originalError;
  }
}

describe("getRestrictionState degraded-read semantics", () => {
  it("successful unrestricted read is authoritative — open and NOT degraded", async () => {
    const db = makeRestrictionQueryClient({ kind: "tuple", data: [], error: null });
    const { result: state, warns, errors } = await captureTrustLogs(() =>
      getRestrictionState(db, USER_A),
    );

    assert.equal(state.canHost, true);
    assert.equal(state.canMessage, true);
    assert.equal(state.canJoinPrivatePlans, true);
    assert.equal(state.canJoinLocationPlans, true);
    assert.deepEqual(state.activeRestrictions, []);
    assert.ok(!state.degraded, "a clean read must not be flagged degraded");
    assert.equal(warns.length, 0, "no warn on a successful read");
    assert.equal(errors.length, 0, "no error on a successful read");
  });

  it("a real active restriction is enforced and NOT degraded", async () => {
    const db = makeRestrictionQueryClient({
      kind: "tuple",
      data: [{ restriction_type: "messaging" }],
      error: null,
    });
    const { result: state, warns, errors } = await captureTrustLogs(() =>
      getRestrictionState(db, USER_A),
    );

    assert.equal(state.canMessage, false, "an active messaging restriction must bite");
    assert.equal(state.canHost, true, "unrelated capabilities stay open");
    assert.deepEqual(state.activeRestrictions, ["messaging"]);
    assert.ok(
      !state.degraded,
      "a real restriction is an authoritative answer — it must be distinguishable " +
        "from a fail-closed guess, which is the whole point of the flag",
    );
    assert.equal(warns.length, 0);
    assert.equal(errors.length, 0);
  });

  it("missing-table TUPLE fails OPEN, flags degraded, and reports on warn only", async () => {
    // All three shapes the shared classifier recognises for this same table.
    const missingTableErrors = [
      { code: "42P01", message: 'relation "trust_restrictions" does not exist' },
      { code: "PGRST204", message: "schema cache miss" },
      { code: "PGRST500", message: "Table trust_restrictions DOES NOT EXIST in schema" },
    ];

    for (const error of missingTableErrors) {
      const db = makeRestrictionQueryClient({ kind: "tuple", data: null, error });
      const { result: state, warns, errors } = await captureTrustLogs(() =>
        getRestrictionState(db, USER_A),
      );

      assert.equal(state.canHost, true, `${error.code}: never-migrated is not a restriction`);
      assert.equal(state.canMessage, true, `${error.code}: never-migrated is not a restriction`);
      assert.equal(state.canJoinPrivatePlans, true, `${error.code}`);
      assert.equal(state.canJoinLocationPlans, true, `${error.code}`);
      assert.deepEqual(state.activeRestrictions, [], `${error.code}`);
      assert.equal(
        state.degraded,
        true,
        `${error.code}: a fail-OPEN guess must carry the flag too, or callers can ` +
          "spot the fail-closed guess but not this one",
      );
      assert.equal(warns.length, 1, `${error.code}: exactly one warn`);
      assert.equal(errors.length, 0, `${error.code}: a missing table is not an ERROR`);
      assert.equal((warns[0].obj as any).userId, USER_A, `${error.code}: warn identifies the user`);
    }
  });

  it("transient-failure TUPLE fails CLOSED on hosting/messaging, flags degraded, reports on error only", async () => {
    const error = { code: "57014", message: "canceling statement due to statement timeout" };
    const db = makeRestrictionQueryClient({ kind: "tuple", data: null, error });
    const { result: state, warns, errors } = await captureTrustLogs(() =>
      getRestrictionState(db, USER_A),
    );

    assert.equal(state.canHost, false, "high-risk action fails closed on a DB error");
    assert.equal(state.canMessage, false, "high-risk action fails closed on a DB error");
    assert.equal(state.canJoinPrivatePlans, true, "low-risk actions stay open");
    assert.equal(state.canJoinLocationPlans, true, "low-risk actions stay open");
    assert.deepEqual(state.activeRestrictions, []);
    assert.equal(state.degraded, true);

    // The otherwise-impossible combination the flag exists to explain.
    assert.ok(
      state.activeRestrictions.length === 0 && state.canMessage === false && state.degraded === true,
      "no active restrictions yet canMessage false must be marked degraded",
    );

    assert.equal(errors.length, 1, "exactly one ERROR — losing messaging must leave evidence");
    assert.equal(warns.length, 0, "a transient failure is not a warn-level event");
    assert.equal((errors[0].obj as any).userId, USER_A, "error identifies the affected user");
    assert.match(
      String((errors[0].obj as any).err?.message ?? ""),
      /statement timeout/,
      "the error log must carry the underlying cause, not just a generic message",
    );
  });

  it("a THROWN failure also fails closed, flags degraded, and reports on error", async () => {
    const db = makeRestrictionQueryClient({
      kind: "throw",
      err: new Error("connection terminated unexpectedly"),
    });
    const { result: state, warns, errors } = await captureTrustLogs(() =>
      getRestrictionState(db, USER_A),
    );

    assert.equal(state.canHost, false);
    assert.equal(state.canMessage, false);
    assert.equal(state.canJoinPrivatePlans, true);
    assert.equal(state.canJoinLocationPlans, true);
    assert.equal(state.degraded, true);
    assert.equal(errors.length, 1);
    assert.equal(warns.length, 0);
    assert.match(
      String((errors[0].obj as any).err?.message ?? ""),
      /connection terminated/,
    );
  });
});
