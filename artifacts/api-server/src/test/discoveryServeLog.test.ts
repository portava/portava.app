/**
 * discoveryServeLog — Stage 0 serve-point instrumentation
 *
 * The property that matters most here is the FIRST one: with the
 * `discovery_serve_log_enabled` flag absent — which is its state in production
 * the moment this code lands — the module must perform NO write whatsoever.
 * That is what makes introducing Stage 0 behaviour-preserving.
 *
 * Tests:
 *  A. Flag absent (no row)            → zero inserts
 *  B. Flag present but false          → zero inserts
 *  C. Flag true                       → exactly one row per served item
 *  D. position mirrors served order
 *  E. servePoint is recorded on every row
 *  F. rankedInRequest is false for serve points 1-4, true for 5 and 6
 *  G. item_kind maps db/ → gem and OSM ids → place (matches discovery.ts:1329)
 *  H. surface is always 'discovery' (a value the CHECK already permits)
 *  I. Empty item list                  → zero inserts
 *  J. An insert ERROR is reported, not swallowed  (the 0202 lesson)
 *  K. An insert THROWING never propagates to the caller
 *  L. The flag read is cached — a second call inside the TTL re-reads nothing
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryServeLog.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  logDiscoveryServe,
  invalidateServeLogFlagCache,
  searchTypeToItemKind,
  DiscoveryServePoint,
  DISCOVERY_SERVE_LOG_FLAG,
} from "../lib/discoveryServeLog.js";

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";

interface Captured { table: string; rows: any[]; }

/**
 * Minimal Supabase stub: answers the feature_flags lookup isFlagEnabled makes,
 * and captures rank_events inserts.
 */
function makeClient(opts: {
  flagRow?:     { enabled: boolean } | null;
  flagError?:   unknown;
  insertError?: unknown;
  insertThrows?: boolean;
}) {
  const captured: Captured[] = [];
  let flagReads = 0;

  const client = {
    from(table: string) {
      if (table === "feature_flags") {
        return {
          select() { return this; },
          eq()     { return this; },
          maybeSingle() {
            flagReads += 1;
            return Promise.resolve({
              data:  opts.flagRow ?? null,
              error: opts.flagError ?? null,
            });
          },
        };
      }
      return {
        insert(rows: any[]) {
          if (opts.insertThrows) throw new Error("insert exploded");
          captured.push({ table, rows });
          return Promise.resolve({ error: opts.insertError ?? null });
        },
      };
    },
  };

  return { client, captured, flagReads: () => flagReads };
}

const ITEMS = [
  { id: "node/1001" },
  { id: "db/22222222-2222-2222-2222-222222222222" },
  { id: "way/3003" },
];

describe("discoveryServeLog — inert until the flag is seeded", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("A. writes nothing when the flag row is absent", async () => {
    const { client, captured } = makeClient({ flagRow: null });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    assert.equal(captured.length, 0, "a missing flag row must produce no write");
  });

  it("B. writes nothing when the flag is explicitly false", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: false } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    assert.equal(captured.length, 0);
  });

  it("B2. writes nothing when the flag read errors (fail-closed)", async () => {
    const { client, captured } = makeClient({ flagError: { message: "boom" } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    assert.equal(captured.length, 0);
  });
});

describe("discoveryServeLog — row shape once enabled", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("C/D/E/H. one row per item, positioned, marked, on surface 'discovery'", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L2_FRESH, items: ITEMS,
      context: { destination: "lisbon", category: "for_you" },
    });

    assert.equal(captured.length, 1, "exactly one insert call");
    const rows = captured[0]!.rows;
    assert.equal(captured[0]!.table, "rank_events");
    assert.equal(rows.length, ITEMS.length, "one row per served item");

    rows.forEach((r: any, idx: number) => {
      assert.equal(r.position, idx, "position mirrors served order");
      assert.equal(r.surface, "discovery");
      assert.equal(r.outcome, "impression");
      assert.equal(r.user_id, USER_ID);
      assert.equal(r.features.servePoint, DiscoveryServePoint.CACHE_A_L2_FRESH);
      assert.equal(r.features.route, "GET /discovery");
      assert.equal(r.features.destination, "lisbon");
    });

    // One session id for the whole batch — "single open" semantics.
    const sessions = new Set(rows.map((r: any) => r.session_id));
    assert.equal(sessions.size, 1, "one session_id per batch");
  });

  it("F. rankedInRequest is false for cache serves and true for the ranking serves", async () => {
    const unranked = [
      DiscoveryServePoint.CACHE_A_L1,
      DiscoveryServePoint.CACHE_A_L2_FRESH,
      DiscoveryServePoint.CACHE_A_L2_STALE,
      DiscoveryServePoint.CACHE_B_HIT,
    ];
    for (const sp of unranked) {
      invalidateServeLogFlagCache();
      const { client, captured } = makeClient({ flagRow: { enabled: true } });
      await logDiscoveryServe(client, { userId: USER_ID, servePoint: sp, items: ITEMS });
      assert.equal(
        captured[0]!.rows[0].features.rankedInRequest, false,
        `serve point ${sp} runs no ranker in-request`,
      );
    }

    // Serve point 4 replays a Compass order but invokes no ranker in THIS
    // request — the distinction the Phase -1 proof corrected from three to four.
    invalidateServeLogFlagCache();
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.COMPASS_FRESH_RANK, items: ITEMS,
    });
    assert.equal(captured[0]!.rows[0].features.rankedInRequest, true);
  });

  it("G. item_kind maps db/ to gem and OSM ids to place", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    const kinds = captured[0]!.rows.map((r: any) => r.item_kind);
    assert.deepEqual(kinds, ["place", "gem", "place"]);
    // Every value must satisfy the CHECK at 0153_add_rank_events.sql:18.
    const allowed = new Set(["post", "event", "plan", "buddy", "place", "gem"]);
    for (const k of kinds) assert.ok(allowed.has(k), `${k} violates the item_kind CHECK`);
  });

  it("I. writes nothing for an empty served list", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: [],
    });
    assert.equal(captured.length, 0);
  });

  it("I2. writes nothing without a user id (rank_events.user_id is NOT NULL)", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: "", servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    assert.equal(captured.length, 0);
  });
});

describe("discoveryServeLog — failure handling", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("J. a rejected insert does not throw (and is reported, not swallowed)", async () => {
    const { client } = makeClient({
      flagRow: { enabled: true },
      insertError: { message: "new row violates check constraint" },
    });
    await assert.doesNotReject(() =>
      logDiscoveryServe(client, {
        userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
      }),
    );
  });

  it("K. a throwing insert never propagates to the caller", async () => {
    const { client } = makeClient({ flagRow: { enabled: true }, insertThrows: true });
    await assert.doesNotReject(() =>
      logDiscoveryServe(client, {
        userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
      }),
    );
  });

  it("K2. a null client is a no-op", async () => {
    await assert.doesNotReject(() =>
      logDiscoveryServe(null, {
        userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
      }),
    );
  });
});

describe("discoveryServeLog — Stage 0b, the rest of the discovery surface", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("M. serve points 7-9 are never marked as having run a ranker", async () => {
    for (const sp of [
      DiscoveryServePoint.FEED,
      DiscoveryServePoint.SEARCH,
      DiscoveryServePoint.SUGGEST,
    ]) {
      invalidateServeLogFlagCache();
      const { client, captured } = makeClient({ flagRow: { enabled: true } });
      await logDiscoveryServe(client, {
        userId: USER_ID, servePoint: sp, items: ITEMS, route: "GET /discovery/x",
      });
      assert.equal(
        captured[0]!.rows[0].features.rankedInRequest, false,
        `serve point ${sp} has no ranker call at all`,
      );
      assert.equal(captured[0]!.rows[0].features.route, "GET /discovery/x");
    }
  });

  it("N. an explicit kind overrides the id-based inference", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.SEARCH,
      items: [
        { id: "node/1", kind: "buddy" },
        { id: "db/2",   kind: "post"  },
        // null is a real, intended value — "served, kind not applicable".
        { id: "city/3", kind: null    },
      ],
    });
    const kinds = captured[0]!.rows.map((r: any) => r.item_kind);
    assert.deepEqual(kinds, ["buddy", "post", null]);
  });

  it("O. search types map only onto kinds the CHECK constraint accepts", () => {
    const allowed = new Set(["post", "event", "plan", "buddy", "place", "gem"]);
    const expected: Record<string, string | null> = {
      travelers: "buddy", buddies: "buddy", events: "event",
      trips: "plan", plans: "plan", places: "place",
      hidden_gems: "gem", posts: "post",
    };
    for (const [type, kind] of Object.entries(expected)) {
      assert.equal(searchTypeToItemKind(type), kind, `${type} maps to ${kind}`);
    }
    // Taxonomic result types have no valid kind and must map to null rather
    // than to an invented one, which would corrupt any item_kind grouping.
    for (const type of [
      "hashtags", "circles", "stamps", "activities",
      "cities", "countries", "languages", "interests", "vibes",
    ]) {
      assert.equal(searchTypeToItemKind(type), null, `${type} has no valid item_kind`);
    }
    // Nothing may escape the constraint's vocabulary.
    for (const type of [...Object.keys(expected), "cities", "unknown_future_type"]) {
      const k = searchTypeToItemKind(type);
      assert.ok(k === null || allowed.has(k), `${type} -> ${k} violates the CHECK`);
    }
  });
});

describe("discoveryServeLog — flag read caching", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("L. reads the flag once across repeated serves inside the TTL", async () => {
    const { client, captured, flagReads } = makeClient({ flagRow: { enabled: true } });
    for (let i = 0; i < 4; i++) {
      await logDiscoveryServe(client, {
        userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
      });
    }
    assert.equal(captured.length, 4, "every serve still logs");
    assert.equal(flagReads(), 1, "the flag is read once, not once per serve");
  });

  it("L2. the flag name is the one this module documents", () => {
    assert.equal(DISCOVERY_SERVE_LOG_FLAG, "discovery_serve_log_enabled");
  });
});

// ── `12` stop-condition evidence (census DV-82) ───────────────────────────────
//
// This writer is the only instrument that knows whether a Discovery event
// actually landed, so it is the only thing that can feed `12`'s first two stop
// conditions. The Phase 9 lesson applies: with the evaluator fully covered by
// its own tests, deleting the CALL that feeds it left everything green. A stop
// condition with no evidence never trips, which is indistinguishable from one
// that is working.
import {
  evaluateStopConditions,
  _resetStopConditionsForTest,
} from "../lib/discoveryStopConditions.js";

describe("discoveryServeLog — feeds the 12 stop conditions", () => {
  beforeEach(() => {
    invalidateServeLogFlagCache();
    _resetStopConditionsForTest();
  });

  it("M. a REJECTED insert is recorded as evidence, not only logged", async () => {
    const { client } = makeClient({ flagRow: { enabled: true }, insertError: { message: "check violation" } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    const v = evaluateStopConditions();
    assert.equal(v.attempts, 1, "the attempt must reach the stop-condition window");
    assert.equal(v.eventRejectionRate, 1, "a rejected batch is a rejection");
    assert.equal(v.loggingGapRate, 1, "and every served item failed to become a row");
  });

  it("M2. a LANDED insert is recorded as healthy evidence", async () => {
    const { client } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    const v = evaluateStopConditions();
    assert.equal(v.attempts, 1);
    assert.equal(v.eventRejectionRate, 0);
    assert.equal(v.loggingGapRate, 0);
  });

  it("M3. a THROWN insert is recorded — the failure most likely to be invisible", async () => {
    const { client } = makeClient({ flagRow: { enabled: true }, insertThrows: true });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    const v = evaluateStopConditions();
    assert.equal(v.attempts, 1, "a throw leaves no error object and no rejected row; if it is not recorded here it is recorded nowhere");
    assert.equal(v.eventRejectionRate, 1);
  });

  it("M4. the FLAG BEING OFF is not evidence of anything — no attempt, no gap", async () => {
    const { client } = makeClient({ flagRow: { enabled: false } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    assert.equal(
      evaluateStopConditions().attempts, 0,
      "counting a disabled writer as a logging gap would make the stop trip hardest precisely while the feature is off",
    );
  });

  it("M5. a serve with NO items records nothing — an empty page is not a dropped page", async () => {
    const { client } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: [],
    });
    assert.equal(evaluateStopConditions().attempts, 0);
  });
});

// ── `04` §5 — the recommendation denominator (DV-40) ─────────────────────────
//
// "Every served item must have a `recommendation_id`", plus a nine-field
// minimum record: recommendation_id, user_id, session_id, candidate_type/id,
// surface, rank_position, model_version, reason codes, served_at.
//
// The census recorded DV-40 as N on the evidence that `recommendation_id` has
// "zero occurrences in Discovery" and that the `10` §3 recommendation tables are
// absent. The second half is true. The first half was false even when written:
// Compass mints an HMAC-signed `recommendation_id` per served item and
// registers it in the production table `compass_served_recommendations`
// (migration 0055_compass_admin.sql:22). What was absent is a denominator on
// DISCOVERY's serves — and seven of the nine fields were already on the row.
//
// So this does not build a recommendation subsystem. It completes the record
// Discovery already writes, on the table Discovery already writes to, with no
// migration: the three missing fields go into the `features` jsonb that every
// serve-log row already carries.
//
// WHY NOT REUSE THE COMPASS TOKEN. `encodeRecommendationToken`
// (src/compass/CompassExplanationEngine.ts:283) is deterministic over
// (userId, itemId, itemType, sectionName, explanationKey) — deliberately, since
// Compass dedupes on it (`dedupeByRecommendationId`) and hands it to the client
// as a `/why` lookup handle. A DENOMINATOR has the opposite requirement: two
// serves of the same item to the same user are TWO exposures, and an id that
// collapses them under-counts exactly the quantity `04` §5 exists to measure.
// The id below therefore binds the serve, not the item.
import {
  recommendationIdFor,
  RECOMMENDATION_RECORD_FIELDS,
} from "../lib/discoveryRecommendationId.js";
import { DISCOVERY_MODEL_VERSION } from "../lib/discoveryRankProvenance.js";

describe("discoveryServeLog — 04 §5 the recommendation denominator (DV-40)", () => {
  beforeEach(() => {
    invalidateServeLogFlagCache();
  });

  it("R1. every served item carries a recommendation_id — none is blank, and a REPEATED item still gets two", async () => {
    // The repeat is the whole point of this fixture. A page of three DISTINCT
    // items cannot tell whether the id binds the exposure or merely the item —
    // both hypotheses predict three different ids — so the one arrangement that
    // separates them is the same item served twice at two rank positions.
    // (Found by mutation: pinning `position` to 0 in the derivation left an
    // all-distinct fixture entirely green.)
    const REPEATED = [
      { id: "node/1001" },
      { id: "db/22222222-2222-2222-2222-222222222222" },
      { id: "node/1001" },
    ];
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.COLD_FETCH_LEGACY_RANK, items: REPEATED,
    });
    const rows = captured[0]?.rows ?? [];
    assert.equal(rows.length, REPEATED.length, "precondition: one row per served item");

    const ids = rows.map((r: any) => r.features?.recommendationId);
    for (const id of ids) {
      assert.equal(typeof id, "string", "04 §5: every served item must have a recommendation_id");
      assert.ok((id as string).length > 0, "a blank id is an absent id wearing a field name");
    }
    assert.equal(
      new Set(ids).size, ids.length,
      "the same item at two rank positions is TWO exposures; one id for both under-counts the denominator",
    );
  });

  it("R2. all nine 04 §5 fields are recoverable from the row the writer produces", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.COLD_FETCH_LEGACY_RANK, items: ITEMS,
      context: { destination: "miami" },
    });
    const row = (captured[0]?.rows ?? [])[1];
    assert.ok(row, "precondition: a row was written");

    // The six the columns already carried.
    assert.equal(row.user_id, USER_ID, "04 §5 user_id");
    assert.equal(typeof row.session_id, "string", "04 §5 session_id");
    assert.ok(row.item_id && row.item_kind, "04 §5 candidate type/id");
    assert.equal(row.surface, "discovery", "04 §5 surface");
    assert.equal(row.position, 1, "04 §5 rank_position");
    assert.ok(row.served_at, "04 §5 served_at");
    // The three this adds, in the jsonb the row already writes.
    assert.equal(typeof row.features.recommendationId, "string", "04 §5 recommendation_id");
    assert.equal(row.features.modelVersion, DISCOVERY_MODEL_VERSION, "04 §5 model_version");
    assert.ok(Array.isArray(row.features.reasonCodes), "04 §5 reason codes");

    // And the list itself is exported, so a reader can check the record against
    // the specification rather than against this test's own memory of it.
    assert.equal(RECOMMENDATION_RECORD_FIELDS.length, 9, "04 §5 names nine fields");
  });

  it("R3. the id binds the SERVE, not the item — the same item served twice is two exposures", async () => {
    const a = recommendationIdFor({
      userId: USER_ID, sessionId: "s1", servedAt: "2026-09-14T00:00:00.000Z",
      surface: "discovery", position: 0, itemId: "node/1001",
    });
    const b = recommendationIdFor({
      userId: USER_ID, sessionId: "s2", servedAt: "2026-09-14T00:00:00.000Z",
      surface: "discovery", position: 0, itemId: "node/1001",
    });
    assert.notEqual(a, b, "a second session is a second exposure; collapsing them under-counts the denominator");

    const c = recommendationIdFor({
      userId: USER_ID, sessionId: "s1", servedAt: "2026-09-14T00:00:00.000Z",
      surface: "discovery", position: 1, itemId: "node/1001",
    });
    assert.notEqual(a, c, "the same item at a different rank position is a different exposure");

    const d = recommendationIdFor({
      userId: "aaaaaaaa-aaaa-aaaa-aaaa-000000000002", sessionId: "s1",
      servedAt: "2026-09-14T00:00:00.000Z", surface: "discovery", position: 0, itemId: "node/1001",
    });
    assert.notEqual(a, d, "another viewer's exposure is not this viewer's");
  });

  it("R4. the id is DETERMINISTIC — the identical batch replayed yields the identical ids", async () => {
    const args = {
      userId: USER_ID, sessionId: "s1", servedAt: "2026-09-14T00:00:00.000Z",
      surface: "discovery", position: 0, itemId: "node/1001",
    } as const;
    assert.equal(
      recommendationIdFor(args), recommendationIdFor(args),
      "DV-37: a retried batch must not manufacture a second exposure for the same serve — a random id would",
    );
  });

  it("R5. the id is opaque and leaks no identifier — a user id must not be readable out of it", async () => {
    const id = recommendationIdFor({
      userId: USER_ID, sessionId: "s1", servedAt: "2026-09-14T00:00:00.000Z",
      surface: "discovery", position: 0, itemId: "node/1001",
    });
    assert.ok(!id.includes(USER_ID), "the viewer's id must not be recoverable from the recommendation id");
    assert.ok(!id.includes("node/1001"), "nor the item id");
    // base64/hex-safe: it goes into jsonb and may later become a URL segment.
    assert.match(id, /^[A-Za-z0-9_-]+$/, "an opaque id must be transport-safe wherever it is later carried");
  });

  it("R6. reason codes on the row are the GROUNDED ones, and a serve with no ranker claims none", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    const rows = captured[0]?.rows ?? [];
    for (const r of rows) {
      assert.deepEqual(
        r.features.reasonCodes, [],
        "serve point 1 replays a cache and ran no ranker; inventing reason codes there would be a claim nothing backs",
      );
    }
  });

  it("R8. a caller's free-form context cannot overwrite the record — the denominator is not decoration", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.COLD_FETCH_LEGACY_RANK, items: ITEMS,
      // A caller that happens to use these names — or a malicious one — must not
      // be able to decide what the exposure record says about itself.
      context: { recommendationId: "forged", modelVersion: "v0-forged" } as any,
    });
    const row = (captured[0]?.rows ?? [])[0];
    assert.notEqual(row.features.recommendationId, "forged", "04 §5: the id is derived from the serve, never taken from the caller");
    assert.equal(row.features.modelVersion, DISCOVERY_MODEL_VERSION, "nor may the caller restate which model ranked the page");
  });

  it("R7. per-item reason codes are carried when the ranker DID supply them", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.COLD_FETCH_LEGACY_RANK, items: ITEMS,
      reasonCodesById: { "way/3003": ["nearby_now", "saved_similar"] },
    });
    const rows = captured[0]?.rows ?? [];
    const third = rows.find((r: any) => r.item_id === "way/3003");
    assert.deepEqual(third.features.reasonCodes, ["nearby_now", "saved_similar"], "the ranker's own codes reach the row");
    const first = rows.find((r: any) => r.item_id === "node/1001");
    assert.deepEqual(first.features.reasonCodes, [], "an item the ranker gave no codes for claims none");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `04` §3's two remaining required properties — VERSIONED and PRIVACY-CLASSIFIED
// (census-discovery DV-38 `N`, DV-39 `W`), and §10.5's constraint tests (DV-45).
//
// DV-38 reads: *"`rank_events` has no `schema_version` column — production
// schema is exactly 13 columns … `04` §6 names `schema_version` explicitly."*
// The column half is true and is a migration this lane may not write. The
// PROPERTY half — that a reader can tell which record shape produced a row — is
// not a column requirement: §13.3 already put three of `04` §5's nine fields
// into the `features` jsonb the row already writes, with the owner's reasoning
// recorded, and the shape version belongs beside them. Without it, the three
// fields that pass added become indistinguishable from their own absence: a row
// with no `reasonCodes` key is either pre-§13.3 or a serve that grounded
// nothing, and nothing on the row says which.
//
// DV-39 reads: *"The privacy RULE is enforced — lib/rankLog.ts:9-12 states it
// and the writer strips raw-coordinate keys from `features` before insert — but
// there is no privacy CLASSIFICATION on the row."* Re-executed at this tree the
// first half is FALSE FOR THIS WRITER: rankLog strips, and discoveryServeLog —
// which now writes the majority of Discovery's rows, across ten call sites in
// four route files — spreads the caller's `context` into `features` unfiltered
// and states the rule only as a JSDoc sentence ("Never coordinates"). A rule
// that lives in a comment at the call site is enforced by whoever remembers it.
// ─────────────────────────────────────────────────────────────────────────────
import {
  DISCOVERY_EVENT_SCHEMA_VERSION,
  DISCOVERY_EVENT_PRIVACY_CLASS,
  classifyServeContext,
  RANK_ITEM_KINDS,
} from "../lib/discoveryServeLog.js";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

describe("discoveryServeLog — 04 §3 versioned (DV-38)", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("T1. every written row says which record SHAPE produced it", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.COLD_FETCH_LEGACY_RANK, items: ITEMS,
    });
    const rows = captured[0]?.rows ?? [];
    assert.equal(rows.length, ITEMS.length, "precondition: rows were written");
    assert.ok(
      Number.isInteger(DISCOVERY_EVENT_SCHEMA_VERSION) && DISCOVERY_EVENT_SCHEMA_VERSION > 0,
      "04 §6 schema_version is a version, not a label",
    );
    for (const r of rows) {
      assert.equal(
        r.features.schemaVersion, DISCOVERY_EVENT_SCHEMA_VERSION,
        "04 §3 'versioned': a row that does not say which shape wrote it cannot be migrated or compared across a deploy",
      );
    }
  });

  it("T2. a caller cannot restate the schema version", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.FEED, items: ITEMS,
      context: { schemaVersion: 999 } as any,
    });
    const row = (captured[0]?.rows ?? [])[0];
    assert.equal(
      row.features.schemaVersion, DISCOVERY_EVENT_SCHEMA_VERSION,
      "the version describes the WRITER's shape; a caller that could set it could forge provenance",
    );
  });
});

describe("discoveryServeLog — 04 §3 privacy-classified, 04 §12 (DV-39)", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("U1. every written row carries its 04 §11 privacy class", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.COMMUNITY, items: ITEMS,
    });
    const rows = captured[0]?.rows ?? [];
    assert.equal(rows.length, ITEMS.length, "precondition: rows were written");
    for (const r of rows) {
      assert.equal(
        r.features.privacyClass, DISCOVERY_EVENT_PRIVACY_CLASS,
        "04 §3 'privacy-classified': an unlabelled row cannot be given a retention rule by anyone who did not write it",
      );
    }
    assert.equal(
      DISCOVERY_EVENT_PRIVACY_CLASS, "raw_behavioral_event",
      "04 §11's FIRST layer, named in the spec's own words — not a retention DECISION, which §11 reserves for privacy/legal review",
    );
  });

  it("U2. precise location handed in by a caller never reaches the row", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.SEARCH, items: ITEMS,
      context: {
        destination: "lisbon", radiusKm: 5,
        lat: 38.7223, lng: -9.1393, userLat: 38.70, userLng: -9.14, distanceKm: 1.2,
      } as any,
    });
    const f = (captured[0]?.rows ?? [])[0].features;
    for (const k of ["lat", "lng", "userLat", "userLng", "distanceKm"]) {
      assert.equal(
        k in f, false,
        `04 §12 'precise historical location beyond product need': ${k} must never be stored on a behaviour row`,
      );
    }
    assert.equal(f.destination, "lisbon", "a diagnostic that is not a coordinate is kept — the strip is a filter, not a ban");
    assert.equal(f.radiusKm, 5, "a RADIUS is not a position; stripping it would cost the baseline its one spatial diagnostic");
  });

  it("U3. the refusal is OBSERVABLE on the row, not silent", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.SEARCH, items: ITEMS,
      context: { destination: "lisbon", lat: 38.7223 } as any,
    });
    const f = (captured[0]?.rows ?? [])[0].features;
    assert.deepEqual(
      f.privacyDropped, ["lat"],
      "the 0202 lesson: a value dropped with nothing saying so is indistinguishable from a caller that never sent it",
    );
  });

  it("U3b. a clean context adds NO dropped-key noise to the row", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.SEARCH, items: ITEMS,
      context: { destination: "lisbon" },
    });
    const f = (captured[0]?.rows ?? [])[0].features;
    assert.equal("privacyDropped" in f, false, "an empty dropped list is an absent key, so a present one always means something happened");
  });

  it("U4. a caller cannot restate the privacy class", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.SEARCH, items: ITEMS,
      context: { privacyClass: "anonymous_aggregate" } as any,
    });
    const row = (captured[0]?.rows ?? [])[0];
    assert.equal(
      row.features.privacyClass, DISCOVERY_EVENT_PRIVACY_CLASS,
      "a class a caller can set is a class nobody can rely on",
    );
  });

  it("U5. classifyServeContext is pure, total, and names what it dropped", () => {
    assert.deepEqual(classifyServeContext(undefined), { kept: {}, dropped: [] });
    assert.deepEqual(classifyServeContext(null as any), { kept: {}, dropped: [] });
    const r = classifyServeContext({ Lat: 1, LONGITUDE: 2, city: "lisbon", venueLatitude: 3 });
    assert.deepEqual(r.kept, { city: "lisbon" }, "matching is case-insensitive and catches a suffixed coordinate name");
    assert.deepEqual(
      [...r.dropped].sort(), ["LONGITUDE", "Lat", "venueLatitude"].sort(),
      "dropped keys are reported under the caller's OWN spelling, so the offending call site is findable",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `04` §10.5 — "test all CHECK/enum constraints" (DV-45).
//
// DV-45's stated limitation stands and is NOT what these tests claim to fix:
// the suite runs against an unreachable SUPABASE_URL, so nothing here exercises
// a real CHECK rejection, and a green run does not prove a live constraint.
//
// What they DO test is the half that is checkable from the repository and was
// not being checked at all: that the vocabulary this writer can emit is a
// SUBSET of the vocabulary the migrations declare. That is the drift a green
// unit suite hides — a kind added in TypeScript with no migration behind it
// looks correct in every test and is refused by the database on the first
// production serve, exactly the 0202 failure the module header was written
// about.
// ─────────────────────────────────────────────────────────────────────────────
const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "migrations",
);

/**
 * The vocabulary a `rank_events` CHECK declares for one column, as the LAST
 * migration to declare it left it. Comment lines are stripped first: 2297 and
 * 2298 both carry the previous vocabulary inside their rollback blocks, and a
 * parser that read those would certify a constraint nobody applied.
 */
function checkVocabulary(column: string): string[] {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  let latest: string[] | null = null;
  const re = new RegExp(`CHECK\\s*\\(\\s*${column}\\s*(?:IN|=\\s*ANY)\\s*\\(([^)]*)\\)`, "gi");
  for (const f of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")
      .split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    // Statement-scoped, and that is not tidiness. Written table-blind, this
    // helper reported `rank_events.outcome` as ('accepted','duplicate',
    // 'rejected') — the memory command kernel's outcome CHECK in migration
    // 2710, which is a different table with the same column name and a later
    // filename. A vocabulary check that reads the wrong table's constraint
    // certifies nothing and does it confidently. Found by the first red run.
    for (const stmt of sql.split(";")) {
      if (!/\brank_events\b/i.test(stmt)) continue;
      for (const m of stmt.matchAll(re)) {
        const vals = [...m[1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!);
        if (vals.length > 0) latest = vals;
      }
    }
  }
  if (!latest) throw new Error(`no CHECK vocabulary found for rank_events.${column}`);
  return latest;
}

describe("discoveryServeLog — 04 §10.5 the writer's vocabulary vs the migrations (DV-45)", () => {
  it("V1. the parser finds a real vocabulary for each constrained column", () => {
    assert.ok(checkVocabulary("surface").includes("discovery"), "surface vocabulary resolved");
    assert.ok(checkVocabulary("item_kind").includes("place"), "item_kind vocabulary resolved");
    assert.ok(checkVocabulary("outcome").includes("impression"), "outcome vocabulary resolved");
    assert.ok(
      checkVocabulary("outcome").includes("dismiss"),
      "the LAST declaration wins — 2297 widened the outcome vocabulary and 2298's rollback comment must not win over it",
    );
  });

  it("V2. every item_kind this writer can emit is admitted by the CHECK", () => {
    const allowed = new Set(checkVocabulary("item_kind"));
    assert.ok(RANK_ITEM_KINDS.length > 0, "the writer's kinds are enumerable at runtime, not only as a type");
    for (const k of RANK_ITEM_KINDS) {
      assert.ok(allowed.has(k), `item_kind '${k}' is emittable in TypeScript and refused by the database`);
    }
  });

  it("V3. every kind searchTypeToItemKind can return is one of those, or NULL", () => {
    const types = [
      "travelers", "buddies", "events", "trips", "plans", "places", "hidden_gems", "posts",
      "traveler", "gem", "event", "place", "plan", "trip", "post",
      "cities", "countries", "languages", "hashtags", "circles", "", "nonsense",
    ];
    const kinds = new Set(RANK_ITEM_KINDS as readonly string[]);
    for (const t of types) {
      const k = searchTypeToItemKind(t);
      assert.ok(
        k === null || kinds.has(k),
        `searchTypeToItemKind('${t}') returned '${k}', which is outside the declared kind vocabulary`,
      );
    }
  });

  it("V4. the surface and outcome this writer hard-codes are admitted", async () => {
    invalidateServeLogFlagCache();
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.MAP_SEARCH, items: ITEMS,
    });
    const surfaces = new Set(checkVocabulary("surface"));
    const outcomes = new Set(checkVocabulary("outcome"));
    for (const r of captured[0]?.rows ?? []) {
      assert.ok(surfaces.has(r.surface), `surface '${r.surface}' is not in the CHECK vocabulary`);
      assert.ok(outcomes.has(r.outcome), `outcome '${r.outcome}' is not in the CHECK vocabulary`);
      assert.ok(r.item_kind === null || new Set(checkVocabulary("item_kind")).has(r.item_kind),
        `item_kind '${r.item_kind}' is not in the CHECK vocabulary`);
    }
  });
});
