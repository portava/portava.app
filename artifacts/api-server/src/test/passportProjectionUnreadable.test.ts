/**
 * P12 — "nothing earned" vs "could not look", on the surface where the
 * difference is a statement about a PERSON.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * A passport is a claim about what someone did. Before this suite the §29
 * projection answered these two questions with the byte-identical object:
 *
 *     "How many countries has this traveller been to?"  → 0
 *     "Could we read user_stamps?"                      → 0
 *
 * and likewise `stamps: []`, `memories: []`. The mechanism is that supabase-js
 * RESOLVES on a database error: a failed read arrives as `{ data: null, error }`,
 * `?? []` turns it into an empty collection, and the `try/catch` wrapped around
 * it never fires because nothing was thrown. So the false statement is made
 * confidently, with no log at the call site and no way for the client to tell.
 *
 * `buildStats().readFailed`, `buildUnifiedStamps().readFailed`,
 * `loadMemoriesRead().readFailed` and `PassportProjection.unreadable` are the
 * only carriers of the difference. Tests 1-3 pin each reader; test 4 pins the
 * aggregate; tests 5-6 pin the consequence — a degraded projection must not be
 * cached at the STATIC hour, because an hour of "you have earned nothing" is
 * the transient failure turned into a sustained lie.
 *
 * ── HOW THIS IS MEASURED, NOT ASSUMED ───────────────────────────────────────
 * `makeFailClosedClient` injects the RESOLVED error shape and never throws — a
 * fake that threw would exercise a path production does not take. Every
 * degraded case is seeded with rows that WOULD have been returned had the read
 * succeeded, so a green cannot come from an empty fixture. The healthy-empty
 * control in each test asserts the numbers are the SAME, which is the whole
 * point: the flag is the only thing that separates them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import { buildStats } from "../services/passport/PassportMapService.js";
import { buildUnifiedStamps } from "../services/passport/UnifiedStampService.js";
import { loadMemoriesRead } from "../services/passport/PassportMemoryService.js";
import {
  buildPassportProjection,
  buildProjectionCachePolicy,
  PASSPORT_DYNAMIC_MAX_AGE,
  PASSPORT_STATIC_MAX_AGE,
  type PassportProjection,
  type ViewerResolution,
} from "../services/passport/PassportProjectionService.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const SELF_RESOLUTION: ViewerResolution = {
  context: "self",
  permissions: {
    relationshipLabel: "self",
    isBlocked: false,
    isUnavailable: false,
    canViewProfile: true,
    canViewFullProfile: true,
    canSeeAvailability: true,
    canSeeTrips: true,
    canSeeMutuals: true,
    canSeeLocationContext: true,
    canSeeFriendOnlyPosts: true,
    canMessage: false,
    canSendMessageRequest: false,
    canFollow: false,
    canInviteToTripCrew: false,
  },
  sharedTrip: false,
  sharedEvent: false,
  ownerIsTripHost: false,
  buddyRole: null,
};

/** A stamp row that a healthy read WOULD have returned. */
const A_STAMP = {
  id: "s1", user_id: OWNER, stamp_definition_id: "d1", source_type: "system",
  city: "Hanoi", country: "VN", earned_at: "2026-01-01T00:00:00Z",
  is_revoked: false, visibility: "public", catalog_id: null,
  stamp_definitions: { name: "First trip", rarity: "common", stamp_type: "trip", category: "trip", slug: "first_event_joined" },
};
const A_MEMORY = {
  id: "m1", user_id: OWNER, status: "active", title: "Hanoi", city: "Hanoi",
  country: "VN", category: "trip", visibility: "public", earned_at: "2026-01-01T00:00:00Z",
};

test("1. buildStats: a failed user_stamps read is NOT 'this traveller has been nowhere'", async () => {
  const broken = makeFailClosedClient({
    rows: { user_stamps: [A_STAMP] },       // would have counted 1 country
    failOn: (c) => (c.table === "user_stamps" ? { message: "boom", code: "57P01" } : null),
  });
  const healthyEmpty = makeFailClosedClient({ rows: { user_stamps: [] } });

  const bad = await buildStats(broken, OWNER);
  const none = await buildStats(healthyEmpty, OWNER);

  // The numbers are identical — which is exactly why the flag has to exist.
  assert.equal(bad.countries, none.countries);
  assert.equal(bad.totalStamps, none.totalStamps);
  assert.equal(bad.countries, 0);

  assert.equal(bad.readFailed, true, "an unreadable user_stamps must not read as 'nothing earned'");
  assert.equal(none.readFailed, false, "an empty shelf is a real, truthful zero");

  // And the control: a healthy read that finds something still says readFailed:false.
  const healthy = makeFailClosedClient({ rows: { user_stamps: [A_STAMP] } });
  const good = await buildStats(healthy, OWNER);
  assert.equal(good.readFailed, false);
  assert.equal(good.countries, 1, "the fixture would have produced a non-zero count");
});

test("2. buildUnifiedStamps: EITHER half failing makes the count a floor, not a total", async () => {
  const cases: Array<[string, string]> = [
    ["v2 half", "user_stamps"],
    ["v1 half", "passport_stamps"],
  ];
  let checked = 0;
  for (const [label, table] of cases) {
    const sc = makeFailClosedClient({
      rows: { user_stamps: [A_STAMP], passport_stamps: [] },
      failOn: (c) => (c.table === table ? { message: "boom", code: "57P01" } : null),
    });
    const r = await buildUnifiedStamps(sc, OWNER);
    assert.equal(r.readFailed, true, `${label}: a failed read must be reported`);
    checked++;
  }
  assert.equal(checked, cases.length);

  const empty = await buildUnifiedStamps(makeFailClosedClient({ rows: { user_stamps: [], passport_stamps: [] } }), OWNER);
  assert.equal(empty.readFailed, false);
  assert.equal(empty.count, 0);

  const full = await buildUnifiedStamps(makeFailClosedClient({ rows: { user_stamps: [A_STAMP], passport_stamps: [] } }), OWNER);
  assert.equal(full.readFailed, false);
  assert.equal(full.count, 1, "the fixture would have produced a stamp");
});

test("3. loadMemoriesRead: an unreadable shelf is not an empty life", async () => {
  const broken = makeFailClosedClient({
    rows: { passport_memories: [A_MEMORY] },
    failOn: (c) => (c.table === "passport_memories" ? { message: "boom", code: "57P01" } : null),
  });
  const r = await loadMemoriesRead(broken, OWNER);
  assert.equal(r.readFailed, true);
  assert.deepEqual(r.rows, []);

  const ok = await loadMemoriesRead(makeFailClosedClient({ rows: { passport_memories: [A_MEMORY] } }), OWNER);
  assert.equal(ok.readFailed, false);
  assert.equal(ok.rows.length, 1, "the fixture would have produced a memory");

  const none = await loadMemoriesRead(makeFailClosedClient({ rows: { passport_memories: [] } }), OWNER);
  assert.equal(none.readFailed, false);
});

function projectionClient(failTables: string[]) {
  return makeFailClosedClient({
    rows: {
      profiles: [{ id: OWNER, handle: "o", verified: true }],
      user_stamps: [A_STAMP],
      passport_stamps: [],
      passport_memories: [A_MEMORY],
    },
    failOn: (c) => (failTables.includes(c.table) ? { message: "boom", code: "57P01" } : null),
  });
}

const PROJ_OPTS = {
  profileRow: { id: OWNER, handle: "o", verified: true } as Record<string, any>,
  resolveViewerContext: async (): Promise<ViewerResolution> => SELF_RESOLUTION,
  crewSignal: "excluded" as const,
};

test("4. the §29 aggregate names the sections it could not read", async () => {
  const healthy = await buildPassportProjection(projectionClient([]), OWNER, OWNER, PROJ_OPTS);
  assert.ok(healthy, "the projection built");
  assert.equal(healthy!.unreadable, undefined, "a fully-read projection carries no degraded marker");
  assert.equal(healthy!.stats.countries, 1, "the seed WOULD have produced a non-zero stat");
  assert.equal(healthy!.stamps.length, 1);
  assert.equal(healthy!.memories.length, 1);

  const degraded = await buildPassportProjection(
    projectionClient(["user_stamps", "passport_stamps", "passport_memories"]),
    OWNER, OWNER, PROJ_OPTS,
  );
  assert.ok(degraded, "the projection still builds — degraded, not absent");
  // The numbers collapse to exactly the "nothing earned" shape...
  assert.equal(degraded!.stats.countries, 0);
  assert.equal(degraded!.stats.stamps, 0);
  assert.deepEqual(degraded!.stamps, []);
  assert.deepEqual(degraded!.memories, []);
  // ...and the ONLY thing that says so is `unreadable`.
  assert.ok(degraded!.unreadable, "a degraded projection must say so");
  assert.deepEqual(
    [...degraded!.unreadable!].sort(),
    ["memories", "stamps", "stats"],
    "every failed section is named",
  );
});

test("5. one failed section is named alone (the marker is not all-or-nothing)", async () => {
  const only = await buildPassportProjection(projectionClient(["passport_memories"]), OWNER, OWNER, PROJ_OPTS);
  assert.ok(only);
  assert.deepEqual(only!.unreadable, ["memories"]);
  assert.equal(only!.stats.countries, 1, "the sections that DID read are still truthful");
});

test("6. a degraded projection is not cached at the STATIC hour", () => {
  const base = {
    userId: OWNER,
    identity: { userId: OWNER, name: null, handle: "o", avatarUrl: null, coverUrl: null, verified: true, verificationLevel: null, homeCountry: null, homeBase: null, isOfficial: false },
    credentials: [],
    stats: { countries: 0, cities: 0, stamps: 0, trips: 0 },
    stamps: [],
    upcomingPlans: [],
    memories: [],
    capabilities: { owner: {} as any, actions: {} as any },
    viewerContext: "public" as const,
  };

  const healthy = buildProjectionCachePolicy(base as unknown as PassportProjection);
  assert.equal(healthy.sections.stamps, PASSPORT_STATIC_MAX_AGE, "a healthy stamp shelf is static-tier");
  assert.equal(healthy.sections.stats, PASSPORT_STATIC_MAX_AGE);

  const degraded = buildProjectionCachePolicy({
    ...base, unreadable: ["stamps", "stats"],
  } as unknown as PassportProjection);
  assert.equal(
    degraded.sections.stamps, PASSPORT_DYNAMIC_MAX_AGE,
    "an unreadable shelf cached for an hour turns a transient failure into an hour of 'you earned nothing'",
  );
  assert.equal(degraded.sections.stats, PASSPORT_DYNAMIC_MAX_AGE);
  assert.equal(degraded.maxAge, PASSPORT_DYNAMIC_MAX_AGE);
  assert.notEqual(PASSPORT_STATIC_MAX_AGE, PASSPORT_DYNAMIC_MAX_AGE, "the two tiers must differ or this test proves nothing");
});
