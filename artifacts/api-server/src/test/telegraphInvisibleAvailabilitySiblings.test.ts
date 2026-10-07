/**
 * Lead ruling P-T1 (2026-10-07) on every availability surface — the independent
 * verification of lane T (finding F2): "Invisible mode withholds an owner's
 * availability from every other viewer … crew included". Lane T built it on the
 * conversation header and in Compass; the verifier found the siblings that still
 * showed an invisible owner's availability:
 *
 *   Passport (buildPassportProjection)          explicit window, quick status,
 *                                               and the traveller state they set
 *   Passport consumer variants                  readVisibleExplicitIntent / the
 *                                               discovery card's window intents
 *   Passport shared context                     "Both free tonight"
 *   GET /trips/:tripId/availability             quick status, open-to-meet, grid
 *   GET /circles/:circleId/availability         the same, plus a BLOCK term (P-T6)
 *
 * Each now asks services/telegraph/availabilityInvisibility.ts; an unreadable
 * consent row withholds. The crew/circle lists also withhold identity and
 * availability of a member in a block with the viewer, either way.
 *
 * Run: node --import tsx/esm --test src/test/telegraphInvisibleAvailabilitySiblings.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  buildPassportProjection,
  type ViewerResolution,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import { readVisibleExplicitIntent } from "../services/passport/PassportConsumerProjections.js";
import { buildSharedContext } from "../services/passport/SharedContextService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";
import { _setTestClient } from "../lib/http.js";
import availabilityRouter from "../routes/availability.js";
import { makeFakeClient, startRouter, call, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const OWNER = "owner-1";
const VIEWER = "viewer-1";
const FUTURE = new Date(Date.now() + 6 * 3_600_000).toISOString();
const PAST = new Date(Date.now() - 2 * 3_600_000).toISOString();

type Prefs = { location_mode?: string; sharing_paused?: boolean; discovery_visibility?: string } | null;
const INVISIBLE: Array<[string, Prefs]> = [
  ["sharing paused", { sharing_paused: true }],
  ["location off", { location_mode: "off" }],
  ["discovery nobody", { discovery_visibility: "nobody" }],
];
const prefsRows = (userId: string, p: Prefs) => (p === null ? [] : [{
  user_id: userId, location_mode: p.location_mode ?? "city", sharing_paused: p.sharing_paused ?? false,
  discovery_visibility: p.discovery_visibility ?? "everyone",
}]);

// ── Passport ──────────────────────────────────────────────────────────────────

function crewPerms(): ViewerPermissions {
  return {
    relationshipLabel: "crew", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: true, canSeeAvailability: true,
    canSeeTrips: true, canSeeMutuals: true, canSeeLocationContext: true,
    canSeeFriendOnlyPosts: true, canMessage: true, canSendMessageRequest: false,
    canFollow: false, canInviteToTripCrew: false,
  };
}
const crewRes: ViewerResolution = { context: "trip_crew", permissions: crewPerms(), sharedTrip: true, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
const selfRes: ViewerResolution = { context: "self", permissions: { ...crewPerms(), relationshipLabel: "self" }, sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };

function passportDb(prefs: Prefs, opts: { failPrefs?: boolean } = {}) {
  return makePassportDb({
    profiles: [{
      id: OWNER, handle: "w", display_name: "W", name: "W", home_city: "Hanoi", home_country: "Vietnam",
      current_city: "Hanoi", is_official: false, is_private: false, passport_visibility: "public",
      show_profile_picture_publicly: true, created_at: "2023-01-01", availability_tags: ["Explore"], open_to_meet: true,
    }],
    feature_flags: [{ flag: "open_to_plans_windows_enabled", enabled: true }],
    quick_availability_status: [{ user_id: OWNER, status: "free_tonight", expires_at: FUTURE }],
    user_availability: [{ user_id: OWNER, weekly_days: { fri: ["evening"] }, open_to_meet: true }],
    availability_windows: [{
      id: "w1", user_id: OWNER, type: "one_time", start_at: PAST, end_at: FUTURE, trip_id: null, open_to_plans: true,
      intents: ["Food"], group_preference: "small_group", max_travel_minutes: 20, visibility: "crew", source: "explicit",
      social_availability: "open", expires_at: null, created_at: PAST, updated_at: PAST,
    }],
    location_preferences: prefsRows(OWNER, prefs),
  }, opts.failPrefs ? { failReads: { location_preferences: { message: "location_preferences: timeout" } } } : {});
}

describe("P-T1 — Passport", () => {
  it("CONTROL: a visible owner's window, quick status and 'Open to Plans' reach a crewmate", async () => {
    const p = (await buildPassportProjection(passportDb({}), OWNER, VIEWER, { resolveViewerContext: async () => crewRes }))!;
    assert.ok(p.availability?.explicitWindow, "the crew window is shown");
    assert.equal(p.travelerState?.state, "open_to_plans");
  });

  for (const [why, prefs] of INVISIBLE) {
    it(`an invisible owner (${why}): no availability, no intent, and the traveller state does not say 'Open to Plans'`, async () => {
      const p = (await buildPassportProjection(passportDb(prefs), OWNER, VIEWER, { resolveViewerContext: async () => crewRes }))!;
      assert.equal(p.availability, undefined, `${why}: availability reached a crewmate`);
      assert.equal(p.intent, undefined);
      assert.notEqual(p.travelerState?.state, "open_to_plans");
      assert.ok(!JSON.stringify(p).includes("free_tonight"), `${why}: the quick status is on the wire`);
    });
  }

  it("an unreadable consent row withholds", async () => {
    const p = (await buildPassportProjection(passportDb({}, { failPrefs: true }), OWNER, VIEWER, { resolveViewerContext: async () => crewRes }))!;
    assert.equal(p.availability, undefined);
  });

  it("the owner still sees their own availability (invisible hides a person FROM others)", async () => {
    const p = (await buildPassportProjection(passportDb({ sharing_paused: true }), OWNER, OWNER, { resolveViewerContext: async () => selfRes }))!;
    assert.ok(p.availability?.explicitWindow);
  });

  it("consumer variants: the explicit intent an invisible owner's window carries is not read for another viewer", async () => {
    const visible = await readVisibleExplicitIntent(passportDb({}), OWNER, "trip_crew");
    assert.deepEqual(visible.intents, ["Food"], "CONTROL");
    for (const [why, prefs] of INVISIBLE) {
      const r = await readVisibleExplicitIntent(passportDb(prefs), OWNER, "trip_crew");
      assert.deepEqual(r.intents, [], why);
      assert.equal(r.hasActiveWindow, false, why);
    }
  });

  it("shared context: no 'Both free tonight' from an invisible owner", async () => {
    const mk = (prefs: Prefs) => makePassportDb({
      quick_availability_status: [
        { user_id: OWNER, status: "free_tonight", expires_at: FUTURE },
        { user_id: VIEWER, status: "free_tonight", expires_at: FUTURE },
      ],
      location_preferences: prefsRows(OWNER, prefs),
    });
    const ALL = { canSeeAvailability: true, canSeeMutuals: true, canSeeTrips: true, canMakePlan: true };
    const keys = async (prefs: Prefs) => (await buildSharedContext(mk(prefs), OWNER, VIEWER, ALL)).facts.map((f) => f.key);
    assert.ok((await keys({})).includes("both_free_tonight"), "CONTROL");
    assert.ok(!(await keys({ sharing_paused: true })).includes("both_free_tonight"));
  });
});

// ── The crew and circle availability lists ───────────────────────────────────

const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1"; // the viewer
const BOB = "bbbbbbbb-0000-4000-8000-0000000000b2"; //   invisible
const CARL = "cccccccc-0000-4000-8000-0000000000c3"; //  blocked ALICE
const DANA = "dddddddd-0000-4000-8000-0000000000d4"; //  CONTROL
const TRIP = "eeeeeeee-0000-4000-8000-0000000000e5";
const DAY = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

function crewWorld(): Record<string, unknown[]> {
  const people = [ALICE, BOB, CARL, DANA];
  return {
    feature_flags: [],
    trips: [{ id: TRIP, owner_id: ALICE, start_date: DAY, end_date: DAY }],
    trip_members: people.map((u, i) => ({ trip_id: TRIP, user_id: u, role: i === 0 ? "owner" : "member", status: "accepted" })),
    circle_memberships: [BOB, CARL, DANA].map((o) => ({ user_id: ALICE, other_id: o })),
    profiles: people.map((u) => ({ id: u, handle: u.slice(0, 4), name: u.slice(0, 4), avatar_url: `https://cdn.example/${u.slice(0, 4)}.jpg` })),
    profile_privacy_settings: [],
    trip_availability: people.map((u) => ({ trip_id: TRIP, user_id: u, open_days: { [DAY]: ["evening"] } })),
    user_availability: people.map((u) => ({ user_id: u, weekly_days: { mon: ["evening"] }, open_to_meet: true })),
    quick_availability_status: people.map((u) => ({ user_id: u, status: "free_now", expires_at: FUTURE })),
    location_preferences: [...prefsRows(BOB, { sharing_paused: true }), ...prefsRows(CARL, {}), ...prefsRows(DANA, {})],
    blocks: [{ blocker_id: CARL, blocked_id: ALICE }],
  };
}

let h: RouterHarness;
before(async () => { h = await startRouter(availabilityRouter); });
after(async () => { _setTestClient(null, false); await h.close(); });

async function list(path: string, opts?: FakeDbOptions) {
  _setTestClient(makeFakeClient(crewWorld(), opts), true);
  const r = await call(h.base, "GET", path, ALICE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const body = r.body as { members: any[]; bestDays?: Array<{ date: string; count: number }> };
  return { m: (id: string) => body.members.find((x) => x.userId === id), body, wire: JSON.stringify(r.body) };
}

for (const [label, path] of [["trip", `/trips/${TRIP}/availability`], ["circle", `/circles/${ALICE}/availability`]] as const) {
  describe(`P-T1 / P-T6 — GET ${label} availability`, () => {
    it("CONTROL: DANA's availability and identity are listed", async () => {
      const { m } = await list(path);
      assert.equal(m(DANA).quickStatus?.status, "free_now");
      assert.equal(m(DANA).openToMeet, true);
      assert.equal(m(DANA).handle, DANA.slice(0, 4));
    });

    it("BOB is invisible: no quick status, no open-to-meet, no general grid — identity stays", async () => {
      const { m } = await list(path);
      assert.equal(m(BOB).quickStatus, null);
      assert.equal(m(BOB).openToMeet, false);
      assert.deepEqual(m(BOB).weeklyDays, {});
      assert.equal(m(BOB).handle, BOB.slice(0, 4), "invisible mode hides availability, not who is in the crew");
    });

    it("CARL blocked ALICE: no identity and no availability (P-T6)", async () => {
      const { m, wire } = await list(path);
      assert.equal(m(CARL).handle, null);
      assert.equal(m(CARL).avatarUrl, null);
      assert.equal(m(CARL).quickStatus, null);
      assert.equal(m(CARL).openToMeet, false);
      if (label === "trip") assert.equal(m(CARL).openDays, null);
      assert.ok(!wire.includes(`${CARL.slice(0, 4)}.jpg`));
    });

    it("an unreadable consent read withholds every other member's availability; an unreadable block read every other identity", async () => {
      const prefsDown = await list(path, { errors: { location_preferences: { message: "timeout" } } });
      for (const id of [BOB, CARL, DANA]) assert.equal(prefsDown.m(id).quickStatus, null, id);
      const blocksDown = await list(path, { errors: { blocks: { message: "timeout" } } });
      for (const id of [BOB, CARL, DANA]) assert.equal(blocksDown.m(id).handle, null, id);
      assert.equal(blocksDown.m(ALICE).handle, ALICE.slice(0, 4), "the viewer is never withheld from herself");
    });
  });
}

describe("P-T1 / P-T6 — the trip's best days", () => {
  it("a member in a block with the viewer is not counted; an invisible member's TRIP grid still is", async () => {
    const { body } = await list(`/trips/${TRIP}/availability`);
    const day = (body.bestDays ?? []).find((d) => d.date === DAY);
    // ALICE, BOB (trip grid kept), DANA — not CARL.
    assert.equal(day?.count, 3, JSON.stringify(body.bestDays));
  });
});
