/**
 * Memory / Compass lane — dead-column repairs, proven against the LIVE schema.
 *
 * Four reads and one write in this lane named a column the database does not
 * have. PostgREST rejects an unknown column with 42703 and fails the WHOLE
 * statement, and supabase-js RESOLVES that rejection rather than throwing, so
 * each site degraded into a plausible emptiness:
 *
 *   CompassStructuredContext   rent_buddy_bookings.date_from / date_to
 *                              → Compass chat has never known the caller has
 *                                a buddy booking.
 *   PassportRemembersService   shared_moments.visibility
 *                              → the shared-moment group of "What Portava
 *                                Remembers" has never rendered a row.
 *   CompassSearchDecayService  feature_flags.numeric_value
 *                              → search-signal decay could not be switched off
 *                                or tuned by anyone.
 *   CompassAbuseDefenseEngine  compass_visibility_cooldowns.updated_at
 *                              → every confirmed medium/high/severe abuse
 *                                pattern left the offender's reach untouched.
 *
 * Every existing test over those paths stayed green, because every fixture had
 * been written to match the code. So these tests drive the PRODUCTION functions
 * through `makeSchemaStrictClient`, which validates each column name against
 * `generated/liveColumns.json` (the live information_schema) and answers 42703
 * exactly as production does. Revert any of the repairs and the corresponding
 * test goes RED with the dead column named.
 *
 * Also covers the graph engine's silent chunk loss: a rejected 500-row upsert
 * chunk used to be skipped without a log or a counter, so a wholly broken write
 * path reported the same "0 upserted" as an empty graph.
 *
 * Runtime: node:test, no HTTP, no DB, no network.
 * Run: node --import tsx/esm --test src/test/memoryCompassLaneRepairs.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildStructuredCompassContext,
  formatStructuredContextLines,
} from "../compass/CompassStructuredContext.js";
import { buildSharedMoments } from "../compass/PassportRemembersService.js";
import { getDecayConfig, getDecayedWeights, readHalfLifeDays } from "../compass/CompassSearchDecayService.js";
import { buildGraphFromSources } from "../compass/CompassGraphEngine.js";
import { makeSchemaStrictClient, selectedColumns } from "./helpers/schemaStrictSupabase.ts";
import { liveColumns } from "./helpers/liveColumns.ts";
import type { CompassProfile } from "../compass/types.js";

const ME    = "00000000-0000-0000-0000-0000000000a1";
const BUDDY = "00000000-0000-0000-0000-0000000000e5";

function profile(overrides: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId: ME,
    preferredCities: [], preferredLanguages: [], budgetStyle: null,
    travelStyles: [], socialStyle: null, safetyPreference: "standard",
    visibilityPreference: "public",
    blockedUserIds: [], blockerUserIds: [], mutedUserIds: [],
    blockCount: 0, blockerCount: 0,
    trustScore: null, trustLevel: null, activeUserScore: null,
    hasActiveTrip: false, hasActiveBooking: false,
    upcomingTripWithin48h: false, hasFutureTripScheduled: false,
    currentCity: null, currentCountry: null, safeReturnActive: false,
    computedAt: new Date().toISOString(),
    ...overrides,
  } as CompassProfile;
}

// ─────────────────────────────────────────────────────────────────────────────
// The helper itself. A schema conscience that cannot fail is worse than none:
// it would silently bless every dead column it was built to catch.
// ─────────────────────────────────────────────────────────────────────────────

describe("schema-strict fake — self-check", () => {
  it("rejects a column the live schema does not have, and resolves rather than throws", async () => {
    const c = makeSchemaStrictClient({ shared_moments: [{ id: "m1", title: "T" }] });
    const { data, error } = await c.from("shared_moments").select("id, visibility");
    assert.equal(data, null, "a dead column must fail the WHOLE statement, not just that field");
    assert.equal((error as any)?.code, "42703");
    assert.deepEqual(
      c.deadColumnErrors.map((e) => `${e.table}.${e.column}`),
      ["shared_moments.visibility"],
    );
  });

  it("accepts a select naming only live columns", async () => {
    const c = makeSchemaStrictClient({ shared_moments: [{ id: "m1", title: "T" }] });
    const { data, error } = await c.from("shared_moments").select("id, title, join_policy");
    assert.equal(error, null);
    assert.equal((data as any[]).length, 1);
  });

  it("parses embedded resources and aliases without treating them as columns", () => {
    assert.deepEqual(
      selectedColumns("title_override, city, stamp_definitions(name), alias:earned_at"),
      ["title_override", "city", "earned_at"],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Compass structured context — active buddy bookings
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassStructuredContext — booking context reads real columns", () => {
  const seed = () => ({
    circles: [], circle_memberships: [], user_stamps: [],
    profiles: [{ id: BUDDY, handle: "localbuddy" }],
    rent_buddy_bookings: [{
      traveler_id: ME, buddy_id: BUDDY, city: "Cebu City",
      booking_date: "2026-07-22", start_time: "14:00:00", duration_h: 4,
      status: "confirmed", notes: "SECRET hotel room 402",
    }],
  });

  it("surfaces the booking — with date_from/date_to this read failed 42703 and returned nothing", async () => {
    const c = makeSchemaStrictClient(seed());
    const ctx = await buildStructuredCompassContext(c as any, profile());
    assert.deepEqual(
      c.deadColumnErrors, [],
      `the booking read named a column the live schema lacks: ${JSON.stringify(c.deadColumnErrors)}`,
    );
    assert.equal(ctx.activeBookings.length, 1, "an active booking must reach the Compass prompt");
    assert.equal(ctx.activeBookings[0].city, "Cebu City");
    assert.equal(ctx.activeBookings[0].date, "2026-07-22");
    assert.equal(ctx.activeBookings[0].durationHours, 4);
    assert.equal(ctx.activeBookings[0].buddyHandle, "@localbuddy");
  });

  it("renders the booking into a prompt line carrying the real booking date", async () => {
    const c = makeSchemaStrictClient(seed());
    const ctx = await buildStructuredCompassContext(c as any, profile());
    const lines = formatStructuredContextLines(ctx).join("\n");
    assert.match(lines, /Cebu City/);
    assert.match(lines, /2026-07-22/);
    assert.match(lines, /confirmed/);
  });

  it("still never leaks the traveller's free-text booking notes", async () => {
    const c = makeSchemaStrictClient(seed());
    const ctx = await buildStructuredCompassContext(c as any, profile());
    const lines = formatStructuredContextLines(ctx).join("\n");
    assert.ok(!lines.includes("SECRET hotel room"), "notes must never reach the prompt");
    assert.ok(!JSON.stringify(ctx).includes("SECRET hotel room"));
  });

  it("the booking date column this code reads is the one rentABuddy's own date filters use", () => {
    // Not a tautology: it pins the two halves of the app to ONE column. The
    // defect was precisely that Compass invented a second, non-existent name
    // for a concept routes/rentABuddy.ts already resolved correctly.
    assert.ok(liveColumns("rent_buddy_bookings").has("booking_date"));
    assert.ok(!liveColumns("rent_buddy_bookings").has("date_from"));
    assert.ok(!liveColumns("rent_buddy_bookings").has("date_to"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Passport Remembers — shared moments
// ─────────────────────────────────────────────────────────────────────────────

describe("PassportRemembersService — shared moments read real columns", () => {
  const seed = () => ({
    shared_moment_memberships: [
      { user_id: ME, moment_id: "m-yes",      status: "accepted" },
      { user_id: ME, moment_id: "m-invited",  status: "invited"  },
    ],
    shared_moments: [
      { id: "m-yes",     title: "Dinner in Da Nang", status: "active",   join_policy: "approval_required", archived_at: null, created_at: "2026-03-01T00:00:00Z" },
      { id: "m-invited", title: "Should not appear", status: "active",   join_policy: "invite_only",       archived_at: null, created_at: "2026-03-01T00:00:00Z" },
      { id: "m-old",     title: "Archived",          status: "archived", join_policy: "approval_required", archived_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
    ],
  });

  it("surfaces an accepted, active moment — with `visibility` this read failed 42703", async () => {
    const c = makeSchemaStrictClient(seed());
    const items = await buildSharedMoments(c as any, ME);
    assert.deepEqual(
      c.deadColumnErrors, [],
      `the shared-moments read named a dead column: ${JSON.stringify(c.deadColumnErrors)}`,
    );
    assert.deepEqual(items.map((i) => i.title), ["Dinner in Da Nang"]);
  });

  it("reports the moment's audience from its real join_policy, never as public", async () => {
    // `m-yes` deliberately carries `approval_required`, NOT the mapper's
    // `?? "invite_only"` fallback. It used to carry the fallback value, which
    // made this assertion unfalsifiable: reading join_policy, failing to read it,
    // or not selecting it at all ALL produced "invite_only" and all passed. A
    // fixture whose expected value equals the code's own default proves nothing.
    //
    // With the two now distinct, dropping join_policy from the `.select()` while
    // the mapper still reads it — the exact hybrid a hunk-by-hunk resolution of
    // the #427/#431/#432 conflict produces — yields the fallback and turns this
    // RED. That only works because schemaStrictSupabase now projects the select
    // list (#436); before, the fixture supplied the column regardless.
    const c = makeSchemaStrictClient(seed());
    const [item] = await buildSharedMoments(c as any, ME);
    assert.equal(item.visibility, "approval_required");
    assert.notEqual(item.visibility, "public", "a shared moment is never a public audience");
  });

  it("the consent gate still holds: no accepted membership ⇒ no moment", async () => {
    // Guards against 'fixed the column, dropped the gate'. The moment row is
    // present and readable; only the membership is missing.
    const s = seed();
    s.shared_moment_memberships = [];
    const c = makeSchemaStrictClient(s);
    assert.deepEqual(await buildSharedMoments(c as any, ME), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Search-signal decay — the flag is now readable, so it can be obeyed
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassSearchDecayService — the decay flag is actually readable", () => {
  const flagRow = (over: Record<string, unknown> = {}) => ({
    feature_flags: [{
      flag: "SEARCH_SIGNAL_DECAY_DAYS", enabled: true,
      metadata: { half_life_days: 7 }, description: null, updated_at: null,
      ...over,
    }],
  });

  it("reads the row — with numeric_value the read failed 42703 and the row was unreachable", async () => {
    const c = makeSchemaStrictClient(flagRow());
    const cfg = await getDecayConfig(c as any);
    assert.deepEqual(c.deadColumnErrors, [], JSON.stringify(c.deadColumnErrors));
    assert.deepEqual(cfg, { enabled: true, halfLifeDays: 7 });
  });

  it("an operator disabling the flag actually disables decay", async () => {
    // Before the repair this was impossible: the read failed, `data` was null,
    // and getDecayConfig returned `enabled: true` no matter what the row said.
    const c = makeSchemaStrictClient(flagRow({ enabled: false }));
    assert.equal((await getDecayConfig(c as any)).enabled, false);
  });

  it("an operator tuning the half-life actually changes it", async () => {
    const c = makeSchemaStrictClient(flagRow({ metadata: { half_life_days: 30 } }));
    assert.equal((await getDecayConfig(c as any)).halfLifeDays, 30);
  });

  // `compass_search_signal_log` is NOT in the live snapshot — see the
  // "capability is inert" test below — so the strict client is told not to
  // check it. That exemption is the finding, not a convenience: without it
  // these two tests could not run at all.
  const UNCHECKED = { unchecked: ["compass_search_signal_log"] };

  it("a disabled flag short-circuits getDecayedWeights — weights are returned undecayed", async () => {
    const weights = { food: 8 };
    const c = makeSchemaStrictClient({
      ...flagRow({ enabled: false }),
      compass_search_signal_log: [{
        user_id: ME, category: "food", search_weight: 8,
        // ~4 half-lives ago at the default: decay would shed almost all of it.
        last_nudge_at: new Date(Date.now() - 28 * 86_400_000).toISOString(),
      }],
    }, UNCHECKED);
    assert.deepEqual(await getDecayedWeights(c as any, ME, weights), weights);
  });

  it("an enabled flag DOES decay the same weights (positive control)", async () => {
    // Without this pair the "disabled" test above would also pass against a
    // getDecayedWeights that never decays anything.
    const c = makeSchemaStrictClient({
      ...flagRow({ enabled: true }),
      compass_search_signal_log: [{
        user_id: ME, category: "food", search_weight: 8,
        last_nudge_at: new Date(Date.now() - 28 * 86_400_000).toISOString(),
      }],
    }, UNCHECKED);
    const out = await getDecayedWeights(c as any, ME, { food: 8 });
    assert.ok(out.food < 8, `expected decay to shed weight, got ${out.food}`);
  });

  it("the decay CAPABILITY is inert in production: its table is not in the live schema", () => {
    // Repairing the flag read makes the CONTROL work. It does not make the
    // feature work. `compass_search_signal_log` and the
    // `upsert_compass_search_signal` RPC have never been created: their DDL
    // sits in the frozen, never-applied root
    // artifacts/api-server/supabase/migrations/20260812_compass_search_signal_log.sql
    // (frozenMigrationRoots.ts:211). Migration 2306 therefore seeds the flag
    // OFF and says so in the row's own description.
    //
    // WHEN SOMEONE PORTS THAT DDL, THIS TEST GOES RED. That is the intent:
    // delete this test in the same commit that applies the table, and stop
    // exempting it above.
    assert.throws(
      () => liveColumns("compass_search_signal_log"),
      /not found in generated live schema/,
      "compass_search_signal_log now EXISTS live — port-complete: drop this test and the `unchecked` exemption above",
    );
  });

  it("a missing, zero or negative half-life falls back to the default rather than annihilating the weight", () => {
    assert.equal(readHalfLifeDays(null), 7);
    assert.equal(readHalfLifeDays({}), 7);
    assert.equal(readHalfLifeDays({ half_life_days: 0 }), 7);
    assert.equal(readHalfLifeDays({ half_life_days: -3 }), 7);
    assert.equal(readHalfLifeDays({ half_life_days: "14" }), 14, "jsonb numerics may arrive as strings");
  });

  it("feature_flags has metadata and has never had numeric_value", () => {
    assert.ok(liveColumns("feature_flags").has("metadata"));
    assert.ok(!liveColumns("feature_flags").has("numeric_value"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Abuse-defense reach reduction — the cooldown write body
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassAbuseDefenseEngine — the reach-reduction cooldown is writable", () => {
  it("the cooldown table has started_at and has never had updated_at", () => {
    const cols = liveColumns("compass_visibility_cooldowns");
    assert.ok(cols.has("started_at"));
    assert.ok(!cols.has("updated_at"),
      "an upsert body naming updated_at is rejected 42703 — the cooldown is never recorded");
  });

  it("the write body the engine sends is accepted by a schema-strict client", async () => {
    // Mirrors applyReachReduction's payload (the function is module-private;
    // driving runScan would need eight detectors' worth of fixture). The body
    // is asserted against the LIVE column set, which is the half that was
    // wrong — and it matches the two sibling writers in
    // CompassFairExposureEngine.ts:112,218 exactly.
    const c = makeSchemaStrictClient({ compass_visibility_cooldowns: [] });
    const { error } = await c.from("compass_visibility_cooldowns").upsert({
      author_id: ME,
      cooldown_type: "reach_reduction",
      reason: "abuse_defense:high",
      ends_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      started_at: new Date().toISOString(),
    });
    assert.equal(error, null, `cooldown upsert rejected: ${JSON.stringify(error)}`);
    assert.equal(c.writes.length, 1);
  });

  it("the same body with updated_at is rejected — the exact production defect", async () => {
    const c = makeSchemaStrictClient({ compass_visibility_cooldowns: [] });
    const { error } = await c.from("compass_visibility_cooldowns").upsert({
      author_id: ME, cooldown_type: "reach_reduction",
      ends_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    assert.equal((error as any)?.code, "42703");
    assert.equal(c.writes.length, 0, "nothing is written when the statement is rejected");
  });

  it("the cooldown the engine writes is visible to the reader that reduces reach", async () => {
    // CompassFeedBuilder:272 filters on author_id + ends_at only (no
    // cooldown_type), so a `reach_reduction` row really does damp the feed —
    // the repair is not merely a write that now succeeds into a void.
    const c = makeSchemaStrictClient({
      compass_visibility_cooldowns: [{
        author_id: ME, cooldown_type: "reach_reduction",
        started_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 3_600_000).toISOString(),
        reason: "abuse_defense:high",
      }],
    });
    const { data, error } = await c.from("compass_visibility_cooldowns")
      .select("author_id").in("author_id", [ME]).gt("ends_at", new Date().toISOString());
    assert.equal(error, null);
    assert.equal((data as any[]).length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Graph engine — a rejected chunk is no longer indistinguishable from none
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassGraphEngine — a rejected upsert chunk is counted and logged", () => {
  /** Minimal reader: one stamp source, everything else empty. */
  function graphClient(writeError: { code: string; message: string } | null) {
    const seed: Record<string, any[]> = {
      user_stamps: [
        { user_id: ME, city: "Da Nang", country: "Vietnam", earned_at: "2026-04-01T10:00:00Z", is_revoked: false },
      ],
    };
    const rejected: string[] = [];
    const client: any = {
      rejected,
      from: (table: string) => {
        let written: any[] | null = null;
        const b: any = new Proxy({}, {
          get(_t, prop: string) {
            if (prop === "upsert") return (rows: any[]) => { written = rows; return b; };
            if (prop === "then") {
              return (resolve: Function) => {
                if (written && writeError) {
                  rejected.push(table);
                  return resolve({ data: null, error: writeError });
                }
                if (written) return resolve({ data: written, error: null });
                return resolve({ data: seed[table] ?? [], error: null });
              };
            }
            if (prop === "maybeSingle") return async () => ({ data: null, error: null });
            if (prop === "single") return async () => ({ data: null, error: null });
            return () => b;
          },
        });
        return b;
      },
    };
    return client;
  }

  it("a healthy write path reports rows upserted and nothing failed", async () => {
    const r = await buildGraphFromSources(graphClient(null));
    assert.ok(r.nodesUpserted > 0, "the fixture must produce at least one node");
    assert.equal(r.nodesFailed, 0);
    assert.equal(r.edgesFailed, 0);
  });

  it("a rejected chunk is counted as FAILED, not silently as zero", async () => {
    // Before the repair both runs returned `nodesUpserted: 0` with no counter
    // and no log line, so "the write path is broken" and "there is no data"
    // were the same observation.
    const r = await buildGraphFromSources(graphClient({ code: "42501", message: "denied" }));
    assert.equal(r.nodesUpserted, 0);
    assert.ok(r.nodesFailed > 0, "rejected rows must be counted");
  });
});
