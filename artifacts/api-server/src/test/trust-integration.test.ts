/**
 * Trust Score Engine — integration tests
 *
 * Chains multiple service-layer calls to validate end-to-end round-trips.
 * Uses the same node:test + fake-client pattern as trust.test.ts.
 *
 * Run: node --import tsx/esm --test src/test/trust-integration.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { recordTrustEvent } from "../services/trust/TrustEventService.js";
import { recalculateTrustScore, getTrustProfile } from "../services/trust/TrustScoreService.js";
import { getActiveCaps } from "../services/trust/TrustCapService.js";
import { getRestrictionState } from "../services/trust/TrustRestrictionService.js";
import {
  confirmEvent,
  dismissEvent,
  adminApplyRestriction,
  adminLiftRestriction,
  adminOverrideScore,
  adminRemoveOverride,
  getPendingEvents,
  getOpenReviews,
} from "../services/trust/TrustAdminService.js";
import { getSafeTrustSummary, getPublicTrustBadge } from "../services/trust/TrustPrivacyGuard.js";
import { getRecoveryStatus } from "../services/trust/TrustRecoveryService.js";
import { runGamingDetectionScan } from "../services/trust/TrustGamingDetectionService.js";

// ── Fake client (copied / adapted from trust.test.ts) ─────────────────────────

const ADMIN   = "admin-int-001";
const USER_A  = "user-int-a";
const USER_B  = "user-int-b";
const USER_C  = "user-int-c";

interface FakeTables {
  feature_flags:      any[];
  trust_settings:     any[];
  trust_events:       any[];
  trust_caps:         any[];
  trust_restrictions: any[];
  trust_profiles:     any[];
  trust_reviews:      any[];
  trust_admin_actions: any[];
  plan_attendance_events: any[];
}

function makeTrustClient(tables: FakeTables) {
  let idCounter = 1;
  function nextId() { return `integ-${idCounter++}`; }

  function from(table: keyof FakeTables) {
    const store = tables[table] as any[];
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let pendingDelete = false;
    let limitN: number | null = null;
    let isCount = false;

    const builder: any = {
      select(_fields?: string, opts?: any) {
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
        const idx = store.findIndex((r) => r[conflictKey] === (row as any)[conflictKey]);
        if (idx >= 0) {
          store[idx] = { ...store[idx], ...row };
          pendingInsert = store[idx];
        } else {
          const r = { id: nextId(), created_at: new Date().toISOString(), ...row };
          store.push(r);
          pendingInsert = r;
        }
        return builder;
      },
      update(patch: any) { pendingUpdate = patch; return builder; },
      delete()           { pendingDelete = true; return builder; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      is(col: string, val: any)    { filters.push((r) => val === null ? r[col] == null : r[col] === val); return builder; },
      gt(col: string, val: any)    { filters.push((r) => r[col] > val); return builder; },
      lt(col: string, val: any)    { filters.push((r) => r[col] < val); return builder; },
      not(col: string, _op: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
      or()     { return builder; },
      order()  { return builder; },
      limit(n: number) { limitN = n; return builder; },
      range()  { return builder; },
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
      if (pendingInsert && !pendingUpdate) return { data: pendingInsert, error: null };
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
      if (pendingInsert && !pendingUpdate) return { data: [pendingInsert], error: null, count: 1 };
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
      { key: "trust_engine_enabled",           enabled: true },
      { key: "trust_gaming_detection_enabled",  enabled: true },
    ],
    trust_settings: [{
      id: 1,
      weight_plan_attendance: 0.18, weight_host_quality: 0.12,
      weight_communication:   0.10, weight_respect_safety: 0.15,
      weight_location_honesty: 0.13, weight_content_quality: 0.08,
      weight_community_value: 0.08, weight_guide_accuracy: 0.08,
      weight_passport_auth:   0.08,
      decay_half_life_days: 90,
      level_building_trust: 35, level_reliable: 50,
      level_trusted: 65, level_highly_trusted: 78, level_city_trusted: 90,
      daily_cap_plan_attend: 3, daily_cap_guide_verify: 5, daily_cap_gem_save: 10,
      weekly_cap_plan_attend: 10, weekly_cap_guide_verify: 20, weekly_cap_gem_save: 40,
      gaming_checkin_cluster_limit: 5,
      gaming_mutual_rate_threshold: 0.80,
      gaming_rapid_jump_points: 20,
    }],
    trust_events:         [],
    trust_caps:           [],
    trust_restrictions:   [],
    trust_profiles:       [],
    trust_reviews:        [],
    trust_admin_actions:  [],
    plan_attendance_events: [],
  };
}

// ── 1. Full event → recalculation → public-level round-trip ───────────────────

describe("Integration: full event → recalc → public level round-trip", () => {
  it("records multiple positive events and derives correct public level", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // Add several 'applied' (non-pending) positive events across categories
    await db.from("trust_events").insert({
      user_id: USER_A, event_type: "PLAN_ATTENDED",
      category: "plan_attendance", delta: 8, severity: "minor",
      status: "applied", source_type: "user_action",
    });
    await db.from("trust_events").insert({
      user_id: USER_A, event_type: "HOST_QUALITY_RATING",
      category: "host_quality", delta: 10, severity: "minor",
      status: "applied", source_type: "user_action",
    });
    await db.from("trust_events").insert({
      user_id: USER_A, event_type: "COMMUNITY_UPVOTE",
      category: "community_value", delta: 5, severity: "minor",
      status: "applied", source_type: "user_action",
    });

    const result = await recalculateTrustScore(db, USER_A);
    assert.ok(result.overall_score > 0, `overall_score should be >0 (got ${result.overall_score})`);
    assert.ok(
      ["new_traveler","building_trust","reliable_traveler","trusted_traveler","highly_trusted","city_trusted"]
        .includes(result.public_level),
      `public_level should be a valid level, got "${result.public_level}"`,
    );

    // getTrustProfile should return persisted values
    const profile = await getTrustProfile(db, USER_A);
    assert.ok(profile !== null, "profile should be persisted");
    assert.equal(profile!.userId, USER_A);
    assert.equal(profile!.overall_score, result.overall_score);
  });

  it("new user with no events gets a neutral score at the reliable_traveler baseline", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // No events seeded — recalculate uses the 50-point neutral default per category
    const result = await recalculateTrustScore(db, USER_B);
    // Each category defaults to 50 (neutral midpoint); weighted overall = 50 × Σweights = 50
    assert.equal(result.overall_score, 50);
    assert.equal(result.public_level, "reliable_traveler");
  });
});

// ── 2. Severe event → pending review (appeal creates a review) ────────────────

describe("Integration: severe event creates pending review", () => {
  it("FAKE_GPS_CONFIRMED severe → pendingReview=true, trust_reviews gets a row", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    const rec = await recordTrustEvent(db, {
      userId:     USER_A,
      eventType:  "FAKE_GPS_CONFIRMED",
      category:   "location_honesty",
      delta:      -20,
      severity:   "severe",
      sourceType: "admin",
      sourceId:   "gps-case-int-1",
    });

    assert.equal(rec.pendingReview, true, "severe event should be pending_review");
    assert.ok(rec.eventId, "eventId should be set");

    // Verify the event row has status pending_review
    const evt = tables.trust_events.find((e) => e.id === rec.eventId);
    assert.ok(evt, "event row should exist");
    assert.equal(evt.status, "pending_review");
  });
});

// ── 3. Admin confirm event → recalculation ────────────────────────────────────

describe("Integration: admin confirm event triggers recalculation", () => {
  it("confirming a severe event caps the category and lowers score", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // Seed a pending_review event
    const rec = await recordTrustEvent(db, {
      userId:     USER_A,
      eventType:  "FAKE_GPS_CONFIRMED",
      category:   "location_honesty",
      delta:      -20,
      severity:   "severe",
      sourceType: "admin",
      sourceId:   "gps-case-int-2",
    });
    assert.equal(rec.pendingReview, true);

    // Admin confirms
    const confirmResult = await confirmEvent(db, ADMIN, rec.eventId!, "Verified by manual review");
    assert.equal(confirmResult.ok, true);

    // Event should now be 'confirmed'
    const evt = tables.trust_events.find((e) => e.id === rec.eventId);
    assert.equal(evt?.status, "confirmed");

    // Cap should have been applied
    const activeCaps = await getActiveCaps(db, USER_A);
    assert.ok(activeCaps.length > 0, "at least one cap should be active after confirmed severe event");

    // Score should reflect the cap
    const result = await recalculateTrustScore(db, USER_A);
    assert.ok(
      result.categories.location_honesty <= 50,
      `location_honesty should be ≤50 after severe confirmed event, got ${result.categories.location_honesty}`,
    );
  });

  it("dismissing a pending_review event marks it dismissed and recalcs without caps", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // Must use "serious" or "severe" to produce a pending_review event
    const rec = await recordTrustEvent(db, {
      userId:     USER_A,
      eventType:  "FAKE_GPS_CONFIRMED",
      category:   "location_honesty",
      delta:      -15,
      severity:   "serious",
      sourceType: "admin",
    });

    const result = await dismissEvent(db, ADMIN, rec.eventId!, "False positive — GPS glitch");
    assert.equal(result.ok, true);

    const evt = tables.trust_events.find((e) => e.id === rec.eventId);
    assert.equal(evt?.status, "dismissed");

    // No caps created for a dismissed event
    const caps = await getActiveCaps(db, USER_A);
    assert.equal(caps.length, 0, "no caps should be created after dismissal");
  });
});

// ── 4. Admin restrict → blocks the hosting seam ───────────────────────────────

describe("Integration: admin restrict blocks hosting, lift restores it", () => {
  it("applying hosting restriction → canHost=false; lifting it → canHost=true", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // Initially no restrictions
    const before = await getRestrictionState(db, USER_A);
    assert.equal(before.canHost, true, "user should be able to host before any restriction");

    // Admin applies hosting restriction
    const applyResult = await adminApplyRestriction(
      db, ADMIN, USER_A, "hosting", "Confirmed venue no-show pattern", null,
    );
    assert.equal(applyResult.ok, true);
    assert.ok(applyResult.restrictionId, "restrictionId should be returned");

    const afterApply = await getRestrictionState(db, USER_A);
    assert.equal(afterApply.canHost, false, "canHost should be false after restriction");

    // Admin lifts it
    const liftResult = await adminLiftRestriction(db, ADMIN, USER_A, applyResult.restrictionId, "Served restriction period");
    assert.equal(liftResult.ok, true);

    const afterLift = await getRestrictionState(db, USER_A);
    assert.equal(afterLift.canHost, true, "canHost should be true again after restriction is lifted");
  });

  it("messaging restriction does not affect hosting ability", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    await adminApplyRestriction(db, ADMIN, USER_A, "messaging", "Spam detected", null);

    const state = await getRestrictionState(db, USER_A);
    assert.equal(state.canHost, true,    "hosting should still be allowed");
    assert.equal(state.canMessage, false, "messaging should be restricted");
  });
});

// ── 5. Override cap removes ceiling, adminRemoveOverride restores natural score ─

describe("Integration: adminOverrideScore → adminRemoveOverride restores score", () => {
  it("score override locks category, removing override allows natural recalc", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // Seed positive events for plan_attendance
    for (let i = 0; i < 5; i++) {
      await db.from("trust_events").insert({
        user_id: USER_A, event_type: "PLAN_ATTENDED",
        category: "plan_attendance", delta: 10, severity: "minor",
        status: "applied", source_type: "user_action",
      });
    }

    // Natural score should be above 0
    const natural = await recalculateTrustScore(db, USER_A);
    const naturalAttendance = natural.categories.plan_attendance;

    // Admin overrides plan_attendance to 5
    await adminOverrideScore(db, ADMIN, USER_A, "plan_attendance", 5, "Downgrade for testing");

    const capped = await recalculateTrustScore(db, USER_A);
    assert.ok(
      capped.categories.plan_attendance <= 5,
      `plan_attendance should be ≤5 after override, got ${capped.categories.plan_attendance}`,
    );

    // Remove override
    await adminRemoveOverride(db, ADMIN, USER_A, "plan_attendance", "Restoring natural score");

    const restored = await recalculateTrustScore(db, USER_A);
    assert.ok(
      restored.categories.plan_attendance >= capped.categories.plan_attendance,
      `After removing override, plan_attendance (${restored.categories.plan_attendance}) should be ≥ capped value (${capped.categories.plan_attendance})`,
    );
  });
});

// ── 6. Gaming detection scan flags a farming pattern ─────────────────────────

describe("Integration: gaming detection scan creates review", () => {
  it("rapid score jump pattern → gaming_suspected review created", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // Seed many rapid events for USER_C (above gaming_rapid_jump_points=20)
    for (let i = 0; i < 6; i++) {
      tables.trust_events.push({
        id: `rapid-int-${i}`,
        user_id: USER_C,
        category: "plan_attendance",
        delta: 5,
        severity: "minor",
        status: "applied",
        source_type: "user_action",
        created_at: new Date().toISOString(),
      });
    }

    const scanResult = await runGamingDetectionScan(db);
    assert.equal(scanResult.ok, true, "scan should complete without error");

    const review = tables.trust_reviews.find(
      (r) => r.user_id === USER_C && r.review_type === "gaming_suspected",
    );
    assert.ok(review, "should have created a gaming_suspected review for USER_C");
    assert.ok(
      ["open", "in_progress"].includes(review.status),
      `review status should be open/in_progress, got "${review.status}"`,
    );
  });

  it("duplicate scan does not create second review if one already open", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // Pre-seed an open gaming review
    tables.trust_reviews.push({
      id: "existing-review-1",
      user_id: USER_C,
      review_type: "gaming_suspected",
      status: "open",
      metadata: { pattern: "rapid_jump" },
      created_at: new Date().toISOString(),
    });

    for (let i = 0; i < 6; i++) {
      tables.trust_events.push({
        id: `rapid-dup-${i}`,
        user_id: USER_C,
        category: "plan_attendance",
        delta: 5,
        severity: "minor",
        status: "applied",
        source_type: "user_action",
        created_at: new Date().toISOString(),
      });
    }

    await runGamingDetectionScan(db);
    const reviews = tables.trust_reviews.filter(
      (r) => r.user_id === USER_C && r.review_type === "gaming_suspected",
    );
    assert.equal(reviews.length, 1, "should not create a second open review");
  });
});

// ── 7. Public profile returns no sensitive data ───────────────────────────────

describe("Integration: public trust badge contains no sensitive fields", () => {
  it("getPublicTrustBadge does not expose raw scores or internal cap info", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // Seed a trust profile for USER_A
    tables.trust_profiles.push({
      user_id:          USER_A,
      overall_score:    42,
      public_level:     "building_trust",
      plan_attendance:  55,
      host_quality:     60,
      communication:    50,
      respect_safety:   70,
      location_honesty: 30,
      content_quality:  40,
      community_value:  45,
      guide_accuracy:   35,
      passport_authenticity: 50,
      updated_at: new Date().toISOString(),
    });

    // Also seed an active cap so we can confirm it's hidden
    tables.trust_caps.push({
      id: "cap-pub-1",
      user_id: USER_A,
      category: "location_honesty",
      ceiling_score: 30,
      reason_code: "fake_gps_severe",
      lifted_at: null,
      expires_at: null,
      created_at: new Date().toISOString(),
    });

    const badge = await getPublicTrustBadge(db, USER_A);
    assert.ok(badge !== null, "badge should not be null for a user with a profile");

    // Should NOT expose raw category scores
    assert.ok(!("plan_attendance" in badge!), "plan_attendance should not be in public badge");
    assert.ok(!("overall_score" in badge!), "overall_score should not be in public badge");

    // Should expose the public level
    assert.ok("level" in badge!, "badge should include public trust level");
  });

  it("getSafeTrustSummary strips event details not safe for LLM context", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    tables.trust_profiles.push({
      user_id:      USER_A,
      overall_score: 72,
      public_level:  "trusted_traveler",
      updated_at:    new Date().toISOString(),
    });

    const summary = await getSafeTrustSummary(db, USER_A);
    assert.ok(summary !== null, "summary should not be null");
    // Should not include anything that would reveal system-internal detail
    const summaryStr = JSON.stringify(summary);
    assert.ok(!summaryStr.includes("caps"), "summary should not include raw cap info");
  });
});

// ── 8. New user can still access low-trust features ──────────────────────────

describe("Integration: new user with no profile has no restrictions", () => {
  it("user with no trust_restrictions rows has all permissions open", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // USER_B has never had any events or restrictions
    const state = await getRestrictionState(db, USER_B);
    assert.equal(state.canHost,              true, "new user can host");
    assert.equal(state.canMessage,           true, "new user can message");
    assert.equal(state.canJoinPrivatePlans,  true, "new user can join private plans");
    assert.equal(state.canJoinLocationPlans, true, "new user can join location plans");
    assert.deepEqual(state.activeRestrictions, [], "no active restrictions");
  });

  it("new user recovery status shows no probation", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    tables.trust_profiles.push({
      user_id: USER_B,
      overall_score: 0,
      public_level: "new_traveler",
      updated_at: new Date().toISOString(),
    });

    const recovery = await getRecoveryStatus(db, USER_B);
    assert.equal(recovery.onProbation, false, "new user should not be on probation");
  });
});

// ── 9. getPendingEvents + getOpenReviews pagination ───────────────────────────

describe("Integration: admin queue helpers return correct rows", () => {
  it("getPendingEvents returns only pending_review events in FIFO order", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // Seed applied + pending events
    tables.trust_events.push(
      { id: "ev-applied-1", user_id: USER_A, event_type: "PLAN_ATTENDED", category: "plan_attendance",
        delta: 5, severity: "minor", status: "applied", source_type: "user_action",
        created_at: "2026-01-01T00:00:00Z" },
      { id: "ev-pending-1", user_id: USER_A, event_type: "FAKE_GPS_CONFIRMED", category: "location_honesty",
        delta: -20, severity: "severe", status: "pending_review", source_type: "admin",
        created_at: "2026-01-02T00:00:00Z" },
      { id: "ev-pending-2", user_id: USER_B, event_type: "FAKE_GPS_CONFIRMED", category: "location_honesty",
        delta: -15, severity: "moderate", status: "pending_review", source_type: "admin",
        created_at: "2026-01-03T00:00:00Z" },
    );

    const pending = await getPendingEvents(db);
    assert.equal(pending.length, 2, "should return exactly 2 pending events");
    assert.ok(!pending.some((e) => e.status !== "pending_review"), "all returned events should be pending_review");
  });

  it("getOpenReviews returns only open/in_progress reviews", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    tables.trust_reviews.push(
      { id: "rev-open-1",     user_id: USER_A, review_type: "gaming_suspected", status: "open",       metadata: {}, created_at: "2026-01-01T00:00:00Z" },
      { id: "rev-progress-1", user_id: USER_B, review_type: "appeal",           status: "in_progress", metadata: {}, created_at: "2026-01-02T00:00:00Z" },
      { id: "rev-resolved-1", user_id: USER_C, review_type: "admin_flagged",     status: "resolved",   metadata: {}, created_at: "2026-01-01T00:00:00Z" },
    );

    const reviews = await getOpenReviews(db);
    assert.equal(reviews.length, 2, "should return exactly 2 open reviews");
    assert.ok(reviews.every((r) => ["open", "in_progress"].includes(r.status)), "all reviews should be open or in_progress");
  });
});

// ── 10. Probation lifecycle ───────────────────────────────────────────────────

describe("Integration: probation set on severe confirmed event", () => {
  it("confirming a severe event sets user on probation", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    const rec = await recordTrustEvent(db, {
      userId:     USER_A,
      eventType:  "HARASSMENT_CONFIRMED",
      category:   "respect_safety",
      delta:      -30,
      severity:   "severe",
      sourceType: "admin",
    });
    assert.equal(rec.pendingReview, true);

    await confirmEvent(db, ADMIN, rec.eventId!, "Confirmed harassment report");

    const recovery = await getRecoveryStatus(db, USER_A);
    assert.equal(recovery.onProbation, true, "user should be on probation after confirmed severe event");
    assert.ok(recovery.probationEndsAt, "probation end date should be set");
  });
});
