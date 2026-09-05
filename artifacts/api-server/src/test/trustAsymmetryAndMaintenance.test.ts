/**
 * Trust engine — the two properties that define it, and the loop that drives
 * them.
 *
 * ── 1. THE EARN/LOSE ASYMMETRY ───────────────────────────────────────────────
 *
 * `TrustScoreService` documents its central product property at length:
 * "slow to earn, immediate to lose. That asymmetry is the whole point." It is
 * implemented by ONE constant, `EARN_CONFIDENCE_WEIGHT`, which ramps positive
 * movement and is deliberately never applied to the negative branch.
 *
 * Nothing pinned it. Setting that constant to 0.0001 — which destroys the
 * property completely, restoring the "trusted off a single review" behaviour
 * the comment says was removed — left the entire 45-test trust suite green.
 * The suite below is what makes that mutation fail.
 *
 * The assertions are relational on purpose: they compare a lone event against a
 * sustained record, and the positive branch against the negative one, rather
 * than restating arithmetic the implementation could change legitimately. The
 * one exception is the worked example the source comment itself states — one
 * +6 review yields 56, not 80 — which is pinned as a value, because that number
 * IS the documented behaviour.
 *
 * ── 2. THE MAINTENANCE LOOP ──────────────────────────────────────────────────
 *
 * `runTrustMaintenance` is the only thing that recalculates a score, expires a
 * cap or ends probation. Decay means a score is stale the moment it is written,
 * so without this loop a penalty never fades and a time-limited ceiling is
 * permanent. It had no test at all.
 *
 * Its ORDERING is the subtle part and is asserted directly: caps must be lifted
 * BEFORE recalculation, or the score written this pass is clamped by a ceiling
 * that has already expired — and, because the loop only revisits a user when
 * they are dirty or stale, that wrong number would stand for days.
 *
 * ── 3. THE EVENT RSVP GATE ───────────────────────────────────────────────────
 *
 * The first consumer surface that turns a trust score into a decision.
 */

// The scheduler reads its budget from the environment AT IMPORT TIME, so the
// truncation test's ceiling has to be in place before the module is loaded.
process.env["TRUST_MAINTENANCE_MAX_USERS"] = "2";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recalculateTrustScore } from "../services/trust/TrustScoreService.js";
import { checkEventEligibility } from "../routes/events.js";

const {
  runTrustMaintenance,
  MAX_USERS_PER_PASS,
} = await import("../lib/trustMaintenanceScheduler.js");

const USER_A = "user-asym-a";
const HALF_LIFE = 90;

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

    const builder: any = {
      select() { return builder; },
      insert(row: any) {
        const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...row };
        store.push(r); pendingInsert = r; return builder;
      },
      upsert(row: any, opts?: any) {
        const key = opts?.onConflict ?? "id";
        const i = store.findIndex((r) => r[key] === row[key]);
        if (i >= 0) { store[i] = { ...store[i], ...row }; pendingInsert = store[i]; }
        else { const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...row }; store.push(r); pendingInsert = r; }
        return builder;
      },
      update(patch: any) { pendingUpdate = patch; return builder; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return builder; },
      gt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] > val); return builder; },
      lt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] < val); return builder; },
      or() { return builder; }, // loadCaps' expiry OR — not the subject of these tests
      order(col: string, opts?: any) { orderBy = { col, asc: opts?.ascending !== false }; return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle() { return one(); },
      single() { return one(); },
      then(onF: any, onR: any) { return list().then(onF, onR); },
    };

    function matched() {
      let rows = store.filter((r) => filters.every((f) => f(r)));
      if (orderBy) {
        const { col, asc } = orderBy;
        rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }
    async function one() {
      if (pendingInsert && !pendingUpdate) return { data: pendingInsert, error: null };
      const rows = matched();
      if (pendingUpdate) { rows.forEach((r) => Object.assign(r, pendingUpdate)); }
      return { data: rows[0] ?? null, error: null };
    }
    async function list() {
      if (pendingInsert && !pendingUpdate) return { data: [pendingInsert], error: null, count: 1 };
      const rows = matched();
      if (pendingUpdate) rows.forEach((r) => Object.assign(r, pendingUpdate));
      return { data: rows, error: null, count: rows.length };
    }
    return builder;
  }
  return { from } as any;
}

const SETTINGS_ROW = {
  id: 1,
  weight_plan_attendance: 0.18, weight_host_quality: 0.12,
  weight_communication: 0.10, weight_respect_safety: 0.15,
  weight_location_honesty: 0.13, weight_content_quality: 0.08,
  weight_community_value: 0.08, weight_guide_accuracy: 0.08,
  weight_passport_auth: 0.08,
  decay_half_life_days: HALF_LIFE,
  level_building_trust: 35, level_reliable: 50,
  level_trusted: 65, level_highly_trusted: 78, level_city_trusted: 90,
  gaming_checkin_cluster_limit: 5,
  gaming_mutual_rate_threshold: 0.8,
  gaming_rapid_jump_points: 100_000,
};

function baseTables(): Store {
  return {
    feature_flags: [
      { flag: "trust_engine_enabled", enabled: true },
      { flag: "trust_gaming_detection_enabled", enabled: false },
    ],
    trust_settings: [{ ...SETTINGS_ROW }],
    trust_events: [],
    trust_caps: [],
    trust_profiles: [],
    trust_reviews: [],
    plan_attendance_events: [],
  };
}

/** `n` identical events of `delta` in one category, all recorded just now. */
function seedEvents(tables: Store, userId: string, delta: number, n: number, category = "host_quality") {
  const now = new Date().toISOString();
  for (let i = 0; i < n; i++) {
    tables["trust_events"].push({
      id: `ev-${category}-${delta}-${i}`, user_id: userId, category,
      delta, severity: "minor", status: "applied", created_at: now,
    });
  }
}

async function scoreFor(delta: number, n: number): Promise<number> {
  const tables = baseTables();
  seedEvents(tables, USER_A, delta, n);
  const r = await recalculateTrustScore(makeClient(tables), USER_A);
  return r.categories.host_quality;
}

/**
 * The size of a "sustained record" — enough decay-weighted evidence that the
 * confidence ramp is fully satisfied.
 *
 * This deliberately does NOT read EARN_CONFIDENCE_WEIGHT. A test that sized its
 * own fixture from the constant would keep passing for any value of it, which is
 * exactly the hole this file exists to close. It is a fixed, generous count: the
 * ramp saturates at the constant's documented value of 5, and any redefinition
 * that needs more than twelve events to grant full credit is a change to the
 * product property, not a refactor.
 */
const SUSTAINED = 12;

describe("TrustScoreService — the earn/lose asymmetry", () => {
  it("a lone positive event moves the score far less than a lone negative one", async () => {
    const up = await scoreFor(+6, 1);
    const down = await scoreFor(-6, 1);
    const gain = up - 50;
    const loss = 50 - down;
    assert.ok(gain > 0, `a positive event must still earn something; got ${up}`);
    assert.ok(
      gain < loss,
      `asymmetry violated: one +6 event gained ${gain.toFixed(2)} while one -6 event cost ` +
      `${loss.toFixed(2)}. Earning must be slower than losing — that is what the confidence ` +
      `ramp is for, and it must never be applied to the negative branch.`,
    );
    // Not merely "less": meaningfully less. A ramp that shaved a rounding error
    // off the gain would satisfy a bare inequality while restoring the defect.
    assert.ok(
      gain * 2 < loss,
      `the gap is too small to be an asymmetry: gained ${gain.toFixed(2)}, lost ${loss.toFixed(2)}`,
    );
  });

  it("one good review does not buy the standing a sustained record does", async () => {
    const lone = await scoreFor(+6, 1);
    const sustained = await scoreFor(+6, SUSTAINED);
    assert.ok(
      lone < sustained,
      `a single +6 event scored ${lone} and ${SUSTAINED} identical events scored ${sustained}. ` +
      `Without a working confidence ramp the mean is identical and volume is irrelevant — ` +
      `which is the "trusted off one review on a brand-new account" behaviour the service ` +
      `comment says was removed.`,
    );
  });

  it("the negative branch is NOT ramped — one bad event bites at full strength", async () => {
    const lone = await scoreFor(-6, 1);
    const sustained = await scoreFor(-6, SUSTAINED);
    assert.equal(
      lone, sustained,
      `one -6 event scored ${lone} and ${SUSTAINED} of them scored ${sustained}. Negative ` +
      `movement must apply immediately at full strength; ramping it would silently protect ` +
      `first-time offenders.`,
    );
  });

  it("the documented worked example holds: one +6 review lands at 56, not 80", async () => {
    // TrustScoreService states this outcome in prose: "one HOST_POSITIVE_REVIEW
    // (delta +6) produced 50 + 6*5 = 80 ... Now that same lone event yields
    // 50 + 30*(1/5) = 56". This pins the number the comment promises.
    const lone = await scoreFor(+6, 1);
    assert.ok(
      Math.abs(lone - 56) < 0.01,
      `expected the documented 56 for a single +6 event, got ${lone}`,
    );
  });

  it("the CEILING, not the delta, is what makes a severe finding survive a good record", async () => {
    // TrustEventService states this explicitly: "severity is a ROUTE, not a
    // magnitude ... the repo's own test proves the delta alone barely moves a
    // well-regarded account". The score is a decay-weighted MEAN, so a long
    // positive history genuinely does dilute one -20. That is by design, and it
    // is exactly why applyEventCaps writes a trust_caps ceiling as well.
    //
    // Both halves are pinned here, because a change that made the delta bite on
    // its own would be a real behaviour change and a change that dropped the
    // ceiling would leave severe findings toothless.
    const withoutCap = baseTables();
    seedEvents(withoutCap, USER_A, +5, 10);
    seedEvents(withoutCap, USER_A, -20, 1);
    const uncapped = await recalculateTrustScore(makeClient(withoutCap), USER_A);
    assert.ok(
      uncapped.categories.host_quality > 50,
      `the mean over ten +5s and one -20 is positive by construction; got ` +
      `${uncapped.categories.host_quality}. If this ever drops below neutral the scoring model ` +
      `changed and the comment in TrustEventService no longer describes it.`,
    );

    const withCap = baseTables();
    seedEvents(withCap, USER_A, +5, 10);
    seedEvents(withCap, USER_A, -20, 1);
    withCap["trust_caps"].push({
      id: "cap-severe", user_id: USER_A, category: "host_quality",
      ceiling_score: 40, expires_at: null, lifted_at: null,
    });
    const capped = await recalculateTrustScore(makeClient(withCap), USER_A);
    assert.equal(capped.categories.host_quality, 40, "the ceiling must clamp the glowing record");
    assert.deepEqual(capped.capsApplied, ["host_quality"]);
  });
});

// ── The maintenance loop ──────────────────────────────────────────────────────

const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

describe("runTrustMaintenance — the driver", () => {
  it("fails closed when trust_engine_enabled is off", async () => {
    const tables = baseTables();
    tables["feature_flags"][0].enabled = false;
    seedEvents(tables, USER_A, +5, 3);
    const r = await runTrustMaintenance(makeClient(tables));
    assert.equal(r.skipped, true);
    assert.equal(r.skipReason, "flag_off");
    assert.equal(r.usersRecalculated, 0);
    assert.equal(tables["trust_profiles"].length, 0, "a disabled engine must write nothing");
  });

  it("recalculates a user who has events but no profile row yet", async () => {
    const tables = baseTables();
    seedEvents(tables, USER_A, +5, 3);
    const r = await runTrustMaintenance(makeClient(tables));
    assert.equal(r.skipped, undefined);
    assert.equal(r.usersRecalculated, 1);
    const profile = tables["trust_profiles"].find((p) => p.user_id === USER_A);
    assert.ok(profile, "the pass must create the missing trust_profiles row");
    assert.ok(profile.last_recalculated_at, "last_recalculated_at must be stamped");
  });

  it("leaves a user alone whose profile is newer than their last event", async () => {
    const tables = baseTables();
    seedEvents(tables, USER_A, +5, 3);
    tables["trust_profiles"].push({
      user_id: USER_A, overall_score: 60, public_level: "reliable_traveler",
      last_recalculated_at: FUTURE, on_probation: false,
    });
    const r = await runTrustMaintenance(makeClient(tables));
    assert.equal(r.usersRecalculated, 0, "a clean, fresh profile is neither dirty nor stale");
    assert.equal(tables["trust_profiles"][0].overall_score, 60, "and must not be overwritten");
  });

  it("refreshes a stale profile even with no new events — decay makes it wrong", async () => {
    const tables = baseTables();
    tables["trust_profiles"].push({
      user_id: USER_A, overall_score: 60, public_level: "reliable_traveler",
      // Older than STALE_DAYS (7) by a wide margin.
      last_recalculated_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      on_probation: false,
    });
    const r = await runTrustMaintenance(makeClient(tables));
    assert.equal(r.usersRecalculated, 1);
    assert.notEqual(
      tables["trust_profiles"][0].last_recalculated_at,
      undefined,
    );
    assert.equal(
      tables["trust_profiles"][0].overall_score, 50,
      "with no events the recalculated score is neutral — the stale 60 must not survive",
    );
  });

  it("lifts expired caps BEFORE recalculating, so the new score is not clamped by them", async () => {
    const tables = baseTables();
    seedEvents(tables, USER_A, +6, 20); // enough to clear the ramp and exceed the ceiling
    tables["trust_caps"].push({
      id: "cap-1", user_id: USER_A, category: "host_quality",
      ceiling_score: 30, expires_at: PAST, lifted_at: null,
    });
    const r = await runTrustMaintenance(makeClient(tables));
    assert.equal(r.capsExpired, 1, "the expired cap must be lifted in this pass");
    assert.ok(tables["trust_caps"][0].lifted_at, "and marked lifted");
    const profile = tables["trust_profiles"].find((p) => p.user_id === USER_A);
    assert.ok(profile, "the user must have been recalculated");
    assert.ok(
      profile.host_quality > 30,
      `host_quality came back as ${profile.host_quality}, still clamped by a ceiling that had ` +
      `already expired. Caps must be lifted BEFORE the recalculation, not after — the loop only ` +
      `revisits a user when they are dirty or stale, so a wrong number here stands for days.`,
    );
  });

  it("keeps an unexpired cap in force through the pass", async () => {
    const tables = baseTables();
    seedEvents(tables, USER_A, +6, 20);
    tables["trust_caps"].push({
      id: "cap-1", user_id: USER_A, category: "host_quality",
      ceiling_score: 30, expires_at: FUTURE, lifted_at: null,
    });
    const r = await runTrustMaintenance(makeClient(tables));
    assert.equal(r.capsExpired, 0);
    const profile = tables["trust_profiles"].find((p) => p.user_id === USER_A);
    assert.equal(profile.host_quality, 30, "a live ceiling must still clamp the recalculated score");
  });

  it("ends probation whose term has run, and only that one", async () => {
    const tables = baseTables();
    tables["trust_profiles"].push(
      { user_id: "p-done", overall_score: 40, on_probation: true, probation_ends_at: PAST, last_recalculated_at: FUTURE },
      { user_id: "p-live", overall_score: 40, on_probation: true, probation_ends_at: FUTURE, last_recalculated_at: FUTURE },
    );
    const r = await runTrustMaintenance(makeClient(tables));
    assert.equal(r.probationCleared, 1);
    assert.equal(tables["trust_profiles"].find((p) => p.user_id === "p-done").on_probation, false);
    assert.equal(tables["trust_profiles"].find((p) => p.user_id === "p-live").on_probation, true);
  });

  it("reports truncation rather than presenting a bounded pass as full coverage", async () => {
    assert.equal(MAX_USERS_PER_PASS, 2, "this file sets the per-pass budget to 2 before import");
    const tables = baseTables();
    for (const u of ["u1", "u2", "u3", "u4"]) seedEvents(tables, u, +5, 1);
    const r = await runTrustMaintenance(makeClient(tables));
    assert.equal(r.truncated, true);
    assert.equal(r.usersRecalculated, MAX_USERS_PER_PASS);
  });

  it("runs the gaming scan and reports what it flagged", async () => {
    const tables = baseTables();
    tables["feature_flags"][1].enabled = true; // gaming detection on
    const limit = SETTINGS_ROW.gaming_checkin_cluster_limit;
    for (let i = 0; i < limit + 1; i++) {
      tables["plan_attendance_events"].push({
        id: `att-${i}`, user_id: USER_A, geofence_id: "gf-1",
        event_type: "checked_in_successfully", created_at: new Date().toISOString(),
      });
    }
    const r = await runTrustMaintenance(makeClient(tables));
    assert.equal(r.gamingFlagged, 1);
    assert.equal(tables["trust_reviews"].length, 1);
  });
});

// ── The first consumer: event RSVP ────────────────────────────────────────────

describe("checkEventEligibility — the trust gate on RSVP", () => {
  function eventTables(overrides: Partial<Record<string, any[]>> = {}): Store {
    return {
      feature_flags: [{ flag: "events_trust_gates_enabled", enabled: true }],
      event_roles: [],
      profiles: [{ id: "guest", verified: true }],
      trust_profiles: [],
      blocks: [],
      user_blocks: [],
      ...overrides,
    } as Store;
  }
  const EVENT = { id: "ev-1", host_id: "host", trust_score_min: 60, verified_only: false, age_min: null, age_max: null };

  it("admits a user whose score clears the minimum", async () => {
    const tables = eventTables({ trust_profiles: [{ user_id: "guest", overall_score: 75 }] });
    const r = await checkEventEligibility(makeClient(tables), EVENT, "guest");
    assert.equal(r.ok, true);
  });

  it("refuses a user below the minimum, naming the threshold", async () => {
    const tables = eventTables({ trust_profiles: [{ user_id: "guest", overall_score: 41 }] });
    const r = await checkEventEligibility(makeClient(tables), EVENT, "guest");
    assert.equal(r.ok, false);
    assert.equal((r as any).errorCode, "forbidden");
    assert.match((r as any).message, /at least 60/);
  });

  it("treats a user with no trust profile as neutral 50, not as zero", async () => {
    // A brand-new account has no trust_profiles row. Reading that as 0 would
    // lock every new user out of every gated event.
    const admits = await checkEventEligibility(
      makeClient(eventTables()), { ...EVENT, trust_score_min: 50 }, "guest",
    );
    assert.equal(admits.ok, true);
    const refuses = await checkEventEligibility(
      makeClient(eventTables()), { ...EVENT, trust_score_min: 51 }, "guest",
    );
    assert.equal(refuses.ok, false);
  });

  it("does not gate at all when events_trust_gates_enabled is off", async () => {
    const tables = eventTables({
      feature_flags: [{ flag: "events_trust_gates_enabled", enabled: false }],
      trust_profiles: [{ user_id: "guest", overall_score: 1 }],
    });
    const r = await checkEventEligibility(makeClient(tables), EVENT, "guest");
    assert.equal(r.ok, true, "the flag is the switch; with it off the score must not decide anything");
  });

  it("never gates the host out of their own event", async () => {
    const tables = eventTables({ trust_profiles: [{ user_id: "host", overall_score: 1 }] });
    const r = await checkEventEligibility(makeClient(tables), EVENT, "host");
    assert.equal(r.ok, true);
  });
});
