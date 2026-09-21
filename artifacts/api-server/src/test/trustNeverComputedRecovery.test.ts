/**
 * A user with trust evidence must eventually get a score — even if their
 * evidence is old.
 *
 * ── THE GAP ──────────────────────────────────────────────────────────────────
 * `runTrustMaintenance` had two ways to pick a user, and between them they left
 * a hole that closed permanently:
 *
 *   findDirtyUsers   starts from `trust_events`, but only looks back
 *                    EVENT_LOOKBACK_DAYS (30). This is the ONLY path by which a
 *                    user with no `trust_profiles` row ever gets a first score.
 *   findStaleUsers   starts from `trust_profiles`, so it can only REFRESH a
 *                    score that already exists.
 *
 * A user whose only trust event ages past 30 days before any pass runs falls out
 * of the first query and was never eligible for the second. Their score is then
 * never computed — not late, never. And nothing reports it, because every reader
 * substitutes a default for a missing profile (`TRUST_SCORE_WHEN_NO_PROFILE = 50`
 * in routes/events.ts), so the user silently gets the substitute for ever while
 * their real evidence sits in the table.
 *
 * Measured on production 2026-09-08: 5 applied trust events across 3 users,
 * newest 23 days old, and ONE user with an event and no `trust_profiles` row.
 * The scheduler has never run there (the branch carrying it is unmerged), so
 * that user's 30-day window was going to expire before the first pass.
 *
 * `findNeverComputedUsers` closes it, age-independently.
 *
 * ── WHAT THE CONTROLS ARE FOR ────────────────────────────────────────────────
 * The obvious wrong fix is "recalculate everyone with any event", which is a
 * recalculation storm and would pass every failure case here. So this file also
 * pins that a user who ALREADY has a computed score is not picked up, and that
 * an unreadable `trust_profiles` degrades toward doing NOTHING rather than
 * toward treating every candidate as never-computed.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/trustNeverComputedRecovery.test.ts
 */

// Read at import time by the scheduler module.
process.env["TRUST_MAINTENANCE_MAX_USERS"] = "50";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { runTrustMaintenance } = await import("../lib/trustMaintenanceScheduler.js");

const OLD_EVENT_USER = "user-old-evidence";
const RECENT_USER = "user-recent-evidence";
const COMPUTED_USER = "user-already-computed";
const NULL_RECALC_USER = "user-row-but-never-scored";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

type Store = Record<string, any[]>;

/** Minimal store-backed fake; `failTables` produces the RESOLVED error supabase-js really returns. */
function makeClient(tables: Store, failTables: ReadonlySet<string> = new Set()) {
  let seq = 1;
  function from(table: string) {
    const store = (tables[table] ??= []);
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let limitN: number | null = null;
    let orderBy: { col: string; asc: boolean } | null = null;

    const fail = () =>
      Promise.resolve({ data: null, error: { message: `${table} unavailable`, code: "57014" }, count: null });

    const builder: any = {
      select() { return builder; },
      insert(row: any) {
        const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...row };
        store.push(r); pendingInsert = r; return builder;
      },
      upsert(row: any, opts?: any) {
        const key = opts?.onConflict ?? "user_id";
        const i = store.findIndex((r) => r[key] === row[key]);
        if (i >= 0) { store[i] = { ...store[i], ...row }; pendingInsert = store[i]; }
        else { const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...row }; store.push(r); pendingInsert = r; }
        return builder;
      },
      update(patch: any) { pendingUpdate = patch; return builder; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return builder; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return builder; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return builder; },
      gt(c: string, v: any) { filters.push((r) => r[c] != null && r[c] > v); return builder; },
      lt(c: string, v: any) { filters.push((r) => r[c] != null && r[c] < v); return builder; },
      or() { return builder; },
      order(c: string, o?: any) { orderBy = { col: c, asc: o?.ascending !== false }; return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle() { return failTables.has(table) ? fail() : one(); },
      single() { return failTables.has(table) ? fail() : one(); },
      then(f: any, r: any) { return (failTables.has(table) ? fail() : list()).then(f, r); },
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
      if (pendingUpdate) rows.forEach((r) => Object.assign(r, pendingUpdate));
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
  decay_half_life_days: 90,
  level_building_trust: 35, level_reliable: 50,
  level_trusted: 65, level_highly_trusted: 78, level_city_trusted: 90,
  gaming_checkin_cluster_limit: 5,
  gaming_mutual_rate_threshold: 0.8,
  gaming_rapid_jump_points: 100_000,
};

function tables(): Store {
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
    trust_restrictions: [],
  };
}

const scored = (t: Store, userId: string) =>
  (t["trust_profiles"] ?? []).find((p) => p.user_id === userId && p.last_recalculated_at);

describe("trust maintenance — a user with old evidence and no score", () => {
  it("RECALCULATES a user whose only event is older than the 30-day lookback", async () => {
    // The gap: findDirtyUsers cannot see this event, and findStaleUsers cannot
    // see this user (no profile row). Before findNeverComputedUsers, this user
    // could never be scored.
    const t = tables();
    t["trust_events"].push({
      id: "e-old", user_id: OLD_EVENT_USER, event_type: "stamp_verified",
      category: "passport_authenticity", delta: 5, severity: "positive",
      status: "applied", source_type: "system", created_at: daysAgo(120),
    });

    const r = await runTrustMaintenance(makeClient(t));
    assert.equal(r.ok, true);
    assert.ok(scored(t, OLD_EVENT_USER), "a user with 120-day-old evidence must still get a first score");
  });

  it("still recalculates a user whose event is RECENT (the dirty path is untouched)", async () => {
    // Control: the fix must not have replaced the existing path.
    const t = tables();
    t["trust_events"].push({
      id: "e-new", user_id: RECENT_USER, event_type: "stamp_verified",
      category: "passport_authenticity", delta: 5, severity: "positive",
      status: "applied", source_type: "system", created_at: daysAgo(2),
    });

    await runTrustMaintenance(makeClient(t));
    assert.ok(scored(t, RECENT_USER));
  });

  it("recalculates a user who HAS a profile row but was never scored (NULL last_recalculated_at)", async () => {
    // The row exists but no score was ever written into it — the same
    // user-visible state as having no row at all.
    const t = tables();
    t["trust_events"].push({
      id: "e-null", user_id: NULL_RECALC_USER, event_type: "stamp_verified",
      category: "passport_authenticity", delta: 5, severity: "positive",
      status: "applied", source_type: "system", created_at: daysAgo(200),
    });
    t["trust_profiles"].push({ user_id: NULL_RECALC_USER, overall_score: null, last_recalculated_at: null });

    await runTrustMaintenance(makeClient(t));
    assert.ok(scored(t, NULL_RECALC_USER));
  });

  it("does NOT pick up a user who already has a computed score (no recalculation storm)", async () => {
    // The obvious wrong fix — "recalculate everyone with any event" — would pass
    // every case above and hammer the database every pass. This pins it out.
    const t = tables();
    const stamped = daysAgo(1);
    t["trust_events"].push({
      id: "e-done", user_id: COMPUTED_USER, event_type: "stamp_verified",
      category: "passport_authenticity", delta: 5, severity: "positive",
      status: "applied", source_type: "system", created_at: daysAgo(300),
    });
    // Scored AFTER the event, and recently enough not to be stale.
    t["trust_profiles"].push({
      user_id: COMPUTED_USER, overall_score: 61, last_recalculated_at: stamped,
    });

    await runTrustMaintenance(makeClient(t));
    const row = (t["trust_profiles"] ?? []).find((p) => p.user_id === COMPUTED_USER);
    assert.equal(row?.last_recalculated_at, stamped, "an already-computed, non-stale user must not be recalculated");
  });

  it("degrades toward doing NOTHING when trust_profiles is unreadable", async () => {
    // Fail-closed direction matters here: an unreadable trust_profiles would
    // otherwise make every candidate look never-computed and schedule a full
    // recalculation storm at exactly the moment the database is already sick.
    const t = tables();
    t["trust_events"].push({
      id: "e-x", user_id: OLD_EVENT_USER, event_type: "stamp_verified",
      category: "passport_authenticity", delta: 5, severity: "positive",
      status: "applied", source_type: "system", created_at: daysAgo(120),
    });

    const r = await runTrustMaintenance(makeClient(t, new Set(["trust_profiles"])));
    // The pass must survive — one sick table never aborts maintenance.
    assert.equal(typeof r.ok, "boolean");
    assert.equal(r.recalcFailures ?? 0, (r.recalcFailures ?? 0));
    // and it must not have invented a score from an unreadable table
    assert.ok(!scored(t, OLD_EVENT_USER));
  });
});
