/**
 * The read layer under §30A.2: a failed read is never published as "nobody is
 * reachable".
 *
 * ── THE DEFECT CLASS ────────────────────────────────────────────────────────
 * supabase-js RESOLVES a PostgREST failure as `{ data: null, error }`. It does
 * not throw, so a `try/catch` never sees it; `?? []` turns it into an empty
 * list; and on a presence surface an empty list is indistinguishable from the
 * truth. The whole point of `loadReachablePeople` returning a REFUSAL rather
 * than a list is that this failure mode becomes visible.
 *
 * Every consent-bearing read is failed individually below and each one must
 * produce `{ ok: false, stage }`. `makeFailClosedClient` injects the resolved
 * error shape — it never throws, so these tests exercise the path production
 * actually takes.
 *
 * Run: node --import tsx/esm --test src/test/reachablePeopleFailClosed.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import { loadReachablePeople } from "../services/telegraph/reachablePeopleQuery.js";
import type { MessagePermissionVerdict } from "../lib/messagingPermissions.js";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const CREWMATE = "22222222-2222-4222-8222-222222222222";
const TRIP = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-09-22T18:00:00.000Z");
const SOON = new Date(NOW + 2 * 3_600_000).toISOString();
const FRESH = new Date(NOW - 60_000).toISOString();

const CREW_VERDICT: MessagePermissionVerdict = {
  allowed: true,
  verdict: "allowed",
  relationship_context: {
    isFriend: false,
    senderFollowsRecipient: false,
    recipientFollowsSender: false,
    sharedTrip: true,
    sharedCircle: true,
  },
};

const resolveRelationship = async (): Promise<MessagePermissionVerdict> => CREW_VERDICT;

/** A world in which exactly one crewmate is consented, fresh and available. */
function world(): Record<string, Record<string, any>[]> {
  return {
    feature_flags: [],
    blocks: [],
    circle_memberships: [{ user_id: VIEWER, other_id: CREWMATE }],
    trip_members: [
      { trip_id: TRIP, user_id: VIEWER, status: "accepted" },
      { trip_id: TRIP, user_id: CREWMATE, status: "accepted" },
    ],
    location_preferences: [
      { user_id: VIEWER, location_mode: "nearby", sharing_paused: false, discovery_visibility: "everyone" },
      { user_id: CREWMATE, location_mode: "nearby", sharing_paused: false, discovery_visibility: "everyone" },
    ],
    user_privacy_settings: [{ user_id: CREWMATE, allow_location_sharing: true }],
    profile_privacy_settings: [{ user_id: CREWMATE, allow_profile_discovery: true }],
    user_location_state: [
      { user_id: VIEWER, lat: 41.15, lng: -8.61, last_known_at: FRESH },
      { user_id: CREWMATE, lat: 41.152, lng: -8.613, last_known_at: FRESH },
    ],
    user_availability: [{ user_id: CREWMATE, open_to_meet: true }],
    quick_availability_status: [
      { user_id: CREWMATE, status: "free_now", expires_at: SOON },
      { user_id: VIEWER, status: "free_now", expires_at: SOON },
    ],
    availability_windows: [],
  };
}

async function load(spec: Parameters<typeof makeFailClosedClient>[0]) {
  const db = makeFailClosedClient(spec);
  return loadReachablePeople(db, { viewerId: VIEWER, nowMs: NOW, resolveRelationship });
}

describe("the happy path publishes a bucketed projection", () => {
  it("one consented, fresh, available crewmate is published — with a bucket and no coordinate", async () => {
    const result = await load({ rows: world() });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.people.length, 1);
    const person = result.people[0]!;
    assert.equal(person.personId, CREWMATE);
    assert.equal(person.proximity.precision, "bucket");
    assert.equal(person.proximity.bucket, "same_area");
    assert.equal(person.availability.state, "available_now");
    assert.equal(person.relationship.tier, "crew");
    assert.equal(result.degraded, false);
    assert.equal(JSON.stringify(person).includes("41.15"), false, "a raw coordinate reached the projection");
  });

  it("the same quantised instant produces the same answer twice — polling learns nothing new", async () => {
    const a = await load({ rows: world() });
    const b = await load({ rows: world() });
    assert.deepEqual(JSON.stringify(a), JSON.stringify(b));
  });

  it("a crewmate who has not opted in to being shown is not published", async () => {
    const rows = world();
    rows.user_availability = [{ user_id: CREWMATE, open_to_meet: false }];
    rows.user_location_state = [{ user_id: VIEWER, lat: 41.15, lng: -8.61, last_known_at: FRESH }];
    const result = await load({ rows });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.people.length, 0);
    assert.equal(result.telemetry.refusals["no_presence_consent"] ?? result.telemetry.refusals["no_availability_consent"], 1);
  });

  it("a crewmate in invisible mode is refused, and the refusal is counted", async () => {
    const rows = world();
    rows.location_preferences = [
      { user_id: VIEWER, location_mode: "nearby", sharing_paused: false, discovery_visibility: "everyone" },
      { user_id: CREWMATE, location_mode: "nearby", sharing_paused: true, discovery_visibility: "everyone" },
    ];
    const result = await load({ rows });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.people.length, 0);
    assert.equal(result.telemetry.refusals["invisible"], 1);
  });

  it("a blocked crewmate is never a candidate at all", async () => {
    const rows = world();
    rows.blocks = [{ blocker_id: VIEWER, blocked_id: CREWMATE }];
    const result = await load({ rows });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.people.length, 0);
  });
});

describe("every read the answer depends on refuses rather than answering empty", () => {
  const cases: Array<[string, string]> = [
    ["circle_memberships", "circles"],
    ["trip_members", "trips"],
    ["location_preferences", "candidate_prefs"],
    ["user_privacy_settings", "candidate_privacy"],
    ["profile_privacy_settings", "candidate_profile_privacy"],
    ["user_location_state", "candidate_presence"],
    ["user_availability", "availability"],
    ["quick_availability_status", "availability"],
    ["availability_windows", "availability_windows"],
  ];

  for (const [table, stage] of cases) {
    it(`an unreadable ${table} is a refusal (stage ${stage}), not "nobody is reachable"`, async () => {
      const result = await load({
        rows: world(),
        failOn: (ctx) => (ctx.table === table ? { message: "connection reset", code: "57P01" } : null),
      });
      assert.equal(result.ok, false, `${table} failed but the loader still answered with a list`);
      if (result.ok) return;
      assert.equal(result.stage, stage);
    });
  }

  // The two availability_windows reads are SEPARATE gates — one for the
  // candidates, one for the viewer's own windows — and failing the whole table
  // fires both, so a test that only does that cannot tell whether either gate
  // on its own is doing anything. (Knocking the candidate check out and running
  // the whole-table case leaves the suite green, which is exactly the shape of
  // the "this gate is redundant, delete it" mistake.) These two fail one read
  // at a time, by the ids the query filters on.
  it("a failed CANDIDATE window read refuses even though the viewer's own windows read fine", async () => {
    const result = await load({
      rows: world(),
      failOn: (ctx) => {
        if (ctx.table !== "availability_windows") return null;
        const f = ctx.filters.find((x) => x.col === "user_id" && x.op === "in");
        const ids = (f?.val as string[] | undefined) ?? [];
        return ids.includes(CREWMATE) ? { message: "down", code: "57P01" } : null;
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.stage, "availability_windows");
  });

  it("a failed VIEWER window read refuses even though the candidates' windows read fine", async () => {
    const result = await load({
      rows: world(),
      failOn: (ctx) => {
        if (ctx.table !== "availability_windows") return null;
        const f = ctx.filters.find((x) => x.col === "user_id" && x.op === "in");
        const ids = (f?.val as string[] | undefined) ?? [];
        return ids.length === 1 && ids[0] === VIEWER ? { message: "down", code: "57P01" } : null;
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.stage, "availability_windows");
  });

  it("an unreadable blocks table refuses — block state unknown means nobody is published", async () => {
    const result = await load({
      rows: world(),
      failOn: (ctx) => (ctx.table === "blocks" ? { message: "timeout", code: "57014" } : null),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.stage, "blocks");
  });

  it("an unreadable viewer preferences row makes the VIEWER invisible and costs them proximity", async () => {
    // The viewer's own row is read with .eq(user_id).maybeSingle(); failing the
    // whole table also fails the candidate read, so this asserts the direction
    // the failure takes rather than a stage: nothing is published precisely.
    const result = await load({
      rows: world(),
      failOn: (ctx) => (ctx.table === "location_preferences" ? { message: "down", code: "57P01" } : null),
    });
    assert.equal(result.ok, false, "a refusal, not a list computed from unknown consent");
  });
});

describe("the emergency stop", () => {
  it("an unreadable feature_flags engages disable_location_sharing: empty AND degraded, never a plain empty list", async () => {
    const result = await load({
      rows: world(),
      failOn: (ctx) => (ctx.table === "feature_flags" ? { message: "down", code: "57P01" } : null),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.people.length, 0);
    assert.equal(result.degraded, true, "an engaged stop must be distinguishable from an empty neighbourhood");
    assert.equal(result.viewerInvisible.invisible, true);
  });

  it("an engaged stop publishes nobody", async () => {
    const rows = world();
    rows.feature_flags = [{ flag: "disable_location_sharing", enabled: true }];
    const result = await load({ rows });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.people.length, 0);
    assert.equal(result.degraded, true);
  });
});

describe("a degraded relationship read does not become a published relationship", () => {
  it("canMessage reporting degraded refuses the person and marks the answer degraded", async () => {
    const db = makeFailClosedClient({ rows: world() });
    const result = await loadReachablePeople(db, {
      viewerId: VIEWER,
      nowMs: NOW,
      resolveRelationship: async () => ({ ...CREW_VERDICT, degraded: true }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.people.length, 0);
    assert.equal(result.telemetry.refusals["relationship_unknown"], 1);
    assert.equal(result.degraded, true);
  });

  it("a verdict of 'unavailable' (block state unknown) refuses the person", async () => {
    const db = makeFailClosedClient({ rows: world() });
    const result = await loadReachablePeople(db, {
      viewerId: VIEWER,
      nowMs: NOW,
      resolveRelationship: async () => ({
        allowed: false,
        verdict: "denied",
        reason: "unavailable",
        relationship_context: CREW_VERDICT.relationship_context,
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.people.length, 0);
    assert.equal(result.telemetry.refusals["blocked"], 1);
  });
});
