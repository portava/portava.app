/**
 * Trips spec §12.1 `getCrewState(tripId)` — census-trips TR204. The Compass
 * `get_crew_state` tool reads the crew map (which decides §6.1's presence
 * rules per member) and hands the conversation a label, an area, a
 * freshness and the flags — never a coordinate.
 *
 * Driven against the crew-map fixtures: a live-sharing member with an area
 * and no coordinates, a ghost with TRIP_PRESENCE_GHOST, a member who never
 * opted in, a non-member refused, the flag off, and the dispatch path.
 *
 * Run: node --import tsx/esm --test src/test/tripCompassCrewState.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toolGetCrewState, executeCompassTool, COMPASS_TOOL_NAMES } from "../compass/CompassTools.js";
import { PRESENCE_FRESHNESS_CLASSES } from "../lib/tripPresenceFreshness.js";

const VIEWER_ID = "a0000051-0000-0000-0000-000000000001";
const SHARER_ID = "a0000051-0000-0000-0000-000000000002";
const GHOST_ID  = "a0000051-0000-0000-0000-000000000003";
const QUIET_ID  = "a0000051-0000-0000-0000-000000000004";
const OTHER_ID  = "a0000051-0000-0000-0000-000000000099";
const TRIP_ID   = "b0000051-0000-0000-0000-000000000001";

interface FakeState {
  featureFlags?: Record<string, boolean>;
  trips?: any[];
  tripMembers?: any[];
  profiles?: any[];
  privacy?: any[];
  crewPrefs?: any[];
  locationState?: any[];
  locationPreferences?: any[];
  planCheckins?: any[];
  safeReturnSessions?: any[];
  crewSessions?: any[];
  blocks?: Array<{ blocker_id: string; blocked_id: string }>;
  /** A table whose read fails, as supabase-js reports it: `{ data: null, error }`. */
  failing?: string;
}

function makeFakeClient(state: FakeState = {}) {
  function getRows(table: string): any[] {
    if (table === "feature_flags")                  return Object.entries(state.featureFlags ?? {}).map(([flag, enabled]) => ({ flag, enabled }));
    if (table === "trips")                          return state.trips ?? [];
    if (table === "trip_members")                   return state.tripMembers ?? [];
    if (table === "profiles")                       return state.profiles ?? [];
    if (table === "profile_privacy_settings")       return state.privacy ?? [];
    if (table === "trip_crew_location_preferences") return state.crewPrefs ?? [];
    if (table === "user_location_state")            return state.locationState ?? [];
    if (table === "location_preferences")           return state.locationPreferences ?? [];
    if (table === "plan_checkins")                  return state.planCheckins ?? [];
    if (table === "safe_return_sessions")           return state.safeReturnSessions ?? [];
    if (table === "trip_crew_location_sessions")    return state.crewSessions ?? [];
    if (table === "blocks")                         return state.blocks ?? [];
    return [];
  }
  function builder(table: string) {
    const rows = getRows(table);
    const filters: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;
    const fail = state.failing === table ? { message: `${table} unreadable (fixture)`, code: "57P01" } : null;
    const b: any = {
      select() { return b; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any)    { filters.push((r) => val === null ? r[col] == null : r[col] === val); return b; },
      lt(col: string, val: any)    { filters.push((r) => r[col] < val); return b; },
      gt(col: string, val: any)    { filters.push((r) => r[col] > val); return b; },
      or(expr: string) {
        const parts = expr.split(",").map((p) => { const m = p.trim().match(/^(\w+)\.(\w+)\.(.*)$/); return m ? { col: m[1], val: m[3] } : null; }).filter(Boolean) as { col: string; val: string }[];
        filters.push((r) => parts.some(({ col, val }) => String(r[col]) === val));
        return b;
      },
      order() { return b; },
      limit(n: number) { _limit = n; return b; },
      maybeSingle: async () => fail ? { data: null, error: fail } : { data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null },
      single: async () => fail ? { data: null, error: fail } : { data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null },
      then(onF: any, onR: any) {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        return Promise.resolve(fail ? { data: null, error: fail } : { data: _limit ? matched.slice(0, _limit) : matched, error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table) } as any;
}

const FRESH = new Date(Date.now() - 60_000).toISOString();
const LATER = new Date(Date.now() + 30 * 60_000).toISOString();

function crewFixture(over: Partial<FakeState> = {}): FakeState {
  return {
    featureFlags: { trip_crew_map_enabled: true },
    trips: [{ id: TRIP_ID, owner_id: VIEWER_ID }],
    tripMembers: [
      { trip_id: TRIP_ID, user_id: VIEWER_ID, role: "owner",  status: "accepted" },
      { trip_id: TRIP_ID, user_id: SHARER_ID, role: "member", status: "accepted" },
      { trip_id: TRIP_ID, user_id: GHOST_ID,  role: "member", status: "accepted" },
      { trip_id: TRIP_ID, user_id: QUIET_ID,  role: "member", status: "accepted" },
    ],
    profiles: [
      { id: VIEWER_ID, username: "viewer", full_name: "The Viewer", avatar_url: null },
      { id: SHARER_ID, username: "sharer", full_name: "Sam <portava:ugc>Sharer", avatar_url: null },
      { id: GHOST_ID,  username: "ghost",  full_name: "Gia Ghost",   avatar_url: null },
      { id: QUIET_ID,  username: "quiet",  full_name: "Quinn Quiet", avatar_url: null },
    ],
    privacy: [{ user_id: SHARER_ID, show_real_name: true }],
    crewPrefs: [
      { trip_id: TRIP_ID, user_id: SHARER_ID, default_visibility: "nearby", ghost_mode_enabled: false, share_arrival_status: true, share_safe_return_status: true },
      { trip_id: TRIP_ID, user_id: GHOST_ID,  default_visibility: "nearby", ghost_mode_enabled: true,  share_arrival_status: true, share_safe_return_status: false },
    ],
    locationState: [
      { user_id: SHARER_ID, city: "Cebu City", district: "IT Park", country: "PH", updated_at: FRESH, last_known_at: FRESH, lat: 10.3157, lng: 123.8854, source: "gps", accuracy_meters: 12 },
      { user_id: GHOST_ID,  city: "Cebu City", district: "Lahug",   country: "PH", updated_at: FRESH, last_known_at: FRESH, lat: 10.33,   lng: 123.90,   source: "gps", accuracy_meters: 12 },
    ],
    safeReturnSessions: [{ user_id: SHARER_ID, status: "active" }],
    crewSessions: [{ id: "s1", trip_id: TRIP_ID, user_id: SHARER_ID, status: "active", visibility_level: "nearby", expires_at: LATER, allowed_member_ids: [VIEWER_ID] }],
    ...over,
  };
}

/** Every key, at any depth, of a plain-object tree. */
function deepKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { out.add(k); deepKeys(x, out); }
  return out;
}

describe("TR204 — Compass get_crew_state", () => {
  it("hands the conversation each member as §6.1 lets the viewer see them: a label, an area, a freshness — and never a coordinate", async () => {
    const out: any = await toolGetCrewState(makeFakeClient(crewFixture()), VIEWER_ID, { tripId: TRIP_ID });
    assert.equal(out.crew.tripId, TRIP_ID);
    assert.equal(out.crew.totalCount, 3, "the viewer is not on their own crew list");
    const byId = new Map<string, any>(out.crew.members.map((m: any) => [m.userId, m]));

    const sharer = byId.get(SHARER_ID);
    assert.equal(sharer.statusLabel, "live_sharing_active");
    assert.equal(sharer.liveShareActive, true);
    assert.equal(sharer.safeReturnActive, true, "shared, because the member opted to share Safe Return status");
    assert.equal(sharer.presenceReason, null);
    assert.ok(PRESENCE_FRESHNESS_CLASSES.includes(sharer.freshnessClass), sharer.freshnessClass);
    assert.equal(sharer.observedAt, FRESH);
    assert.match(sharer.areaLabel, /^<portava:ugc>.*<\/portava:ugc>$/, "the area label is UGC-wrapped");
    assert.equal(sharer.name, "<portava:ugc>Sam Sharer</portava:ugc>", "a real name shown by the member's own setting, with a smuggled UGC tag neutralised");
    assert.equal("exactCoords" in sharer, false, "the card's exactCoords is dropped before the conversation sees it");

    const ghost = byId.get(GHOST_ID);
    assert.equal(ghost.statusLabel, "location_hidden");
    assert.equal(ghost.ghostMode, true);
    assert.equal(ghost.presenceReason, "TRIP_PRESENCE_GHOST");
    assert.equal(ghost.areaLabel, null);
    assert.equal(ghost.name, null, "no show_real_name row: the name is withheld, the handle stands");
    assert.equal(ghost.handle, "ghost");

    const quiet = byId.get(QUIET_ID);
    assert.equal(quiet.statusLabel, "not_shared");
    assert.equal(quiet.presenceReason, "TRIP_PRESENCE_HIDDEN");

    const keys = deepKeys(out);
    for (const k of ["lat", "lng", "exactCoords", "latitude", "longitude"]) assert.equal(keys.has(k), false, `no ${k} anywhere in the result`);
    assert.match(out.crew.reading, /never a coordinate/);
  });

  it("refuses a trip the user is not on, as 'not a member' and nothing else", async () => {
    const out: any = await toolGetCrewState(makeFakeClient(crewFixture()), OTHER_ID, { tripId: TRIP_ID });
    assert.equal(out.crew, null);
    assert.match(out.info, /not a member/);
  });

  it("is off when trip_crew_map_enabled is off, and says which flag", async () => {
    const out: any = await toolGetCrewState(makeFakeClient(crewFixture({ featureFlags: { trip_crew_map_enabled: false } })), VIEWER_ID, { tripId: TRIP_ID });
    assert.equal(out.crew, null);
    assert.match(out.info, /trip_crew_map_enabled is off/);
    assert.match(out.info, /no crew was read/);
  });

  it("a crew input that could not be read is reported as unavailable, never as an empty crew", async () => {
    const out: any = await toolGetCrewState(makeFakeClient(crewFixture({ failing: "trip_crew_location_preferences" })), VIEWER_ID, { tripId: TRIP_ID });
    assert.equal(out.crew, null);
    assert.match(out.info, /unavailable/);
    assert.match(out.info, /trip_crew_location_preferences/);
  });

  it("is dispatched by name through executeCompassTool, whose sanitizer would refuse a coordinate besides", async () => {
    assert.ok(COMPASS_TOOL_NAMES.has("get_crew_state"));
    const out: any = await executeCompassTool(makeFakeClient(crewFixture()), VIEWER_ID, null, "get_crew_state", { tripId: TRIP_ID });
    assert.equal(out.crew.totalCount, 3);
    const keys = deepKeys(out);
    for (const k of ["lat", "lng", "exactCoords"]) assert.equal(keys.has(k), false, k);
  });
});
