/**
 * Compass Phase 5 — dynamic UI block builder tests.
 *
 * Covers:
 *  A. collectToolCandidates: indexes places / events / circle people from the
 *     tool log, unwraps UGC delimiters.
 *  B. buildUiBlocks: invented ids are dropped; blocks with no valid entities
 *     are dropped entirely (client falls back to plain text).
 *  C. Hydration: validated place ids get coordinates from the DB; DB failure
 *     is non-fatal.
 *  D. Caps: items per block, block count, comparison columns.
 *  E. person_cards: handles validated against circle memberHandles (with or
 *     without the leading @, case-insensitive).
 *
 * Runtime: node:test. Run: node --import tsx/esm --test src/test/compass-ui-blocks.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectToolCandidates,
  buildUiBlocks,
  type CompassUiBlock,
} from "../compass/CompassUiBlocks.js";
import type { ToolExecution } from "../compass/CompassTools.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PLACE_A = "place-aaaa";
const PLACE_B = "place-bbbb";
const EVENT_A = "event-aaaa";

function toolLog(): ToolExecution[] {
  return [
    {
      name: "search_places",
      arguments: {},
      result: {
        candidates: [
          { id: PLACE_A, name: "<portava:ugc>Cafe Uno</portava:ugc>", category: "food", city: "Cebu", rating: 4.5, verified: true, blurb: "<portava:ugc>Great beans</portava:ugc>" },
          { id: PLACE_B, name: "<portava:ugc>Bar Dos</portava:ugc>", category: "nightlife", city: "Cebu" },
        ],
      },
    },
    {
      name: "search_events",
      arguments: {},
      result: {
        candidates: [
          { id: EVENT_A, title: "<portava:ugc>Beach Meetup</portava:ugc>", city: "Cebu", startsAt: "2026-08-01T10:00:00Z", category: "Hiking" },
        ],
      },
    },
    {
      name: "get_circle_activity",
      arguments: {},
      result: {
        circles: [
          { name: "<portava:ugc>Island Crew</portava:ugc>", memberHandles: ["@maria_travels", "@ben_k"], isOwner: true },
        ],
      },
    },
  ];
}

/** Fake supabase client supporting from().select().in() for coord hydration. */
function fakeClient(rows: any[] | null, fail = false) {
  return {
    from: () => ({
      select: () => ({
        in: async () => (fail ? Promise.reject(new Error("db down")) : { data: rows, error: null }),
      }),
    }),
  } as any;
}

/** Table-aware fake client: rowsByTable maps table name → returned rows. */
function fakeClientByTable(rowsByTable: Record<string, any[]>) {
  return {
    from: (table: string) => ({
      select: () => ({
        in: async () => ({ data: rowsByTable[table] ?? [], error: null }),
      }),
    }),
  } as any;
}

// ── A. Candidate index ────────────────────────────────────────────────────────

describe("collectToolCandidates", () => {
  it("indexes places, events, and circle people with UGC unwrapped", () => {
    const idx = collectToolCandidates(toolLog());
    assert.equal(idx.places.get(PLACE_A)?.name, "Cafe Uno");
    assert.equal(idx.places.get(PLACE_A)?.blurb, "Great beans");
    assert.equal(idx.events.get(EVENT_A)?.title, "Beach Meetup");
    assert.equal(idx.people.get("maria_travels")?.handle, "maria_travels");
    assert.equal(idx.people.get("maria_travels")?.circleName, "Island Crew");
  });

  it("indexes get_place_details results too", () => {
    const idx = collectToolCandidates([
      { name: "get_place_details", arguments: {}, result: { place: { id: "p9", name: "Solo Spot" } } },
    ]);
    assert.equal(idx.places.get("p9")?.name, "Solo Spot");
  });
});

// ── B. Validation ─────────────────────────────────────────────────────────────

describe("buildUiBlocks validation", () => {
  it("drops invented ids and keeps real ones", async () => {
    const blocks = await buildUiBlocks(null, {
      blocks: [{ type: "place_cards", placeIds: [PLACE_A, "invented-id"] }],
    }, toolLog());
    assert.equal(blocks.length, 1);
    const b = blocks[0] as Extract<CompassUiBlock, { type: "place_cards" }>;
    assert.deepEqual(b.places.map((p) => p.id), [PLACE_A]);
  });

  it("drops a block whose entities are all invented", async () => {
    const blocks = await buildUiBlocks(null, {
      blocks: [
        { type: "place_cards", placeIds: ["nope"] },
        { type: "event_cards", eventIds: [EVENT_A] },
      ],
    }, toolLog());
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "event_cards");
  });

  it("returns [] when payload has no blocks or is null", async () => {
    assert.deepEqual(await buildUiBlocks(null, null, toolLog()), []);
    assert.deepEqual(await buildUiBlocks(null, { type: "recommendation" }, toolLog()), []);
  });

  it("validates comparison rows against candidates and hydrates labels", async () => {
    const blocks = await buildUiBlocks(null, {
      blocks: [{
        type: "comparison",
        columns: ["Distance", "Vibe"],
        rows: [
          { kind: "place", id: PLACE_A, values: ["1 km", "chill"] },
          { kind: "place", id: "fake", values: ["0 km", "?"] },
          { kind: "event", id: EVENT_A, values: ["2 km", "party"] },
        ],
      }],
    }, toolLog());
    assert.equal(blocks.length, 1);
    const cmp = blocks[0] as Extract<CompassUiBlock, { type: "comparison" }>;
    assert.equal(cmp.rows.length, 2);
    assert.equal(cmp.rows[0].label, "Cafe Uno");
    assert.equal(cmp.rows[1].label, "Beach Meetup");
    assert.equal(cmp.rows[1].kind, "event");
  });
});

// ── C. Hydration ──────────────────────────────────────────────────────────────

describe("buildUiBlocks coordinate hydration", () => {
  it("attaches real DB coordinates to validated places", async () => {
    const sc = fakeClient([{ id: PLACE_A, lat: 10.3, lng: 123.9 }]);
    const blocks = await buildUiBlocks(sc, {
      blocks: [{ type: "map", placeIds: [PLACE_A] }],
    }, toolLog());
    const b = blocks[0] as Extract<CompassUiBlock, { type: "map" }>;
    assert.equal(b.places[0].lat, 10.3);
    assert.equal(b.places[0].lng, 123.9);
  });

  it("DB failure is non-fatal — blocks ship without coordinates", async () => {
    const sc = fakeClient(null, true);
    const blocks = await buildUiBlocks(sc, {
      blocks: [{ type: "place_cards", placeIds: [PLACE_A] }],
    }, toolLog());
    const b = blocks[0] as Extract<CompassUiBlock, { type: "place_cards" }>;
    assert.equal(b.places[0].lat, null);
  });

  it("attaches venue coordinates to comparison event rows when show_exact_location allows", async () => {
    const sc = fakeClientByTable({
      discovery_places: [{ id: PLACE_A, lat: 10.3, lng: 123.9 }],
      events: [{ id: EVENT_A, location_lat: 10.31, location_lng: 123.91, show_exact_location: true }],
    });
    const blocks = await buildUiBlocks(sc, {
      blocks: [{
        type: "comparison",
        columns: ["Vibe"],
        rows: [
          { kind: "place", id: PLACE_A, values: ["chill"] },
          { kind: "event", id: EVENT_A, values: ["party"] },
        ],
      }],
    }, toolLog());
    const cmp = blocks[0] as Extract<CompassUiBlock, { type: "comparison" }>;
    assert.equal(cmp.rows[0].place?.lat, 10.3);
    assert.equal(cmp.rows[1].event?.lat, 10.31);
    assert.equal(cmp.rows[1].event?.lng, 123.91);
  });

  it("attaches venue coordinates to event_cards blocks when show_exact_location allows", async () => {
    const sc = fakeClientByTable({
      events: [{ id: EVENT_A, location_lat: 10.31, location_lng: 123.91, show_exact_location: true }],
    });
    const blocks = await buildUiBlocks(sc, {
      blocks: [{ type: "event_cards", eventIds: [EVENT_A] }],
    }, toolLog());
    const b = blocks[0] as Extract<CompassUiBlock, { type: "event_cards" }>;
    assert.equal(b.events[0].lat, 10.31);
    assert.equal(b.events[0].lng, 123.91);
  });

  it("withholds event_cards coordinates when show_exact_location is false", async () => {
    const sc = fakeClientByTable({
      events: [{ id: EVENT_A, location_lat: 10.31, location_lng: 123.91, show_exact_location: false }],
    });
    const blocks = await buildUiBlocks(sc, {
      blocks: [{ type: "event_cards", eventIds: [EVENT_A] }],
    }, toolLog());
    const b = blocks[0] as Extract<CompassUiBlock, { type: "event_cards" }>;
    assert.equal(b.events[0].lat, null);
    assert.equal(b.events[0].lng, null);
  });

  it("withholds event coordinates when show_exact_location is false", async () => {
    const sc = fakeClientByTable({
      events: [{ id: EVENT_A, location_lat: 10.31, location_lng: 123.91, show_exact_location: false }],
    });
    const blocks = await buildUiBlocks(sc, {
      blocks: [{
        type: "comparison",
        columns: ["Vibe"],
        rows: [{ kind: "event", id: EVENT_A, values: ["party"] }],
      }],
    }, toolLog());
    const cmp = blocks[0] as Extract<CompassUiBlock, { type: "comparison" }>;
    assert.equal(cmp.rows[0].event?.lat, null);
    assert.equal(cmp.rows[0].event?.lng, null);
  });
});

// ── D. Caps ───────────────────────────────────────────────────────────────────

describe("buildUiBlocks caps", () => {
  it("caps blocks at 4 and items at 6", async () => {
    const manyPlaces = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
    const log: ToolExecution[] = [
      { name: "search_places", arguments: {}, result: { candidates: manyPlaces } },
    ];
    const blockDecl = { type: "place_cards", placeIds: manyPlaces.map((p) => p.id) };
    const blocks = await buildUiBlocks(null, { blocks: [blockDecl, blockDecl, blockDecl, blockDecl, blockDecl, blockDecl] }, log);
    assert.equal(blocks.length, 4);
    assert.equal((blocks[0] as any).places.length, 6);
  });
});

// ── E. person_cards ───────────────────────────────────────────────────────────

describe("buildUiBlocks person_cards", () => {
  it("accepts handles with or without @, case-insensitive; drops unknowns", async () => {
    const blocks = await buildUiBlocks(null, {
      blocks: [{ type: "person_cards", handles: ["@Maria_Travels", "ben_k", "@stranger"] }],
    }, toolLog());
    const b = blocks[0] as Extract<CompassUiBlock, { type: "person_cards" }>;
    assert.deepEqual(b.people.map((p) => p.handle), ["maria_travels", "ben_k"]);
  });
});
