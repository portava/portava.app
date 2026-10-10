/**
 * CPH-08-ADAPT (lead ruling 2026-10-07; census-compass §52) — Compass's
 * search_places / search_events consult a live provider only behind
 * `compass_live_search_enabled` (3704, seeded FALSE), the provider key, and a
 * per-person daily quota of 5; anything labelled live obeys D-67; any refusal or
 * provider failure falls back to the catalog with no error.
 *
 * Driven through the real tool dispatcher (executeCompassTool) over a
 * table-backed fake whose `rpc("compass_live_search_take")` implements 3704's
 * atomic take (count < limit → TRUE and +1; else FALSE). The providers and key
 * readers are replaced through the adapter's test seam, so no network is used.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/compassLiveSearch.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeClient } from "./highlightRouteHarness.js";
import { executeCompassTool } from "../compass/CompassTools.js";
import { _setLiveSearchDeps, COMPASS_LIVE_SEARCH_DAILY_QUOTA, COMPASS_LIVE_SEARCH_FLAG } from "../compass/CompassLiveSearch.js";
import type { CompassProfile } from "../compass/types.js";

const USER = "a1a1a1a1-aaaa-4aaa-8aaa-000000000001";
const PLACE = "11111111-0000-4000-8000-000000000001";
const PROFILE = { userId: USER, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile;
// Han Market, Da Nang — the catalog place's own coordinates.
const HAN = { lat: 16.0678, lng: 108.2208 };

function world(opts: { flag?: boolean | "unreadable"; quotaError?: boolean; used?: number } = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: opts.flag === undefined || opts.flag === "unreadable" ? [] : [{ flag: COMPASS_LIVE_SEARCH_FLAG, enabled: opts.flag }],
    discovery_places: [{ id: PLACE, name: "Han Market", category: "market", primary_category: "market", city: "Da Nang", neighborhood: null, rating: 4.4, saved_count: 3, verified: true, blurb: "covered market", lat: HAN.lat, lng: HAN.lng }],
    events: [], trips: [], trip_members: [], safe_return_sessions: [], profiles: [],
  };
  const c: any = makeClient(tables, opts.flag === "unreadable" ? { errors: { feature_flags: { message: "flags unreadable", code: "XX000" } } } : {});
  let used = opts.used ?? 0;
  c.rpcCalls = 0;
  c.rpc = async (fn: string, args: any) => {
    if (fn !== "compass_live_search_take") return { data: null, error: { message: "rpc not modelled" } };
    c.rpcCalls++;
    if (opts.quotaError) return { data: null, error: { message: "quota table unreadable", code: "XX000" } };
    if (used < Number(args.p_daily_limit)) { used++; return { data: true, error: null }; }
    return { data: false, error: null };
  };
  return c;
}

/** Provider stand-ins that count their calls. */
function providers(opts: { places?: any[]; events?: any[]; placesKey?: string | null; eventsKey?: string | null; throwPlaces?: boolean } = {}) {
  const calls = { places: 0, events: 0 };
  _setLiveSearchDeps({
    placesKey: () => (opts.placesKey === undefined ? "fsq-test-key" : opts.placesKey),
    eventsKey: () => (opts.eventsKey === undefined ? "tm-test-key" : opts.eventsKey),
    searchPlaces: async () => { calls.places++; if (opts.throwPlaces) throw new Error("provider down"); return opts.places ?? []; },
    searchEvents: async () => { calls.events++; return { events: opts.events ?? [] }; },
  });
  return calls;
}
afterEach(() => _setLiveSearchDeps({}));

const fsq = (name: string, lat: number, lng: number, extra: Record<string, unknown> = {}) =>
  ({ id: `foursquare-${name}`, type: "landmark", name, city: "Da Nang", lat, lng, source: "foursquare", attribution: "Powered by Foursquare", ...extra });
const search = (c: any, args: Record<string, unknown> = { city: "Da Nang" }) => executeCompassTool(c, USER, PROFILE, "search_places", args) as Promise<any>;

describe("CPH-08-ADAPT — the gates, in order, and nothing spent on a refusal", () => {
  it("flag OFF (absent): no quota taken, no provider called, and the result is exactly today's (no live fields)", async () => {
    const calls = providers({ places: [fsq("Han Market", HAN.lat, HAN.lng)] });
    const c = world();
    const r = await search(c);
    assert.equal(calls.places, 0); assert.equal(c.rpcCalls, 0);
    assert.equal(r.liveSearch, undefined); assert.equal(r.liveListings, undefined);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].confidence.sourceClass, "community_reported");
  });

  it("an UNREADABLE flag is off: nothing spent", async () => {
    const calls = providers({ places: [fsq("Other Cafe", 16.07, 108.22)] });
    const c = world({ flag: "unreadable" });
    const r = await search(c);
    assert.equal(calls.places, 0); assert.equal(c.rpcCalls, 0);
    assert.equal(r.liveSearch, undefined);
  });

  it("flag ON, keys ABSENT: refused before the quota — catalog only, no error, the reason stated", async () => {
    const calls = providers({ placesKey: null, places: [fsq("Other Cafe", 16.07, 108.22)] });
    const c = world({ flag: true });
    const r = await search(c);
    assert.equal(calls.places, 0); assert.equal(c.rpcCalls, 0, "no quota unit taken for a call that cannot be made");
    assert.deepEqual(r.liveSearch, { used: false, provider: "foursquare", reason: "keys_absent" });
    assert.equal(r.candidates.length, 1); assert.equal(r.info, undefined);
  });

  it(`the daily quota: ${COMPASS_LIVE_SEARCH_DAILY_QUOTA} live searches, then catalog only (quota_exhausted) with no provider call`, async () => {
    const calls = providers({ places: [fsq("Other Cafe", 16.07, 108.22)] });
    const c = world({ flag: true });
    for (let i = 0; i < COMPASS_LIVE_SEARCH_DAILY_QUOTA; i++) assert.equal((await search(c)).liveSearch.used, true, `search ${i + 1}`);
    const sixth = await search(c);
    assert.deepEqual(sixth.liveSearch, { used: false, provider: "foursquare", reason: "quota_exhausted" });
    assert.equal(calls.places, COMPASS_LIVE_SEARCH_DAILY_QUOTA, "the sixth search reached the provider");
    assert.equal(sixth.candidates.length, 1);
  });

  it("an UNREADABLE quota spends nothing (fail closed): catalog only", async () => {
    const calls = providers({ places: [fsq("Other Cafe", 16.07, 108.22)] });
    const r = await search(world({ flag: true, quotaError: true }));
    assert.deepEqual(r.liveSearch, { used: false, provider: "foursquare", reason: "quota_unreadable" });
    assert.equal(calls.places, 0);
  });

  it("a provider that fails or finds nothing: catalog only, no error", async () => {
    for (const p of [{ throwPlaces: true }, { places: [] }]) {
      providers(p);
      const r = await search(world({ flag: true }));
      assert.deepEqual(r.liveSearch, { used: false, provider: "foursquare", reason: "provider_returned_nothing" });
      assert.equal(r.candidates.length, 1); assert.equal(r.info, undefined);
    }
  });

  it("no query and no city: nothing to search live, no quota taken", async () => {
    providers({ places: [fsq("Other Cafe", 16.07, 108.22)] });
    const c = world({ flag: true });
    const r = await search(c, {});
    assert.equal(r.liveSearch.reason, "no_query"); assert.equal(c.rpcCalls, 0);
  });
});

describe("CPH-08-ADAPT — D-67 for anything labelled live", () => {
  it("a provider record with the same name within 150 m CONFIRMS the catalog place, which alone is labelled verified live", async () => {
    providers({ places: [fsq("HAN  market!", HAN.lat + 0.0005, HAN.lng)] }); // ~55 m, name normalises equal
    const r = await search(world({ flag: true }));
    assert.equal(r.liveSearch.used, true);
    assert.equal(r.candidates[0].confidence.sourceClass, "verified_live");
    assert.equal(r.liveListings, undefined, "a confirmed record is not offered a second time as a listing");
  });

  it("the same name 400 m away, or a different name at the same spot, confirms nothing: a provider LISTING, never labelled verified live", async () => {
    providers({ places: [fsq("Han Market", HAN.lat + 0.0036, HAN.lng), fsq("Han Market Annex", HAN.lat, HAN.lng)] });
    const r = await search(world({ flag: true }));
    assert.equal(r.candidates[0].confidence.sourceClass, "community_reported");
    assert.equal(r.liveListings.length, 2);
    for (const l of r.liveListings) {
      assert.notEqual(l.confidence.sourceClass, "verified_live");
      assert.match(l.confidence.dataNote, /not verified live/);
      assert.equal(l.attribution, "Powered by Foursquare");
      assert.equal(l.lat, undefined, "no provider coordinate reaches the model"); assert.equal(l.lng, undefined);
    }
  });

  it("a record without coordinates confirms nothing", async () => {
    providers({ places: [fsq("Han Market", null as any, null as any)] });
    const r = await search(world({ flag: true }));
    assert.equal(r.candidates[0].confidence.sourceClass, "community_reported");
  });
});

describe("CPH-08-ADAPT — search_events", () => {
  const ev = { id: "tm1", name: "Night Concert", category: "Music", localDate: "2026-10-09", venueName: "Arena", url: "https://example.test/e" };
  it("flag on + key: Ticketmaster listings, quota taken, never labelled live", async () => {
    const calls = providers({ events: [ev] });
    const c = world({ flag: true });
    const r: any = await executeCompassTool(c, USER, PROFILE, "search_events", { city: "Da Nang" });
    assert.equal(calls.events, 1); assert.equal(c.rpcCalls, 1);
    assert.equal(r.liveSearch.used, true);
    assert.equal(r.liveListings[0].title, "Night Concert");
    assert.notEqual(r.liveListings[0].confidence.sourceClass, "verified_live");
  });
  it("flag off: nothing spent, today's result", async () => {
    const calls = providers({ events: [ev] });
    const c = world();
    const r: any = await executeCompassTool(c, USER, PROFILE, "search_events", { city: "Da Nang" });
    assert.equal(calls.events, 0); assert.equal(c.rpcCalls, 0); assert.equal(r.liveSearch, undefined);
  });
  it("key absent: no quota taken, catalog only", async () => {
    const calls = providers({ eventsKey: null, events: [ev] });
    const c = world({ flag: true });
    const r: any = await executeCompassTool(c, USER, PROFILE, "search_events", { city: "Da Nang" });
    assert.equal(calls.events, 0); assert.equal(c.rpcCalls, 0);
    assert.equal(r.liveSearch.reason, "keys_absent");
  });
});
