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
} from "../lib/liveIntelligence.js";
import { executeCompassTool, sanitizeToolResult } from "../compass/CompassTools.js";
import { collectToolCandidates } from "../compass/CompassUiBlocks.js";
import type { ToolExecution } from "../compass/CompassTools.js";
import { FOURSQUARE_KEY_VARS, snapshotKeyEnv, restoreKeyEnv, clearKeyEnv, setKeyEnv } from "./helpers/apiKeyEnv.js";

// ── fetch stub ────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchCalls: string[] = [];
let fetchResponder: (() => any) | null = null;

function stubFetch(responder: () => any) {
  fetchResponder = responder;
  globalThis.fetch = (async (url: any) => {
    fetchCalls.push(String(url));
    const body = fetchResponder!();
    if (body instanceof Error) throw body;
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

function makeClient(db: Record<string, any[]>) {
  function builder(rows: any[]) {
    let filtered = [...rows];
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      gte: () => b,
      or: () => b,
      ilike: () => b,
      in: () => b,
      is: () => b,
      order: () => b,
      limit: (n: number) => { filtered = filtered.slice(0, n); return b; },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: filtered, error: null }),
    };
    return b;
  }
  return { from: (table: string) => builder(db[table] ?? []) } as any;
}

const PLACE = {
  id: "place-1", name: "Cafe Uno", category: "food", primary_category: "cafe",
  city: "Cebu", neighborhood: null, rating: 4.5, saved_count: 3, verified: true,
  blurb: "Great beans", secondary_categories: null, place_type: "cafe",
};
const EVENT = {
  id: "event-1", title: "Beach Meetup", description: "Fun", city: "Cebu",
  country: "PH", starts_at: "2099-01-01T10:00:00Z", category: "beach",
  host_id: "host-1", state: "open", visibility: "public",
};

const FSQ_OPEN = { results: [{ fsq_place_id: "fsq-1", name: "Cafe Uno", hours: { open_now: true } }] };

// ── A. Live fetch on demand + short-lived cache ───────────────────────────────

describe("Phase 8 — live fetch layer", () => {
  it("fetches live open-now status on demand from the live source", async () => {
    stubFetch(() => FSQ_OPEN);
    const status = await getLiveVenueStatus("Cafe Uno", "Cebu");
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].includes("foursquare"));
    assert.equal(status?.openNow, true);
    assert.equal(status?.source, "foursquare");
    assert.ok(status?.checkedAt);
  });

  it("caches live status — second lookup within TTL does not re-hit the source", async () => {
    stubFetch(() => FSQ_OPEN);
    await getLiveVenueStatus("Cafe Uno", "Cebu");
    const again = await getLiveVenueStatus("Cafe Uno", "Cebu");
    assert.equal(fetchCalls.length, 1);
    assert.equal(again?.openNow, true);
  });

  it("returns null (never a fabricated value) on source error", async () => {
    stubFetch(() => new Error("boom"));
    const status = await getLiveVenueStatus("Cafe Uno", "Cebu");
    assert.equal(status, null);
  });

  it("returns null when no API key is configured", async () => {
    clearKeyEnv(FOURSQUARE_KEY_VARS);
    stubFetch(() => FSQ_OPEN);
    const status = await getLiveVenueStatus("Cafe Uno", "Cebu");
    assert.equal(status, null);
    assert.equal(fetchCalls.length, 0);
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

    const status = await getLiveVenueStatus("Cafe Uno", "Cebu");
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
