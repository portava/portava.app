/**
 * OD-TRIP-3 — "a private trip place is owner-only unless the owner shared it"
 * — on the two Safe Return readers of `trip_plan_items`.
 *
 * ## The defects
 *
 * 1. `GET /me/safe-return/suggest/:planItemId` reads the item through the
 *    user's client. `plan_items_select` (2337) admits ANY trip crew member to
 *    ANY non-removed item, private or not, and the route then used the item's
 *    exact `lat`/`lng` to look up `geo_zones` — so a crewmate learned, from the
 *    verdict, whether another member's private place sits in a caution zone.
 * 2. `notifyTrustedCircle` read the session's plan item `location_name` with
 *    the service client and sent "around <place> in <area>" to the traveller's
 *    trusted contacts — people who are not on the trip at all — whoever the
 *    place belonged to.
 *
 * ## The contract (lane C's `withholdPrivatePlanItems`, through the seam in
 * `services/safeReturn/safeReturnPlanItemAccess.ts`)
 *
 * The creator sees their own private place. Anyone else gets the slot, not the
 * place: no name, no coordinates, and nothing DERIVED from them (no caution
 * lookup). A row that does not carry the privacy columns is withheld.
 *
 * Run: node --import tsx/esm --test src/test/safeReturnPrivatePlanItems.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import safeReturnRouter from "../routes/safeReturn.js";
import { notifyTrustedCircle } from "../services/safeReturn/SafeReturnNotificationService.js";
import type { SafeReturnContact, SafeReturnSession } from "../services/safeReturn/SafeReturnService.js";
import { canSeePlanItemLocation, ownerOnlyAccess, withholdPrivatePlanItems } from "../services/safeReturn/safeReturnPlanItemAccess.js";

process.env.TZ = "UTC";

const VIEWER = "aaaaaaaa-1111-4111-8111-000000000001";
const CREWMATE = "aaaaaaaa-1111-4111-8111-000000000002";
const CONTACT = "aaaaaaaa-1111-4111-8111-000000000003";
const TRIP = "bbbbbbbb-2222-4222-8222-000000000001";
const ITEM = "cccccccc-3333-4333-8333-000000000001";
const SESSION = "dddddddd-4444-4444-8444-000000000001";
const SECRET = "Crewmate's Hidden Guesthouse";
const TOKEN = "private-plan-token";

type Row = Record<string, unknown>;

/**
 * Filter-agnostic double: `maybeSingle`/`single` answer `singles[table]`, a
 * list answers `rows[table]`. It records every table read and every insert, so
 * a test can assert that a lookup did NOT happen. Like PostgREST, it returns
 * only the columns a plain `select("a, b")` names — so a reader that stops
 * selecting the privacy columns is SEEN to over-withhold.
 */
function makeClient(singles: Record<string, Row | null>, rows: Record<string, Row[]> = {}) {
  const read: string[] = [];
  const inserted: Record<string, Row[]> = {};
  function builder(table: string) {
    let pendingInsert: Row | null = null;
    let cols: string[] | null = null;
    const project = (r: Row | null) => (r && cols ? Object.fromEntries(Object.entries(r).filter(([k]) => cols!.includes(k))) : r);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.select = (c?: string) => {
      if (!pendingInsert && typeof c === "string" && c.trim() !== "*" && !/[()*]/.test(c)) cols = c.split(",").map((x) => x.trim()).filter(Boolean);
      return b;
    };
    for (const m of ["eq", "neq", "in", "is", "lt", "lte", "gt", "gte", "order", "limit", "or", "not", "filter", "match", "contains", "update", "upsert", "delete"]) b[m] = chain;
    b.insert = (r: Row | Row[]) => {
      pendingInsert = Array.isArray(r) ? r[0]! : r;
      (inserted[table] ??= []).push(...(Array.isArray(r) ? r : [r]));
      return b;
    };
    const one = async () => {
      if (pendingInsert) return { data: { id: `gen-${table}-${(inserted[table] ?? []).length}`, ...pendingInsert }, error: null };
      read.push(table);
      return { data: project(singles[table] ?? null), error: null };
    };
    b.maybeSingle = one;
    b.single = one;
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
      if (!pendingInsert) read.push(table);
      return Promise.resolve({ data: pendingInsert ? [pendingInsert] : (rows[table] ?? []).map((r) => project(r)), error: null, count: (rows[table] ?? []).length }).then(onF, onR);
    };
    return b;
  }
  return {
    from: (t: string) => builder(t),
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async (tok: string) => (tok === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    read, inserted,
  };
}

let server: http.Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/", safeReturnRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

function get(path: string): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET", headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let body: Record<string, unknown> = {}; try { body = JSON.parse(raw); } catch { /* raw */ } resolve({ status: res.statusCode ?? 0, body, raw }); });
    });
    r.on("error", reject);
    r.end();
  });
}

function planItem(over: Row = {}): Row {
  return {
    id: ITEM, category: "nightlife", starts_at: "2026-07-01T23:00:00.000Z", day_date: "2026-07-01",
    location_name: SECRET, lat: 13.75, lng: 100.5, trip_id: TRIP,
    creator_id: CREWMATE, location_is_private: true, ...over,
  };
}

function suggestClient(item: Row) {
  return makeClient(
    {
      feature_flags: { enabled: true },
      trip_plan_items: item,
      trip_members: { user_id: VIEWER },
      profiles: { home_city: "London" },
      user_location_state: { city: "Bangkok" },
    },
    { geo_zones: [{ safety_rating: "avoid" }] },
  );
}

describe("GET /me/safe-return/suggest/:planItemId — a crewmate's private place", () => {
  it("is not looked up in geo_zones, and no caution derived from it reaches the viewer", async () => {
    const c = suggestClient(planItem());
    _setTestClient(c, true); _setTestServiceClient(c);
    const r = await get(`/me/safe-return/suggest/${ITEM}`);
    assert.equal(r.status, 200, r.raw);
    assert.ok(!c.read.includes("geo_zones"), `the private place's coordinates were used for a caution lookup: ${c.read.join(",")}`);
    assert.ok(!(r.body.reasons as string[]).includes("location_caution_flag"), r.raw);
    assert.ok(!r.raw.includes(SECRET) && !r.raw.includes("13.75"), r.raw);
  });

  it("the viewer's OWN private place is still assessed (creator sees own)", async () => {
    const c = suggestClient(planItem({ creator_id: VIEWER }));
    _setTestClient(c, true); _setTestServiceClient(c);
    const r = await get(`/me/safe-return/suggest/${ITEM}`);
    assert.equal(r.status, 200, r.raw);
    assert.ok(c.read.includes("geo_zones"));
    assert.ok((r.body.reasons as string[]).includes("location_caution_flag"), r.raw);
  });

  it("a crewmate's place that is NOT private is assessed like any trip place", async () => {
    const c = suggestClient(planItem({ location_is_private: false }));
    _setTestClient(c, true); _setTestServiceClient(c);
    const r = await get(`/me/safe-return/suggest/${ITEM}`);
    assert.ok((r.body.reasons as string[]).includes("location_caution_flag"), r.raw);
  });

  it("a row that does not say it is not private is withheld (fail closed)", async () => {
    const { creator_id: _c, location_is_private: _p, ...bare } = planItem({ creator_id: VIEWER });
    const c = suggestClient(bare);
    _setTestClient(c, true); _setTestServiceClient(c);
    const r = await get(`/me/safe-return/suggest/${ITEM}`);
    assert.equal(r.status, 200, r.raw);
    assert.ok(!c.read.includes("geo_zones"), c.read.join(","));
  });
});

describe("notifyTrustedCircle — the alert to people who are not on the trip", () => {
  const session = (): SafeReturnSession => ({
    id: SESSION, userId: VIEWER, planItemId: ITEM, tripId: TRIP, status: "missed", triggerReason: null,
    escalationLevel: 2, timerStartAt: null, timerEndAt: "2026-07-01T23:30:00.000Z", lastPromptAt: null, lastSafeConfirmationAt: null,
    trustedCircleEnabled: true, liveShareEnabled: false, notifyHostEnabled: false, notifyTripCrewEnabled: false,
    emergencyNote: null, closedAt: null, createdAt: "2026-07-01T22:00:00.000Z", updatedAt: "2026-07-01T22:00:00.000Z",
  } as unknown as SafeReturnSession);
  const contacts: SafeReturnContact[] = [{
    id: "ct-1", sessionId: SESSION, contactUserId: CONTACT, contactName: "Ana", contactPhone: null, contactEmail: null,
    contactMethod: "in_app", canReceiveLiveLocation: false, notifiedAt: null, acknowledgedAt: null,
  }];
  const alertBody = (c: ReturnType<typeof makeClient>) => (c.inserted.notifications ?? []).map((n) => String(n.body)).join(" | ");
  const clientFor = (item: Row | null) => makeClient({
    profiles: { name: "Sam", handle: "sam" },
    user_location_state: { city: "Bangkok", country: "Thailand" },
    trip_plan_items: item,
  });

  it("a crewmate's private place is NOT named to the traveller's contacts", async () => {
    const c = clientFor(planItem());
    const out = await notifyTrustedCircle(c as never, session(), contacts);
    assert.equal(out.delivered, 1, JSON.stringify(out));
    assert.ok(!alertBody(c).includes(SECRET), alertBody(c));
    assert.ok(alertBody(c).includes("Bangkok"), alertBody(c));
  });

  it("the traveller's OWN private place is named (creator sees own)", async () => {
    const c = clientFor(planItem({ creator_id: VIEWER }));
    await notifyTrustedCircle(c as never, session(), contacts);
    assert.ok(alertBody(c).includes(SECRET), alertBody(c));
  });

  it("a crewmate's place that is NOT private is named", async () => {
    const c = clientFor(planItem({ location_is_private: false }));
    await notifyTrustedCircle(c as never, session(), contacts);
    assert.ok(alertBody(c).includes(SECRET), alertBody(c));
  });

  it("a row without the privacy columns is not named (fail closed)", async () => {
    const { creator_id: _c, location_is_private: _p, ...bare } = planItem({ creator_id: VIEWER });
    const c = clientFor(bare);
    await notifyTrustedCircle(c as never, session(), contacts);
    assert.ok(!alertBody(c).includes(SECRET), alertBody(c));
  });
});

describe("the seam keeps lane C's contract", () => {
  const access = ownerOnlyAccess(VIEWER);
  it("own private: visible; another's private: withheld to the slot; not private: visible; unknown owner: withheld", () => {
    assert.equal(canSeePlanItemLocation(access, { creator_id: VIEWER, location_is_private: true }), true);
    assert.equal(canSeePlanItemLocation(access, { creator_id: CREWMATE, location_is_private: true }), false);
    assert.equal(canSeePlanItemLocation(access, { creator_id: CREWMATE, location_is_private: false }), true);
    assert.equal(canSeePlanItemLocation(access, { location_is_private: true }), false);
    const [w] = withholdPrivatePlanItems([planItem({ title: "Hotel" })], access);
    assert.equal(w!.location_name, null); assert.equal(w!.lat, null); assert.equal(w!.lng, null);
    assert.equal(w!.title, "Private plan"); assert.equal(w!.starts_at, "2026-07-01T23:00:00.000Z");
  });
  it("a grant counts only when it was made by the item's creator", () => {
    const granted = { viewerId: VIEWER, status: "ok" as const, grants: new Map([[ITEM, CREWMATE]]) };
    assert.equal(canSeePlanItemLocation(granted, planItem()), true);
    const wrongOwner = { viewerId: VIEWER, status: "ok" as const, grants: new Map([[ITEM, CONTACT]]) };
    assert.equal(canSeePlanItemLocation(wrongOwner, planItem()), false);
  });
});
