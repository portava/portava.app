/**
 * Lead ruling P-T1a (2026-10-08, on the verification of 3e2b9c1afd, finding F1): `profiles.open_to_meet`
 * IS availability under P-T1. An invisible owner's open_to_meet is withheld for every non-self viewer,
 * anonymous included, and an unreadable consent read withholds it.
 *
 * The verifier found three doors still serving it:
 *   GET /users/:userId and GET /users/by-handle/:handle  (routes/follows.ts buildPassportResponse; auth optional)
 *   GET /users/:username/passport                         (routes/passport.ts → toPublicProfilePreview / toFullProfileView)
 *   Passport Travel DNA                                   (buildTravelIdentity: "Open to meeting travelers")
 * and, while fixing them, lane T found a fourth the merge of lane C's D-103 branch opened: the Passport's
 * explicit-window door for a mutual follow did not ask the invisibility read at all.
 *
 * WHAT IS EXERCISED: the real follows and passport routers over a lenient PostgREST fake (express on
 * 127.0.0.1), and the real buildPassportProjection over the Passport fake.
 *
 * Run: node --import tsx/esm --test src/test/telegraphOpenToMeetInvisible.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { buildPassportProjection, type ViewerResolution, type ViewerPermissions } from "../services/passport/PassportProjectionService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const CALLER = "11111111-1111-1111-1111-111111111111";
const TARGET = "22222222-2222-2222-2222-222222222222";
const HANDLE = "targetuser";

type Row = Record<string, unknown>;
const PROFILE: Row = {
  id: TARGET, handle: HANDLE, username: HANDLE, name: "Target Person", avatar_url: null, bio: "bio", home_city: "Lisbon",
  home_country: "PT", current_city: "Porto", interests: [], verified: false, is_private: false,
  passport_visibility: "public", created_at: "2026-01-01T00:00:00Z", account_status: "active", is_official: false,
  open_to_meet: true,
};

/** A lenient PostgREST-shaped fake: profiles and location_preferences answer; everything else is empty. */
function makeClient(o: { callerId: string | null; prefs: Row | null; failPrefs?: boolean }) {
  const builder = (table: string): any => {
    const filters: Array<[string, unknown]> = [];
    let countMode = false;
    const get = (col: string) => filters.find(([c]) => c === col)?.[1];
    const one = () => {
      if (table === "profiles") {
        const byId = get("id");
        const byHandle = get("handle") ?? get("username");
        if (byId === TARGET || (typeof byHandle === "string" && byHandle.toLowerCase() === HANDLE)) return { data: PROFILE, error: null };
        if (byId === CALLER) return { data: { id: CALLER, handle: "caller", account_status: "active" }, error: null };
      }
      return { data: null, error: null };
    };
    const list = () => {
      if (table === "location_preferences") {
        if (o.failPrefs) return { data: null, error: { message: "location_preferences: timeout" } };
        return { data: o.prefs ? [{ user_id: TARGET, ...o.prefs }] : [], error: null };
      }
      if (table === "profiles") { const r = one(); return { data: r.data ? [r.data] : [], error: null }; }
      return { data: [], error: null };
    };
    const b: any = {
      select: (_c?: string, opts?: any) => { if (opts?.count) countMode = true; return b; },
      eq: (c: string, v: unknown) => { filters.push([c, v]); return b; },
      ilike: (c: string, v: unknown) => { filters.push([c, v]); return b; },
      neq: () => b, in: () => b, or: () => b, is: () => b, not: () => b, contains: () => b, order: () => b, limit: () => b,
      gte: () => b, lte: () => b, lt: () => b, gt: () => b, range: () => b, insert: () => b, upsert: () => b, update: () => b, delete: () => b,
      maybeSingle: () => Promise.resolve(one()),
      single: () => Promise.resolve(one()),
      then: (resolve: (v: any) => any, reject?: any) =>
        Promise.resolve(countMode ? { data: null, count: 0, error: null } : list()).then(resolve, reject),
    };
    return b;
  };
  return {
    auth: {
      getUser: async () =>
        o.callerId ? { data: { user: { id: o.callerId } }, error: null } : { data: { user: null }, error: { message: "no session" } },
    },
    from: (t: string) => builder(t),
    rpc: async () => ({ data: null, error: null }),
  } as any;
}

let server: http.Server;
let baseUrl = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  const { default: followsRouter } = await import("../routes/follows.js");
  const { default: passportRouter } = await import("../routes/passport.js");
  app.use(followsRouter);
  app.use(passportRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => { server.close(); _setTestServiceClient(null); _setTestClient(null, false); });

function get(path: string, authed: boolean): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, { method: "GET", headers: authed ? { authorization: "Bearer t" } : {} }, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => { let body: any = null; try { body = JSON.parse(raw); } catch { body = raw; } resolve({ status: res.statusCode ?? 0, body }); });
    });
    req.on("error", reject);
    req.end();
  });
}
function use(o: Parameters<typeof makeClient>[0]) {
  const c = makeClient(o);
  _setTestServiceClient(c);
  _setTestClient(c, true);
}

const INVISIBLE: Row = { location_mode: "nearby", sharing_paused: true, discovery_visibility: "everyone" };
const VISIBLE: Row = { location_mode: "nearby", sharing_paused: false, discovery_visibility: "everyone" };

for (const [label, path] of [["GET /users/:userId", `/users/${TARGET}`], ["GET /users/by-handle/:handle", `/users/by-handle/${HANDLE}`]] as const) {
  describe(`P-T1a — ${label}`, () => {
    it("CONTROL: a visible owner's openToMeet reaches a stranger", async () => {
      use({ callerId: null, prefs: VISIBLE });
      const r = await get(path, false);
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      assert.equal(r.body.openToMeet, true);
    });
    it("an invisible owner's openToMeet reaches no one else — an anonymous caller included", async () => {
      use({ callerId: null, prefs: INVISIBLE });
      assert.equal((await get(path, false)).body.openToMeet, false);
      use({ callerId: CALLER, prefs: INVISIBLE });
      assert.equal((await get(path, true)).body.openToMeet, false);
    });
    it("an unreadable consent read withholds it", async () => {
      use({ callerId: null, prefs: VISIBLE, failPrefs: true });
      const r = await get(path, false);
      assert.equal(r.status, 200);
      assert.equal(r.body.openToMeet, false);
    });
    it("the owner still sees their own", async () => {
      use({ callerId: TARGET, prefs: INVISIBLE });
      assert.equal((await get(path, true)).body.openToMeet, true);
    });
  });
}

describe("P-T1a — GET /users/:username/passport (the public profile preview)", () => {
  it("CONTROL: a visible owner's openToMeet reaches a public viewer", async () => {
    use({ callerId: CALLER, prefs: VISIBLE });
    const r = await get(`/users/${HANDLE}/passport`, true);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.openToMeet, true);
  });
  it("an invisible owner's openToMeet does not, and an unreadable consent read withholds it", async () => {
    use({ callerId: CALLER, prefs: INVISIBLE });
    assert.equal((await get(`/users/${HANDLE}/passport`, true)).body.openToMeet, false);
    use({ callerId: CALLER, prefs: VISIBLE, failPrefs: true });
    assert.equal((await get(`/users/${HANDLE}/passport`, true)).body.openToMeet, false);
  });
});

// ── The Passport projection: Travel DNA and the D-103 window door ─────────────

const OWNER = "owner-1";
const VIEWER = "viewer-1";
const FUTURE = new Date(Date.now() + 6 * 3_600_000).toISOString();
const PAST = new Date(Date.now() - 2 * 3_600_000).toISOString();

function perms(over: Partial<ViewerPermissions> = {}): ViewerPermissions {
  return {
    relationshipLabel: "crew", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: true, canSeeAvailability: true,
    canSeeTrips: true, canSeeMutuals: true, canSeeLocationContext: true,
    canSeeFriendOnlyPosts: true, canMessage: true, canSendMessageRequest: false,
    canFollow: false, canInviteToTripCrew: false, ...over,
  };
}
const crewRes: ViewerResolution = { context: "trip_crew", permissions: perms(), sharedTrip: true, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
const mutualRes: ViewerResolution = {
  context: "public",
  permissions: perms({ relationshipLabel: "public", canSeeAvailability: false, viewerFollowsOwner: true, ownerFollowsViewer: true }),
  sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null,
};
function passportDb(prefs: Row | null, windowVisibility = "crew") {
  return makePassportDb({
    profiles: [{
      id: OWNER, handle: "w", display_name: "W", name: "W", home_city: "Hanoi", home_country: "Vietnam", current_city: "Hanoi",
      is_official: false, is_private: false, passport_visibility: "public", show_profile_picture_publicly: true,
      created_at: "2023-01-01", availability_tags: ["Explore"], open_to_meet: true, travel_group_style: ["social"],
    }],
    feature_flags: [{ flag: "open_to_plans_windows_enabled", enabled: true }],
    availability_windows: [{
      id: "w1", user_id: OWNER, type: "one_time", start_at: PAST, end_at: FUTURE, trip_id: null, open_to_plans: true,
      intents: ["Food"], group_preference: "small_group", max_travel_minutes: 20, visibility: windowVisibility, source: "explicit",
      social_availability: "open", expires_at: null, created_at: PAST, updated_at: PAST,
    }],
    location_preferences: prefs ? [{ user_id: OWNER, ...prefs }] : [],
  });
}
const dnaText = (p: unknown) => JSON.stringify((p as { travelIdentity?: unknown }).travelIdentity ?? null);

describe("P-T1a — the Passport projection", () => {
  it("Travel DNA: a visible owner's 'Open to meeting travelers' reaches a crewmate (CONTROL), an invisible owner's does not", async () => {
    const visible = (await buildPassportProjection(passportDb(VISIBLE), OWNER, VIEWER, { resolveViewerContext: async () => crewRes }))!;
    assert.match(dnaText(visible), /Open to meeting travelers/, "CONTROL: the evidence is there for a visible owner");
    const invisible = (await buildPassportProjection(passportDb(INVISIBLE), OWNER, VIEWER, { resolveViewerContext: async () => crewRes }))!;
    assert.doesNotMatch(dnaText(invisible), /Open to meeting travelers/);
  });

  it("the D-103 window door (a mutual follow): a visible owner's followers window reaches them (CONTROL), an invisible owner's does not", async () => {
    const visible = (await buildPassportProjection(passportDb(VISIBLE, "followers"), OWNER, VIEWER, { resolveViewerContext: async () => mutualRes }))!;
    assert.ok(visible.availability?.explicitWindow, "CONTROL: the mutual follow sees the followers window");
    const invisible = (await buildPassportProjection(passportDb(INVISIBLE, "followers"), OWNER, VIEWER, { resolveViewerContext: async () => mutualRes }))!;
    assert.equal(invisible.availability, undefined);
    assert.equal(invisible.intent, undefined);
  });
});
