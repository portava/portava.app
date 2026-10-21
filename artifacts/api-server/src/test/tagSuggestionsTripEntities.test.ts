/**
 * Tag suggestions (wave 5, 2026-10-17) — the @-mention picker offers the trips
 * the caller is an ACCEPTED member of, by title.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/tagSuggestionsTripEntities.test.ts
 *
 * THE DEFECT. GET /api/tags/suggestions read
 * `trip_members.select("trip_id, trips(id, name, destination, status)")`.
 * `trips` has `title` and `destination_city`; it has never had `name` or
 * `destination` (2026-08-19 production baseline, the 2026-09-22 production
 * capture, no migration). PostgREST failed the read with 42703, the route never
 * read `error`, and the trip half of the picker was empty on every call. Found
 * by test/schemaColumnProductionScan.test.ts (class A: the columns exist
 * nowhere).
 *
 * THE FIX. Read `name:title, destination:destination_city` (the keys the route
 * already used), and only for an `accepted` membership: once the read works, an
 * invited, declined, removed or departed row must not surface the trip's title.
 * Proven here on schemaStrictSupabase with `joinEmbeds` (each embed materialised
 * from flat seed tables along its foreign key, its columns checked against the
 * live schema — a dead name answers 42703):
 *   1. a matching trip the caller is an accepted member of is suggested with its
 *      title and destination city;
 *   2. a trip whose membership is not accepted is not suggested;
 *   3. the read names no dead trips / trip_members column.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeSchemaStrictClient, type Seed } from "./helpers/schemaStrictSupabase.js";
import tagsRouter from "../routes/tags.js";

const ME = "a1a1a1a1-0000-4000-a000-0000000000a1";
const T_JOINED = "71717171-0000-4000-a000-000000000001";
const T_LEFT = "71717171-0000-4000-a000-000000000002";
const T_INVITED = "71717171-0000-4000-a000-000000000003";
const T_OTHER = "71717171-0000-4000-a000-000000000004";
const TOKEN = "tok-me";

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, child() { return noopLog; } };

function trip(id: string, title: string, city: string) {
  return { id, owner_id: ME, title, destination_city: city, status: "planning", visibility: "private" };
}
function member(tripId: string, status: string) {
  return { trip_id: tripId, user_id: ME, role: "member", status, created_at: "2026-10-01T00:00:00.000Z" };
}

function world(): Seed {
  return {
    profiles: [{ id: ME, handle: "me", name: "Me", avatar_url: null, tag_permission: "anyone" }],
    user_account_states: [],
    blocks: [],
    trips: [
      trip(T_JOINED, "Lisbon Escape", "Lisbon"),
      trip(T_LEFT, "Lisbon Old Crew", "Lisbon"),
      trip(T_INVITED, "Lisbon Maybe", "Lisbon"),
      trip(T_OTHER, "Porto Weekend", "Porto"),
    ],
    trip_members: [member(T_JOINED, "accepted"), member(T_LEFT, "left"), member(T_INVITED, "invited"), member(T_OTHER, "accepted")],
  };
}

const auth = { getUser: async (token: string) => (token === TOKEN ? { data: { user: { id: ME } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) };

let server: http.Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", tagsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

/** schemaStrictSupabase with embeds materialised; `.or()` (not modelled there) narrows nothing — every seeded profile is "me", excluded by `.neq`. */
function install(seed: Seed) {
  const strict = makeSchemaStrictClient(seed, { joinEmbeds: true });
  const memberSelects: string[] = [];
  const from = (t: string) => {
    const b = strict.from(t);
    b.or = () => b;
    const select = b.select;
    b.select = (c?: string, o?: any) => { if (t === "trip_members") memberSelects.push(c ?? ""); return select(c, o); };
    return b;
  };
  const client = { from, auth };
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
  return { strict, memberSelects };
}

async function suggestions(q: string): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${base}/api/tags/suggestions?q=${encodeURIComponent(q)}&surface=post`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body, raw };
}

describe("schema-strict: GET /api/tags/suggestions offers the caller's accepted trips by title", () => {
  it("a matching accepted trip is suggested with its title and destination city", async () => {
    install(world());
    const r = await suggestions("lisbon");
    assert.equal(r.status, 200, r.raw);
    const trips = (r.body.suggestions as any[]).filter((s) => s.type === "trip");
    assert.deepEqual(trips, [{ id: T_JOINED, type: "trip", name: "Lisbon Escape", destination: "Lisbon" }]);
  });

  it("a trip whose membership is left or invited is not suggested", async () => {
    install(world());
    const r = await suggestions("lisbon");
    const ids = (r.body.suggestions as any[]).filter((s) => s.type === "trip").map((s) => s.id);
    assert.ok(!ids.includes(T_LEFT), "a departed member must not be offered the trip");
    assert.ok(!ids.includes(T_INVITED), "an invitation is not membership");
  });

  it("the membership read names only live columns (the 42703 that emptied the trip half)", async () => {
    const { strict, memberSelects } = install(world());
    await suggestions("lisbon");
    assert.ok(memberSelects.some((c) => c.includes("trips(")), "the trip read ran");
    assert.deepEqual(strict.deadColumnErrors.filter((e) => e.table === "trips" || e.table === "trip_members"), []);
  });
});
