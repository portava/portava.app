/**
 * Phase 8 — Live Intelligence tests.
 *
 *  A. Live fetch happens on demand at tool time, with a short-lived cache
 *     (second lookup within TTL does NOT re-hit the source).
 *  B. Confidence labels are correct per source class end to end:
 *     catalog places → community_reported/historical, events →
 *     community_reported, live open-now → verified_live, AI output →
 *     ai_inference.
 *  C. Simulated source outage produces an honest "can't verify right now" —
 *     zero fabricated fields (openNow stays null, no invented source/time).
 *  D. Confidence + openNow survive sanitizeToolResult and are carried into
 *     the UI blocks (API → UI).
 *  E. Lead ruling D-67 (2026-10-06): a provider record is labelled verified
 *     live only when it is confirmed to BE the place — names equal after
 *     normalisation AND its coordinates within LIVE_IDENTITY_MAX_DISTANCE_M
 *     (150 m) of the place's own. A namesake elsewhere, a different venue at
 *     the same spot, a record with no coordinates and a place with no
 *     coordinates all get NO verified-live label, and no cache entry crosses
 *     from one place to another place with the same name.
 *
 * Runtime: node:test. Run: node --import tsx/esm --test src/test/compass-live-intel.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  makeConfidence,
  getLiveVenueStatus,
  _setSimulatedOutage,
  _clearLiveCache,
  CANT_VERIFY_NOTE,
  CONFIDENCE_LABELS,
  LIVE_IDENTITY_MAX_DISTANCE_M,
  normaliseVenueName,
  type LiveVenueAnchor,
} from "../lib/liveIntelligence.js";
import { executeCompassTool, sanitizeToolResult } from "../compass/CompassTools.js";
import { collectToolCandidates } from "../compass/CompassUiBlocks.js";
import type { ToolExecution } from "../compass/CompassTools.js";
import { FOURSQUARE_KEY_VARS, snapshotKeyEnv, restoreKeyEnv, clearKeyEnv, setKeyEnv } from "./helpers/apiKeyEnv.js";

// ── fetch stub ────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchCalls: string[] = [];
let fetchResponder: (() => any) | null = null;

/** A responder may return `{ __status: n }` to answer with that HTTP status and no body. */
function stubFetch(responder: () => any) {
  fetchResponder = responder;
  globalThis.fetch = (async (url: any) => {
    fetchCalls.push(String(url));
    const body = fetchResponder!();
    if (body instanceof Error) throw body;
    if (body && typeof body.__status === "number") {
      return { ok: body.__status < 400, status: body.__status, json: async () => ({}) } as any;
    }
    return { ok: true, status: 200, json: async () => body } as any;
  }) as any;
}

const originalFsqEnv = snapshotKeyEnv(FOURSQUARE_KEY_VARS);

beforeEach(() => {
  fetchCalls = [];
  _clearLiveCache();
  _setSimulatedOutage("places_live", false);
  setKeyEnv(FOURSQUARE_KEY_VARS, "test-key");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreKeyEnv(originalFsqEnv);
  _setSimulatedOutage("places_live", false);
});

// ── Minimal fake supabase client ──────────────────────────────────────────────

/** `failReads` names tables whose reads resolve the way supabase-js reports a failure: `{ data: null, error }`. */
function makeClient(db: Record<string, any[]>, failReads: string[] = []) {
  function builder(rows: any[], table: string) {
    const failed = failReads.includes(table) ? { message: `${table} read blew up`, code: "57014" } : null;
    let filtered = [...rows];
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      // `.not(col, op, val)` was ABSENT, so the chain returned undefined the
      // moment production started using it — the double could not express a
      // negated filter at all. PostgREST's `not.in` takes `("a","b")`.
      not: (col: string, op: string, val: any) => {
        const o = String(op).toLowerCase();
        if (o === "eq") filtered = filtered.filter((r) => r[col] !== val);
        else if (o === "neq") filtered = filtered.filter((r) => r[col] === val);
        else if (o === "is") filtered = filtered.filter((r) => (val === null ? r[col] != null : true));
        else if (o === "in") {
          const set = new Set(
            String(val).replace(/^\(/, "").replace(/\)$/, "").split(",")
              .map((s) => s.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")),
          );
          filtered = filtered.filter((r) => !set.has(String(r[col])));
        }
        return b;
      },
      gte: () => b,
      or: () => b,
      ilike: () => b,
      in: () => b,
      is: () => b,
      order: () => b,
      limit: (n: number) => { filtered = filtered.slice(0, n); return b; },
      maybeSingle: () => Promise.resolve(failed ? { data: null, error: failed } : { data: filtered[0] ?? null, error: null }),
      then: (resolve: any) => resolve(failed ? { data: null, error: failed } : { data: filtered, error: null }),
    };
    return b;
  }
  return { from: (table: string) => builder(db[table] ?? [], table) } as any;
}

// The place's own stored coordinates — the live lookup's identity anchor (D-67).
const CEBU: LiveVenueAnchor = { lat: 10.3157, lng: 123.8854 };
const PLACE = {
  id: "place-1", name: "Cafe Uno", category: "food", primary_category: "cafe",
  city: "Cebu", neighborhood: null, rating: 4.5, saved_count: 3, verified: true,
  blurb: "Great beans", secondary_categories: null, place_type: "cafe",
  lat: CEBU.lat, lng: CEBU.lng,
};
const EVENT = {
  id: "event-1", title: "Beach Meetup", description: "Fun", city: "Cebu",
  country: "PH", starts_at: "2099-01-01T10:00:00Z", category: "beach",
  host_id: "host-1", state: "open", visibility: "public",
};

// The provider's record of THIS Cafe Uno: same name, ~15 m from the place's coordinates.
const FSQ_OPEN = { results: [{ fsq_place_id: "fsq-1", name: "Cafe Uno", latitude: 10.3158, longitude: 123.8855, hours: { open_now: true } }] };

// ── A. Live fetch on demand + short-lived cache ───────────────────────────────

describe("Phase 8 — live fetch layer", () => {
  it("fetches live open-now status on demand from the live source", async () => {
    stubFetch(() => FSQ_OPEN);
    const status = await getLiveVenueStatus("Cafe Uno", CEBU);
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].includes("foursquare"));
    assert.equal(status?.openNow, true);
    assert.equal(status?.source, "foursquare");
    assert.ok(status?.checkedAt);
  });

  it("caches live status — second lookup within TTL does not re-hit the source", async () => {
    stubFetch(() => FSQ_OPEN);
    await getLiveVenueStatus("Cafe Uno", CEBU);
    const again = await getLiveVenueStatus("Cafe Uno", CEBU);
    assert.equal(fetchCalls.length, 1);
    assert.equal(again?.openNow, true);
  });

  it("returns null (never a fabricated value) on source error", async () => {
    stubFetch(() => new Error("boom"));
    const status = await getLiveVenueStatus("Cafe Uno", CEBU);
    assert.equal(status, null);
  });

  it("returns null when no API key is configured", async () => {
    clearKeyEnv(FOURSQUARE_KEY_VARS);
    stubFetch(() => FSQ_OPEN);
    const status = await getLiveVenueStatus("Cafe Uno", CEBU);
    assert.equal(status, null);
    assert.equal(fetchCalls.length, 0);
  });

  it("returns null when the account has no credits left (429)", async () => {
    stubFetch(() => ({ __status: 429 }));
    const status = await getLiveVenueStatus("Cafe Uno", CEBU);
    assert.equal(status, null);
    assert.equal(fetchCalls.length, 1);
  });

  it("returns null when the source times out", async () => {
    stubFetch(() => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    const status = await getLiveVenueStatus("Cafe Uno", CEBU);
    assert.equal(status, null);
  });
});

// ── B. Confidence labels per source class ─────────────────────────────────────

describe("Phase 8 — confidence system", () => {
  it("makeConfidence produces the correct label per source class", () => {
    for (const sc of ["verified_live", "community_reported", "historical", "ai_inference"] as const) {
      const c = makeConfidence(sc);
      assert.equal(c.sourceClass, sc);
      assert.equal(c.label, CONFIDENCE_LABELS[sc]);
      assert.ok(c.checkedAt);
    }
    assert.equal(makeConfidence("historical", "why").dataNote, "why");
  });

  it("confidence (incl. dataNote) survives sanitizeToolResult", () => {
    const out: any = sanitizeToolResult({
      confidence: makeConfidence("historical", CANT_VERIFY_NOTE),
      note: "should be stripped",
    });
    assert.equal(out.confidence.sourceClass, "historical");
    assert.equal(out.confidence.dataNote, CANT_VERIFY_NOTE);
    assert.equal(out.note, undefined); // private-key strip still applies
  });

  it("search_places labels verified catalog places community_reported and unverified historical", async () => {
    const sc = makeClient({ discovery_places: [PLACE, { ...PLACE, id: "place-2", verified: false }] });
    const res: any = await executeCompassTool(sc, "user-1", null, "search_places", { query: "cafe" });
    const byId = new Map(res.candidates.map((c: any) => [c.id, c]));
    assert.equal((byId.get("place-1") as any).confidence.sourceClass, "community_reported");
    assert.equal((byId.get("place-2") as any).confidence.sourceClass, "historical");
  });

  it("search_events labels candidates community_reported", async () => {
    const sc = makeClient({ events: [EVENT] });
    const res: any = await executeCompassTool(sc, "user-1", null, "search_events", { query: "beach" });
    assert.equal(res.candidates.length, 1);
    assert.equal(res.candidates[0].confidence.sourceClass, "community_reported");
    assert.equal(res.candidates[0].confidence.label, CONFIDENCE_LABELS.community_reported);
  });

  it("get_place_details attaches a verified_live liveStatus when the live source responds", async () => {
    stubFetch(() => FSQ_OPEN);
    const sc = makeClient({ discovery_places: [PLACE] });
    const res: any = await executeCompassTool(sc, "user-1", null, "get_place_details", { placeId: "place-1" });
    assert.equal(res.place.liveStatus.available, true);
    assert.equal(res.place.liveStatus.openNow, true);
    assert.equal(res.place.liveStatus.confidence.sourceClass, "verified_live");
    assert.equal(res.place.confidence.sourceClass, "community_reported");
  });
});

// ── C. Simulated outage → honest degradation ──────────────────────────────────

describe("Phase 8 — honest degradation on outage", () => {
  it("simulated outage yields an explicit can't-verify with zero fabricated fields", async () => {
    _setSimulatedOutage("places_live", true);
    stubFetch(() => FSQ_OPEN); // would succeed — must not even be attempted

    const status = await getLiveVenueStatus("Cafe Uno", CEBU);
    assert.equal(status, null);
    assert.equal(fetchCalls.length, 0, "no fetch attempted during simulated outage");

    const sc = makeClient({ discovery_places: [PLACE] });
    const res: any = await executeCompassTool(sc, "user-1", null, "get_place_details", { placeId: "place-1" });
    const ls = res.place.liveStatus;
    assert.equal(ls.available, false);
    assert.equal(ls.openNow, null);                      // never invented
    assert.equal(ls.dataNote, CANT_VERIFY_NOTE);         // explicit honest statement
    assert.equal(ls.source, undefined);                  // no fabricated source
    assert.equal(ls.confidence.sourceClass, "historical");
    assert.equal(ls.confidence.dataNote, CANT_VERIFY_NOTE);
    // The underlying catalog data stays clearly labeled, not upgraded.
    assert.equal(res.place.confidence.sourceClass, "community_reported");
  });
});

// ── D. Carry-through into UI blocks (API → UI) ────────────────────────────────

describe("Phase 8 — confidence carried into UI blocks", () => {
  it("place cards carry confidence + openNow; live status upgrades the label", () => {
    const toolLog: ToolExecution[] = [
      {
        name: "get_place_details", arguments: {},
        result: {
          place: {
            id: "place-1", name: "Cafe Uno", category: "food", city: "Cebu",
            verified: true,
            confidence: makeConfidence("community_reported"),
            liveStatus: { available: true, openNow: false, source: "foursquare", checkedAt: "2026-07-20T00:00:00Z", confidence: makeConfidence("verified_live") },
          },
        },
      },
      {
        name: "search_places", arguments: {},
        result: { candidates: [{ id: "place-2", name: "Bar Dos", confidence: makeConfidence("historical") }] },
      },
      {
        name: "search_events", arguments: {},
        result: { candidates: [{ id: "event-1", title: "Beach Meetup", confidence: makeConfidence("community_reported") }] },
      },
    ];
    const index = collectToolCandidates(toolLog);

    const p1 = index.places.get("place-1")!;
    assert.equal(p1.confidence?.sourceClass, "verified_live"); // upgraded honestly
    assert.equal(p1.openNow, false);

    const p2 = index.places.get("place-2")!;
    assert.equal(p2.confidence?.sourceClass, "historical");
    assert.equal(p2.openNow, null); // no live data → no invented status

    const e1 = index.events.get("event-1")!;
    assert.equal(e1.confidence?.sourceClass, "community_reported");
  });

  it("degraded live status does NOT upgrade the label and leaves openNow null", () => {
    const toolLog: ToolExecution[] = [{
      name: "get_place_details", arguments: {},
      result: {
        place: {
          id: "place-1", name: "Cafe Uno",
          confidence: makeConfidence("historical"),
          liveStatus: { available: false, openNow: null, dataNote: CANT_VERIFY_NOTE, confidence: makeConfidence("historical", CANT_VERIFY_NOTE) },
        },
      },
    }];
    const p = collectToolCandidates(toolLog).places.get("place-1")!;
    assert.equal(p.confidence?.sourceClass, "historical");
    assert.equal(p.openNow, null);
  });

  it("invalid/forged confidence objects are dropped, not passed through", () => {
    const toolLog: ToolExecution[] = [{
      name: "search_places", arguments: {},
      result: { candidates: [{ id: "place-x", name: "X", confidence: { sourceClass: "totally_fake", label: "Verified live" } }] },
    }];
    const p = collectToolCandidates(toolLog).places.get("place-x")!;
    assert.equal(p.confidence, null);
  });
});

// ── E. Lead ruling D-67 — only a place whose identity is confirmed is verified live ──

/** `metres` north of an anchor (1° of latitude ≈ 111,195 m on the mean sphere). */
function north(a: LiveVenueAnchor, metres: number): { latitude: number; longitude: number } {
  return { latitude: a.lat + metres / 111_195, longitude: a.lng };
}
function record(id: string, name: string, at: { latitude: number; longitude: number } | null, openNow: boolean | null) {
  return { fsq_place_id: id, name, ...(at ?? {}), ...(openNow === null ? {} : { hours: { open_now: openNow } }) };
}
/** Another Cafe Uno 2 km north — a namesake, not this place. */
const FAR = north(CEBU, 2_000);

describe("D-67 — the identity rule", () => {
  it("is one exported constant, the ruling's 150 m", () => {
    assert.equal(LIVE_IDENTITY_MAX_DISTANCE_M, 150);
  });

  it("same name within 150 m → verified live", async () => {
    stubFetch(() => ({ results: [record("fsq-near", "Cafe Uno", north(CEBU, 139), true)] }));
    const status = await getLiveVenueStatus("Cafe Uno", CEBU);
    assert.ok(status, "a same-named record 139 m away is this place");
    assert.equal(status.openNow, true);
    assert.equal(status.venueName, "Cafe Uno");
  });

  it("same name just past 150 m → not verified", async () => {
    stubFetch(() => ({ results: [record("fsq-edge", "Cafe Uno", north(CEBU, 161), true)] }));
    assert.equal(await getLiveVenueStatus("Cafe Uno", CEBU), null);
    assert.equal(fetchCalls.length, 1, "the source was asked; its answer was not this place");
  });

  it("same name 2 km away → not verified (the defect: a namesake's hours shown as this place's)", async () => {
    stubFetch(() => ({ results: [record("fsq-far", "Cafe Uno", FAR, true)] }));
    assert.equal(await getLiveVenueStatus("Cafe Uno", CEBU), null);
  });

  it("different name at the same coordinates → not verified", async () => {
    stubFetch(() => ({ results: [record("fsq-other", "Cafe Dos", { latitude: CEBU.lat, longitude: CEBU.lng }, true)] }));
    assert.equal(await getLiveVenueStatus("Cafe Uno", CEBU), null);
  });

  it("a record with no coordinates cannot be placed, so it is never verified", async () => {
    stubFetch(() => ({ results: [record("fsq-nowhere", "Cafe Uno", null, true)] }));
    assert.equal(await getLiveVenueStatus("Cafe Uno", CEBU), null);
  });

  it("the second result is used when the first is a namesake elsewhere", async () => {
    stubFetch(() => ({ results: [
      record("fsq-far", "Cafe Uno", FAR, false),
      record("fsq-here", "Cafe Uno", north(CEBU, 20), true),
    ] }));
    const status = await getLiveVenueStatus("Cafe Uno", CEBU);
    assert.ok(status, "the matching second record is found");
    assert.equal(status.openNow, true, "the namesake's closed hours are not this place's");
  });

  it("names match after NFKD, diacritics, case fold, punctuation and whitespace — and only then", async () => {
    assert.equal(normaliseVenueName("  Café   UNO! "), normaliseVenueName("cafe uno"));
    assert.equal(normaliseVenueName("Joe's Bar & Grill"), normaliseVenueName("JOES BAR  GRILL"));
    assert.equal(normaliseVenueName("Straße 1"), normaliseVenueName("STRASSE 1"));
    assert.equal(normaliseVenueName("ＣＡＦＥ"), normaliseVenueName("cafe"), "NFKD folds full-width letters");
    assert.notEqual(normaliseVenueName("Cafe Uno 2"), normaliseVenueName("Cafe Uno"));
    assert.notEqual(normaliseVenueName("Cafe Uno Lisboa"), normaliseVenueName("Cafe Uno"));
    stubFetch(() => ({ results: [record("fsq-accent", "CAFÉ  UNO.", north(CEBU, 30), false)] }));
    const status = await getLiveVenueStatus("Cafe Uno", CEBU);
    assert.ok(status, "a record whose name differs only by accent, case, punctuation and spacing is this place");
    assert.equal(status.openNow, false);
  });

  it("a punctuation-only or empty name matches nothing", async () => {
    stubFetch(() => ({ results: [record("fsq-dash", "—", { latitude: CEBU.lat, longitude: CEBU.lng }, true)] }));
    assert.equal(await getLiveVenueStatus("—", CEBU), null);
  });

  it("null anchor → the provider is not asked and the answer is null", async () => {
    stubFetch(() => FSQ_OPEN);
    assert.equal(await getLiveVenueStatus("Cafe Uno", null), null);
    assert.equal(await getLiveVenueStatus("Cafe Uno", { lat: Number.NaN, lng: CEBU.lng }), null);
    assert.equal(await getLiveVenueStatus("Cafe Uno", { lat: 95, lng: CEBU.lng }), null);
    assert.equal(fetchCalls.length, 0, "no fetch without a usable anchor");
  });

  it("asks around the anchor, for enough candidates, with their coordinates", async () => {
    stubFetch(() => FSQ_OPEN);
    await getLiveVenueStatus("Cafe Uno", CEBU);
    const u = new URL(fetchCalls[0]!);
    assert.equal(u.searchParams.get("ll"), `${CEBU.lat},${CEBU.lng}`);
    assert.equal(u.searchParams.get("near"), null, "ll and near are alternatives; the anchor is the centre");
    assert.equal(u.searchParams.get("limit"), "5");
    const fields = (u.searchParams.get("fields") ?? "").split(",");
    for (const f of ["fsq_place_id", "name", "latitude", "longitude", "hours"]) assert.ok(fields.includes(f), `fields carries ${f}`);
  });

  it("the cache does not cross anchors — a verified place does not lend its status to a namesake", async () => {
    stubFetch(() => FSQ_OPEN); // the record sits at CEBU
    const here = await getLiveVenueStatus("Cafe Uno", CEBU);
    assert.equal(here?.openNow, true);
    const there = await getLiveVenueStatus("Cafe Uno", { lat: FAR.latitude, lng: FAR.longitude });
    assert.equal(there, null, "the namesake 2 km away is not served the cached verified status");
    assert.equal(fetchCalls.length, 2, "a different anchor is a different entry");
  });

  it("the cache does not cross anchors — a namesake's cached miss does not blank the real place", async () => {
    stubFetch(() => FSQ_OPEN);
    assert.equal(await getLiveVenueStatus("Cafe Uno", { lat: FAR.latitude, lng: FAR.longitude }), null);
    const here = await getLiveVenueStatus("Cafe Uno", CEBU);
    assert.equal(here?.openNow, true);
    assert.equal(fetchCalls.length, 2);
  });
});

describe("D-67 — get_place_details anchors the lookup on the place row", () => {
  it("passes the row's own coordinates and never returns them on the place", async () => {
    stubFetch(() => FSQ_OPEN);
    const sc = makeClient({ discovery_places: [PLACE] });
    const res: any = await executeCompassTool(sc, "user-1", null, "get_place_details", { placeId: "place-1" });
    assert.equal(res.place.liveStatus.available, true);
    assert.equal(new URL(fetchCalls[0]!).searchParams.get("ll"), `${PLACE.lat},${PLACE.lng}`);
    // The fake ignores the select list, so the row carries lat/lng: only the
    // tool itself can be keeping them off the result.
    assert.equal("lat" in res.place, false, "coordinates stay out of the tool result (PLACE_SAFE_COLUMNS)");
    assert.equal("lng" in res.place, false);
  });

  it("a namesake 2 km away gives no verified-live label", async () => {
    stubFetch(() => ({ results: [record("fsq-far", "Cafe Uno", FAR, true)] }));
    const sc = makeClient({ discovery_places: [PLACE] });
    const res: any = await executeCompassTool(sc, "user-1", null, "get_place_details", { placeId: "place-1" });
    const ls = res.place.liveStatus;
    assert.equal(ls.available, false);
    assert.equal(ls.openNow, null);
    assert.equal(ls.dataNote, CANT_VERIFY_NOTE);
    assert.equal(ls.confidence.sourceClass, "historical");
  });

  it("a place with no coordinates asks no provider and says it can't verify", async () => {
    stubFetch(() => FSQ_OPEN);
    const sc = makeClient({ discovery_places: [{ ...PLACE, lat: null, lng: null }] });
    const res: any = await executeCompassTool(sc, "user-1", null, "get_place_details", { placeId: "place-1" });
    assert.equal(fetchCalls.length, 0);
    assert.equal(res.place.liveStatus.available, false);
    assert.equal(res.place.liveStatus.confidence.sourceClass, "historical");
  });
});

describe("get_place_details — a failed catalog read is unreadable, never 'Place not found'", () => {
  it("a failed discovery_places read says unreadable and asks no live source", async () => {
    stubFetch(() => FSQ_OPEN);
    const sc = makeClient({ discovery_places: [PLACE] }, ["discovery_places"]);
    const res: any = await executeCompassTool(sc, "user-1", null, "get_place_details", { placeId: "place-1" });
    assert.equal(res.place, null);
    assert.equal(res.unreadable, true);
    assert.match(res.info, /unreadable right now/);
    assert.doesNotMatch(res.info, /not found/i, "an outage is not a finding about the place");
    assert.equal(fetchCalls.length, 0);
  });

  it("a real miss (no error, no row) is still 'Place not found.' and is not flagged unreadable", async () => {
    stubFetch(() => FSQ_OPEN);
    const sc = makeClient({ discovery_places: [PLACE] });
    const res: any = await executeCompassTool(sc, "user-1", null, "get_place_details", { placeId: "no-such-place" });
    assert.equal(res.place, null);
    assert.equal(res.info, "Place not found.");
    assert.equal("unreadable" in res, false);
    assert.equal(fetchCalls.length, 0);
  });
});
