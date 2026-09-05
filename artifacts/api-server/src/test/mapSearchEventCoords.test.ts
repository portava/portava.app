/**
 * map/search must honor show_exact_location (audit six-system MAP·H1).
 *
 * loadNearbyEvents used to select raw location_lat/lng and never consult
 * show_exact_location, so a host who hid the exact venue still had it echoed on
 * the discovery map to any non-participant. This pins the redaction.
 *
 * Run: node --import tsx/esm --test src/test/mapSearchEventCoords.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadNearbyEvents } from "../routes/mapSearch.js";

const VIEWER = "viewer-0000-0000-0000-000000000001";
const HOST   = "host-0000-0000-0000-000000000002";

const EVENTS = [
  { id: "e-visible", host_id: HOST,   title: "Open party",   location_name: "Rooftop",
    location_lat: 10.30, location_lng: 123.90, show_exact_location: true,  visibility: "public", state: "open" },
  { id: "e-hidden",  host_id: HOST,   title: "Private addr", location_name: "Downtown",
    location_lat: 10.31, location_lng: 123.91, show_exact_location: false, visibility: "public", state: "open" },
  { id: "e-mine",    host_id: VIEWER, title: "My hidden ev", location_name: "My place",
    location_lat: 10.32, location_lng: 123.92, show_exact_location: false, visibility: "public", state: "open" },
];

/** Records every filter the events query applied, so the optional narrowing
 *  window can be asserted rather than assumed. */
interface QueryLog { lte: [string, unknown][]; or: string[]; limit: number[] }

// Table-aware fake: events list returns the fixtures; every eligibility read
// resolves so checkEventEligibility returns {ok:true}; the trust-gates flag is off.
function fakeSc(log?: QueryLog) {
  const b = (table: string): any => {
    const chain: any = {
      _t: table,
      select() { return chain; }, eq() { return chain; }, neq() { return chain; },
      in() { return chain; }, not() { return chain; }, is() { return chain; },
      gte() { return chain; },
      lte(col: string, val: unknown) { if (table === "events") log?.lte.push([col, val]); return chain; },
      gt() { return chain; }, lt() { return chain; },
      or(expr: string) { if (table === "events") log?.or.push(expr); return chain; },
      order() { return chain; },
      limit(n: number) { if (table === "events") log?.limit.push(n); return chain; },
      range() { return chain; },
      maybeSingle() {
        if (table === "feature_flags") return Promise.resolve({ data: { enabled: false }, error: null });
        return Promise.resolve({ data: null, error: null }); // no roles, no ban, no block
      },
      then(onF: any, onR: any) {
        const data = table === "events" ? EVENTS.map((e) => ({ ...e })) : [];
        return Promise.resolve({ data, error: null }).then(onF, onR);
      },
    };
    return chain;
  };
  return { from: (t: string) => b(t) };
}

describe("loadNearbyEvents — show_exact_location redaction", () => {
  it("nulls coordinates of an other-host hidden-location event, keeps visible + own", async () => {
    const out = await loadNearbyEvents(fakeSc() as any, VIEWER, 10.31, 123.91, 25, new Set());
    assert.ok(out, "a successful read returns rows, not null");
    const by = Object.fromEntries(out.map((e: any) => [e.id, e]));

    // Positive controls: a shown-location event and the viewer's OWN hidden event keep coords.
    assert.equal(by["e-visible"].location_lat, 10.30, "shown-location event keeps coords");
    assert.equal(by["e-mine"].location_lat, 10.32, "viewer's own hidden event keeps coords (they are the host)");

    // The redaction: another host's hidden-location event must have no coordinates.
    assert.equal(by["e-hidden"].location_lat, null, "hidden-location event coords must be redacted");
    assert.equal(by["e-hidden"].location_lng, null, "hidden-location event coords must be redacted");
  });
});

describe("loadNearbyEvents — optional candidate window (Wall spec TABLE 4)", () => {
  const emptyLog = (): QueryLog => ({ lte: [], or: [], limit: [] });

  it("omitting the window leaves the query exactly as it was: no time filter, 60 rows", async () => {
    const log = emptyLog();
    const out = await loadNearbyEvents(fakeSc(log) as any, VIEWER, 10.31, 123.91, 25, new Set());
    assert.equal(out?.length, 3);
    assert.deepEqual(log.or, [], "no OR predicate is added for a caller that wants the neighbourhood");
    assert.deepEqual(log.limit, [60]);
    // Only the two bounding-box lte filters.
    assert.deepEqual(log.lte.map(([c]) => c), ["location_lat", "location_lng"]);
  });

  it("a window narrows the candidate rows BEFORE the per-row privacy pass", async () => {
    const log = emptyLog();
    const window = {
      nowIso: "2026-09-01T12:00:00.000Z",
      startsBeforeIso: "2026-09-01T13:30:00.000Z",
      openEndedStartsAfterIso: "2026-09-01T09:00:00.000Z",
    };
    await loadNearbyEvents(fakeSc(log) as any, VIEWER, 10.31, 123.91, 25, new Set(), { window, limit: 8 });
    assert.ok(
      log.lte.some(([c, v]) => c === "starts_at" && v === window.startsBeforeIso),
      `starts_at must be bounded; saw ${JSON.stringify(log.lte)}`,
    );
    // A multi-day event that started before the window is KEPT (ends_at ahead);
    // an open-ended one is kept only within the assumed duration.
    assert.deepEqual(log.or, [
      `ends_at.gte.${window.nowIso},and(ends_at.is.null,starts_at.gte.${window.openEndedStartsAfterIso})`,
    ]);
    assert.deepEqual(log.limit, [8], "the caller's row bound is what reaches the query");
  });

  it("clamps a caller's row bound into 1..60", async () => {
    const high = emptyLog();
    await loadNearbyEvents(fakeSc(high) as any, VIEWER, 10.31, 123.91, 25, new Set(), { limit: 5_000 });
    assert.deepEqual(high.limit, [60]);
    const low = emptyLog();
    await loadNearbyEvents(fakeSc(low) as any, VIEWER, 10.31, 123.91, 25, new Set(), { limit: 0 });
    assert.deepEqual(low.limit, [1]);
  });
});
