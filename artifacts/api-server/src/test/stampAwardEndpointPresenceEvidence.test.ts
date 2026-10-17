/**
 * H4 (census-highlights-memories), BD-OD-2's remainder — the two generic award
 * endpoints put a place on a PRESENCE stamp only with occurrence evidence.
 *
 * Before: `POST /admin/stamps/award` and the internal `POST /stamps/award`
 * handed the engine any caller-supplied city/country/lat/lng, and for a
 * presence slug (city_explorer, first_trip_completed, …) the engine kept it.
 * Now `decidePresenceAward` (services/passport/presenceAwardEvidence.ts):
 *   - refuses coordinates on a presence slug;
 *   - refuses a city/country on a presence slug without evidence;
 *   - reads the evidence the rest of the system uses (a check-in on the trip,
 *     a stamp-eligible unrevoked postcard) for THIS person, and writes THE
 *     EVIDENCE'S place and source, refusing a different one;
 *   - answers 503 and writes nothing when the evidence cannot be read.
 *
 * Part 1 drives the decision directly; part 2 drives both HTTP endpoints and
 * reads what the engine inserted (nothing, on every refusal).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/stampAwardEndpointPresenceEvidence.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { decidePresenceAward } from "../services/passport/presenceAwardEvidence.js";
import { makeEngineFake } from "./stampEngineFake.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampsRouter from "../routes/stamps.js";
import adminStampsRouter from "../routes/adminStamps.js";

const USER = "aaaaaaaa-0000-4000-8000-0000000000a1";
const OTHER = "aaaaaaaa-0000-4000-8000-0000000000a2";
const ADMIN = "aaaaaaaa-0000-4000-8000-0000000000ad";
const TRIP = "bbbbbbbb-0000-4000-8000-0000000000b1";
const POST = "cccccccc-0000-4000-8000-0000000000c1";
const ADMIN_TOKEN = "admin-token-h4";
const SECRET = "internal-secret-h4";

type Row = Record<string, unknown>;
interface World {
  trips?: Row[] | "error";
  plan_checkins?: Row[] | "error";
  passport_stamps?: Row[] | "error";
  passport_postcards?: Row[] | "error";
}

const TRIP_ROW = { id: TRIP, status: "completed", destination_city: "Lisbon", destination_country: "Portugal" };
const ARRIVAL = { trip_id: TRIP, user_id: USER, status: "arrived", checked_in_at: "2026-10-01T10:00:00Z" };
const POSTCARD = { post_id: POST, user_id: USER, stamp_eligible: true, stamp_revoked: false, location_city: "Kyoto", location_country: "Japan" };

/** A builder that applies eq/in to seeded rows; "error" answers a DB error. */
function tableBuilder(rows: Row[] | "error" | undefined) {
  const eqs: Array<[string, unknown]> = [];
  const ins: Array<[string, unknown[]]> = [];
  const result = () => {
    if (rows === "error") return { data: null, error: { message: "relation unreadable" } };
    const out = (rows ?? []).filter((r) => eqs.every(([k, v]) => r[k] === v) && ins.every(([k, vs]) => vs.includes(r[k])));
    return { data: out, error: null };
  };
  const b: any = {
    select: () => b,
    eq: (k: string, v: unknown) => { eqs.push([k, v]); return b; },
    in: (k: string, vs: unknown[]) => { ins.push([k, vs]); return b; },
    maybeSingle: async () => { const r = result(); return r.error ? r : { data: r.data![0] ?? null, error: null }; },
    then: (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad),
  };
  return b;
}

function worldClient(world: World, base?: any) {
  return {
    ...(base ?? {}),
    from(table: string) {
      if (table in world && (table !== "trips" || world.trips !== undefined)) return tableBuilder((world as any)[table]);
      if (base) return base.from(table);
      return tableBuilder([]);
    },
  } as any;
}

// ── Part 1: the decision ──────────────────────────────────────────────────────

describe("decidePresenceAward", () => {
  const base = { userId: USER, definitionSlug: "city_explorer" };

  it("passes a NON-presence slug through unchanged (the engine drops its place)", async () => {
    const input = { userId: USER, definitionSlug: "trip_planner", city: "Paris", country: "France" };
    const d = await decidePresenceAward(worldClient({}), input);
    assert.equal(d.ok, true);
    assert.deepEqual(d.ok && d.input, input);
  });

  it("passes a presence slug with NO place and no evidence (a placeless attestation)", async () => {
    const d = await decidePresenceAward(worldClient({}), { ...base, sourceType: "admin" });
    assert.equal(d.ok, true);
    assert.equal(d.ok && d.input.city, undefined);
  });

  it("REFUSES a city on a presence slug without evidence (422)", async () => {
    const d = await decidePresenceAward(worldClient({}), { ...base, city: "Lisbon" });
    assert.deepEqual(!d.ok && [d.status, d.reason], [422, "presence_evidence_required"]);
  });

  it("REFUSES a country alone on a presence slug without evidence (422)", async () => {
    const d = await decidePresenceAward(worldClient({}), { ...base, country: "Portugal" });
    assert.deepEqual(!d.ok && [d.status, d.reason], [422, "presence_evidence_required"]);
  });

  it("REFUSES coordinates on a presence slug even WITH evidence (422)", async () => {
    const world = { trips: [TRIP_ROW], plan_checkins: [ARRIVAL], passport_stamps: [] };
    const d = await decidePresenceAward(worldClient(world), { ...base, lat: 38.7, lng: -9.1 }, { kind: "trip_checkin", tripId: TRIP });
    assert.deepEqual(!d.ok && [d.status, d.reason], [422, "presence_coordinates_refused"]);
  });

  it("trip check-in: writes the TRIP's place and source, and records the evidence", async () => {
    const world = { trips: [TRIP_ROW], plan_checkins: [ARRIVAL], passport_stamps: [] };
    const d = await decidePresenceAward(worldClient(world), { ...base, definitionSlug: "first_trip_completed" }, { kind: "trip_checkin", tripId: TRIP });
    assert.equal(d.ok, true);
    if (!d.ok) return;
    assert.equal(d.input.city, "Lisbon");
    assert.equal(d.input.country, "Portugal");
    assert.equal(d.input.sourceType, "trips");
    assert.equal(d.input.sourceId, TRIP);
    assert.deepEqual(d.input.metadata, { presence_evidence: { kind: "trip_checkin", id: TRIP } });
  });

  it("trip check-in: a verified passport stamp on the trip is evidence too", async () => {
    const world = { trips: [TRIP_ROW], plan_checkins: [], passport_stamps: [{ trip_id: TRIP, user_id: USER, verification_level: "gps" }] };
    const d = await decidePresenceAward(worldClient(world), base, { kind: "trip_checkin", tripId: TRIP });
    assert.equal(d.ok, true);
  });

  it("trip check-in: ANOTHER member's arrival is not this person's evidence (422)", async () => {
    const world = { trips: [TRIP_ROW], plan_checkins: [{ ...ARRIVAL, user_id: OTHER }], passport_stamps: [] };
    const d = await decidePresenceAward(worldClient(world), base, { kind: "trip_checkin", tripId: TRIP });
    assert.deepEqual(!d.ok && [d.status, d.reason], [422, "presence_evidence_absent"]);
  });

  it("trip check-in: a planned/invited row (no arrival) is not evidence (422)", async () => {
    const world = { trips: [TRIP_ROW], plan_checkins: [{ ...ARRIVAL, status: "planned", checked_in_at: null }], passport_stamps: [] };
    const d = await decidePresenceAward(worldClient(world), base, { kind: "trip_checkin", tripId: TRIP });
    assert.deepEqual(!d.ok && [d.status, d.reason], [422, "presence_evidence_absent"]);
  });

  it("trip check-in: unreadable check-ins answer 503, never 'absent' and never an award", async () => {
    const world = { trips: [TRIP_ROW], plan_checkins: "error" as const, passport_stamps: [] };
    const d = await decidePresenceAward(worldClient(world), base, { kind: "trip_checkin", tripId: TRIP });
    assert.deepEqual(!d.ok && [d.status, d.reason], [503, "presence_evidence_unverifiable"]);
  });

  it("trip check-in: an unreadable trip is 503; a missing trip is 422", async () => {
    const e = await decidePresenceAward(worldClient({ trips: "error" }), base, { kind: "trip_checkin", tripId: TRIP });
    assert.deepEqual(!e.ok && [e.status, e.reason], [503, "presence_evidence_unverifiable"]);
    const m = await decidePresenceAward(worldClient({ trips: [] }), base, { kind: "trip_checkin", tripId: TRIP });
    assert.deepEqual(!m.ok && [m.status, m.reason], [422, "presence_evidence_absent"]);
  });

  it("a city that is NOT the evidenced place is refused; the same city in another case is accepted", async () => {
    const world = { trips: [TRIP_ROW], plan_checkins: [ARRIVAL], passport_stamps: [] };
    const bad = await decidePresenceAward(worldClient(world), { ...base, city: "Paris" }, { kind: "trip_checkin", tripId: TRIP });
    assert.deepEqual(!bad.ok && [bad.status, bad.reason], [422, "presence_place_mismatch"]);
    const badCountry = await decidePresenceAward(worldClient(world), { ...base, country: "France" }, { kind: "trip_checkin", tripId: TRIP });
    assert.deepEqual(!badCountry.ok && badCountry.reason, "presence_place_mismatch");
    const good = await decidePresenceAward(worldClient(world), { ...base, city: " lisbon " }, { kind: "trip_checkin", tripId: TRIP });
    assert.equal(good.ok && good.input.city, "Lisbon");
  });

  it("a caller-supplied source other than the evidence is refused, not overwritten", async () => {
    const world = { trips: [TRIP_ROW], plan_checkins: [ARRIVAL], passport_stamps: [] };
    const d = await decidePresenceAward(worldClient(world), { ...base, sourceType: "admin" }, { kind: "trip_checkin", tripId: TRIP });
    assert.deepEqual(!d.ok && [d.status, d.reason], [422, "presence_source_conflict"]);
    const id = await decidePresenceAward(worldClient(world), { ...base, sourceId: POST }, { kind: "trip_checkin", tripId: TRIP });
    assert.deepEqual(!id.ok && id.reason, "presence_source_conflict");
  });

  it("verified postcard: writes the POSTCARD's place, source posts", async () => {
    const d = await decidePresenceAward(worldClient({ passport_postcards: [POSTCARD] }), base, { kind: "verified_postcard", postId: POST });
    assert.equal(d.ok, true);
    if (!d.ok) return;
    assert.deepEqual([d.input.city, d.input.country, d.input.sourceType, d.input.sourceId], ["Kyoto", "Japan", "posts", POST]);
  });

  it("verified postcard: a revoked stamp, an ineligible postcard and someone else's postcard are not evidence", async () => {
    for (const pc of [{ ...POSTCARD, stamp_revoked: true }, { ...POSTCARD, stamp_eligible: false }, { ...POSTCARD, user_id: OTHER }]) {
      const d = await decidePresenceAward(worldClient({ passport_postcards: [pc] }), base, { kind: "verified_postcard", postId: POST });
      assert.deepEqual(!d.ok && [d.status, d.reason], [422, "presence_evidence_absent"], JSON.stringify(pc));
    }
  });

  it("verified postcard: an unreadable postcard table answers 503", async () => {
    const d = await decidePresenceAward(worldClient({ passport_postcards: "error" }), base, { kind: "verified_postcard", postId: POST });
    assert.deepEqual(!d.ok && [d.status, d.reason], [503, "presence_evidence_unverifiable"]);
  });
});

// ── Part 2: both HTTP endpoints ───────────────────────────────────────────────

function presenceDefinition(slug: string) {
  return {
    id: `def-${slug}`, slug, name: slug, stamp_type: "city", is_active: true, is_repeatable: false,
    max_awards_per_user: null, visibility_default: "public", criteria_type: "automatic", criteria: null,
  };
}

function httpWorld(slug: string, world: World) {
  const engine = makeEngineFake({ definition: presenceDefinition(slug), sources: { trips: TRIP_ROW, posts: { status: "active" } } });
  const engineFrom = engine.client.from;
  const client: any = {
    from(table: string) {
      if (table === "profiles") return tableBuilder([{ id: ADMIN, role: "admin" }]);
      if (table === "trips") return world.trips !== undefined ? tableBuilder(world.trips) : engineFrom(table);
      if (table in world) return tableBuilder((world as any)[table]);
      return engineFrom(table);
    },
    auth: { getUser: async (t: string) => (t === ADMIN_TOKEN ? { data: { user: { id: ADMIN } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    storage: { from: () => ({ createSignedUrls: async () => ({ data: [], error: null }) }) },
  };
  return { client, engine };
}

async function serve(client: any): Promise<http.Server> {
  _setTestClient(client, true);
  _setTestServiceClient(client);
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use("/api", stampsRouter);
  app.use("/api", adminStampsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return server;
}

async function post(server: http.Server, path: string, body: unknown, headers: Record<string, string>) {
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as { error?: string; message?: string } | null };
}

const asAdmin = { authorization: `Bearer ${ADMIN_TOKEN}` };
const asService = { "x-internal-secret": SECRET };

describe("POST /api/admin/stamps/award and POST /api/stamps/award — a place on a presence slug needs evidence", () => {
  let server: http.Server | null = null;
  before(() => { process.env.INTERNAL_API_SECRET = SECRET; });
  after(() => { server?.close(); delete process.env.INTERNAL_API_SECRET; });

  async function run(slug: string, world: World, path: string, body: Row, headers: Record<string, string>) {
    const { client, engine } = httpWorld(slug, world);
    server?.close();
    server = await serve(client);
    const res = await post(server, path, body, headers);
    const stamps = engine.inserted.filter((x) => x.table === "user_stamps").map((x) => x.row);
    const events = engine.inserted.filter((x) => x.table === "stamp_award_events").map((x) => x.row);
    return { res, stamps, events };
  }

  it("admin: a city on city_explorer with no evidence is 422 and NOTHING is written", async () => {
    const r = await run("city_explorer", {}, "/api/admin/stamps/award", { userId: USER, definitionSlug: "city_explorer", reason: "manual", city: "Lisbon" }, asAdmin);
    assert.equal(r.res.status, 422);
    assert.equal(r.res.body?.error, "presence_evidence_required");
    assert.deepEqual([r.stamps.length, r.events.length], [0, 0]);
  });

  it("admin: with a check-in on the trip, the stamp carries the TRIP's place and source", async () => {
    const r = await run("first_trip_completed", { plan_checkins: [ARRIVAL], passport_stamps: [] }, "/api/admin/stamps/award",
      { userId: USER, definitionSlug: "first_trip_completed", reason: "support ticket 12", evidence: { kind: "trip_checkin", tripId: TRIP } }, asAdmin);
    assert.equal(r.res.status, 201, JSON.stringify(r.res.body));
    assert.equal(r.stamps.length, 1);
    assert.deepEqual([r.stamps[0].city, r.stamps[0].country, r.stamps[0].source_type, r.stamps[0].source_id], ["Lisbon", "Portugal", "trips", TRIP]);
  });

  it("admin: evidence for a trip the person never checked in on is 422 and nothing is written", async () => {
    const r = await run("first_trip_completed", { plan_checkins: [{ ...ARRIVAL, user_id: OTHER }], passport_stamps: [] }, "/api/admin/stamps/award",
      { userId: USER, definitionSlug: "first_trip_completed", reason: "r", evidence: { kind: "trip_checkin", tripId: TRIP } }, asAdmin);
    assert.equal(r.res.status, 422);
    assert.equal(r.res.body?.error, "presence_evidence_absent");
    assert.equal(r.stamps.length, 0);
  });

  it("admin: a NON-presence slug with a place is still awarded, placeless (positive control: the gate is not a blanket refusal)", async () => {
    const r = await run("trip_planner", {}, "/api/admin/stamps/award", { userId: USER, definitionSlug: "trip_planner", reason: "r", city: "Paris" }, asAdmin);
    assert.equal(r.res.status, 201, JSON.stringify(r.res.body));
    assert.deepEqual([r.stamps[0].city, r.stamps[0].country], [null, null]);
  });

  it("internal: coordinates on city_explorer are 422 and nothing is written", async () => {
    const r = await run("city_explorer", {}, "/api/stamps/award", { userId: USER, definitionSlug: "city_explorer", lat: 35.0, lng: 135.7 }, asService);
    assert.equal(r.res.status, 422);
    assert.equal(r.res.body?.error, "presence_coordinates_refused");
    assert.equal(r.stamps.length, 0);
  });

  it("internal: a city on world_citizen without evidence is 422 and nothing is written", async () => {
    const r = await run("world_citizen", {}, "/api/stamps/award", { userId: USER, definitionSlug: "world_citizen", city: "Kyoto", country: "Japan" }, asService);
    assert.equal(r.res.status, 422);
    assert.equal(r.stamps.length, 0);
  });

  it("internal: with a verified postcard, the stamp carries the POSTCARD's place, source posts", async () => {
    const r = await run("city_explorer", { passport_postcards: [POSTCARD] }, "/api/stamps/award",
      { userId: USER, definitionSlug: "city_explorer", evidence: { kind: "verified_postcard", postId: POST } }, asService);
    assert.equal(r.res.status, 201, JSON.stringify(r.res.body));
    assert.deepEqual([r.stamps[0].city, r.stamps[0].country, r.stamps[0].source_type, r.stamps[0].source_id], ["Kyoto", "Japan", "posts", POST]);
  });

  it("internal: unreadable evidence is 503 and nothing is written", async () => {
    const r = await run("city_explorer", { passport_postcards: "error" }, "/api/stamps/award",
      { userId: USER, definitionSlug: "city_explorer", evidence: { kind: "verified_postcard", postId: POST } }, asService);
    assert.equal(r.res.status, 503);
    assert.equal(r.stamps.length, 0);
  });

  it("both: a malformed evidence object is a 400 before anything is read", async () => {
    const a = await run("city_explorer", {}, "/api/admin/stamps/award", { userId: USER, definitionSlug: "city_explorer", reason: "r", evidence: { kind: "trip_checkin", tripId: "not-a-uuid" } }, asAdmin);
    assert.equal(a.res.status, 400);
    const i = await run("city_explorer", {}, "/api/stamps/award", { userId: USER, definitionSlug: "city_explorer", evidence: { kind: "saved_place", placeId: TRIP } }, asService);
    assert.equal(i.res.status, 400);
    assert.equal(i.stamps.length + a.stamps.length, 0);
  });
});
