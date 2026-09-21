/**
 * census-passport P159 — "9 — Intelligence: Travel DNA, yearbook, deeper
 * Experience Graph". Travel DNA and the yearbook are built; the graph had no
 * Passport reader at all. §13.4 measured it exactly: **30 files reference
 * `compass_graph_nodes` / `compass_graph_edges` and ZERO are under
 * `src/services/passport/` or `src/routes/passport*.ts`** — "the Experience
 * Graph is built and has no Passport reader".
 *
 * ── WHAT THIS PINS ──────────────────────────────────────────────────────────
 *  §1  The reader reads the EXISTING graph. It creates no node, no edge and no
 *      table, and it counts only the edge types `CompassGraphEngine` writes.
 *  §2  The privacy blocker §16.2 answered stays answered: the experience feed is
 *      filtered `published` AND `visibility = 'public'` TWICE — in the query and
 *      again per row — so a Passport reader over those nodes cannot be a second
 *      route to a private memory. **A mutation removing EITHER half turns this
 *      suite red.**
 *  §3  An unreadable graph is reported as unread, never as "this traveller has
 *      experienced nothing".
 *  §4  The unruled half of P159 is not guessed: every viewer relationship except
 *      the owner's own gets no surface at all.
 *  §5  It is reachable from the shipping API — it rides on the projection
 *      `GET /passport/:userId/projection` already returns.
 *
 * ── MUTATIONS (census P24) ──────────────────────────────────────────────────
 *   G1  delete `.eq("state", "published")` from CompassGraphEngine's `memories`
 *       select                                          → §2 query-filter red
 *   G2  delete `.eq("visibility", "public")` from that same select
 *                                                       → §2 query-filter red
 *   G3  `isPublicWorldMemory` → `return true`           → §2 per-row guard red
 *   G4  drop the `if (!isPublicWorldMemory(r)) continue;` re-check from the
 *       row loop                                        → §2 per-row guard red
 *   G5  `if (error) return unreadable(...)` → `experienceKeys = []`
 *                                                       → §3 red
 *   G6  `if (viewerContext !== "self") return null;` → `if (false) return null;`
 *                                                       → §4 red
 *   G7  count an edge type the engine never writes (add "follows" to
 *       EXPERIENCE_EDGE_TYPES)                          → §1 red
 *
 * Run: node --import tsx/esm --test src/test/passportExperienceGraphReader.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildExperienceGraphProjection,
  EXPERIENCE_EDGE_TYPES,
} from "../services/passport/PassportExperienceGraphService.js";
import { isPublicWorldMemory } from "../compass/CompassGraphEngine.js";
import {
  buildPassportProjection,
  type ViewerResolution,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";

const OWNER = "owner-1";

function permsPublic(): ViewerPermissions {
  return {
    relationshipLabel: "stranger", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: false, canSeeAvailability: false,
    canSeeTrips: false, canSeeMutuals: false, canSeeLocationContext: false,
    canSeeFriendOnlyPosts: false, canMessage: false, canSendMessageRequest: false,
    canFollow: true, canInviteToTripCrew: false,
  };
}
function permsSelf(): ViewerPermissions {
  return {
    ...permsPublic(), relationshipLabel: "self", canViewFullProfile: true,
    canSeeAvailability: true, canSeeTrips: true, canSeeMutuals: true,
    canSeeLocationContext: true, canSeeFriendOnlyPosts: true, canFollow: false,
  };
}
const SELF: ViewerResolution = { context: "self", permissions: permsSelf(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
const PUBLIC: ViewerResolution = { context: "public", permissions: permsPublic(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
const resolver = (r: ViewerResolution) => async () => r;

/** The edges CompassGraphEngine writes for one traveller with two experiences. */
const GRAPH_EDGES = [
  { src_type: "person", src_key: OWNER, dst_type: "experience", dst_key: "mem-1", edge_type: "experienced" },
  { src_type: "person", src_key: OWNER, dst_type: "experience", dst_key: "mem-2", edge_type: "experienced" },
  { src_type: "experience", src_key: "mem-1", dst_type: "place", dst_key: "pl-9", edge_type: "at_place" },
  { src_type: "experience", src_key: "mem-1", dst_type: "city", dst_key: "lisbon", edge_type: "in_city" },
  { src_type: "experience", src_key: "mem-2", dst_type: "city", dst_key: "porto", edge_type: "in_city" },
  { src_type: "experience", src_key: "mem-2", dst_type: "trip", dst_key: "tr-4", edge_type: "during_trip" },
  // Another traveller's experience — must never be counted into this one.
  { src_type: "person", src_key: "someone-else", dst_type: "experience", dst_key: "mem-9", edge_type: "experienced" },
  { src_type: "experience", src_key: "mem-9", dst_type: "city", dst_key: "madrid", edge_type: "in_city" },
];

function db(edges = GRAPH_EDGES) {
  return makePassportDb({
    profiles: [{
      id: OWNER, handle: "wanderer", display_name: "Wanderer", name: "Wanderer",
      verified: false, is_official: false, is_private: false,
      passport_visibility: "public", show_profile_picture_publicly: true,
      created_at: "2023-01-01",
    }],
    compass_graph_edges: edges,
  });
}

// ── §1 — it READS the existing graph; it does not build a second one ─────────

describe("P159 §1 — the reader consumes CompassGraphEngine's own edges", () => {
  it("counts this traveller's experiences and their four engine edge types", async () => {
    const g = (await buildExperienceGraphProjection(db() as any, OWNER, "self"))!;
    assert.equal(g.experiences, 2);
    assert.equal(g.edges.at_place, 1);
    assert.equal(g.edges.in_city, 2);
    assert.equal(g.edges.during_trip, 1);
    assert.equal(g.edges.at_event, 0, "a type the engine wrote none of reads 0, not null");
    assert.equal(g.cities, 2);
    assert.equal(g.unreadable, false);
  });

  it("the vocabulary is the ENGINE's — no edge type this service invented", () => {
    // G7: adding a key here that CompassGraphEngine never writes is a second
    // graph's vocabulary wearing this one's name.
    const engine = readFileSync(
      fileURLToPath(new URL("../compass/CompassGraphEngine.ts", import.meta.url)),
      "utf8",
    );
    for (const t of EXPERIENCE_EDGE_TYPES) {
      assert.ok(
        engine.includes(`edge_type: "${t}"`),
        `${t} is not an edge CompassGraphEngine writes — the Passport reader must not invent one`,
      );
    }
  });

  it("another traveller's experiences are not counted into this one", async () => {
    const g = (await buildExperienceGraphProjection(db() as any, OWNER, "self"))!;
    assert.equal(g.experiences, 2, "mem-9 belongs to someone-else");
    assert.equal(g.cities, 2, "madrid is not this traveller's city");
  });

  it("a read that SUCCEEDS and finds nothing reports zero — a measurement", async () => {
    const g = (await buildExperienceGraphProjection(db([]) as any, OWNER, "self"))!;
    assert.equal(g.experiences, 0);
    assert.equal(g.cities, 0);
    assert.equal(g.unreadable, false);
    assert.deepEqual(g.edges, { at_place: 0, during_trip: 0, at_event: 0, in_city: 0 });
  });
});

// ── §2 — the double filter is load-bearing and stays load-bearing ────────────

describe("P159 §2 — a Passport reader cannot be a second route to a private memory", () => {
  it("THE PER-ROW GUARD: only published AND public memories enter the graph", () => {
    // G3 (`return true`) and G4 (dropping the re-check) both redden here.
    assert.equal(isPublicWorldMemory({ state: "published", visibility: "public" }), true);
    assert.equal(isPublicWorldMemory({ state: "published", visibility: "friends_only" }), false);
    assert.equal(isPublicWorldMemory({ state: "published", visibility: "only_me" }), false);
    assert.equal(isPublicWorldMemory({ state: "draft", visibility: "public" }), false);
    assert.equal(isPublicWorldMemory({ state: "archived", visibility: "public" }), false);
    assert.equal(isPublicWorldMemory(null), false, "an absent row is ineligible, not permitted");
    assert.equal(isPublicWorldMemory({}), false);
  });

  it("THE QUERY FILTER: both halves are still on the experience-node select", () => {
    // G1 / G2. The engine belongs to another lane, so this asserts its shape
    // from the outside rather than editing it: both predicates must sit on the
    // `memories` select that feeds the experience nodes, AND the per-row guard
    // must still be applied inside that loop.
    const engine = readFileSync(
      fileURLToPath(new URL("../compass/CompassGraphEngine.ts", import.meta.url)),
      "utf8",
    );
    const start = engine.indexOf('.from("memories")');
    assert.ok(start > 0, "the memories → experience-node select must still exist");
    const block = engine.slice(start, start + 2500);
    assert.ok(block.includes('.eq("state", "published")'), "the published filter was removed from the query");
    assert.ok(block.includes('.eq("visibility", "public")'), "the visibility filter was removed from the query");
    assert.ok(
      block.includes("isPublicWorldMemory(r)"),
      "the per-row re-check was removed — the query predicate would be the only thing left",
    );
  });

  it("the Passport reader never touches `memories` itself", () => {
    // It reads the graph, and the graph is already filtered. A direct memories
    // read here would be exactly the second route §13.5 warned about.
    const src = readFileSync(
      fileURLToPath(new URL("../services/passport/PassportExperienceGraphService.ts", import.meta.url)),
      "utf8",
    );
    assert.equal(/\.from\("memories"\)/.test(src), false);
    assert.equal(/\.from\("compass_graph_nodes"\)/.test(src), false, "no node reads: attrs are not needed and not taken");
  });
});

// ── §3 — an unreadable graph is unread, not empty ────────────────────────────

describe("P159 §3 — an unreadable graph is reported, never rendered as an empty life", () => {
  it("a RESOLVED {data:null,error} makes every count null and sets `unreadable`", async () => {
    // supabase-js resolves on a database error. This is the shape it really
    // returns, so a try/catch would never see it. G5 reddens here.
    const sc = makeFailClosedClient({
      rows: { compass_graph_edges: GRAPH_EDGES },
      failOn: (ctx) =>
        ctx.table === "compass_graph_edges"
          ? { code: "57014", message: "canceling statement due to statement timeout" }
          : null,
    });
    const g = (await buildExperienceGraphProjection(sc as any, OWNER, "self"))!;
    assert.equal(g.unreadable, true);
    assert.equal(g.experiences, null, "null, never 0 — 0 is a claim about this traveller");
    assert.equal(g.cities, null);
    assert.deepEqual(g.edges, { at_place: null, during_trip: null, at_event: null, in_city: null });
  });

  it("the aggregate NAMES the section it could not read", async () => {
    const sc = makeFailClosedClient({
      rows: {
        profiles: [{
          id: OWNER, handle: "wanderer", display_name: "Wanderer", name: "Wanderer",
          verified: false, is_official: false, is_private: false,
          passport_visibility: "public", show_profile_picture_publicly: true,
          created_at: "2023-01-01",
        }],
        compass_graph_edges: GRAPH_EDGES,
      },
      failOn: (ctx) => (ctx.table === "compass_graph_edges" ? { code: "57014", message: "timeout" } : null),
    });
    const p = (await buildPassportProjection(sc as any, OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    assert.ok((p.unreadable ?? []).includes("experience_graph"));
    assert.equal(p.experienceGraph?.unreadable, true);
  });
});

// ── §4 — the unruled half of P159 is not guessed ─────────────────────────────

describe("P159 §4 — every viewer but the owner gets NO surface, not an empty one", () => {
  it("a public viewer gets no experience graph at all", async () => {
    // G6 reddens here. "Which edges, about whom, at what relationship" is the
    // owner's paragraph; an empty summary would be a different unruled answer,
    // so the surface is ABSENT rather than zeroed.
    for (const ctx of ["public", "friend", "trip_crew", "buddy_client", "blocked"] as const) {
      assert.equal(await buildExperienceGraphProjection(db() as any, OWNER, ctx as any), null, ctx);
    }
    assert.notEqual(await buildExperienceGraphProjection(db() as any, OWNER, "self"), null);
  });

  it("the projection omits the key entirely for a stranger", async () => {
    const p = (await buildPassportProjection(db() as any, OWNER, "viewer-9", { resolveViewerContext: resolver(PUBLIC) }))!;
    assert.equal("experienceGraph" in p, false);
  });
});

// ── §5 — reachable from the shipping API ─────────────────────────────────────

describe("P159 §5 — it rides on the projection the product already serves", () => {
  it("GET /passport/:userId/projection's own builder carries it for the owner", async () => {
    const p = (await buildPassportProjection(db() as any, OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    assert.equal(p.experienceGraph?.experiences, 2);
    assert.equal(p.experienceGraph?.basis, "public_published_experiences");
  });

  it("the route that serves it still exists", () => {
    const route = readFileSync(
      fileURLToPath(new URL("../routes/passport.ts", import.meta.url)),
      "utf8",
    );
    assert.ok(route.includes('router.get("/passport/:userId/projection"'));
    assert.ok(route.includes("buildPassportProjection("));
  });
});
