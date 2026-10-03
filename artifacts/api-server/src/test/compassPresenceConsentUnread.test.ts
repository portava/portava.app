/**
 * census-discovery §108 (DV-83 round 11, lane W11-X2; D-W11X2-75, D-W11X2-76, D-W11X2-83, D-W11X2-85).
 *
 * §108.1 BK1: `canViewCirclePresenceBatch` — the consent batch the Compass presence walk reads —
 * checked only its `blocks` read. A failed `circle_visibility_settings` read denied every target as
 * `target_sharing_off`; a failed `circle_presence` read allowed a target with no presence row, which
 * the walk drops. Neither is `unavailable`, so the walk never said it failed: GET /compass/home
 * answered `circleActivity: "ok"` and cached it, and `get_whos_around` said "Nobody … is sharing".
 * A failed `circle_context_settings` or `user_account_states` read also failed OPEN on privacy: a
 * context the target paused, or a banned target, was shown. §108.1 BK2: the tool presented a
 * partial list as complete. SM6: the event context's `event_attendees` read failing alone.
 *
 * V10-* cases are the round-10 verifier's probes (scratchpad v10-probes/zz-v10-presenceTelegraphCity),
 * copied in unchanged apart from the harness they share.
 *
 *   CB0      CONTROL: the batch, every read answered → the friend allowed with the presence row
 *   CB1      the batch's circle_visibility_settings read fails → every target unavailable
 *   CB2      circle_context_settings fails while the target PAUSED this context → denied (unavailable), never shown
 *   CB3      user_account_states fails while the target is BANNED → denied (unavailable), never shown
 *   CB4      circle_presence fails → every target unavailable, never "allowed, no presence"
 *   CB2c     CONTROL: the paused context, read → context_paused;  CB3c: the ban, read → target_restricted
 *   V10-HP0  CONTROL: a friend is sharing, every read answered → circleActivity ok with @ana
 *   V10-HP1  circle_visibility_settings fails → circleActivity not "ok"
 *   V10-HP2  circle_presence fails → circleActivity not "ok"
 *   V10-HP3  the HP1 home is not cached: after the read recovers the next home shows @ana
 *   HP4      circle_context_settings fails → circleActivity not "ok";  HP5: user_account_states fails → the same
 *   V10-SM6  only an event context's event_attendees read fails → circleActivity not "ok" (pins SM6)
 *   V10-WT1  get_whos_around, circle_visibility_settings fails → never "Nobody … is sharing"
 *   V10-WT2  get_whos_around, one context's read fails while @ana is shown → the list may be incomplete
 *   WT2c     CONTROL: every read answered, @ana shown → the complete-list wording
 *   MO0      sweep (D-W11X2-83), get_meetup_opportunities CONTROL: both sharing → one occasion, the complete wording
 *   MO1      the forward consent read fails → "could not be checked", never "Nobody … is sharing"
 *   MO2      the viewer's trip read fails → never "no active trips or upcoming events"
 *   MO3      the reciprocity (viewer-side) read fails → "could not be checked", never "isn't shared both ways"
 *   MO4      an event context's read fails while an occasion is found → the occasion, and the list may be incomplete
 *   MO5      the reciprocity check THROWS → could not be checked (withheld, and said)
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/compassPresenceConsentUnread.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import compassHomeRouter, { _clearCompassHomeCache } from "../routes/compassHome.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearL1Cache } from "../compass/CompassCacheEngine.js";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { executeCompassTool } from "../compass/CompassTools.js";
import { canViewCirclePresenceBatch } from "../lib/circleAccessGuard.js";
import type { CompassProfile } from "../compass/types.js";
import { compassWorld, eqValue, TOKEN, VIEWER, DB_ERR, type WorldOpts } from "./helpers/compassReadWorld.js";

const TRIP = "a1000000-0000-4000-a000-000000000001";
const FRIEND = "a2000000-0000-4000-a000-000000000002";
const EVT = "a4000000-0000-4000-a000-000000000004";

let base = "";
let server: Server;
let world = compassWorld();
function serve(opts: WorldOpts = {}) { world = compassWorld(opts); _setTestClient(world.client as any, true); }
const realFetch = globalThis.fetch;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }; next(); });
  app.use("/api", compassHomeRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
    if (url.includes("geocod")) return new Response(JSON.stringify({ results: [{ latitude: 48.85, longitude: 2.35 }] }), { status: 200 });
    const d = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    return new Response(JSON.stringify({ daily: { time: [d], weathercode: [1], temperature_2m_max: [20], temperature_2m_min: [10], precipitation_sum: [0] } }), { status: 200 });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; server.close(); });
beforeEach(() => { clearL1Cache(); invalidateFlagsCache(); _resetRateLimit(); _clearCompassHomeCache(); clearCompassProfileCache(); });

async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await realFetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json() };
}
let n = 0;
const homePath = () => `/compass/home?tzOffsetMinutes=${(n++ % 40) * 15}`;

interface Extra { rsvps?: "going"; eventMembersFail?: boolean; attendeesFail?: boolean; contextPaused?: boolean; banned?: boolean }

/** A viewer on one trip with FRIEND (an accepted member who shares). `fail` names one consent-batch table to fail. */
function friendWorld(fail?: string, extra?: Extra): WorldOpts["answer"] {
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 3_600_000).toISOString();
  return (table, calls) => {
    const byTrip = eqValue(calls, "trip_id"), byUser = eqValue(calls, "user_id"), byEvent = eqValue(calls, "event_id");
    const hasIn = (col: string) => calls.some(([k, a]) => k === "in" && a[0] === col);
    if (fail && table === fail) return { data: null, error: DB_ERR };
    if (table === "trip_members") {
      if (byTrip && byUser) return { data: { role: "owner", status: "accepted" }, error: null };
      if (byTrip && hasIn("user_id")) return { data: [{ user_id: FRIEND, role: "member", status: "accepted" }], error: null };
      if (byTrip) return { data: [{ user_id: VIEWER, role: "owner", status: "accepted" }, { user_id: FRIEND, role: "member", status: "accepted" }], error: null };
      if (byUser === VIEWER) return { data: [{ trip_id: TRIP, role: "owner", status: "accepted" }], error: null };
    }
    if (table === "trips" && calls.some(([k, a]) => k === "in" && a[0] === "status")) return { data: [{ id: TRIP, title: "Paris trip", destination_city: "Paris", status: "active" }], error: null };
    if (table === "event_rsvps" && byUser === VIEWER && eqValue(calls, "status") === "going") return extra?.rsvps === "going" ? { data: [{ event_id: EVT, status: "going" }], error: null } : { data: [], error: null };
    if (table === "events" && calls.some(([k, a]) => k === "select" && a[0] === "id, title, starts_at")) return { data: [{ id: EVT, title: "Jazz", starts_at: later }], error: null };
    if (table === "event_attendees" && byEvent === EVT && !hasIn("user_id") && extra?.attendeesFail) return { data: null, error: DB_ERR };
    if ((table === "event_rsvps" || table === "event_attendees") && byEvent === EVT && !hasIn("user_id")) return extra?.eventMembersFail ? { data: null, error: DB_ERR } : { data: [{ user_id: FRIEND }], error: null };
    if (table === "circle_visibility_settings") return { data: [{ user_id: FRIEND, global_enabled: true, visibility_mode: "status_only", trip_sharing_default: null, event_sharing_default: null, is_paused: false, consent_version: "v1", consented_at: now }], error: null };
    if (table === "circle_context_settings") return { data: extra?.contextPaused ? [{ user_id: FRIEND, enabled: true, visibility_mode_override: null, paused: true, paused_until: null }] : [], error: null };
    if (table === "user_account_states") return { data: extra?.banned ? [{ user_id: FRIEND, state: "banned", expires_at: null }] : [], error: null };
    if (table === "circle_presence") return { data: [{ user_id: FRIEND, id: "p1", status: "active", status_label: null, approximate_label: null, venue_label: null, checked_in: false, last_seen_at: now, expires_at: later, stale_after_secs: 900, is_stale: false, needs_help: false, updated_at: now }], error: null };
    if (table === "profiles" && hasIn("id")) return { data: [{ id: FRIEND, handle: "ana", name: null, display_name: null }], error: null };
    return undefined;
  };
}

const profile = { userId: VIEWER, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile;
const tool = async (w: ReturnType<typeof compassWorld>) => (await executeCompassTool(w.client as any, VIEWER, profile, "get_whos_around", {})) as { people: any[]; info: string };
const batch = async (fail?: string, extra?: Extra) => canViewCirclePresenceBatch(compassWorld({ answer: friendWorld(fail, extra) }).client as any, VIEWER, [FRIEND], "trip", TRIP);

describe("§108 (BK1) the consent batch refuses a failed read of its own", () => {
  it("CB0 CONTROL: every read answered → the friend allowed, with the presence row", async () => {
    const r = (await batch()).get(FRIEND) as any;
    assert.equal(r.allowed, true, JSON.stringify(r));
    assert.equal(r.presenceRow?.id, "p1");
  });
  it("CB1 circle_visibility_settings fails → unavailable, never 'target_sharing_off'", async () => {
    assert.deepEqual((await batch("circle_visibility_settings")).get(FRIEND), { allowed: false, reason: "unavailable" });
  });
  it("CB2 circle_context_settings fails while the target PAUSED this context → denied (unavailable), never shown", async () => {
    assert.deepEqual((await batch("circle_context_settings", { contextPaused: true })).get(FRIEND), { allowed: false, reason: "unavailable" });
  });
  it("CB2c CONTROL: the paused context, read → context_paused", async () => {
    assert.equal(((await batch(undefined, { contextPaused: true })).get(FRIEND) as any).reason, "context_paused");
  });
  it("CB3 user_account_states fails while the target is BANNED → denied (unavailable), never shown", async () => {
    assert.deepEqual((await batch("user_account_states", { banned: true })).get(FRIEND), { allowed: false, reason: "unavailable" });
  });
  it("CB3c CONTROL: the ban, read → target_restricted", async () => {
    assert.equal(((await batch(undefined, { banned: true })).get(FRIEND) as any).reason, "target_restricted");
  });
  it("CB4 circle_presence fails → unavailable, never 'allowed with no presence'", async () => {
    assert.deepEqual((await batch("circle_presence")).get(FRIEND), { allowed: false, reason: "unavailable" });
  });
});

describe("§108 (BK1) GET /compass/home over a failed consent-batch read", () => {
  it("V10-HP0 CONTROL: a friend is sharing, every read answered → ok with @ana", async () => {
    serve({ answer: friendWorld() });
    const { body } = await get(homePath());
    assert.equal(body.circleActivity?.people?.[0]?.handle, "@ana", JSON.stringify(body.circleActivity));
    assert.equal(body.sources.circleActivity, "ok");
  });
  it("V10-HP1 circle_visibility_settings read fails → circleActivity must not be 'ok' (nobody around)", async () => {
    serve({ answer: friendWorld("circle_visibility_settings") });
    const { body } = await get(homePath());
    assert.notEqual(body.sources.circleActivity, "ok", `circleActivity=${JSON.stringify(body.circleActivity)} sources=${JSON.stringify(body.sources)} degraded=${body.degraded}`);
  });
  it("V10-HP2 circle_presence read fails → circleActivity must not be 'ok' (nobody around)", async () => {
    serve({ answer: friendWorld("circle_presence") });
    const { body } = await get(homePath());
    assert.notEqual(body.sources.circleActivity, "ok", `circleActivity=${JSON.stringify(body.circleActivity)} sources=${JSON.stringify(body.sources)} degraded=${body.degraded}`);
  });
  it("V10-HP3 the HP1 home must not be cached and replayed after the read recovers", async () => {
    serve({ answer: friendWorld("circle_visibility_settings") });
    await get("/compass/home?tzOffsetMinutes=30");
    serve({ answer: friendWorld() });
    const { body } = await get("/compass/home?tzOffsetMinutes=30");
    assert.equal(body.circleActivity?.people?.[0]?.handle, "@ana", `replayed: ${JSON.stringify(body.circleActivity)}; reads=${world.readsSeen.length}`);
  });
  it("HP4 circle_context_settings read fails → circleActivity unavailable", async () => {
    serve({ answer: friendWorld("circle_context_settings") });
    const { body } = await get(homePath());
    assert.equal(body.sources.circleActivity, "unavailable", JSON.stringify(body.sources));
  });
  it("HP5 user_account_states read fails → circleActivity unavailable", async () => {
    serve({ answer: friendWorld("user_account_states") });
    const { body } = await get(homePath());
    assert.equal(body.sources.circleActivity, "unavailable", JSON.stringify(body.sources));
  });
  it("V10-SM6 (reachability of mutation SM6) only an event context's event_attendees read fails → circleActivity must not be 'ok'", async () => {
    serve({ answer: (t, c, sg) => (t === "trip_members" && eqValue(c, "user_id") === VIEWER && !eqValue(c, "trip_id") ? { data: [], error: null } : friendWorld(undefined, { rsvps: "going", attendeesFail: true })!(t, c, sg)) });
    const { body } = await get(homePath());
    assert.notEqual(body.sources.circleActivity, "ok", JSON.stringify(body.sources));
  });
});

describe("§108 (BK1, BK2) the get_whos_around tool", () => {
  it("V10-WT1 get_whos_around, circle_visibility_settings fails → must not say 'Nobody … is sharing'", async () => {
    const r = await tool(compassWorld({ answer: friendWorld("circle_visibility_settings") }));
    assert.doesNotMatch(r.info, /Nobody in the user's circles is sharing/, r.info);
  });
  it("V10-WT2 get_whos_around, one context's read fails while @ana is shown → must say the list may be incomplete", async () => {
    const r = await tool(compassWorld({ answer: friendWorld(undefined, { rsvps: "going", eventMembersFail: true }) }));
    assert.equal(r.people.length, 1, JSON.stringify(r));
    assert.match(r.info, /could not|incomplete|partial|some/i, `people=${r.people.length} info=${r.info}`);
  });
  it("WT2c CONTROL: every read answered, @ana shown → the complete-list wording, no incomplete note", async () => {
    const r = await tool(compassWorld({ answer: friendWorld(undefined, { rsvps: "going" }) }));
    assert.equal(r.people.length, 1, JSON.stringify(r));
    assert.match(r.info, /^Only people who opted in to sharing appear/, r.info);
    assert.doesNotMatch(r.info, /incomplete/i, r.info);
  });
});

/** friendWorld, plus the VIEWER's own sharing rows the reciprocity guard reads (single reads, by user). */
function meetupWorld(opts: { fail?: string; extra?: Extra; viewerSideFails?: boolean; tripsFail?: boolean; viewerSideThrows?: boolean } = {}): WorldOpts["answer"] {
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const base = friendWorld(opts.fail, opts.extra)!;
  return (table, calls, single) => {
    const byUser = eqValue(calls, "user_id");
    if (opts.tripsFail && table === "trips") return { data: null, error: DB_ERR };
    if (single && byUser === VIEWER && opts.viewerSideThrows && table === "circle_presence") throw new Error("socket hang up");
    if (single && byUser === VIEWER) {
      if (table === "circle_visibility_settings") return opts.viewerSideFails ? { data: null, error: DB_ERR } : { data: { global_enabled: true, visibility_mode: "status_only", trip_sharing_default: null, event_sharing_default: null, is_paused: false, consent_version: "v1", consented_at: now }, error: null };
      if (table === "circle_context_settings") return { data: null, error: null };
      if (table === "circle_presence") return { data: { id: "pv", status: "active", status_label: null, approximate_label: null, venue_label: null, checked_in: false, last_seen_at: now, expires_at: later, stale_after_secs: 900, is_stale: false, needs_help: false, updated_at: now }, error: null };
    }
    if (table === "user_account_states" && byUser === VIEWER) return { data: [], error: null };
    return base(table, calls, single);
  };
}
const meetup = async (answer: WorldOpts["answer"]) => (await executeCompassTool(compassWorld({ answer }).client as any, VIEWER, profile, "get_meetup_opportunities", {})) as { opportunities: any[]; withheldForPrivacy: number; info: string };

describe("§108 sweep (D-W11X2-83): the get_meetup_opportunities tool over a failed read", () => {
  it("MO0 CONTROL: both sharing, every read answered → one occasion, the complete wording", async () => {
    const r = await meetup(meetupWorld());
    assert.equal(r.opportunities.length, 1, JSON.stringify(r));
    assert.match(r.info, /^Each occasion exists only because both people/, r.info);
  });
  it("MO1 the forward consent read fails → could not be checked, never 'Nobody … is sharing'", async () => {
    const r = await meetup(meetupWorld({ fail: "circle_visibility_settings" }));
    assert.deepEqual(r.opportunities, []);
    assert.doesNotMatch(r.info, /Nobody in the user's circles/, r.info);
    assert.match(r.info, /could not be checked/i, r.info);
  });
  it("MO2 the viewer's trip read fails → never 'no active trips or upcoming events'", async () => {
    const r = await meetup(meetupWorld({ tripsFail: true }));
    assert.doesNotMatch(r.info, /no active trips/, r.info);
    assert.match(r.info, /could not be checked/i, r.info);
  });
  it("MO3 the reciprocity read fails → could not be checked, never 'isn't shared both ways'", async () => {
    const r = await meetup(meetupWorld({ viewerSideFails: true }));
    assert.deepEqual(r.opportunities, []);
    assert.doesNotMatch(r.info, /isn't shared both ways/, r.info);
    assert.match(r.info, /could not be checked/i, r.info);
  });
  it("MO4 an event context's read fails while an occasion is found → the occasion, and the list may be incomplete", async () => {
    const r = await meetup(meetupWorld({ extra: { rsvps: "going", eventMembersFail: true } }));
    assert.equal(r.opportunities.length, 1, JSON.stringify(r));
    assert.match(r.info, /may be incomplete/i, r.info);
  });
  it("MO5 the reciprocity check THROWS → could not be checked, never 'nobody is sharing'", async () => {
    const r = await meetup(meetupWorld({ viewerSideThrows: true }));
    assert.deepEqual(r.opportunities, []);
    assert.match(r.info, /could not be checked/i, r.info);
  });
});
