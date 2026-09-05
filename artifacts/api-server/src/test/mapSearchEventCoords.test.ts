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
import {
  eventPhaseAt,
  EVENT_CAUSE_DEFAULT_DURATION_MINUTES,
  EVENT_CAUSE_UPCOMING_MINUTES,
} from "../lib/mapProducers/eventContextProducer.js";

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
    // anything else is kept only if it starts inside the assumed-duration window.
    // The second branch is NOT keyed on `ends_at IS NULL` — see the superset
    // suite below for why that would silently drop `ongoing` rows.
    assert.deepEqual(log.or, [
      `ends_at.gte.${window.nowIso},starts_at.gte.${window.openEndedStartsAfterIso}`,
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

// ── The window must not out-narrow the derivation it serves ──────────────────
//
// The window exists to shrink the candidate rows BEFORE loadNearbyEvents' per-row
// privacy pass. Its ONLY correctness obligation is that it never drops a row the
// consumer would have kept: `buildEventStateLiveCandidates` decides what is on
// with `eventPhaseAt`, so every row eventPhaseAt calls `ongoing` or `upcoming`
// must survive the query.
//
// It did not. The predicate's fallback branch was `and(ends_at.is.null, …)`,
// while eventPhaseAt ignores an `ends_at` that is not strictly AFTER `starts_at`
// and substitutes the assumed duration. A row with a malformed end — one at or
// before its own start — is therefore `ongoing` to the consumer and was dropped
// by the query. These tests evaluate the REAL emitted predicate against rows and
// pin the superset property, so the two cannot drift apart again.

/** The PostgREST filter subset this query actually emits, evaluated in JS.
 *  Supports `col.op.value`, `is.null`, and nested `and(...)` / `or(...)`. */
function splitTopLevel(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur !== "") out.push(cur);
  return out;
}

function evalPredicate(term: string, row: Record<string, unknown>): boolean {
  const t = term.trim();
  if (t.startsWith("and(") && t.endsWith(")")) {
    return splitTopLevel(t.slice(4, -1)).every((x) => evalPredicate(x, row));
  }
  if (t.startsWith("or(") && t.endsWith(")")) {
    return splitTopLevel(t.slice(3, -1)).some((x) => evalPredicate(x, row));
  }
  const i = t.indexOf(".");
  const j = t.indexOf(".", i + 1);
  const col = t.slice(0, i);
  const op = t.slice(i + 1, j);
  const val = t.slice(j + 1);
  const v = row[col];
  if (op === "is") return val === "null" ? v == null : String(v) === val;
  // SQL three-valued logic: a comparison against NULL is never true.
  if (v == null) return false;
  const a = Date.parse(String(v));
  const b = Date.parse(val);
  const cmp = Number.isNaN(a) || Number.isNaN(b) ? String(v).localeCompare(val) : a - b;
  switch (op) {
    case "gte": return cmp >= 0;
    case "lte": return cmp <= 0;
    case "gt": return cmp > 0;
    case "lt": return cmp < 0;
    case "eq": return cmp === 0;
    default: throw new Error(`unsupported operator in emitted predicate: ${op}`);
  }
}

const NOW_MS = Date.parse("2026-09-01T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW_MS + minutes * 60_000).toISOString();

/** Every row carries the same coordinate so only the TIME filters can drop it. */
const TIMING_ROWS = [
  // eventPhaseAt: ongoing (well-formed end ahead of now).
  { id: "ongoing-plain", starts_at: at(-60), ends_at: at(60) },
  // eventPhaseAt: ongoing (no end ⇒ assumed duration, still running).
  { id: "ongoing-open-ended", starts_at: at(-30), ends_at: null },
  // eventPhaseAt: ongoing (end NOT after start ⇒ the same assumed duration).
  // THE REGRESSION ROW: `and(ends_at.is.null, …)` dropped this one.
  { id: "ongoing-malformed-end", starts_at: at(-30), ends_at: at(-30) },
  { id: "ongoing-end-before-start", starts_at: at(-20), ends_at: at(-95) },
  // eventPhaseAt: upcoming.
  { id: "upcoming", starts_at: at(30), ends_at: at(90) },
  // eventPhaseAt: null — long over, and far ahead. The window must still drop
  // these, or it is narrowing nothing.
  { id: "long-ended", starts_at: at(-600), ends_at: at(-540) },
  { id: "far-future", starts_at: at(600), ends_at: at(660) },
].map((r) => ({
  ...r,
  host_id: HOST, title: r.id, location_name: "Anywhere",
  location_lat: 10.31, location_lng: 123.91, show_exact_location: true,
  visibility: "public", state: "open",
}));

/** A fake that APPLIES the emitted time filters to `events`, instead of only
 *  recording them — so what the assertions see is what PostgREST would return. */
function filteringSc(rows: Record<string, unknown>[]) {
  const b = (table: string): any => {
    const terms: string[] = [];
    const chain: any = {
      select: () => chain, eq: () => chain, neq: () => chain, in: () => chain,
      not: () => chain, is: () => chain, gt: () => chain, lt: () => chain,
      order: () => chain, range: () => chain, limit: () => chain,
      gte(col: string, val: unknown) {
        if (table === "events" && col.startsWith("starts") ) terms.push(`${col}.gte.${String(val)}`);
        return chain;
      },
      lte(col: string, val: unknown) {
        if (table === "events" && col.startsWith("starts")) terms.push(`${col}.lte.${String(val)}`);
        return chain;
      },
      or(expr: string) {
        if (table === "events") terms.push(`or(${expr})`);
        return chain;
      },
      maybeSingle() {
        if (table === "feature_flags") return Promise.resolve({ data: { enabled: false }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any, onR: any) {
        const data =
          table === "events"
            ? rows.filter((r) => terms.every((t) => evalPredicate(t, r))).map((r) => ({ ...r }))
            : [];
        return Promise.resolve({ data, error: null }).then(onF, onR);
      },
    };
    return chain;
  };
  return { from: (t: string) => b(t) };
}

describe("loadNearbyEvents window — a SUPERSET of eventPhaseAt, never narrower", () => {
  /** Exactly the window buildEventStateLiveCandidates builds, from the same
   *  canonical constants — so this pins the pairing, not a hand-picked range. */
  const window = {
    nowIso: new Date(NOW_MS).toISOString(),
    startsBeforeIso: new Date(NOW_MS + EVENT_CAUSE_UPCOMING_MINUTES * 60_000).toISOString(),
    openEndedStartsAfterIso: new Date(
      NOW_MS - EVENT_CAUSE_DEFAULT_DURATION_MINUTES * 60_000,
    ).toISOString(),
  };

  it("keeps every row eventPhaseAt would call ongoing or upcoming", async () => {
    const expected = TIMING_ROWS.filter((r) => {
      const phase = eventPhaseAt(r as any, NOW_MS)?.phase;
      return phase === "ongoing" || phase === "upcoming";
    }).map((r) => r.id);
    // Guard the fixture itself: the malformed-end rows must really be `ongoing`,
    // or this test would pass by testing nothing.
    assert.ok(expected.includes("ongoing-malformed-end"), "fixture: a malformed end is still ongoing");
    assert.ok(expected.includes("ongoing-end-before-start"), "fixture: an end before the start is ongoing");
    assert.equal(expected.length, 5);

    const out = await loadNearbyEvents(
      filteringSc(TIMING_ROWS) as any, VIEWER, 10.31, 123.91, 25, new Set(), { window, limit: 8 },
    );
    assert.ok(out, "a successful read returns rows");
    const kept = out.map((e: any) => e.id).sort();
    for (const id of expected) {
      assert.ok(kept.includes(id), `the window dropped ${id}, which eventPhaseAt accepts`);
    }
  });

  it("still narrows: a long-over and a far-future event never reach the per-row pass", async () => {
    const out = await loadNearbyEvents(
      filteringSc(TIMING_ROWS) as any, VIEWER, 10.31, 123.91, 25, new Set(), { window, limit: 8 },
    );
    const kept = new Set((out ?? []).map((e: any) => e.id));
    assert.ok(!kept.has("long-ended"), "an event that ended ten hours ago must be filtered out");
    assert.ok(!kept.has("far-future"), "an event ten hours out must be filtered out");
    assert.equal(kept.size, 5, "exactly the five temporally-adjacent rows survive");
  });

  it("without a window nothing is time-filtered (the Map gateway's read is unchanged)", async () => {
    const out = await loadNearbyEvents(
      filteringSc(TIMING_ROWS) as any, VIEWER, 10.31, 123.91, 25, new Set(),
    );
    assert.equal(out?.length, TIMING_ROWS.length);
  });
});
