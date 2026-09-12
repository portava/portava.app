/**
 * Trips spec §6.3 — the public preview "must not leak future absence from
 * home" (census-trips TR119).
 *
 *   the decision (pure): guard off → dates follow show_exact_dates; guard on
 *   and the trip starts after today → withheld with TRIP_PRIVACY_FUTURE_ABSENCE;
 *   a trip that starts today, started already, or has no start date → not a
 *   future absence;
 *   the rendering: toPrivateTripPreview with withholdFutureDates carries null
 *   dates and datesWithheld: "future_absence"; without it the shape is exactly
 *   what it was (no key at all);
 *   the route: GET /trips/:tripId for a non-member of a PUBLIC trip that has
 *   not begun — flag on: no dates, datesWithheld; flag off: the dates.
 *
 * Run: node --import tsx/esm --test src/test/tripAbsenceGuard.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { ABSENCE_GUARD_FLAG, absenceDisclosure } from "../lib/privacy/absenceDisclosure.js";
import { toPrivateTripPreview } from "../lib/privacy/tripSerializers.js";
import { TRIP_REASON_CODES } from "../lib/tripReasonCodes.js";

const NOW = Date.parse("2026-09-12T10:00:00.000Z");

describe("TR119 — absenceDisclosure (pure)", () => {
  it("guard off: nothing is withheld, and the decision names the flag", () => {
    const d = absenceDisclosure({ start_date: "2026-12-20", show_exact_dates: true }, NOW, false);
    assert.equal(d.withholdDates, false); assert.equal(d.reason, null);
    assert.match(d.detail, new RegExp(ABSENCE_GUARD_FLAG));
  });
  it("guard on, trip starts after today: withheld, whatever show_exact_dates says", () => {
    for (const toggle of [true, false, null, undefined]) {
      const d = absenceDisclosure({ start_date: "2026-12-20", show_exact_dates: toggle }, NOW, true);
      assert.equal(d.withholdDates, true, `toggle=${String(toggle)}`);
      assert.equal(d.reason, "TRIP_PRIVACY_FUTURE_ABSENCE");
    }
  });
  it("guard on, trip starts today: the absence has begun — not withheld", () => {
    assert.equal(absenceDisclosure({ start_date: "2026-09-12" }, NOW, true).withholdDates, false);
  });
  it("guard on, trip started already or has no start date: not a future absence", () => {
    assert.equal(absenceDisclosure({ start_date: "2026-09-01" }, NOW, true).withholdDates, false);
    assert.equal(absenceDisclosure({ start_date: null }, NOW, true).withholdDates, false);
    assert.equal(absenceDisclosure({}, NOW, true).withholdDates, false);
    assert.equal(absenceDisclosure({ start_date: "not a date" }, NOW, true).withholdDates, false);
  });
  it("a timestamp start date is read as its calendar day", () => {
    assert.equal(absenceDisclosure({ start_date: "2026-09-13T00:30:00Z" }, NOW, true).withholdDates, true);
  });
  it("the reason is Appendix B's", () => {
    assert.ok((TRIP_REASON_CODES as readonly string[]).includes("TRIP_PRIVACY_FUTURE_ABSENCE"));
  });
});

const ROW = {
  id: "cccc0000-0001-4000-a000-000000000009", owner_id: "owner000-0001-4000-a000-000000000001",
  title: "Away", destination_city: "Porto", destination_country: "Portugal",
  start_date: "2026-12-20", end_date: "2026-12-27", status: "upcoming", visibility: "public",
  cover_url: null, trip_type: "leisure", open_to_meet: false, show_exact_dates: true,
  show_destination_city: true, precise_location_visible: false, show_header_publicly: false,
  created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-01T10:00:00Z",
};

describe("TR119 — toPrivateTripPreview renders the decision", () => {
  it("withholdFutureDates: both dates null and datesWithheld says why", () => {
    const p = toPrivateTripPreview(ROW, null, { withholdFutureDates: true });
    assert.equal(p.startDate, null); assert.equal(p.endDate, null);
    assert.equal(p.datesWithheld, "future_absence");
  });
  it("without it the shape is exactly what it was: dates present, no datesWithheld key", () => {
    const p = toPrivateTripPreview(ROW, null);
    assert.equal(p.startDate, "2026-12-20"); assert.equal(p.endDate, "2026-12-27");
    assert.equal("datesWithheld" in p, false);
    const q = toPrivateTripPreview(ROW, null, { withholdFutureDates: false });
    assert.equal("datesWithheld" in q, false);
  });
  it("show_exact_dates=false still nulls the dates but is NOT the absence guard: no datesWithheld", () => {
    const p = toPrivateTripPreview({ ...ROW, show_exact_dates: false }, null);
    assert.equal(p.startDate, null); assert.equal("datesWithheld" in p, false);
  });
});

// ── Route: the flag decides, the serializer renders ──────────────────────────
const OUTSIDER_ID = "outside0-0001-4000-a000-000000000003";
const OUTSIDER_TOKEN = "absence-outsider-token";

function makeClient(flagEnabled: boolean | null) {
  const db: Record<string, any[]> = {
    trips: [ROW],
    trip_members: [], trip_join_requests: [], blocks: [], user_follows: [],
    profiles: [{ id: OUTSIDER_ID, handle: "outsider", name: "Outsider" }],
    user_account_states: [], user_restrictions: [], user_interaction_cooldowns: [],
    feature_flags: flagEnabled === null ? [] : [{ flag: "trip_absence_guard_enabled", enabled: flagEnabled }],
  };
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const rowsNow = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const obj: any = {
      select() { return obj; }, insert() { return obj; }, upsert() { return obj; }, update() { return obj; }, delete() { return obj; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return obj; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return obj; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return obj; },
      or() { return obj; }, not() { return obj; }, limit() { return obj; }, order() { return obj; }, range() { return obj; }, gte() { return obj; }, gt() { return obj; },
      is(col: string, val: any) { filters.push((r) => val === null ? r[col] == null : r[col] === val); return obj; },
      maybeSingle() { return Promise.resolve({ data: rowsNow()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: rowsNow()[0] ?? null, error: null }); },
      then(onF: any, onR: any) { return Promise.resolve({ data: rowsNow(), error: null }).then(onF, onR); },
    };
    return obj;
  }
  return {
    auth: { getUser: async (tok: string) => tok === OUTSIDER_TOKEN ? { data: { user: { id: OUTSIDER_ID } }, error: null } : { data: { user: null }, error: { message: "invalid" } } },
    from: (table: string) => chain(table),
    storage: { createBucket: async () => ({ error: null }), from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
    rpc: async () => ({ data: null, error: null }),
  };
}

function get(server: Server, path: string): Promise<{ status: number; body: any }> {
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = httpRequest({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET", headers: { authorization: `Bearer ${OUTSIDER_TOKEN}` } }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c));
      res.on("end", () => { let b: any; try { b = JSON.parse(raw); } catch { b = raw; } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    r.on("error", reject); r.end();
  });
}

describe("TR119 — GET /trips/:tripId for a non-member of a public trip that has not begun", () => {
  let server: Server;
  before(() => new Promise<void>((resolve) => { server = createServer(app); server.listen(0, "127.0.0.1", resolve); }));
  after(() => new Promise<void>((resolve, reject) => { _setTestClient(null as any, false); server.close((e) => (e ? reject(e) : resolve())); }));

  it("flag on: the preview carries no dates and says datesWithheld: future_absence", async () => {
    _setTestClient(makeClient(true) as any, true);
    const r = await get(server, `/api/trips/${ROW.id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.isPrivate, true);
    assert.equal(r.body.startDate, null); assert.equal(r.body.endDate, null);
    assert.equal(r.body.datesWithheld, "future_absence");
    assert.equal("ownerId" in r.body, false);
  });
  it("flag off: the dates are on the preview exactly as before, and no datesWithheld key", async () => {
    _setTestClient(makeClient(false) as any, true);
    const r = await get(server, `/api/trips/${ROW.id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.startDate, "2026-12-20"); assert.equal(r.body.endDate, "2026-12-27");
    assert.equal("datesWithheld" in r.body, false);
  });
  it("no flag row (the un-migrated state): fail-closed to OFF — the preview is unchanged", async () => {
    _setTestClient(makeClient(null) as any, true);
    const r = await get(server, `/api/trips/${ROW.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.startDate, "2026-12-20");
    assert.equal("datesWithheld" in r.body, false);
  });
});
